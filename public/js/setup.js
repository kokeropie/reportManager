const form = document.getElementById('form');
const msg = document.getElementById('msg');
const say = (text, kind) => { msg.textContent = text; msg.className = 'msg ' + (kind || ''); };

async function post(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  let data = {};
  try { data = await res.json(); } catch (e) { /* empty */ }
  if (!res.ok) { const err = new Error(data.error || res.statusText); err.hint = data.hint; throw err; }
  return data;
}

function values() {
  const f = new FormData(form);
  return {
    code: f.get('code'), server: f.get('server'), port: f.get('port'), database: f.get('database'),
    user: f.get('user'), password: f.get('password'), trustCert: f.get('trustCert') === 'on', createDb: f.get('createDb') === 'on',
    adminUsername: f.get('adminUsername'), adminPassword: f.get('adminPassword'), encryptionKey: f.get('encryptionKey'),
  };
}

function fail(e) { say(e.message + (e.hint ? ' ' + e.hint : ''), 'error'); }

fetch('/setup/info').then((r) => r.json()).then((i) => { if (!i.hasEncryptionKey) document.getElementById('keyBox').hidden = false; }).catch(() => {});

document.getElementById('test').addEventListener('click', async (e) => {
  e.target.disabled = true; say('Testing...');
  try { const r = await post('/setup/test', values()); say(r.message, 'ok'); } catch (err) { fail(err); }
  e.target.disabled = false;
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = document.getElementById('save');
  btn.disabled = true; say('Saving...');
  try {
    const r = await post('/setup/apply', values());
    say('Saved. Starting the app...' + (r.newEncryptionKey ? ' A new encryption key was generated: back up the ENCRYPTION_KEY line of the .env file.' : ''), 'ok');
    for (let i = 0; i < 60; i++) {
      await new Promise((ok) => setTimeout(ok, 1500));
      try { const h = await fetch('/healthz'); if (h.ok) { location.href = '/login.html'; return; } } catch (err) { /* restarting */ }
    }
    say('The app did not come up within 90 seconds. Check the server console.', 'error');
  } catch (err) { fail(err); btn.disabled = false; }
});
