// The agent capability token is the one secret this server holds. It is
// kept sealed (AES-256-GCM) in the store, opened only to call the relay,
// and never returned, logged or put in an error. The key comes from the
// environment (WYLLS_MCP_SEAL_KEY, 32 bytes base64url); without one a
// random per-process key is used, which suits an in-memory store only.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export class Sealer {
  constructor(key = null) {
    const k = key ? Buffer.from(key, 'base64url') : randomBytes(32);
    if (k.length !== 32) throw new Error('WYLLS_MCP_SEAL_KEY must be 32 bytes (base64url)');
    this.key = k;
    this.ephemeral = !key;
  }
  seal(text) {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    const body = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
    return `v1.${iv.toString('base64url')}.${body.toString('base64url')}.${c.getAuthTag().toString('base64url')}`;
  }
  open(sealed) {
    const [v, iv, body, tag] = String(sealed).split('.');
    if (v !== 'v1') throw new Error('unknown seal');
    const d = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(body, 'base64url')), d.final()]).toString('utf8');
  }
  toJSON() { return { sealer: this.ephemeral ? 'ephemeral' : 'configured' }; }
}
