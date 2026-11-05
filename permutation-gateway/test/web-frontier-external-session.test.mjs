import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setLang } from '../../permutation-server/web/lang.mjs';
import { render } from '../../permutation-server/web/frontier/screens/join.mjs';

afterEach(() => setLang('ja'));

const screen = (patch = {}) => String(render({
  land: { stage: 'joined' }, wallet: { address: 'owner' },
  session: null, sessionProblem: null, delegation: null,
  citizen: { session: 'CouRiEr11111111111111111111111111111111111' },
  ...patch,
}));

test('an unknown registered session warns that taking control replaces its key', () => {
  const card = screen({ sessionProblem: 'SessionMismatch' });
  assert.match(card, /別のアプリや端末に操作を任せている可能性/);
  assert.match(card, /現在登録されている鍵は使えなくなります/);
  assert.match(card, /data-act="session"/);
  assert.doesNotMatch(card, /鍵を作り直す|この端末には.*鍵がありません/);

  setLang('en');
  const english = screen({ sessionProblem: 'SessionMismatch' });
  assert.match(english, /Another app or device may be acting for you/);
  assert.match(english, /currently registered key unusable/);
  assert.doesNotMatch(english, /[぀-ヿ一-鿿]/);
});

test('a missing local key without a registered mismatch keeps the recovery card', () => {
  const card = screen({ citizen: null });
  assert.match(card, /同じ鍵を作り直せます/);
  assert.match(card, /鍵を作り直す/);
});
