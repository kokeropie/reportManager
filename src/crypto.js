'use strict';
const crypto = require('crypto');

// AES-256-GCM. Stored format: v1:<iv b64>:<tag b64>:<ciphertext b64>
const VERSION = 'v1';

function keyBuffer(hexKey) {
  if (!/^[0-9a-fA-F]{64}$/.test(hexKey || '')) throw new Error('ENCRYPTION_KEY must be 64 hex characters');
  return Buffer.from(hexKey, 'hex');
}

function encrypt(plain, hexKey) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyBuffer(hexKey), iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return [VERSION, iv.toString('base64'), cipher.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
}

function decrypt(payload, hexKey) {
  const parts = String(payload || '').split(':');
  if (parts.length !== 4 || parts[0] !== VERSION) throw new Error('Unrecognised encrypted value');
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyBuffer(hexKey), Buffer.from(parts[1], 'base64'));
  decipher.setAuthTag(Buffer.from(parts[2], 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64')), decipher.final()]).toString('utf8');
}

module.exports = { encrypt, decrypt };
