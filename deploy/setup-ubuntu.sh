#!/usr/bin/env bash
# One-step setup for Ubuntu / Debian (systemd). Run as root from the unpacked app folder:
#
#   sudo bash deploy/setup-ubuntu.sh            # PORT=3000 by default; override with PORT=8080 sudo -E bash ...
#
# It checks Node, creates .env with fresh secrets, optionally creates the SQL Server database, installs a systemd
# service (report-server, runs as its own user, restarts 5 seconds after a crash), checks /healthz, then removes
# the first-admin password from .env. Safe to run again: an existing .env is never overwritten.
# Not yet run on a real server. Read it once before using it.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE="${SERVICE:-report-server}"
RUN_USER="${RUN_USER:-reportserver}"
PORT="${PORT:-3000}"
cd "$APP_DIR"

step() { printf '\n== %s\n' "$1"; }
ask() { local v; read -r -p "$1${2:+ [$2]}: " v; echo "${v:-$2}"; }
ask_secret() { local v; read -r -s -p "$1: " v; echo >&2; echo "$v"; }

[ "$(id -u)" -eq 0 ] || { echo "Run this as root: sudo bash deploy/setup-ubuntu.sh" >&2; exit 1; }

step "1/6 Checking Node.js"
if ! command -v node >/dev/null 2>&1; then
  cat <<'MSG'
Node.js was not found. Install it, then run this script again. For example Node 24 LTS:
  curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
  sudo apt-get install -y nodejs
(The app needs Node 20 or newer; use a currently supported LTS, 22 or 24.)
MSG
  exit 1
fi
NODE_BIN="$(command -v node)"
NODE_VER="$("$NODE_BIN" -v)"
echo "Found Node $NODE_VER at $NODE_BIN"
[ "${NODE_VER#v}" ] && [ "$(echo "${NODE_VER#v}" | cut -d. -f1)" -ge 20 ] || { echo "Node $NODE_VER is too old. Install Node 20 or newer (22 or 24 LTS recommended)." >&2; exit 1; }

step "2/6 Checking dependencies"
if [ -d node_modules/express ]; then
  echo "node_modules is present (release package)."
else
  command -v npm >/dev/null 2>&1 || { echo "npm not found. Use the release package, which already contains node_modules." >&2; exit 1; }
  echo "node_modules is missing, running: npm ci --omit=dev (needs internet access to the npm registry)"
  npm ci --omit=dev --no-audit --no-fund
fi

step "3/6 Configuration (.env)"
ADMIN_USER=admin
CREATED_ENV=0
if [ -f .env ]; then
  echo ".env already exists, keeping it."
else
  echo "Answer a few questions. Secrets are generated for you."
  DB_SERVER="$(ask 'SQL Server host (where the app database lives)' 'localhost')"
  DB_PORT="$(ask 'SQL Server port' '1433')"
  DB_NAME="$(ask 'App database name' 'ReportServer')"
  DB_USER="$(ask 'App database login' 'report_app')"
  DB_PASS="$(ask_secret 'App database password')"
  DB_TRUST="$(ask 'Trust the SQL Server certificate? (true if it is self-signed)' 'true')"
  ADMIN_USER="$(ask 'First admin username' 'admin')"
  ADMIN_PASS="$(ask_secret 'First admin password (min 8 characters)')"
  [ "${#ADMIN_PASS}" -ge 8 ] || { echo "The admin password must be at least 8 characters." >&2; exit 1; }
  OUT_DIR="$(ask 'Folder for saved scheduled reports (blank = the "output" folder inside the app)' '')"

  # Fill .env.example with node so quoting is exact (dotenv: single quotes keep every character as typed).
  RS_PORT="$PORT" RS_DB_SERVER="$DB_SERVER" RS_DB_PORT="$DB_PORT" RS_DB_NAME="$DB_NAME" RS_DB_USER="$DB_USER" \
  RS_DB_PASS="$DB_PASS" RS_DB_TRUST="$DB_TRUST" RS_ADMIN_USER="$ADMIN_USER" RS_ADMIN_PASS="$ADMIN_PASS" RS_OUT_DIR="$OUT_DIR" \
  "$NODE_BIN" -e '
    const fs = require("fs"), crypto = require("crypto"), e = process.env;
    const q = (v) => { if (!v.includes("\x27")) return "\x27" + v + "\x27"; if (!v.includes("\"")) return "\"" + v + "\""; throw new Error("A value contains both single and double quotes. Use a password without quotes."); };
    const map = {
      PORT: e.RS_PORT, SESSION_SECRET: crypto.randomBytes(48).toString("hex"), ENCRYPTION_KEY: crypto.randomBytes(32).toString("hex"),
      APP_DB_SERVER: e.RS_DB_SERVER, APP_DB_PORT: e.RS_DB_PORT, APP_DB_NAME: e.RS_DB_NAME, APP_DB_USER: q(e.RS_DB_USER),
      APP_DB_PASSWORD: q(e.RS_DB_PASS), APP_DB_TRUST_CERT: e.RS_DB_TRUST, ADMIN_USERNAME: e.RS_ADMIN_USER, ADMIN_PASSWORD: q(e.RS_ADMIN_PASS),
    };
    const lines = fs.readFileSync(".env.example", "utf8").split(/\r?\n/).map((l) => {
      const m = /^([A-Z_]+)=/.exec(l);
      return m && m[1] in map ? m[1] + "=" + map[m[1]] : l;
    });
    if (e.RS_OUT_DIR) lines.push("OUTPUT_DIR=" + q(e.RS_OUT_DIR));
    fs.writeFileSync(".env", lines.join("\n").replace(/\n*$/, "\n"), { mode: 0o600 });
  '
  CREATED_ENV=1
  echo ".env written. BACK UP the ENCRYPTION_KEY line somewhere safe: without it, stored connection passwords cannot be read."

  step "4/6 App database"
  echo "The database '$DB_NAME' and login '$DB_USER' must exist (deploy/create-database.sql shows how; run it with sqlcmd or SSMS)."
  if [ "$(ask "Create an empty database '$DB_NAME' now using the login above (needs the right to create databases)? (y/n)" 'n')" = y ]; then
    "$NODE_BIN" scripts/create-app-database.js || echo "Could not create it. Create the database by hand with deploy/create-database.sql."
  fi
  read -r -p "Press Enter once the database and login exist (SQL Server must allow TCP/IP and SQL logins) " _
fi

step "5/6 systemd service"
id -u "$RUN_USER" >/dev/null 2>&1 || useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin "$RUN_USER"
mkdir -p "$APP_DIR/reports" "$APP_DIR/output" "$APP_DIR/logs"
# the service account owns the app folder: it writes uploaded reports, saved results and (in setup mode) .env
chown -R "$RUN_USER":"$RUN_USER" "$APP_DIR"
chmod 600 .env
cat > "/etc/systemd/system/$SERVICE.service" <<UNIT
[Unit]
Description=Report Server (SSRS-style RDL report viewer)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$RUN_USER
WorkingDirectory=$APP_DIR
ExecStart=$NODE_BIN server.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null
systemctl restart "$SERVICE"
echo "Service $SERVICE installed and started. Logs: journalctl -u $SERVICE -f"

step "6/6 Health check"
OK=0
for _ in $(seq 1 15); do
  if "$NODE_BIN" -e "require('http').get('http://localhost:$PORT/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"; then OK=1; break; fi
  sleep 2
done
if [ "$OK" -eq 1 ]; then
  echo "Report Server is up: http://$(hostname):$PORT"
  echo "Scheduled reports run on this server's clock ($(cat /etc/timezone 2>/dev/null || date +%Z)). Fix it with 'timedatectl set-timezone' if that is not your local time."
  if [ "$CREATED_ENV" -eq 1 ]; then
    sed -i 's/^ADMIN_PASSWORD=.*/ADMIN_PASSWORD=/' .env
    echo "The first admin '$ADMIN_USER' exists. ADMIN_PASSWORD was removed from .env."
  fi
  echo 'Next: sign in, add connections, upload reports. See README.md "First real run checklist".'
else
  echo "The service did not answer on port $PORT. Read: journalctl -u $SERVICE -n 50" >&2
  exit 1
fi
