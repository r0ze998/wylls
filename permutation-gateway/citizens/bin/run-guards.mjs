// The guards of the run script (contract section 1.1 "One live stack at a time", 7.1 "Guards", 8.4; unit AC5), in one
// place so the script and the tests use the same code. `ai-citizens-run.sh --check` runs `check`; every start runs it
// again. It refuses (exit 1, every reason printed):
//   - an API key in the environment (the paid-API names below) or the file .local/anthropic-key;
//   - the old gateway (permutation-gateway/src/server.mjs) running;
//   - uncommitted changes under the guarded code paths (what a run commits to must be what runs);
//   - a stack config that is not the local test chain (mode accel, beacon test-key), whose ports leave 41901-41999
//     (or are 41900 itself, a reserved port, MC's 41000-41899) or are already listened on;
//   - a citizens config with a non-loopback URL, a port outside 41901-41999, or a missing pinned key;
//   - a held stack lock (a live pid).
//
//   node run-guards.mjs check --stack T --citizens-config C [--repo R] [--lock-file F] [--unit U] [--ab A|B --rep N] [--no-busy-check]
//   node run-guards.mjs lock-take --lock-file F --unit U --run-id R        (exit 1 when held; replaces a stale lock)
//   node run-guards.mjs lock-release --lock-file F --run-id R
//   node run-guards.mjs ports --stack T                                     (prints name=port lines of the stack)
//
// Lives in bin/: the run script may name the variables it refuses (the G10 grep skips this directory).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseStackToml, rulesFromConfig, GUARDED_PATHS, dirtyPaths } from '../registrar.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..', '..', '..');

/** The paid-API variables a run refuses and every child is started without. */
export const API_KEY_ENV = Object.freeze([
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_API_KEY', 'OPENAI_API_KEY', 'AZURE_OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY',
  'MISTRAL_API_KEY', 'COHERE_API_KEY', 'XAI_API_KEY', 'GROQ_API_KEY', 'OPENROUTER_API_KEY', 'DEEPSEEK_API_KEY', 'TOGETHER_API_KEY', 'PERPLEXITY_API_KEY', 'FIREWORKS_API_KEY',
]);
const API_KEY_PATTERN = /^(ANTHROPIC|OPENAI)_[A-Z0-9_]*(KEY|TOKEN)$/;
/** MC's, the playtest's and the M1 reserved ports (section 1.1): never bound by an AI run. */
export const RESERVED_PORTS = Object.freeze([4185, 4190, 4191, 4194, 18899, 17799, 28899, 27799, 26699, 5185, 5191]);
export const AI_MIN = 41901;
export const AI_MAX = 41999;
export const STACK_BASE = 41900;
export const LOOPBACK = ['127.0.0.1', '::1'];

/** The stack's ports from its toml: base_port + the offsets (stack/src/config.rs, defaults unless `[ports]` sets them). */
export function stackPorts(stack) {
  const base = stack.base_port ?? 41000;
  const off = { localnet: 10, localnet_ws: 11, drand: 20, relay_operator: 30, relay_public: 33, herald: 40, keeper_a: 50, keeper_b: 51, bots: 70, viewers: 75 };
  for (const k of Object.keys(off)) if (stack[`ports.${k}`] !== undefined) off[k] = stack[`ports.${k}`];
  return Object.fromEntries(Object.entries(off).map(([k, v]) => [k, base + v]));
}

export function portProblems(named, { busy = () => false, distinct = true } = {}) {
  const out = [];
  const seen = new Map();
  for (const [name, p] of Object.entries(named)) {
    if (!Number.isInteger(p)) { out.push(`${name}: ${p} is not a port`); continue; }
    if (RESERVED_PORTS.includes(p)) out.push(`${name}: port ${p} is reserved (M1 reserved list)`);
    else if (p === STACK_BASE) out.push(`${name}: port 41900 is never bound by the AI stack (MC reserves it)`);
    else if (p >= 41000 && p <= 41899) out.push(`${name}: port ${p} lies in 41000-41899 (the m1-exit stack, the design preview, the playtest and MC)`);
    else if (p < AI_MIN || p > AI_MAX) out.push(`${name}: port ${p} is outside 41901-41999`);
    else if (busy(p)) out.push(`${name}: port ${p} is already listened on`);
    if (distinct && seen.has(p)) out.push(`${name}: port ${p} is also ${seen.get(p)}'s`);
    seen.set(p, name);
  }
  return out;
}

export const lsofBusy = port => {
  try { return execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() !== ''; } catch { return false; }
};

export function envProblems(env) {
  const out = [];
  for (const k of Object.keys(env)) if (API_KEY_ENV.includes(k) || API_KEY_PATTERN.test(k)) out.push(`${k} is set: no paid-API key may exist in an AI run's environment`);
  return out;
}

/** Any process whose command line runs permutation-gateway/src/server.mjs (the old gateway), not src/frontier/server.mjs (the M1 relay). */
export function oldGatewayProblems(psLines) {
  return psLines.filter(l => /(^|[\s/])src\/server\.mjs(\s|$)/.test(l) && !/src\/frontier\/server\.mjs/.test(l)).map(l => `the old gateway is running (${l.trim().slice(0, 120)})`);
}
export const psLines = () => { try { return execFileSync('ps', ['-axo', 'command'], { encoding: 'utf8' }).split('\n'); } catch { return []; } };

export function urlProblems(cfg) {
  const out = [];
  const walk = (v, where) => {
    if (typeof v === 'string' && /^[a-z]+:\/\//i.test(v)) {
      let u;
      try { u = new URL(v); } catch { out.push(`${where}: ${v} is not a URL`); return; }
      const host = u.hostname === '[::1]' ? '::1' : u.hostname;
      if (u.protocol !== 'http:' || !LOOPBACK.includes(host)) out.push(`${where}: ${v} is not a loopback http URL`);
      else if (u.port && (Number(u.port) < AI_MIN || Number(u.port) > AI_MAX)) out.push(`${where}: port ${u.port} is outside 41901-41999`);
    } else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${where}.${k}`);
  };
  walk(cfg, 'config');
  return out;
}

/** Ports a citizens config names (llm.url, serve.port, ports.*); each must lie in 41901-41999 and none may be another's. */
export function citizensPorts(cfg) {
  const named = {};
  if (cfg.llm?.url) { try { named['llm.url'] = Number(new URL(cfg.llm.url).port); } catch { /* reported by urlProblems */ } }
  if (cfg.serve?.port !== undefined) named['serve.port'] = cfg.serve.port;
  for (const [k, v] of Object.entries(cfg.ports ?? {})) named[`ports.${k}`] = v;
  return named;
}

/** The lock `{pid, unit, run_id, started}`; `held` is true while its pid lives. */
export function readLock(file) {
  let l;
  try { l = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { exists: fs.existsSync(file), held: false, lock: null }; }
  let alive = false;
  try { process.kill(l.pid, 0); alive = true; } catch (e) { alive = e.code === 'EPERM'; }
  return { exists: true, held: alive, lock: l };
}
export function lockProblems(file) {
  const l = readLock(file);
  return l.held ? [`the stack lock ${file} is held by pid ${l.lock.pid} (${l.lock.unit}, run ${l.lock.run_id}, started ${l.lock.started})`] : [];
}
/** Take the lock atomically (O_EXCL). A lock whose pid is gone is replaced. Returns `{ok, replaced, holder}`. */
export function takeLock(file, { pid = process.pid, unit, run_id }) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = `${JSON.stringify({ pid, unit, run_id, started: new Date().toISOString() })}\n`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try { fs.writeFileSync(file, body, { flag: 'wx' }); return { ok: true, replaced: attempt > 0 }; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const l = readLock(file);
      if (l.held) return { ok: false, holder: l.lock };
      fs.rmSync(file, { force: true }); // stale: its process is gone
    }
  }
  return { ok: false, holder: readLock(file).lock };
}
export function releaseLock(file, run_id) {
  const l = readLock(file);
  if (l.lock && l.lock.run_id === run_id) { fs.rmSync(file, { force: true }); return true; }
  return false;
}

/**
 * Everything `--check` refuses. `opts`: repo, stackPath, citizensConfigPath, lockFile, env, ps, busy, ab, rep.
 * Returns `{ok, refusals: [string], notes: [string]}`.
 */
export function checkAll(opts) {
  const repo = opts.repo ?? REPO_ROOT;
  const refusals = [];
  const notes = [];
  refusals.push(...envProblems(opts.env ?? process.env));
  if (fs.existsSync(path.join(repo, '.local', 'anthropic-key'))) refusals.push('.local/anthropic-key exists: no paid-API key file may sit in the tree of an AI run');
  refusals.push(...oldGatewayProblems(opts.ps ?? psLines()));
  try {
    const dirty = dirtyPaths(repo, GUARDED_PATHS);
    if (dirty.length) refusals.push(`uncommitted changes under the guarded paths (${dirty.length}): ${dirty.slice(0, 4).join('; ')}${dirty.length > 4 ? '; ...' : ''}`);
  } catch (e) { refusals.push(`git status failed: ${e.message.split('\n')[0]}`); }
  if (opts.ab !== undefined || opts.rep !== undefined) {
    if (!['A', 'B'].includes(opts.ab)) refusals.push(`--ab ${opts.ab}: expected A or B`);
    if (![1, 2, 3].includes(Number(opts.rep))) refusals.push(`--rep ${opts.rep}: expected 1, 2 or 3`);
  }
  let stack = null;
  try {
    stack = parseStackToml(fs.readFileSync(opts.stackPath, 'utf8'));
    if ((stack.mode ?? 'accel') !== 'accel') refusals.push(`stack mode ${stack.mode}: only Mode A (accel) on the local test chain`);
    if ((stack.beacon ?? 'test-key') !== 'test-key') refusals.push(`stack beacon ${stack.beacon}: only the test-key drand`);
    for (const k of ['run_id', 'bot_seed', 'season_id', 'bots', 'base_port']) if (stack[k] === undefined) refusals.push(`stack config lacks ${k}`);
    if (typeof stack.bots_args !== 'string' && stack.bots_args !== undefined) refusals.push('bots_args must be a string (the stack reads no arrays)');
    refusals.push(...portProblems(stackPorts(stack), { busy: opts.busy ?? lsofBusy }).map(p => `stack ${p}`));
  } catch (e) { refusals.push(`stack config ${opts.stackPath}: ${e.message}`); }
  try {
    const cfg = JSON.parse(fs.readFileSync(opts.citizensConfigPath, 'utf8'));
    try { rulesFromConfig(cfg); } catch (e) { refusals.push(e.message); }
    refusals.push(...urlProblems(cfg));
    const named = citizensPorts(cfg);
    refusals.push(...portProblems(named, { busy: () => false, distinct: false }).map(p => `citizens config ${p}`)); // llm.url and ports.llama name one service: equal is fine
    if (stack) {
      const mine = new Set(Object.values(stackPorts(stack)));
      for (const [k, p] of Object.entries(named)) if (mine.has(p)) refusals.push(`citizens config ${k}: port ${p} is the stack's`);
    }
  } catch (e) { refusals.push(`citizens config ${opts.citizensConfigPath}: ${e.message}`); }
  if (opts.lockFile) {
    refusals.push(...lockProblems(opts.lockFile));
    const l = readLock(opts.lockFile);
    if (l.exists && !l.held) notes.push(`a stale stack lock (pid gone) is replaced at start: ${opts.lockFile}`);
  }
  return { ok: refusals.length === 0, refusals, notes };
}

// ------------------------------------------------------------------ command line
function argsOf(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!k.startsWith('--')) { a._.push(k); continue; }
    if (k === '--no-busy-check') a['no-busy-check'] = true;
    else a[k.slice(2)] = argv[++i];
  }
  return a;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const a = argsOf(process.argv.slice(2));
    const cmd = a._[0];
    if (cmd === 'check') {
      const r = checkAll({ repo: a.repo, stackPath: a.stack, citizensConfigPath: a['citizens-config'], lockFile: a['lock-file'], ab: a.ab, rep: a.rep, busy: a['no-busy-check'] ? () => false : undefined });
      for (const n of r.notes) console.log(`note: ${n}`);
      for (const x of r.refusals) console.error(`REFUSED: ${x}`);
      console.log(r.ok ? 'guards: PASS' : `guards: REFUSED (${r.refusals.length})`);
      process.exit(r.ok ? 0 : 1);
    } else if (cmd === 'lock-take') {
      const r = takeLock(a['lock-file'], { unit: a.unit ?? 'ai', run_id: a['run-id'], pid: a.pid ? Number(a.pid) : process.ppid });
      if (!r.ok) { console.error(`REFUSED: the stack lock is held by pid ${r.holder.pid} (${r.holder.unit}, run ${r.holder.run_id})`); process.exit(1); }
      console.log(r.replaced ? 'lock taken (a stale lock was replaced)' : 'lock taken');
    } else if (cmd === 'lock-release') {
      console.log(releaseLock(a['lock-file'], a['run-id']) ? 'lock released' : 'lock not ours; left alone');
    } else if (cmd === 'ports') {
      for (const [k, v] of Object.entries(stackPorts(parseStackToml(fs.readFileSync(a.stack, 'utf8'))))) console.log(`${k}=${v}`);
    } else {
      console.error('usage: run-guards.mjs check|lock-take|lock-release|ports ...');
      process.exit(2);
    }
  } catch (e) {
    console.error(`run-guards: ${e.message}`);
    process.exit(2);
  }
}
