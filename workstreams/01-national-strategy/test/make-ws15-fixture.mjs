// ⑮へ渡す fold() の出力を作り直す（鍵の生成・導出・署名をしない台本 scenario-e2e.mjs から）。
//   node workstreams/01-national-strategy/test/make-ws15-fixture.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { noDerivation, runScenario, ws15Export, writeFixture, FIXTURE } from './scenario-e2e.mjs';

noDerivation();
const r = await runScenario(fs.mkdtempSync(path.join(os.tmpdir(), 'ws01-ws15-')));
writeFixture(JSON.parse(JSON.stringify(ws15Export(r, r.board.state()))));
console.log(`書いた：${FIXTURE}`);
