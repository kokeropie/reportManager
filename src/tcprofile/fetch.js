'use strict';
// Downloads the Alvis TC Profile Excel export to a file. Uses https (not fetch) so it stays Node 16 compatible.
const https = require('https');
const http = require('http');
const fs = require('fs');

const IDLE_MS = 120 * 1000;       // no data for this long = give up
const TOTAL_MS = 20 * 60 * 1000;  // whole download

function download(url, apiKey, toFile, { redirects = 3, onBytes } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.request(u, { method: 'GET', headers: { 'X-API-Key': apiKey, Accept: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, */*' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(download(new URL(res.headers.location, u).toString(), apiKey, toFile, { redirects: redirects - 1, onBytes }));
      }
      if (res.statusCode !== 200) {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { if (body.length < 1000) body += c; });
        res.on('end', () => {
          const why = res.statusCode === 401 ? 'The API key was refused (401). Check ALVIS_API_KEY.'
            : res.statusCode === 400 ? 'Alvis rejected the request (400): ' + body.replace(/\s+/g, ' ').slice(0, 300)
              : `Alvis answered ${res.statusCode}. ${body.replace(/\s+/g, ' ').slice(0, 200)}`;
          reject(Object.assign(new Error(why), { status: res.statusCode }));
        });
        return;
      }
      const out = fs.createWriteStream(toFile);
      let size = 0;
      res.on('data', (c) => { size += c.length; if (onBytes) onBytes(size); });
      res.pipe(out);
      out.on('finish', () => out.close(() => resolve(size)));
      out.on('error', reject);
      res.on('error', reject);
      res.on('aborted', () => reject(new Error('The download was cut off.')));
    });
    req.setTimeout(IDLE_MS, () => req.destroy(new Error('Alvis stopped sending data (timed out).')));
    const total = setTimeout(() => req.destroy(new Error('The download took longer than 20 minutes.')), TOTAL_MS);
    total.unref();
    req.on('close', () => clearTimeout(total));
    req.on('error', reject);
    req.end();
  });
}

module.exports = { download };
