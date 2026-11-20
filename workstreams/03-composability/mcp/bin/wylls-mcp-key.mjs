#!/usr/bin/env node
// (2026-11-20, ③ public exposure) Manages the public server's API key file (src/api-keys.mjs). The file holds hashes
// only; a new key's token is printed ONCE on stdout and never stored. Keys carry the public read scope only.
//
//   node bin/wylls-mcp-key.mjs add    --file keys.json --label "agent-x" [--days 30] [--tools a,b] [--rate 30/1] [--per-day 5000]
//   node bin/wylls-mcp-key.mjs revoke --file keys.json --id <16 hex>
//   node bin/wylls-mcp-key.mjs list   --file keys.json
// A running server re-reads the file when it changes (within ~5 s): a revocation needs no restart.
import { newKey, readKeyFile, writeKeyFile, KeyFileError } from '../src/api-keys.mjs';
import { PUBLIC_TOOLS } from '../src/public-tools.mjs';

const USAGE = 'usage: wylls-mcp-key.mjs add|revoke|list --file <keys.json> [--label <text>] [--days <n>] [--tools a,b] [--rate b/s] [--per-day <n>] [--id <id>]';
const [cmd, ...rest] = process.argv.slice(2);
const opt = {};
for (let i = 0; i < rest.length; i += 2) {
  if (!/^--[a-z-]+$/.test(rest[i]) || rest[i + 1] === undefined) { console.error(USAGE); process.exit(64); }
  opt[rest[i].slice(2)] = rest[i + 1];
}
if (!opt.file || !['add', 'revoke', 'list'].includes(cmd)) { console.error(USAGE); process.exit(64); }
try {
  const keys = readKeyFile(opt.file);
  if (cmd === 'list') {
    for (const k of keys) console.log(`${k.id}  ${k.revokedAt ? 'revoked' : k.expiresAt && k.expiresAt <= Date.now() ? 'expired' : 'active '}  ${k.label}  tools=${k.tools ? k.tools.join(',') : 'all'}  rate=${k.rate ?? 'default'}  perDay=${k.perDay ?? 'default'}`);
  } else if (cmd === 'revoke') {
    const k = keys.find(x => x.id === opt.id);
    if (!k) { console.error('no key with that id'); process.exit(1); }
    k.revokedAt = Date.now();
    writeKeyFile(opt.file, keys);
    console.error(`revoked ${k.id}`);
  } else {
    if (!opt.label) { console.error(USAGE); process.exit(64); }
    const days = opt.days === undefined ? 30 : Number(opt.days);
    if (!(Number.isInteger(days) && days >= 1 && days <= 366)) { console.error('--days: 1 to 366'); process.exit(64); }
    const known = PUBLIC_TOOLS.map(t => t.name);
    if (opt.tools && opt.tools.split(',').map(x => x.trim()).some(t => !known.includes(t))) { console.error(`--tools: names among ${known.join(', ')}`); process.exit(64); }
    const { token, entry } = newKey({ label: opt.label, tools: opt.tools ? opt.tools.split(',').map(x => x.trim()).filter(Boolean) : null,
      expiresAt: Date.now() + days * 86_400_000, rate: opt.rate ?? null, perDay: opt['per-day'] === undefined ? null : Number(opt['per-day']) });
    writeKeyFile(opt.file, [...keys, entry]);
    console.error(`added ${entry.id} (${entry.label}); the token below is shown once and is not stored:`);
    console.log(token);
  }
} catch (e) {
  console.error(e instanceof KeyFileError ? e.message : 'the key file could not be read or written');
  process.exit(1);
}
