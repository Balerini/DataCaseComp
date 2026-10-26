'use strict';
// Field-level encryption for sensitive values (AES-256-GCM). Key: MDM_KEY (64 hex chars) or data/.mdm.key (auto-created, git-ignored).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PREFIX = 'enc:v1:';
let key;

function getKey() {
  if (key) return key;
  if (process.env.MDM_KEY) { key = Buffer.from(process.env.MDM_KEY, 'hex'); }
  else {
    const f = process.env.MDM_KEYFILE || path.join(__dirname, '..', 'data', '.mdm.key');
    if (fs.existsSync(f)) key = Buffer.from(fs.readFileSync(f, 'utf8').trim(), 'hex');
    else {
      key = crypto.randomBytes(32);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, key.toString('hex'), { mode: 0o600 });
    }
  }
  if (key.length !== 32) throw new Error('MDM_KEY must be 32 bytes (64 hex characters)');
  return key;
}

const isEnc = v => typeof v === 'string' && v.startsWith(PREFIX);

function encrypt(plain) {
  if (plain == null || plain === '' || isEnc(plain)) return plain;
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return PREFIX + [iv, c.getAuthTag(), ct].map(b => b.toString('base64')).join(':');
}

function decrypt(v) {
  if (!isEnc(v)) return v;
  const [iv, tag, ct] = v.slice(PREFIX.length).split(':').map(s => Buffer.from(s, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', getKey(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

const MASK = '•••• restricted';

module.exports = { encrypt, decrypt, isEnc, MASK };
