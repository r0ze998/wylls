// （2026-11-18、B13）板が入口の下の道に置かれたとき（ローカルプレイの起動役の世界ごとの板）、画面は /coop/*・/h/* をその下で読む。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mountOf, under } from '../coop/mount.mjs';
import { PAGE, answerCoop, staticFile } from '../coop/board.mjs';
import { createBoard } from './nokey.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('mount：画面の道の前の部分。根に置かれた板は空', () => {
  assert.equal(mountOf(PAGE), '');
  assert.equal(mountOf(`/coop-world/41006${PAGE}`), '/coop-world/41006');
  for (const bad of [undefined, '', '/', '/frontier/frontier/', '/a b/ws01/repo/x', '//evil/ws01/repo/']) assert.equal(mountOf(bad), '', String(bad));
  assert.equal(under('/coop-world/41006', '/coop/config'), '/coop-world/41006/coop/config');
  assert.equal(under('', '/coop/config'), '/coop/config');
  assert.equal(under('/m', '//evil/x'), '//evil/x');
  assert.equal(under('/m', 'rel'), 'rel');
});

test('answerCoop と staticFile：createServer と同じ答えを、ほかのサーバーからも使える', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws01-coop-mount-'));
  try {
    const board = createBoard({ herald: null, programId: 'P', seasonId: '7', dataDir: dir, fetchHerald: async () => ({ status: 404, json: null }) });
    const cfg = await answerCoop(board, { method: 'GET' }, new URL('http://x/coop/config'));
    assert.equal(cfg.status, 200); assert.deepEqual(cfg.body.season, { programId: 'P', seasonId: '7' }); assert.equal(cfg.body.page, PAGE);
    assert.equal(await answerCoop(board, { method: 'GET' }, new URL('http://x/frontier/')), null);
    assert.equal((await answerCoop(board, { method: 'POST' }, new URL('http://x/coop/rpc'))).status, 404);
    assert.equal(staticFile('workstreams/01-national-strategy/coop/').status, 200);
    assert.equal(staticFile('workstreams/01-national-strategy/coop/mount.mjs').type, 'text/javascript; charset=utf-8');
    assert.equal(staticFile('frontier-node/Cargo.toml').status, 404);
    assert.equal(staticFile('..%2F..%2Fetc/passwd').status, 404);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
