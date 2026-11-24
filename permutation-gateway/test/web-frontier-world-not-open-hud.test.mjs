// (page-not-open-yet) The plate and the watcher's rail while the world is not created yet (hud/hud.mjs), JA and EN:
// "the world is not open yet" with the time or "soon" — not "reading the record…", not "your record has not loaded /
// check your connection", and no reload key. Without `FS.notOpen` everything is as before. Imports hud/hud.mjs, so it
// runs locally (through src/), like the other HUD tests.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setLang } from '../../permutation-server/web/lang.mjs';
import * as hud from '../../permutation-server/web/frontier/hud/hud.mjs';
import { openTimeText } from '../../permutation-server/web/frontier/world-not-open.mjs';

afterEach(() => setLang('ja'));

const FAR = 4_000_000_000;   // (2096: "not yet" whenever this test runs)
const words = {
  ja: { title: '世界はまだ開いていません', soon: 'まもなく開きます。', auto: '開いたら、このページに自動で表示されます。', reading: '記録を読み込んでいます…', miss: '記録をまだ読み込めていません', conn: '通信の状態を確かめてください', unread: '世界の記録を読めません' },
  en: { title: 'The world is not open yet', soon: 'It opens soon.', auto: 'This page shows it automatically once it opens.', reading: 'Reading the record…', miss: 'Your record has not loaded yet', conn: 'Check your connection', unread: 'record cannot be read' },
};

test('the plate: not open yet, calmly; as before without it', () => {
  for (const lang of ['ja', 'en']) {
    setLang(lang);
    const w = words[lang], base = { mode: 'play', season: null, record: null, citizen: null, holdings: [], playReady: false, error: null };
    const soon = String(hud.renderPlate({ ...base, notOpen: { opensAt: null } }));
    assert.ok(soon.includes(w.title) && soon.includes(w.soon) && soon.includes(w.auto), `${lang}: ${soon}`);
    assert.match(soon, /class="plate plate-open plate-miss plate-notopen" role="status"/);
    for (const not of [w.reading, w.miss, w.conn]) assert.ok(!soon.includes(not), `${lang}: no "${not}"`);
    assert.doesNotMatch(soon, /data-act=/, 'no key: nothing to press');
    assert.doesNotMatch(soon, /season|シーズン|HTTP/i);
    const timed = String(hud.renderPlate({ ...base, notOpen: { opensAt: FAR } }));
    assert.ok(timed.includes(openTimeText(FAR)) && !timed.includes(w.soon), `${lang}: ${timed}`);
    // a player whose wallet is being asked about still reads "not open yet" (nothing will answer until the world is there)
    assert.ok(String(hud.renderPlate({ ...base, wallet: { address: 'x' }, meStatus: 'loading', notOpen: { opensAt: null } })).includes(w.title));
    // as before: no answer yet → reading; a failed read → could not load, with the connection hint and the reload key
    const pending = String(hud.renderPlate({ ...base, notOpen: null }));
    assert.ok(pending.includes(w.reading) && !pending.includes(w.title));
    const failed = String(hud.renderPlate({ ...base, notOpen: null, error: { code: 'network', text: 'x', source: 'season' } }));
    assert.ok(failed.includes(w.miss) && failed.includes(w.conn) && /data-act="reload"/.test(failed) && !failed.includes(w.title));
    // once a world was read the plate is the world's own, whatever `notOpen` says
    assert.ok(!String(hud.renderPlate({ ...base, season: {}, notOpen: { opensAt: null } })).includes(w.title));
  }
});

test('the watcher\'s rail: not open yet instead of "reading" or "cannot be read"', () => {
  for (const lang of ['ja', 'en']) {
    setLang(lang);
    const w = words[lang], base = { mode: 'spectate', season: null, overviews: new Map(), error: null };
    const rail = String(hud.renderRail({ ...base, notOpen: { opensAt: null } }));
    assert.ok(rail.includes(w.title) && rail.includes(w.soon) && rail.includes(w.auto), `${lang}: ${rail}`);
    assert.match(rail, /data-read="notopen"/);
    for (const not of [w.reading, w.unread, w.conn]) assert.ok(!rail.includes(not), `${lang}: no "${not}"`);
    const waiting = String(hud.renderRail({ ...base, notOpen: null }));
    assert.match(waiting, /data-read="waiting"/); assert.ok(waiting.includes(w.reading));
    const unread = String(hud.renderRail({ ...base, notOpen: null, error: { code: 'network' } }));
    assert.match(unread, /data-read="unread"/); assert.ok(unread.includes(w.unread) && unread.includes(w.conn));
  }
});
