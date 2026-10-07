import { api, setCsrf } from './api.js';

const form = document.getElementById('form');
const msg = document.getElementById('msg');

api('GET', '/auth/csrf').then((r) => setCsrf(r.csrfToken)).catch(() => { msg.textContent = 'Cannot reach the server'; });

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  msg.textContent = '';
  const f = new FormData(form);
  try {
    await api('POST', '/auth/login', { username: f.get('username'), password: f.get('password') });
    location.href = '/';
  } catch (err) {
    msg.textContent = err.message;
  }
});
