// The live llama-server against the commitments (AI-CITIZENS contract v1.3, R9; sections 7.1 and 8.4 "llama check"): the run script
// calls this after the commitments are built and BEFORE anything is started, and refuses on a difference. It compares
//   /props            model_alias with `model.alias`, n_ctx with `-c`, total_slots with `-np`, build_info with `server.llama_cpp`;
//   the process       the command line of the process that listens on the port (`ps -o args=`): its flags, order aside, with
//                     `server.flags` (flags_sha256 is checked too), its `-m` file with `model.file` and with AI_MODEL, its
//                     binary (realpath) with the AI_LLAMA_DIR tree the commitments measured.
// `/props` shows few of the flags (it has no -ngl, -fa, --jinja, --reasoning); the process command line is what shows them all,
// so a check that cannot read the command line is UNVERIFIED, and an unverified non-smoke run is refused. A smoke run
// (config smoke.json) may go on and the check says what it could not verify. Nothing here starts or stops a process.
//
//   node llama-check.mjs --llm http://127.0.0.1:41901 --commitments PUB/commitments.json [--ai-model F] [--ai-llama-dir D] [--smoke]
//                        [--argv-json F]   (tests only: {ps_args, binary_realpath} instead of reading the process)
//   exit 0: no difference (and, for a non-smoke run, nothing unverified); 1: a difference or an unverified non-smoke run; 2: usage.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { UNMEASURED, sha256hex, canonicalJson } from '../registrar.mjs';

const isMain = () => { try { return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } };

const real = p => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };

/** llama-server's flags that take no value; every other flag takes the next token as its value. */
export const BOOLEAN_FLAGS = new Set(['--jinja', '--no-webui', '--metrics']);

/** `['-np','1','--jinja','--port','41901']` -> Map {'-np' => '1', '--jinja' => true, '--port' => '41901'}. `-m FILE` is returned apart. */
export function parseFlags(tokens) {
  const flags = new Map();
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t.startsWith('-')) continue;
    if (BOOLEAN_FLAGS.has(t)) { flags.set(t, true); continue; }
    flags.set(t, tokens[i + 1] ?? '');
    i += 1;
  }
  return flags;
}

/** `/opt/homebrew/bin/llama-server -m F --alias A ...` -> {binary, model, flags: Map (without -m)}. */
export function parsePsArgs(line) {
  const tokens = String(line).trim().split(/\s+/);
  const binary = tokens.shift();
  const flags = parseFlags(tokens);
  const model = flags.get('-m') ?? flags.get('--model') ?? null;
  flags.delete('-m'); flags.delete('--model');
  return { binary, model, flags };
}

/** The pid that listens on `port` (lsof) and its command line (ps), or null. */
export function inspectListener(port) {
  try {
    const pid = execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n')[0];
    if (!pid) return null;
    const ps_args = execFileSync('ps', ['-ww', '-o', 'args=', '-p', pid], { encoding: 'utf8' }).trim();
    return ps_args ? { pid: Number(pid), ps_args, binary_realpath: real(ps_args.split(/\s+/)[0]) } : null;
  } catch { return null; }
}

const flagMapOf = list => parseFlags(list);
const sameMap = (a, b) => a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);
const showMap = m => [...m].map(([k, v]) => (v === true ? k : `${k} ${v}`)).sort().join(' ');

/**
 * compareLlama({props, listener, commitments, aiModel, aiLlamaDir}) -> {ok, mismatches: [...], unverified: [...], checks: [...]}.
 * `props` = the parsed /props, `listener` = {ps_args, binary_realpath} or null, `commitments` = the parsed commitments.json.
 */
export function compareLlama({ props, listener, commitments, aiModel = null, aiLlamaDir = null }) {
  const mismatches = [];
  const unverified = [];
  const checks = [];
  const ok = (what, detail) => checks.push(`${what}: ${detail}`);
  const bad = (what, detail) => mismatches.push(`${what}: ${detail}`);
  const model = commitments.model ?? {};
  const server = commitments.server ?? {};
  const want = flagMapOf(server.flags ?? []);

  if (server.flags_sha256 !== sha256hex(canonicalJson(server.flags ?? []))) bad('commitments server.flags_sha256', 'does not hash server.flags');
  // ---- /props
  if (props?.model_alias === undefined) unverified.push('/props has no model_alias');
  else if (props.model_alias !== model.alias) bad('model alias', `/props says ${JSON.stringify(props.model_alias)}, the commitments ${JSON.stringify(model.alias)}`);
  else ok('model alias', props.model_alias);
  const nctx = props?.default_generation_settings?.n_ctx ?? props?.n_ctx;
  if (nctx === undefined) unverified.push('/props has no n_ctx');
  else if (String(nctx) !== String(want.get('-c'))) bad('context size', `/props n_ctx ${nctx}, the commitments' -c ${want.get('-c')}`);
  else ok('context size', `n_ctx ${nctx} = -c`);
  if (props?.total_slots === undefined) unverified.push('/props has no total_slots');
  else if (String(props.total_slots) !== String(want.get('-np'))) bad('slots', `/props total_slots ${props.total_slots}, the commitments' -np ${want.get('-np')}`);
  else ok('slots', `total_slots ${props.total_slots} = -np`);
  const build = props?.build_info;
  const wantBuild = /b(\d+)\s*\/\s*([0-9a-f]{7,})/i.exec(server.llama_cpp ?? '');
  if (!build) unverified.push('/props has no build_info');
  else if (!wantBuild) unverified.push(`the commitments' llama_cpp ${JSON.stringify(server.llama_cpp)} has no "bNNNN / hash" to compare`);
  else if (!build.includes(wantBuild[1]) || !build.includes(wantBuild[2])) bad('llama.cpp build', `/props build_info ${build}, the commitments ${server.llama_cpp}`);
  else ok('llama.cpp build', build);

  // ---- the process
  if (!listener?.ps_args) unverified.push('the command line of the process on the port could not be read (flags such as -ngl, -fa, --jinja and --reasoning are not in /props)');
  else {
    const live = parsePsArgs(listener.ps_args);
    if (!sameMap(live.flags, want)) bad('flags', `the live process has [${showMap(live.flags)}], the commitments [${showMap(want)}]`);
    else ok('flags', `${want.size} flags equal (order aside)`);
    if (!live.model) bad('model file', 'the live process has no -m');
    else {
      if (model.file !== UNMEASURED && path.basename(live.model) !== model.file) bad('model file', `the live process loaded ${path.basename(live.model)}, the commitments name ${model.file}`);
      else if (model.file !== UNMEASURED) ok('model file', `${path.basename(live.model)} = model.file`);
      if (aiModel) {
        if (real(live.model) !== real(aiModel)) bad('model path', `the live process loaded ${real(live.model)}, AI_MODEL is ${real(aiModel)}`);
        else ok('model path', 'the loaded file is AI_MODEL');
      } else unverified.push('AI_MODEL is not set: the loaded file cannot be tied to the file whose sha256 the commitments carry');
      if (props?.model_path && real(props.model_path) !== real(live.model)) bad('model path', `/props model_path ${props.model_path} is not the process's -m ${live.model}`);
    }
    if (aiLlamaDir) {
      const bin = real(listener.binary_realpath ?? live.binary);
      const dir = real(aiLlamaDir);
      if (!(bin === dir || bin.startsWith(`${dir}${path.sep}`))) bad('llama.cpp binary', `the live binary ${bin} is not inside AI_LLAMA_DIR ${dir}, the tree the commitments measured`);
      else ok('llama.cpp binary', `${bin} lies inside AI_LLAMA_DIR`);
    } else unverified.push('AI_LLAMA_DIR is not set: the live binary cannot be tied to the tree the commitments measured');
  }
  if (model.sha256 === UNMEASURED) unverified.push('the commitments say model.sha256 is unmeasured');
  if (server.tree_sha256 === UNMEASURED) unverified.push('the commitments say server.tree_sha256 is unmeasured');
  return { ok: mismatches.length === 0, mismatches, unverified, checks };
}

async function main(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) { const k = argv[i]; if (k === '--smoke') a.smoke = true; else if (k.startsWith('--')) a[k.slice(2)] = argv[++i]; }
  if (!a.llm || !a.commitments) { console.error('usage: llama-check.mjs --llm URL --commitments FILE [--ai-model F] [--ai-llama-dir D] [--smoke]'); return 2; }
  const url = new URL(a.llm);
  if (!['127.0.0.1', '::1', '[::1]'].includes(url.hostname)) { console.error(`llama-check: ${a.llm} is not a loopback URL`); return 2; }
  const props = await (await fetch(`${url.origin}/props`, { signal: AbortSignal.timeout(10_000) })).json();
  const listener = a['argv-json'] ? JSON.parse(fs.readFileSync(a['argv-json'], 'utf8')) : inspectListener(Number(url.port));
  const commitments = JSON.parse(fs.readFileSync(a.commitments, 'utf8'));
  const r = compareLlama({ props, listener, commitments, aiModel: a['ai-model'] || null, aiLlamaDir: a['ai-llama-dir'] || null });
  for (const c of r.checks) console.log(`ok: ${c}`);
  for (const u of r.unverified) console.log(`UNVERIFIED: ${u}`);
  for (const m of r.mismatches) console.error(`MISMATCH: ${m}`);
  if (!r.ok) { console.error(`llama check: REFUSED (${r.mismatches.length} difference(s))`); return 1; }
  if (r.unverified.length && !a.smoke) { console.error(`llama check: REFUSED, ${r.unverified.length} item(s) unverified in a non-smoke run`); return 1; }
  console.log(r.unverified.length ? `llama check: PASS with ${r.unverified.length} unverified item(s) (smoke run)` : 'llama check: PASS');
  return 0;
}

if (isMain()) main(process.argv.slice(2)).then(c => { process.exitCode = c; }, e => { console.error(`llama-check: ${e.message}`); process.exitCode = 2; });
