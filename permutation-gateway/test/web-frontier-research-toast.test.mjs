// verify-pr232: a refused research press (world goal ②) names itself in the toast, never the previous send, and a
// refused pledge offers no blind retry. Kept apart from web-frontier-research-card.test.mjs: hud/status.mjs reads the
// delegation module, which the key-test scan follows conservatively.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setLang } from '../../permutation-server/web/lang.mjs';
test('(verify-pr232) a refused research press names itself, never the previous send, and a refused pledge offers no blind retry', async () => {
  const { statusOf } = await import('../../permutation-server/web/frontier/hud/status.mjs');
  const { readFileSync } = await import('node:fs');
  // app.mjs records the press as the last send (so 「もう一度」 cannot re-run an earlier Build)
  const app = readFileSync(new URL('../../permutation-server/web/frontier/app.mjs', import.meta.url), 'utf8');
  const sends = /export const SENDS = Object\.freeze\(new Set\(\[([\s\S]*?)\]\)\);/.exec(app)[1];
  assert.match(sends, /'research-pledge', 'research-apply'/);
  setLang('en');
  const pledge = statusOf({ mode: 'play', lastAct: { kind: 'act', name: 'research-pledge', data: {} }, notice: { ok: false, code: 'Program', programCode: 13, text: 'x', retry: false } }, { canRetry: true });
  assert.equal(pledge.what, 'No science has been contributed.');
  assert.equal(pledge.retry, false);
  const apply = statusOf({ mode: 'play', lastAct: { kind: 'act', name: 'research-apply', data: {} }, notice: { ok: false, code: 'Program', programCode: 52, text: 'x' } }, { canRetry: true });
  assert.equal(apply.what, "The techs' effects have not been brought to the village.");
  assert.equal(apply.retry, true);
  setLang('ja');
  const ja = statusOf({ mode: 'play', lastAct: { kind: 'act', name: 'research-pledge', data: {} }, notice: { ok: false, code: 'Program', programCode: 13, text: 'x', retry: false } }, { canRetry: true });
  assert.equal(ja.what, '科学はまだ差し出されていません。');
});
