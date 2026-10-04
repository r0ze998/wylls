// AC8: the season-end publication runs inside the citizens service's permission sandbox (contract 1.3 C1): with the flags the service is started
// with (mind/permissions.mjs `permissionFlags`: the citizens/audit directory is on the read list), it reads AI_DIR/state, writes AI_DIR/pub/full and
// nothing else, and it cannot read KEYS or the stack toml.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { permissionFlags } from '../citizens/mind/permissions.mjs';
import { SLICE4 } from './fixtures/ai-audit-doubles.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const cp = (from, to) => { if (fs.statSync(from).isDirectory()) { fs.mkdirSync(to, { recursive: true }); for (const n of fs.readdirSync(from)) cp(path.join(from, n), path.join(to, n)); } else fs.copyFileSync(from, to); };

test('season_end.mjs runs under the service\'s permission flags and publishes PUB/full from STATE; a read of KEYS or the stack toml is refused', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-audit-perm-'));
  try {
    cp(path.join(SLICE4, 'state'), path.join(dir, 'state'));
    fs.mkdirSync(path.join(dir, 'pub'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'keys'));
    fs.writeFileSync(path.join(dir, 'keys', 'registrar.json'), '[]');
    const flags = permissionFlags({ repoRoot: ROOT, aiDir: dir });
    const r = spawnSync(process.execPath, [...flags, path.join(ROOT, 'permutation-gateway/citizens/audit/season_end.mjs'), '--ai-dir', dir], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout.trim().split('\n').pop());
    assert.equal(out.published, true);
    assert.equal(out.unreleased, 7);
    assert.ok(fs.existsSync(path.join(dir, 'pub', 'full', 'index.json')));
    const denied = spawnSync(process.execPath, [...flags, '--input-type=module', '-e', `
      const fs = await import('node:fs');
      const t = p => { try { fs.readFileSync(p); return 'READ'; } catch (e) { return e.code; } };
      console.log(JSON.stringify([t(${JSON.stringify(path.join(dir, 'keys', 'registrar.json'))}), t(${JSON.stringify(path.join(ROOT, 'permutation-gateway/citizens/stack/ai-smoke.toml'))}), t(${JSON.stringify(path.join(ROOT, 'permutation-gateway/citizens/registrar.mjs'))})]));
    `], { encoding: 'utf8' });
    assert.deepEqual(JSON.parse(denied.stdout.trim()), ['ERR_ACCESS_DENIED', 'ERR_ACCESS_DENIED', 'ERR_ACCESS_DENIED'], denied.stderr);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
