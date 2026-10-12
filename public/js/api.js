// Small fetch wrapper: JSON in/out, CSRF header on writes, redirect to login on 401.
let csrfToken = null;

export function setCsrf(t) { csrfToken = t; }

export async function api(method, url, body) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && csrfToken) headers['X-CSRF-Token'] = csrfToken;
  const res = await fetch('/api' + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin' });
  let data = null;
  try { data = await res.json(); } catch (e) { /* empty body */ }
  if (res.status === 401 && !url.startsWith('/auth/login')) { location.href = '/login.html'; throw new Error('Signed out'); }
  if (!res.ok) { const err = new Error((data && data.error) || res.statusText); err.status = res.status; err.data = data; throw err; }
  return data;
}

// Tiny DOM helper. Uses textContent only, so server data can never inject markup.
export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v !== false && v !== null && v !== undefined) el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) el.append(kid instanceof Node ? kid : document.createTextNode(kid == null ? '' : String(kid)));
  return el;
}

// POST that returns a file: saved through a temporary link. Errors come back as JSON, like api().
// With `save` ({ name, ext, mime }) the browser's Save As dialog opens first, so the user picks the folder and file
// name (Chrome/Edge on https or localhost). The dialog must open straight from the click, before the slow request.
// Browsers without it, or plain-http pages, fall back to a normal download into the Downloads folder.
export async function download(url, body, save) {
  let handle = null;
  if (save && window.showSaveFilePicker && window.isSecureContext) {
    try {
      handle = await window.showSaveFilePicker({
        suggestedName: save.name,
        types: [{ description: save.ext.toUpperCase() + ' file', accept: { [save.mime]: ['.' + save.ext] } }],
      });
    } catch (e) {
      if (e && e.name === 'AbortError') return false; // user cancelled the dialog
      handle = null;
    }
  }
  const res = await fetch('/api' + url, {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken || '' },
    body: JSON.stringify(body),
  });
  if (res.status === 401) { location.href = '/login.html'; throw new Error('Signed out'); }
  if (!res.ok) {
    let data = null;
    try { data = await res.json(); } catch (e) { /* not JSON */ }
    const err = new Error((data && data.error) || res.statusText);
    err.data = data;
    throw err;
  }
  const cd = res.headers.get('Content-Disposition') || '';
  const star = /filename\*=UTF-8''([^;]+)/i.exec(cd);
  const plain = /filename="([^"]+)"/i.exec(cd);
  const name = star ? decodeURIComponent(star[1]) : plain ? plain[1] : 'report';
  const blob = await res.blob();
  if (handle) {
    const w = await handle.createWritable();
    await w.write(blob);
    await w.close();
    return true;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  return true;
}
