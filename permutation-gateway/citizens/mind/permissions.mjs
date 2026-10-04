// The Node permission-model flags of the citizens service (contract section 1.3 C1) and the helper that
// pins the read list. The service runs as
//   node --experimental-permission --allow-fs-read=<path> (one flag per path) --allow-fs-write=AI_DIR/state --allow-fs-write=AI_DIR/pub citizens/server.mjs ...
// <list> = citizens/{server.mjs, serve.mjs, mind, memory, persona, social, watcher, audit, prompts, config},
// the read-only web imports the service loads (web/frontier/council/, web/frontier/people/identity.mjs,
// web/lang.mjs and everything they import, resolved here by following the static imports), AI_DIR/state and
// AI_DIR/pub. NOT: citizens/stack, bin, llama, ab, probe, injection, scenario, registrar.mjs (the stack
// tomls hold bot_seed, from which every AI and seat key derives), KEYS, .local/frontier/runs/**.
// The permission model does not restrict the network: loopback-only is enforced by guards.mjs.
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';

export const CITIZENS_READ = ['server.mjs', 'serve.mjs', 'mind', 'memory', 'persona', 'social', 'watcher', 'audit', 'prompts', 'config'];
export const WEB_ENTRIES = [
  'permutation-server/web/frontier/people/identity.mjs',
  'permutation-server/web/lang.mjs',
];
export const WEB_DIRS = ['permutation-server/web/frontier/council'];

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s[^'"\n]*?from\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;

/** Every relative file reachable from `entries` by static (and literal dynamic) imports. */
export function importClosure(entries) {
  const seen = new Set();
  const stack = [...entries];
  while (stack.length) {
    const f = stack.pop();
    if (seen.has(f) || !existsSync(f) || !statSync(f).isFile()) continue;
    seen.add(f);
    if (!/\.(mjs|js)$/.test(f)) continue;
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(IMPORT_RE)) {
      const spec = m[1] ?? m[2] ?? m[3];
      if (!spec || !spec.startsWith('.')) continue; // builtins and packages need no fs grant here
      stack.push(resolve(dirname(f), spec));
    }
  }
  return [...seen].sort();
}

export function readList({ repoRoot, aiDir }) {
  const gw = join(repoRoot, 'permutation-gateway/citizens');
  const list = CITIZENS_READ.map((p) => join(gw, p));
  const web = importClosure(WEB_ENTRIES.map((p) => join(repoRoot, p)));
  const webDirs = WEB_DIRS.map((d) => join(repoRoot, d)).filter((d) => existsSync(d));
  // aisocial.mjs and the council page modules are read-only imports of the social service
  const councilFiles = webDirs.flatMap((d) => (statSync(d).isDirectory() ? readdirSync(d).filter((f) => f.endsWith('.mjs')).map((f) => join(d, f)) : []));
  const closure = importClosure(councilFiles);
  // integ-A: the read-only web imports of the modules the service loads dynamically (watcher/feed.mjs, owners.mjs, memory/*, ...):
  // the static imports of every .mjs under the citizens directories listed above, whatever they reach outside them
  const ownFiles = list.filter((p) => existsSync(p)).flatMap((p) => (statSync(p).isDirectory() ? readdirSync(p).filter((f) => f.endsWith('.mjs')).map((f) => join(p, f)) : [p]));
  const ownClosure = importClosure(ownFiles);
  return [...new Set([...list.filter((p) => existsSync(p)), ...web, ...webDirs, ...closure, ...ownClosure, join(aiDir, 'state'), join(aiDir, 'pub')])].sort();
}

/**
 * One --allow-fs-read flag per path: on Node 20.19.4 a comma-separated list with more than one entry does
 * not work (the entry script is then refused: measured), so the list is spelled as repeated flags.
 */
export function permissionFlags({ repoRoot, aiDir }) {
  const flags = ['--experimental-permission'];
  for (const p of readList({ repoRoot, aiDir })) flags.push(`--allow-fs-read=${p}`);
  flags.push(`--allow-fs-write=${join(aiDir, 'state')}`, `--allow-fs-write=${join(aiDir, 'pub')}`);
  return flags;
}
