'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { encrypt, decrypt } = require('../src/crypto');

const KEY = 'ab'.repeat(32);

test('encrypt/decrypt round trip', () => {
  const enc = encrypt('s3cret!p@ss', KEY);
  assert.ok(enc.startsWith('v1:'));
  assert.ok(!enc.includes('s3cret'));
  assert.strictEqual(decrypt(enc, KEY), 's3cret!p@ss');
});

test('same plaintext gives different ciphertext (random IV)', () => {
  assert.notStrictEqual(encrypt('x', KEY), encrypt('x', KEY));
});

test('tampered ciphertext is rejected', () => {
  const parts = encrypt('hello', KEY).split(':');
  const ct = Buffer.from(parts[3], 'base64');
  ct[0] ^= 1;
  parts[3] = ct.toString('base64');
  assert.throws(() => decrypt(parts.join(':'), KEY));
});

test('wrong key is rejected', () => {
  assert.throws(() => decrypt(encrypt('hello', KEY), 'cd'.repeat(32)));
});

test('bad key format is rejected', () => {
  assert.throws(() => encrypt('x', 'short'));
});
