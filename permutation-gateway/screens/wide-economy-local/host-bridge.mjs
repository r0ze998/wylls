// Node-only bridge to the LOCAL economy host: ONE fixed prebuilt binary, a persistent stdio line protocol.
//
// Security shape (all fixed here; nothing comes from a client):
//   - the binary path is REPO/.local/wide-economy-demo/target/debug/examples/local_economy_demo. It must be a regular
//     executable file whose realpath equals that exact expected path (no symlink anywhere on it);
//   - spawn without a shell, with NO arguments, a minimal fixed environment (nothing is inherited: no keys, no
//     fixture-export variables, no PATH) and the binary's own directory as cwd;
//   - one command (<= 256 B ASCII) in flight at a time; one reply line (<= 64 KiB, printable ASCII) per command;
//   - stderr is drained but only a short tail is kept (never forwarded to a client), and a flood kills the host;
//   - timeout, exit, spawn error, oversize, malformed or unsolicited output => the bridge is DEAD for good: no retry, no
//     restart, no respawn. The caller must treat the state as uncertain.
import { spawn } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOST_REL_PATH, MAX_COMMAND_BYTES, MAX_REPLY_BYTES } from './local-model.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..', '..', '..');
export const EXPECTED_HOST_PATH = join(REPO_ROOT, ...HOST_REL_PATH);
// The whole environment of the child. Literal and closed: nothing is copied from the parent's environment.
export const HOST_ENV = Object.freeze({ LANG: 'C', LC_ALL: 'C', RUST_BACKTRACE: '0' });
export const DEFAULT_TIMEOUT_MS = 5000;
export const STDERR_TAIL_BYTES = 4096;
export const STDERR_TOTAL_LIMIT = 1024 * 1024;

export class BridgeError extends Error {
  constructor(code, message) { super(message ?? code); this.code = code; }
}

/**
 * The fixed binary, verified: exact expected path, realpath-identical (no symlink on it), regular file, executable.
 * `deps` exist for tests only (fake filesystem); production passes nothing.
 */
export async function resolveHostBinary(deps = {}) {
  const realpathFn = deps.realpathFn ?? realpath, statFn = deps.statFn ?? stat;
  const root = deps.repoRoot ?? REPO_ROOT;
  let expected, real;
  try {
    expected = join(await realpathFn(root), ...HOST_REL_PATH);
    real = await realpathFn(expected);
  } catch { throw new BridgeError('HostMissing', 'the local host binary is not built at its fixed path'); }
  if (real !== expected) throw new BridgeError('HostPathMismatch', 'the host path resolves somewhere else');
  let info;
  try { info = await statFn(real); } catch { throw new BridgeError('HostMissing', 'stat failed'); }
  if (!info.isFile()) throw new BridgeError('HostNotRegular', 'the host is not a regular file');
  if ((info.mode & 0o111) === 0) throw new BridgeError('HostNotExecutable', 'the host is not executable');
  return real;
}

const printable = buf => { for (const b of buf) if (b < 0x20 || b > 0x7e) return false; return true; };

/**
 * Spawn the fixed host once and return `{exchange(line) -> Promise<string>, close(), alive, deadReason, stderrTail}`.
 * `deps` = test-only injection ({spawnFn, resolveBinary, timeoutMs}); there is no path, argument or environment option.
 */
export async function createChildBridge(deps = {}) {
  const spawnFn = deps.spawnFn ?? spawn;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const file = await (deps.resolveBinary ?? resolveHostBinary)();
  const child = spawnFn(file, [], {
    shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: { ...HOST_ENV }, cwd: dirname(file), windowsHide: true, detached: false,
  });
  let dead = null, pending = null, buf = Buffer.alloc(0), errTail = Buffer.alloc(0), errTotal = 0;

  const fail = (code, message) => {
    if (dead) return;
    dead = code;
    if (pending) { clearTimeout(pending.timer); const p = pending; pending = null; p.reject(new BridgeError(code, message)); }
    buf = Buffer.alloc(0);
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
    for (const s of [child.stdin, child.stdout, child.stderr]) { try { s?.destroy(); } catch { /* ignore */ } }
  };

  // `on`, not `once`: a second event after the host is dead must still be swallowed, never become an unhandled 'error'
  child.on?.('error', () => fail('SpawnError'));
  child.on?.('exit', () => fail('Exit'));
  child.on?.('close', () => fail('Exit'));
  child.stdin?.on('error', () => fail('Exit'));
  child.stdout?.on('error', () => fail('Exit'));
  child.stderr?.on('error', () => fail('Exit'));
  child.stderr?.on('data', chunk => {
    errTotal += chunk.length;
    errTail = Buffer.concat([errTail, chunk]).subarray(-STDERR_TAIL_BYTES);
    if (errTotal > STDERR_TOTAL_LIMIT) fail('StderrFlood');
  });
  child.stdout?.on('data', chunk => {
    if (dead) return;
    if (!pending) return fail('Unsolicited', 'output with no command in flight');
    buf = Buffer.concat([buf, chunk]);
    const nl = buf.indexOf(0x0a);
    if (nl < 0) { if (buf.length > MAX_REPLY_BYTES) fail('Oversize'); return; }
    if (nl > MAX_REPLY_BYTES) return fail('Oversize');
    if (nl === 0) return fail('Malformed', 'empty reply line');
    if (buf.length > nl + 1) return fail('Protocol', 'more than one reply line');
    const line = buf.subarray(0, nl);
    if (!printable(line)) return fail('Malformed', 'non-ASCII reply');
    const p = pending; pending = null; clearTimeout(p.timer); buf = Buffer.alloc(0);
    p.resolve(line.toString('latin1'));
  });

  return Object.freeze({
    get alive() { return dead === null; },
    get deadReason() { return dead; },
    get stderrTail() { return errTail.toString('latin1'); },
    exchange(line) {
      if (typeof line !== 'string' || line.length === 0 || line.length > MAX_COMMAND_BYTES || !/^[\x20-\x7e]+$/.test(line)) return Promise.reject(new BridgeError('BadCommand', 'command shape'));
      if (dead) return Promise.reject(new BridgeError('Closed', dead));
      if (pending) return Promise.reject(new BridgeError('Busy', 'one command at a time'));
      return new Promise((resolveReply, reject) => {
        const timer = setTimeout(() => fail('Timeout'), timeoutMs);
        pending = { resolve: resolveReply, reject, timer };
        try {
          child.stdin.write(`${line}\n`, err => { if (err) fail('Exit'); });
        } catch { fail('Exit'); }
      });
    },
    close() { fail('Closed'); },
  });
}
