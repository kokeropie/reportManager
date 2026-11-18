'use strict';
// Minimal Microsoft Graph client for uploading files to a SharePoint document library (app-only, client secret).
// Ubuntu / Node 20+ only: uses the built-in fetch.
const fs = require('fs');

const CHUNK = 32 * 320 * 1024; // 10 MiB; upload-session chunks must be a multiple of 320 KiB
const SIMPLE_MAX = 4 * 1024 * 1024; // Graph simple upload limit
const GRAPH = 'https://graph.microsoft.com/v1.0';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// SharePoint refuses these characters in a file or folder name; they become "_".
function cleanSegment(s) {
  let out = String(s).replace(/["*:<>?/\\|#%\u0000-\u001f]/g, '_').trim().replace(/[. ]+$/, '');
  if (/^(\.lock|CON|PRN|AUX|NUL|COM\d|LPT\d|_vti_.*)$/i.test(out) || out.startsWith('~$')) out = '_' + out;
  return out.slice(0, 120) || '_';
}

function encodePath(segments) {
  return segments.map((s) => encodeURIComponent(s)).join('/');
}

function createGraphClient({ tenantId, clientId, clientSecret, driveId, fetchImpl = fetch, sleepImpl = sleep }) {
  let token = null;
  let tokenExpires = 0;

  async function getToken(force = false) {
    if (!force && token && Date.now() < tokenExpires - 60000) return token;
    const res = await fetchImpl(`https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId, client_secret: clientSecret, scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials',
      }).toString(),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.access_token) {
      throw Object.assign(new Error(`Microsoft sign-in failed: ${body.error_description ? String(body.error_description).split('\r')[0] : res.status}`), { fatal: true });
    }
    token = body.access_token;
    tokenExpires = Date.now() + (body.expires_in || 3600) * 1000;
    return token;
  }

  // One Graph call with token refresh on 401 and back-off on 429 / 5xx. `auth:false` is for upload-session URLs.
  async function call(url, opts = {}, { auth = true } = {}) {
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      const headers = { ...(opts.headers || {}) };
      if (auth) headers.Authorization = `Bearer ${await getToken()}`;
      const res = await fetchImpl(url, { ...opts, headers });
      if (res.status === 401 && auth && !refreshed) { refreshed = true; await getToken(true); continue; }
      if ((res.status === 429 || res.status >= 500) && attempt < 4) {
        const wait = Math.min(60, parseInt(res.headers.get('retry-after') || '', 10) || 2 ** (attempt + 1));
        await sleepImpl(wait * 1000);
        continue;
      }
      return res;
    }
  }

  async function fail(res, what) {
    let msg = '';
    try { const b = await res.json(); msg = (b.error && b.error.message) || ''; } catch (e) { /* no body */ }
    throw Object.assign(new Error(`${what} failed (${res.status})${msg ? ': ' + msg : ''}`), { status: res.status, fatal: res.status === 401 || res.status === 403 });
  }

  // segments = ["Report Output", "kusuma", "Finance", "file.xlsx"]; missing folders are created by SharePoint.
  async function uploadFile(segments, absPath) {
    const size = fs.statSync(absPath).size;
    const base = `${GRAPH}/drives/${encodeURIComponent(driveId)}/root:/${encodePath(segments)}:`;
    if (size <= SIMPLE_MAX) {
      const res = await call(`${base}/content?@microsoft.graph.conflictBehavior=replace`, {
        method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: fs.readFileSync(absPath),
      });
      if (!res.ok) await fail(res, 'Upload');
      return size;
    }
    const sess = await call(`${base}/createUploadSession`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'replace' } }),
    });
    if (!sess.ok) await fail(sess, 'Upload');
    const { uploadUrl } = await sess.json();
    const fd = fs.openSync(absPath, 'r');
    try {
      for (let start = 0; start < size; start += CHUNK) {
        const len = Math.min(CHUNK, size - start);
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, start);
        const res = await call(uploadUrl, {
          method: 'PUT', headers: { 'Content-Length': String(len), 'Content-Range': `bytes ${start}-${start + len - 1}/${size}` }, body: buf,
        }, { auth: false });
        if (!res.ok) {
          await call(uploadUrl, { method: 'DELETE' }, { auth: false }).catch(() => {});
          await fail(res, 'Upload');
        }
      }
    } finally { fs.closeSync(fd); }
    return size;
  }

  return { uploadFile, getToken };
}

module.exports = { createGraphClient, cleanSegment, SIMPLE_MAX, CHUNK };
