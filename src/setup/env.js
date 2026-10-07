'use strict';
const fs = require('fs');

// dotenv: single quotes keep every character exactly as typed. Plain safe values stay unquoted.
function quote(v) {
  const s = String(v);
  if (/[\r\n\0]/.test(s)) throw new Error('Values cannot contain line breaks');
  if (/^[A-Za-z0-9_.-]+$/.test(s)) return s;
  if (!s.includes("'")) return `'${s}'`;
  if (!s.includes('"')) return `"${s}"`;
  throw new Error('A value cannot contain both single and double quotes');
}

// Replace KEY=... lines in place, append missing keys. Everything else in the file is left alone.
function updateEnvText(text, updates) {
  let out = text;
  for (const [key, value] of Object.entries(updates)) {
    const line = `${key}=${quote(value)}`;
    const re = new RegExp(`^${key}=.*$`, 'm');
    if (re.test(out)) out = out.replace(re, () => line);
    else out = out.replace(/\s*$/, '\n') + line + '\n';
  }
  return out;
}

function writeEnvFile(envPath, templatePath, updates) {
  let text = '';
  if (fs.existsSync(envPath)) text = fs.readFileSync(envPath, 'utf8');
  else if (templatePath && fs.existsSync(templatePath)) text = fs.readFileSync(templatePath, 'utf8');
  const next = updateEnvText(text, updates);
  const tmp = envPath + '.tmp';
  fs.writeFileSync(tmp, next, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, envPath); // never leave a half-written .env
}

module.exports = { quote, updateEnvText, writeEnvFile };
