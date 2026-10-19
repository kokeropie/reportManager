#!/usr/bin/env bash
# Removes the systemd service. Does not delete the app, its data, the service user or the database.
set -euo pipefail
SERVICE="${SERVICE:-report-server}"
[ "$(id -u)" -eq 0 ] || { echo "Run this as root." >&2; exit 1; }
systemctl disable --now "$SERVICE" 2>/dev/null || true
rm -f "/etc/systemd/system/$SERVICE.service"
systemctl daemon-reload
echo "Service $SERVICE removed."
