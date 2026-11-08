// ⑯ static audit (reads text only; usage: node v16-closure-audit.mjs <tree> <entry...>; V16_LIST=1 lists the files): literal-import closure of given entry files; reports PAT hits, unfollowed constructs, bare imports.
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
const [root, ...entries] = process.argv.slice(2);
// PAT copied from scripts/ci/scan-node-key-tests.mjs:25 (that module is NOT imported: its top level rewrites the list)
const P = /Keypair\.generate|Keypair\.fromSeed|Keypair\.fromSecretKey|generateKeyPair|generateKey\(|createPrivateKey|subtle\.(sign|generateKey|importKey)|signTransaction|signMessage|\.sign\(|partialSign|ed25519\.|secp256k1\.|nacl|keygen|secretKey|privateKey/;
const UNF = /['"](?:node:)?(?:child_process|worker_threads)['"]|\bimport\(\s*(?!['"`]\.?[^'"`]*['"`]\s*\))[^)\s]|new\s+Worker\b/;
const IMP = /(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|(?:^|[;\s])import\s*['"]([^'"]+)['"]/gm;
const seen = new Set(), bare = new Map(), hits = [], unf = [];
const walk = f => { if (seen.has(f) || !existsSync(f)) return; seen.add(f); const s = readFileSync(f, 'utf8');
  if (P.test(s)) hits.push(relative(root, f)); if (UNF.test(s)) unf.push(relative(root, f));
  for (const m of s.matchAll(IMP)) { const sp = m[1] ?? m[2] ?? m[3]; if (sp.startsWith('.')) walk(resolve(dirname(f), sp)); else { if (!bare.has(sp)) bare.set(sp, []); bare.get(sp).push(relative(root, f)); } } };
for (const e of entries) walk(resolve(root, e));
console.log(JSON.stringify({ files: seen.size, keyApiNamed: hits, unfollowed: unf, bare: Object.fromEntries(bare) }, null, 1));
if (process.env.V16_LIST) for (const f of [...seen].sort()) console.log(relative(root, f));
