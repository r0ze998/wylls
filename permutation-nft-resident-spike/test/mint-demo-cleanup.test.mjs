// `node src/mint-demo.mjs --localnet` started its own validator; on SIGTERM (or Ctrl-C) it must stop it and
// remove its ledger, leaving no process and no scratch directory behind. Real validator, loopback only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { localnetAvailable } from '../src/localnet.mjs';

const DEMO = fileURLToPath(new URL('../src/mint-demo.mjs', import.meta.url));
const skip = !localnetAvailable() ? 'needs the validator, Core and the resident program' : false;
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const children = pid => { try { return execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).map(Number); } catch { return []; } };
const argsOf = pid => execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });

for (const signal of ['SIGTERM', 'SIGINT']) {
  test(`${signal}: the validator stops and its ledger is removed`, { skip, timeout: 180_000 }, async () => {
    const node = spawn(process.execPath, [DEMO, '--localnet', '--port', '0'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } });
    let out = '';
    node.stdout.on('data', d => { out += d; });
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`not ready: ${out}`)), 150_000);
      const check = () => { if (/mint page \(REAL program/.test(out)) { clearTimeout(t); resolve(); } };
      node.stdout.on('data', check);
      node.on('exit', c => reject(new Error(`exited ${c}: ${out}`)));
    });
    const validator = children(node.pid).find(pid => /solana-test-validator/.test(argsOf(pid)));
    assert.ok(validator, 'the validator is this process\'s child');
    const ledger = /--ledger (\S+)/.exec(argsOf(validator))[1];
    assert.ok(existsSync(ledger));
    const exited = new Promise(r => node.on('exit', r));
    node.kill(signal);
    await exited;
    for (let i = 0; i < 50 && alive(validator); i++) await new Promise(r => setTimeout(r, 200));
    assert.equal(alive(validator), false, 'no orphan validator');
    assert.equal(existsSync(ledger), false, 'the ledger is removed');
  });
}
