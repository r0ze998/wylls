// Workstream 15 (owner decision 2026-11-18, ruleset B): the titles and chronicle of cooperation between nations, read
// from 01's board (/coop/outcomes) and shown beside the chronicle. Read only: the card changes nothing in the page's
// state, asks nothing but /coop/outcomes, and an answer that claims an effect on who wins, scores, prizes or the end
// of a season — or a ruleset other than B — is not shown. FIXTURE answers only (a fake fetch); no wallet, no key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as T from '../../permutation-server/web/frontier/hud/coopoutcomes.mjs';
import { setLang } from '../../permutation-server/web/lang.mjs';

const PROGRAM = 'Frnt1111111111111111111111111111111111111111';
const text = h => String(h).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const answer = (status, body) => async () => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const FS = (season = 7n, faction = 1) => ({ season: { seasonId: season }, pin: { programId: PROGRAM }, citizen: { faction } });
const entry = (id, goal, at, subject, title, reason) => ({ id, goal, track: subject.kind === 'nation' ? 'national' : 'personal', at, subject, title, reason, recordOnly: { ja: '称号と記録だけ。勝敗・得点・賞金には関わらない', en: 'A title and a record only' }, evidence: ['chain:1:0'] });
// 01's board answer as workstreams/15-coop-outcomes/src/live.mjs evaluateLive + coop/board.mjs outcomes() make it
const OUT = (over = {}) => ({
  ok: true, v: 1, kind: 'ws15-coop-outcomes', season: { programId: PROGRAM, seasonId: '7' }, complete: true, nowBell: 50,
  ruleset: { id: 'B-separate-tracks', variant: 'B', version: 3, hash: 'x', carryInputs: true },
  window: { id: 'world-so-far', opensAt: 0, closeAt: 51 }, inputHash: 'i', verdictHash: 'v',
  effects: { win: 'none', score: 'none', prize: 'none', seasonEnd: 'none' },
  entries: [
    entry('P-raider|w|tag:52', 'P-raider', 44, { kind: 'actor', id: 'tag:52', nation: 'n1' }, { ja: '他国の隊商を襲った者', en: 'Raider of foreign caravans' }, { ja: 'ほかの国の隊商から奪った', en: 'Took from another nation\'s caravans' }),
    entry('N-hold|w|n3', 'N-hold', 30, { kind: 'nation', id: 'n3', nation: 'n3' }, { ja: '砦を守り通した国', en: 'Nation that held its keeps' }, { ja: '砦を持ち続けた', en: 'Held keeps' }),
    entry('P-raider|w|tag:9', 'P-raider', 12, { kind: 'actor', id: 'tag:9', nation: null }, { ja: '他国の隊商を襲った者', en: 'Raider of foreign caravans' }, { ja: 'ほかの国の隊商から奪った', en: 'Took from another nation\'s caravans' }),
  ],
  undecided: 2, records: { gaps: 0, refused: 0 }, notes: {}, outcomesHash: 'h', ...over,
});

test('reading: absent (404, 204), not read (5xx with a code, network), read', async () => {
  assert.deepEqual(await T.probeOutcomes({ fetch: answer(404, {}) }), { read: 'absent' });
  assert.deepEqual(await T.probeOutcomes({ fetch: async () => new Response(null, { status: 204 }) }), { read: 'absent' });
  assert.deepEqual(await T.probeOutcomes({ fetch: answer(503, { ok: false, code: 'NoSeason' }) }), { read: 'unread', code: 'NoSeason' });
  assert.deepEqual(await T.probeOutcomes({ fetch: answer(502, {}) }), { read: 'unread', code: 'HTTP502' });
  assert.deepEqual(await T.probeOutcomes({ fetch: async () => { throw new TypeError('down'); } }), { read: 'unread', code: 'network' });
  assert.equal((await T.probeOutcomes({ fetch: answer(200, OUT()) })).read, 'ok');
});

test('no effect: an answer claiming any effect, an extra effect, a ruleset other than B or dropped carried inputs is refused', async () => {
  for (const bad of [
    OUT({ effects: { win: 'none', score: 'none', prize: 'share', seasonEnd: 'none' } }),
    OUT({ effects: { win: 'nation', score: 'none', prize: 'none', seasonEnd: 'none' } }),
    OUT({ effects: { win: 'none', score: 'none', prize: 'none', seasonEnd: 'none', bonus: 'none' } }),
    OUT({ effects: undefined }),
    OUT({ ruleset: { id: 'C-joint-window', variant: 'C', carryInputs: true } }),
    OUT({ ruleset: { id: 'B-separate-tracks', variant: 'B', carryInputs: false } }),
    OUT({ entries: [{ id: 'x' }] }),
  ]) assert.deepEqual(await T.probeOutcomes({ fetch: answer(200, bad) }), { read: 'unread', code: 'BadOutcomes' });
});

test('the card: titles newest first with their reasons, the viewer\'s nation marked, in Japanese and English', async () => {
  const b = await T.probeOutcomes({ fetch: answer(200, OUT()) });
  setLang('ja');
  const ja = text(T.render(FS(), b));
  assert.match(ja, /称号と記録 国をまたぐ協力の達成。勝敗・得点・賞金には関わらない/);
  assert.match(ja, /ターン 44 .+の領主が称号「他国の隊商を襲った者」を得た （あなたの国） 理由：ほかの国の隊商から奪った/);
  assert.match(String(T.render(FS(), b)), /<use href="art\/ui\/icons\.svg#banner"\/>/, 'the sprite\'s banner, as icons.mjs writes it');
  assert.match(ja, /ターン 30 .+が称号「砦を守り通した国」を得た 理由：砦を持ち続けた/);
  assert.match(ja, /ターン 12 所属の分からない領主が称号/);
  assert.match(ja, /まだ判定できない達成 2（記録が欠けているか、量が確かめられない）/);
  assert.match(ja, /称号と記録だけです。勝敗・得点・賞金・シーズンの終わりには何も加えません/);
  assert.ok(ja.indexOf('ターン 44') < ja.indexOf('ターン 30') && ja.indexOf('ターン 30') < ja.indexOf('ターン 12'));
  setLang('en');
  const en = text(T.render(FS(), b));
  assert.match(en, /Titles and records/);
  assert.match(en, /Turn 44 A lord of .+ earned the title “Raider of foreign caravans” \(your nation\) Why: Took from another nation(&#39;|')s caravans/);
  assert.match(en, /A lord of an unknown nation earned the title/);
  assert.match(en, /Achievements not decided yet: 2/);
  assert.doesNotMatch(en, /[ぁ-んァ-ヶ一-龯]/);
  assert.doesNotMatch(en, /\bbells?\b|settl/i);
  setLang('ja');
  // no titles yet
  assert.match(text(T.render(FS(), await T.probeOutcomes({ fetch: answer(200, OUT({ entries: [], undecided: 0 })) }))), /まだ称号はありません/);
  // more than SHOWN fold the older ones
  const many = OUT({ entries: Array.from({ length: T.SHOWN + 2 }, (_, i) => entry(`P-raider|w|tag:${i}`, 'P-raider', 100 - i, { kind: 'actor', id: `tag:${i}`, nation: 'n2' }, { ja: '他国の隊商を襲った者', en: 'Raider' }, { ja: '奪った', en: 'Took' })) });
  assert.match(text(T.render(FS(), await T.probeOutcomes({ fetch: answer(200, many) }))), /それより前の称号（2）/);
});

test('another world\'s answer is not shown; no board draws nothing; a board not read says so (not "none")', async () => {
  const b = await T.probeOutcomes({ fetch: answer(200, OUT()) });
  assert.equal(T.render(FS(8n), b), '');
  assert.equal(T.render({ ...FS(), pin: { programId: 'Other111111111111111111111111111111111111111' } }, b), '');
  assert.equal(T.render(FS(), { read: 'absent' }), '');
  assert.equal(T.render(FS(), null), '');
  setLang('ja');
  assert.match(text(T.render(FS(), { read: 'unread', code: 'NoSeason' })), /称号と記録を読み込めませんでした（NoSeason）。記録が空という意味ではありません/);
});

test('install: a server without outcomes is asked once; one that answers is asked again', async () => {
  for (const [status, again] of [[404, false], [503, true], [200, true]]) {
    let asked = 0; const timers = { setTimeout: () => 1, clearTimeout: () => {} };
    const later = [];
    timers.setTimeout = f => { later.push(f); return 1; };
    const stop = T.installCoopOutcomes({ fetch: async (...a) => { asked++; return answer(status, status === 200 ? OUT() : { code: 'X' })(...a); }, timers });
    await new Promise(r => setTimeout(r, 0));
    assert.equal(asked, 1);
    assert.equal(later.length, again ? 1 : 0, `${status}`);
    assert.equal(T.installCoopOutcomes({ fetch: async () => { asked++; return answer(200, OUT())(); }, timers }), stop, 'installs once');
    await new Promise(r => setTimeout(r, 0));
    assert.equal(asked, 1, 'a second install asks nothing more');
    stop();
    assert.equal(T.current(), null);
  }
});

test('read only, and nowhere near win, score or prize: what the module reaches and what the page does with it', () => {
  const src = readFileSync(new URL('../../permutation-server/web/frontier/hud/coopoutcomes.mjs', import.meta.url), 'utf8');
  const code = src.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  assert.deepEqual([...code.matchAll(/from '([^']+)'/g)].map(m => m[1]).sort(), ['../../lang.mjs', '../../sdk/base58.mjs', '../../util.mjs', '../fi18n.mjs', '../people/identity.mjs'], 'the two added 2026-11-22 only name the viewer (a pure tag and base58 decode)');
  assert.deepEqual([...code.matchAll(/`\$\{base\}([^`]+)`/g)].map(m => m[1]), ['/coop/outcomes'], 'it asks for nothing else');
  assert.doesNotMatch(code, /method\s*:|POST|FS\.[A-Za-z_$]+\s*=[^=]|localStorage|sign/, 'no write, no state of the page changed, no signing');
  assert.doesNotMatch(code, /standings|fprize|FS\.(prize|score|standing|win)|winners?\b/i, 'no standing, score or prize is read or written');
  const app = readFileSync(new URL('../../permutation-server/web/frontier/app.mjs', import.meta.url), 'utf8');
  const uses = app.split('\n').filter(l => /coopTitles\./.test(l)).map(l => [...l.matchAll(/coopTitles\.(\w+)/g)].map(m => m[1])).flat();
  assert.deepEqual([...new Set(uses)].sort(), ['current', 'installCoopOutcomes', 'render'], 'the page only installs the reader and draws the card');
  assert.match(app, /else parts\.push\(feed\.renderCentre\([^\n]*chronicleScreen\.render\(FS\), coopTitles\.render\(FS, coopTitles\.current\(\)\),/, 'drawn right after the chronicle');
  // the prize and standings screens never read the titles
  for (const f of ['fprize.mjs', 'screens/standings.mjs', 'screens/prize.mjs']) {
    let s = '';
    try { s = readFileSync(new URL(`../../permutation-server/web/frontier/${f}`, import.meta.url), 'utf8'); } catch { continue; }
    assert.doesNotMatch(s, /coopoutcomes|coop\/outcomes|coopTitles/, f);
  }
});

// ⑮ 「依頼に応えた」 (owner decision 2026-11-22 11:56): the title of a delivery to a fulfilled ① request is shown to its
// holder only (audience 'subject'). The deliverer sees 「あなたが称号「依頼に応えた」を得た」; the requester (and anyone
// else) does not see that line. The viewer is named as the evaluator names actors: tag:<u64> of their Citizen.
test('「依頼に応えた」: shown to the deliverer as their own title, not to the requester or anyone else; EN and JA', async () => {
  const owner = n => { const b = new Uint8Array(32); new DataView(b.buffer).setBigUint64(0, BigInt(n), true); return b; };
  const help = { ...entry('P-board-helper|w|tag:82', 'P-board-helper', 40, { kind: 'actor', id: 'tag:82', nation: 'n2' }, { ja: '依頼に応えた', en: 'Answered a request' }, { ja: 'ほかの国の人の協力の依頼に、自分の隊商で荷を届け、その依頼が依頼量に届いた（数えた量の下限で証明）', en: 'Delivered goods by their own caravan to a co-op request from someone of another nation, and the request reached its amount (proven by the lower bound counted)' }), audience: 'subject' };
  const b = await T.probeOutcomes({ fetch: answer(200, OUT({ entries: [help, ...OUT().entries] })) });
  assert.equal(b.read, 'ok');
  const deliverer = { ...FS(7n, 2), holdings: [{ ownerCitizen: owner(82) }] };
  const requester = { ...FS(7n, 1), holdings: [{ ownerCitizen: owner(65) }] };
  assert.equal(T.viewerActor(deliverer), 'tag:82');
  assert.equal(T.viewerActor(requester), 'tag:65');
  assert.equal(T.viewerActor(FS()), null, 'no village and no wallet: nobody');
  setLang('ja');
  const mine = text(T.render(deliverer, b));
  assert.match(mine, /ターン 40 あなたが称号「依頼に応えた」を得た 理由：ほかの国の人の協力の依頼に、自分の隊商で荷を届け/);
  assert.doesNotMatch(mine, /依頼に応えた」を得た （あなたの国）/, 'one\'s own title is not marked as the nation\'s');
  assert.match(String(T.render(deliverer, b)), /class="chron-turn coop-title-row mine own" data-title="P-board-helper\|w\|tag:82"/);
  for (const other of [requester, FS(), { ...FS(7n, 2), holdings: [{ ownerCitizen: owner(83) }] }]) {
    const t = text(T.render(other, b));
    assert.doesNotMatch(t, /依頼に応えた/, 'not on the requester\'s page, nor a stranger\'s (same nation or not)');
    assert.match(t, /他国の隊商を襲った者/, 'the public titles are still there');
  }
  setLang('en');
  assert.match(text(T.render(deliverer, b)), /Turn 40 You earned the title “Answered a request” Why: Delivered goods by their own caravan/);
  assert.doesNotMatch(text(T.render(requester, b)), /Answered a request/);
  setLang('ja');
  // a wallet whose Citizen address the pin derives (no village held yet)
  const viaWallet = { ...FS(7n, 2), wallet: { address: 'W' }, pin: { programId: PROGRAM, addresses: { of: () => '11111111111111111111111111111111' } } };
  assert.equal(T.viewerActor(viaWallet), 'tag:0');
  // an audience the page does not know is refused as a whole
  assert.deepEqual(await T.probeOutcomes({ fetch: answer(200, OUT({ entries: [{ ...help, audience: 'nation' }] })) }), { read: 'unread', code: 'BadOutcomes' });
});
