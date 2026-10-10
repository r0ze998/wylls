// Council page, "Follow this decision" (council/trace.mjs): one decision followed through four steps, each read from
// public files. SYNTHETIC fixtures in the shapes of a real run's files (minds/<b>.json, open/<b>.json,
// memory/<tag>/episodes.json, events/latest.json, the herald's /h/events): a person of nation 0 sends 500 troops at bell 11
// (public event 1572), the event becomes a `threat` episode of an AI, the AI is woken with W-THREAT at bell 12 and the
// model chooses a march to a camp, citing ANOTHER line. The properties: the actor's type comes from the roster only and
// is never guessed; "shown, not cited" is said exactly so; no step says why the model chose; an autopilot step is never
// printed as the model's; a sealed decision shows nothing that is still sealed; "no result yet" until a record exists.
import './fixtures/ai-page-lang.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeH } from '../../permutation-server/web/frontier/council/dom.mjs';
import { makeRosterIndex } from '../../permutation-server/web/frontier/council/badges.mjs';
import { normalizeMinds, normalizeOpenFile, normalizeEpisodes, decisionList, renderDecisions } from '../../permutation-server/web/frontier/council/decisions.mjs';
import { normalizeEvents } from '../../permutation-server/web/frontier/council/events.mjs';
import { normalizeHerald, makeLog, ingestLog, hostOwner, buildTrace, traceOf, eventTraces, startedByPeople, traceNeeds, findRecord, actorType, renderTrace, renderTracePanel } from '../../permutation-server/web/frontier/council/trace.mjs';
import { hostParts } from '../../permutation-server/web/frontier/faddr.mjs';
import { tl } from '../../permutation-server/web/frontier/council/lang.mjs';
import { makeFakeDocument, textOf, byClass, byTag, hasActiveContent } from './fixtures/ai-page-dom.mjs';
import { roster, T, W } from './fixtures/ai-page-kit.mjs';

const h = makeH(makeFakeDocument());
// a roster whose script list is complete: two wallets, two derived tags
const fullRoster = () => roster({ script: { first_index: 0, count: 2, wallets: [W.s0, W.s1], kind: 'script', label: 'script bot: not AI, not human' } });
const index = makeRosterIndex(fullRoster(), { scriptTags: [T.s0, T.s1] });
const ctxOf = (lang, ix = index) => ({ h, t: (k, v) => tl(lang, k, v), lang, index: ix, resolve: null });

const AI = T.ai1; // nation 1
const ID = '7f6ba8d5e59610db06dc4f2756b86cbf8a2cf35bc3efd9425fb98de8c5cb5ee3';
const SIG_EV = 'K2t6norKpZtccgWdoYN8kbaDHUyqo1Bs5RYJkVnvCPbzw7JZgMRBAk5oMH2xsKdAge2rF8TuKYG6hwrA235EcDc';
const SIG_TX = '4nvnNVFGAUyNWL3hZEpmkh3wBodwKiqFQiRPuaw6Sj6DHU6wzMdmVo5dGKA2jEKhPVrDrCAS6fScXXdrWBJxpWVm';
const SIG_CL = '3Xe9ra1meAdkA9wezkRSne98Q8TCmHkuynanuzNsD2tAQLtQVzaQcwkxurtNN2qJePiy3UTyPq3GyaFp15dwaQtw';
const HOST_P = '134144713555968', HOST_AI = '183622736805888';
const WHY = 'I am marching H1 to a nearby camp to fulfill my daily march goal.';

const sealed = (over = {}) => ({
  v: 2, sealed: true, release_bell: 16, commit: '12'.repeat(32),
  tx: [{ intent: 'harvest', sig: SIG_CL, status: 'sent', code: null }, { intent: 'depart', sig: SIG_TX, status: 'sent', code: null }],
  ai: AI, index: 1001, bell: 12, kind: 'session', mode: 'model', reason: 'ok', wake: ['W-THREAT', 'W-QUEUE'], gate_score: 4, id: ID, ...over,
});
const opened = (over = {}) => ({
  id: ID, ai: AI, index: 1001, bell: 12, mode: 'model', kind: 'session', by: 'model', wake: ['W-THREAT', 'W-QUEUE'], release_bell: 16, opened_bell: 16,
  choice: { ids: ['c3'], params: { c3: { retreat: 0, stance: 'assault', timing: 'earliest' } }, council: null, goal_id: 'G2', mem: ['61367590dbdaa439'] },
  retrieved: ['61367590dbdaa439', '8d26a605fdc1acdd'],
  public: { say: [], why: WHY, why_withheld: null },
  candidates: [
    { id: 'c1', kind: 'autopilot', label: 'Routine: economy and duties only, no march', facts: { routine: 'economy and duties only, no march' }, entities: [], refs: [] },
    { id: 'c3', kind: 'march', label: 'March H1 (100 troops) to a barbarian camp, 2 hexes away; earliest arrival at bell 15', facts: { enemy_troops: 101, target_kind: 'camp', troops: 100 }, entities: ['pq:-1,2'], refs: ['M1'], troops: 100 },
  ],
  remembered: [{ id: '61367590dbdaa439', bell: 3, text: { en: 'At bell 3 your sawmill was finished.', ja: '鐘3で、あなたの製材所が完成した。' } }],
  destinations: [{ host_id: HOST_AI, planned_arrive_bell: 15, via: 'model', state: 'revealed', p: -1, q: 2, tile: 29, arrive_bell: 15, depart_bell: 12 }],
  ...over,
});
const THREAT = { v: 1, id: '8d26a605fdc1acdd', bell: 11, created_bell: 11, kind: 'threat', entities: ['nation:0', 'pq:2,0'], text: { en: 'At bell 11 nation Aster sent an army of 500 troops from (2,0); it arrives at bell 14; its destination is not known.', ja: '鐘11で、アステルが(2,0)から兵500の軍を出した。到着は鐘14。行き先は不明。' }, importance: 5, src: ['event:1572'], facts: { p: 2, q: 0, nation: 0, mass: 500, arrive_bell: 14 } };
const SAWMILL = { v: 1, id: '61367590dbdaa439', bell: 3, created_bell: 3, kind: 'build_done', entities: ['pq:-1,2'], text: { en: 'At bell 3 your sawmill was finished.', ja: '鐘3で、あなたの製材所が完成した。' }, importance: 2, src: ['event:507'], facts: { p: -1, q: 2 } };
const WIN = { v: 1, id: '9337f9463da25114', bell: 15, created_bell: 17, kind: 'clash_own_win', entities: ['pq:-1,2'], text: { en: 'At bell 15 your army at (-1,2) beat the camp: you lost 12, they lost 101.', ja: '鐘15で、あなたの軍は(-1,2)で野営地に勝った。あなたは兵12、相手は兵101を失った。' }, importance: 6, src: ['event:2394', 'event:2395', `host:${HOST_AI}`], facts: { p: -1, q: 2, lost_own: 12, lost_enemy: 101, camp: true } };
const episodes = (list = [SAWMILL, THREAT]) => normalizeEpisodes({ v: 1, tag: AI, episodes: list });

const heraldRow = (seq, bell, name, key, payload, sig) => ({ bell, decoded: { bell, key, kind: 0, links: [], name, payload }, kind: 0, seq: String(seq), sig, slot: 1, tx: 1 });
const DEPART_ROW = heraldRow(1572, 11, 'DEPART', { host_id: HOST_P }, { arrive_bell: 14, dep_mass: 500000, depart_bell: 11, origin_p: 2, origin_q: 0, origin_tile: 36 }, SIG_EV);
const CLASH_ROW = heraldRow(2395, 17, 'CLASH', { bell: 15, p: -1, q: 2 }, { engagements: 1 }, SIG_CL);
const heraldOf = (...rows) => new Map(normalizeHerald({ v: 1, events: rows }).map(r => [r.seq, r]));
const departEvent = (tag, faction = 0) => ({ kind: 'depart', bell: 11, host_id: HOST_P, arrive_bell: 14, mass: 500, origin: { p: 2, q: 0 }, actor: { tag, kind: 'ai', ai: true, faction, name: { en: 'X', ja: 'X' } }, destination: null });
const clashEvent = { kind: 'clash', bell: 15, log_bell: 17, p: -1, q: 2, engagements: 1, arrivals: 1, actors: [{ tag: AI, kind: 'ai', ai: true, faction: 1, arrived: true, engaged: true, fate: 'Stays', troops_after: 487 }] };
const eventsOf = (...rows) => normalizeEvents({ v: 1, events: rows });

const rec0 = (over = {}) => normalizeMinds({ records: [sealed(over)] })[0];
const op0 = (over = {}) => normalizeOpenFile({ records: [opened(over)] })[0];
const full = (over = {}) => buildTrace({ rec: rec0(), opened: op0(), minds: [rec0()], episodes: episodes(), herald: heraldOf(DEPART_ROW), events: eventsOf(departEvent(T.human)), index, bellNow: 16, ...over });

const NO_CAUSE = /\bbecause\b|\btherefore\b|\bso it\b|\bled to\b|\bcaused\b|\bdue to\b|\bin response\b|\breacted\b/i;
const NO_CAUSE_JA = /だから|そのため|によって決め|を受けて|に反応|が原因|のせい|したので|たため/;

test('shown, not cited: the person\'s event is step 1, its line is M2 of step 2 and is marked exactly "shown, not cited"', () => {
  const tr = full();
  assert.equal(tr.by, 'model');
  assert.deepEqual(tr.triggers.map(g => [g.seq, g.kind, g.bell, g.troops, g.from, g.arrive, g.sig, g.nation, g.actors.map(a => a.type)]), [[1572, 'depart', 11, 500, { p: 2, q: 0 }, 14, SIG_EV, 0, ['person']]]);
  assert.deepEqual(tr.window, { from: 4, to: 12 });
  assert.deepEqual(tr.memory.lines.map(l => [l.n, l.id.slice(0, 4), l.kind, l.bell, l.cited, l.fromStep1, l.events]), [[1, '6136', 'build_done', 3, true, false, []], [2, '8d26', 'threat', 11, false, true, [1572]]]);
  assert.deepEqual(tr.memory.verdicts, [{ seq: 1572, status: 'shown_not_cited' }]);
  assert.equal(tr.startedByPerson, true);

  const en = textOf(renderTrace(ctxOf('en'), tr));
  assert.match(en, /What a person did/);
  assert.match(en, /nation Aster · .*person \(player\).* sent an army of 500 troops from \(2,0\); arrival at turn 14\./);
  assert.match(en, /public event 1572/);
  assert.ok(en.includes(SIG_EV), 'the full signature is in the opened box');
  assert.match(en, /transaction signature \(local test chain\) K2t6norK…35EcDc/);
  assert.match(en, /M2 At bell 11 nation Aster sent an army of 500 troops.*threat · turn 11from event 1572 of step 1shown, not cited/);
  assert.match(en, /M1 At bell 3 your sawmill was finished\..*shown and cited by the model/);
  assert.match(en, /The line from event 1572 was shown, not cited\./);
  assert.match(en, /A citation shows that the line was shown to the model and named by it, not that the choice rested on it\./, 'the page\'s caveat for cited memory');
  assert.match(en, /by: model/);
  assert.match(en, /AI's words \(model-written, not verified\)/);
  assert.ok(en.includes(WHY));
  assert.match(en, /Parameters: c3: retreat 0 · stance assault · timing earliest/);
  assert.match(en, /Local test chain\./);
  assert.doesNotMatch(en.replace(WHY, ''), NO_CAUSE, 'no causal word outside the model\'s own labelled words');

  const ja = textOf(renderTrace(ctxOf('ja'), tr));
  assert.match(ja, /人間がしたこと/);
  assert.match(ja, /人（プレイヤー）/);
  assert.match(ja, /AIが覚えたこと/);
  assert.match(ja, /示されたが、引用はされなかった/);
  assert.match(ja, /選んだ行動/);
  assert.match(ja, /結果/);
  assert.match(ja, /決めたのは：モデル/);
  assert.match(ja, /AIの言葉（モデルが書いたもので、検証されていません）/);
  assert.match(ja, /ローカルテストチェーン/);
  assert.doesNotMatch(ja, NO_CAUSE_JA);
  assert.equal(hasActiveContent(renderTrace(ctxOf('ja'), tr)), null);
});

test('cited: when the model names the line of the event, the verdict is "shown and cited", and still no claim of cause', () => {
  const tr = full({ opened: op0({ choice: { ids: ['c3'], params: {}, council: null, goal_id: 'G2', mem: ['8d26a605fdc1acdd'] }, remembered: [] }) });
  assert.deepEqual(tr.memory.verdicts, [{ seq: 1572, status: 'cited' }]);
  assert.deepEqual(tr.memory.lines.map(l => [l.n, l.cited, l.fromStep1]), [[1, false, false], [2, true, true]]);
  const en = textOf(renderTrace(ctxOf('en'), tr));
  assert.match(en, /The line from event 1572 was shown to the model and cited by it\./);
  assert.match(en, /not that the choice rested on it/);
  assert.doesNotMatch(en.replace(WHY, ''), NO_CAUSE);
  assert.match(textOf(renderTrace(ctxOf('ja'), tr)), /イベント1572の行はモデルに示され、モデルが引用しました。/);
  // a line of the event that was not shown at all is said so
  const tr2 = full({ opened: op0({ retrieved: ['61367590dbdaa439'] }) });
  assert.deepEqual(tr2.memory.verdicts, [{ seq: 1572, status: 'not_shown' }]);
  assert.match(textOf(renderTrace(ctxOf('en'), tr2)), /The line from event 1572 is not among the lines shown for this decision\./);
});

test('autopilot: a rule\'s step is printed as autopilot in every step, never with model words, and gets no button', () => {
  const auto = { v: 2, sealed: false, release_bell: null, commit: null, tx: [{ intent: 'muster', sig: SIG_TX, status: 'sent', code: null }], ai: AI, index: 1001, bell: 12, kind: 'autopilot', mode: 'autopilot', reason: 'below_gate', wake: ['W-THREAT'],
    choice: { ids: ['c1'], params: {}, council: null, goal_id: null, mem: [] }, retrieved: [], public: { say: [], why: null, why_withheld: null }, id: 'ab'.repeat(32) };
  const rec = normalizeMinds({ records: [auto] })[0];
  const tr = buildTrace({ rec, opened: null, minds: [rec], episodes: episodes(), herald: heraldOf(DEPART_ROW), events: eventsOf(departEvent(T.human)), index, bellNow: 13 });
  assert.equal(tr.by, 'autopilot');
  assert.equal(tr.memory.state, 'autopilot');
  for (const lang of ['en', 'ja']) {
    const node = renderTrace(ctxOf(lang), tr);
    const text = textOf(node);
    assert.match(text, lang === 'en' ? /by: autopilot/ : /決めたのは：自動操縦/);
    assert.match(text, lang === 'en' ? /no model words \(autopilot\)/ : /モデルの言葉なし（自動操縦）/);
    assert.match(text, lang === 'en' ? /A rule chose this, not the model\./ : /ルールによる選択で、モデルによるものではありません/);
    assert.doesNotMatch(text, /by: model|決めたのは：モデル|model-written|モデルが書いたもの|cited by the model|モデルが引用/);
    assert.equal(byClass(node, 'chip-model').length, 0, 'no model chip anywhere in an autopilot trace');
    assert.ok(byClass(node, 'trace-autopilot').length === 1, 'the autopilot trace has its own look');
  }
  // entry points: no button on the autopilot row, not in the lists of model decisions
  const env = { minds: [rec], opened: new Map(), episodesByTag: new Map([[AI, episodes()]]), herald: heraldOf(DEPART_ROW), events: eventsOf(departEvent(T.human)), index, bellNow: 13 };
  assert.deepEqual(eventTraces(env), []);
  assert.deepEqual(startedByPeople(env), []);
  const list = renderDecisions(ctxOf('en'), decisionList({ minds: [rec], showAutopilot: true }), { onTrace: () => {} });
  assert.equal(byClass(list, 'btn-trace').length, 0);
});

test('sealed, not yet opened: step 1 and the sent transactions are shown; steps 2 and 3 say "published after arrival" with the release bell', () => {
  const tr = buildTrace({ rec: rec0(), opened: null, minds: [rec0()], episodes: episodes(), herald: heraldOf(DEPART_ROW), events: eventsOf(departEvent(T.human)), index, bellNow: 13 });
  assert.equal(tr.state, 'sealed');
  assert.equal(tr.triggers.length, 1);
  assert.deepEqual(tr.memory, { state: 'sealed', lines: [], verdicts: [] });
  assert.deepEqual(tr.result.tx.map(x => [x.intent, x.status, x.sig]), [['harvest', 'sent', SIG_CL], ['depart', 'sent', SIG_TX]]);
  assert.deepEqual(tr.result.marches, []);
  const node = renderTrace(ctxOf('en'), tr);
  const en = textOf(node);
  assert.match(en, /What a person did/);
  assert.match(en, /sent an army of 500 troops from \(2,0\)/);
  assert.match(textOf(byClass(node, 'trace-step-2')[0]), /^2 What the AI rememberedPublished after arrival \(release at turn 16\)\.$/);
  assert.match(textOf(byClass(node, 'trace-step-3')[0]), /^3 What was chosenby: model A model decision was made; its content is sealed\. Published after arrival \(release at turn 16\)\.$/);
  assert.match(textOf(byClass(node, 'trace-step-4')[0]), /march.*sent.*The destination is sealed until the army has arrived\. Published after arrival \(release at turn 16\)\./);
  assert.doesNotMatch(en, /sawmill|barbarian camp|\(-1,2\)|shown, not cited/, 'nothing that is still sealed, and no word on what was shown');
  const ja = textOf(renderTrace(ctxOf('ja'), tr));
  assert.match(ja, /到着後に開示（ターン16で公開予定）。/);
  assert.match(ja, /モデルによる判断が行われました。内容は封印中です。/);
});

test('who acted: person, AI citizen, script bot and seat come from the roster; an unchecked script list or a missing row is said, never guessed', () => {
  const typeWith = (tag, ix = index) => full({ events: eventsOf(departEvent(tag)), index: ix }).triggers[0].actors.map(a => a.type);
  assert.deepEqual(typeWith(T.human), ['person']);
  assert.deepEqual(typeWith(T.ai0), ['ai'], 'the file\'s own kind/ai flags are ignored: the roster decides');
  assert.deepEqual(typeWith(T.s0), ['script']);
  assert.deepEqual(typeWith(T.seat), ['seat']);
  // the script list cannot be checked (120 bots, tags derived for none of them): not an AI, but not called a person
  const partial = makeRosterIndex(roster(), { scriptTags: [] });
  assert.deepEqual(typeWith(T.human, partial), ['unlisted']);
  assert.equal(actorType(partial, { wallet: W.human }), 'person', 'a wallet is checked against the roster\'s wallet lists directly');
  assert.equal(actorType(partial, { wallet: W.s0 }), 'script');
  assert.equal(actorType(index, {}), 'unknown');
  // nothing names the holder yet (the log has not been read that far): no actor, "being read", and the heading does not say "a person"
  const none = full({ events: [] });
  assert.deepEqual([none.triggers[0].actors, none.triggers[0].actorState, none.pending], [[], 'loading', true]);
  assert.equal(none.startedByPerson, false);
  const en = textOf(renderTrace(ctxOf('en'), none));
  assert.match(en, /What another participant did/);
  assert.match(en, /being read from the public log/);
  assert.doesNotMatch(en, /person \(player\)|not found/);
  // the host-id reader could not be loaded: said as not found, never guessed
  const off = full({ events: [], hostParts: false });
  assert.deepEqual([off.triggers[0].actorState, off.pending, off.scanTo], ['unknown', false, 0]);
  assert.match(textOf(renderTrace(ctxOf('en'), off)), /not found in the public log/);
  // a file that flags a person as an AI changes nothing; a file that flags an AI as nothing changes nothing
  const ai = textOf(renderTrace(ctxOf('en'), full({ events: eventsOf(departEvent(T.ai0)) })));
  assert.match(ai, /What another participant did/);
  assert.match(ai, /AI citizen, Gemma 4 local/);
  assert.doesNotMatch(ai, /person \(player\)/);
  const bot = textOf(renderTrace(ctxOf('ja'), full({ events: eventsOf(departEvent(T.s0)) })));
  assert.match(bot, /スクリプトボット/);
  assert.doesNotMatch(bot, /人（プレイヤー）|人間がしたこと/);
  assert.match(textOf(renderTrace(ctxOf('ja', partial), full({ index: partial }))), /AI名簿になし（スクリプトボットの一覧は未確認）/);
  // the event row itself has not been read from the herald: the facts come from the episode, the signature is "not read yet", nobody is named
  const unread = full({ herald: new Map() });
  assert.deepEqual([unread.triggers[0].troops, unread.triggers[0].from, unread.triggers[0].nation, unread.triggers[0].sig, unread.triggers[0].actors], [500, { p: 2, q: 0 }, 0, '', []]);
  assert.deepEqual(unread.wantSeqs, [1572]);
  assert.match(textOf(renderTrace(ctxOf('en'), unread)), /transaction signature: being read from the public log/);
});

test('result: transactions, the revealed destination, the public clash row and the AI\'s own later line; "no result yet" until a record exists', () => {
  const early = full();
  assert.deepEqual(early.result.marches.map(m => [m.p, m.q, m.tile, m.arrive, m.hostId, m.status]), [[-1, 2, 29, 15, HOST_AI, 'pending']]);
  const e1 = textOf(renderTrace(ctxOf('en'), early));
  assert.match(e1, /Destination: \(-1,2\) tile 29 · arrives at turn 15 \(planned 15\)/);
  assert.match(e1, /No result yet\./);
  assert.match(textOf(renderTrace(ctxOf('ja'), early)), /まだ結果は出ていません。/);

  const done = full({ episodes: episodes([SAWMILL, THREAT, WIN]), events: eventsOf(departEvent(T.human), clashEvent), herald: heraldOf(DEPART_ROW, CLASH_ROW), bellNow: 18 });
  const m = done.result.marches[0];
  assert.equal(m.status, 'recorded');
  assert.deepEqual(m.clashes.map(c => [c.at, c.bell, c.own.fate, c.own.after]), [[{ p: -1, q: 2 }, 15, 'Stays', 487]]);
  assert.deepEqual(m.lines.map(l => [l.kind, l.events.map(e => [e.seq, e.loaded])]), [['clash_own_win', [[2394, false], [2395, true]]]]);
  assert.deepEqual(done.wantSeqs, [2394]);
  const d1 = textOf(renderTrace(ctxOf('en'), done));
  assert.match(d1, /Clash at \(-1,2\), turn 15: 1 engagements\..*487 troops after the clash · stayed/);
  assert.match(d1, /At bell 15 your army at \(-1,2\) beat the camp: you lost 12, they lost 101\./);
  assert.match(d1, /public event 2395/);
  assert.doesNotMatch(d1, /No result yet/);

  // long after arrival and still no record: the page says what its files hold, never that no clash happened
  const late = full({ bellNow: 40 });
  assert.equal(late.result.marches[0].status, 'no_record');
  for (const lang of ['en', 'ja']) {
    const text = textOf(renderTrace(ctxOf(lang), late));
    assert.match(text, lang === 'en' ? /The public files this page reads hold no clash record for this march\./ : /このページが読む公開ファイルに、この進軍の衝突の記録はありません。/);
    assert.doesNotMatch(text, /no clash happened|There was no clash|衝突はありませんでした/);
  }
  // a model decision that sent no march
  const plain = normalizeMinds({ records: [sealed({ sealed: false, release_bell: null, commit: null, tx: [{ intent: 'train', sig: SIG_TX, status: 'sent' }], choice: { ids: ['c5'], params: { c5: { share: 50 } }, council: null, goal_id: 'G2', mem: [] }, retrieved: ['8d26a605fdc1acdd'], public: { say: [], why: 'I am training troops.', why_withheld: null } })] })[0];
  const p = buildTrace({ rec: plain, opened: null, minds: [plain], episodes: episodes(), herald: heraldOf(DEPART_ROW), events: eventsOf(departEvent(T.human)), index, bellNow: 13 });
  assert.deepEqual(p.memory.verdicts, [{ seq: 1572, status: 'shown_not_cited' }]);
  const pt = textOf(renderTrace(ctxOf('en'), p));
  assert.match(pt, /This decision sent no march\./);
  assert.match(pt, /The candidate list is not published for this record\./);
  assert.match(pt, /Chose: c5/);
});

test('which events are step 1: the AI\'s episodes of the wake\'s kind since its previous decision with that wake (at most 8 bells back)', () => {
  const t2 = { ...THREAT, id: 'aaaaaaaaaaaaaaa1', bell: 13, created_bell: 13, src: ['event:1823'] };
  const t3 = { ...THREAT, id: 'aaaaaaaaaaaaaaa2', bell: 1, created_bell: 1, src: ['event:90'] };
  const later = normalizeMinds({ records: [sealed({ id: 'cd'.repeat(32), bell: 14, sealed: false, release_bell: null, tx: [], choice: { ids: ['c1'], params: {}, council: null, goal_id: null, mem: [] }, retrieved: [], public: { say: [], why: 'x', why_withheld: null } })] })[0];
  const eps = episodes([SAWMILL, THREAT, t2, t3]);
  const first = buildTrace({ rec: rec0(), opened: null, minds: [rec0(), later], episodes: eps, index });
  assert.deepEqual(first.triggers.map(g => g.seq), [1572], 'bell 12: not the event of bell 13 (later), not the event of bell 1 (more than 8 bells back)');
  const second = buildTrace({ rec: later, opened: null, minds: [rec0(), later], episodes: eps, index });
  assert.deepEqual(second.triggers.map(g => g.seq), [1823], 'bell 14: only what came after the bell-12 decision');
  assert.deepEqual(second.window, { from: 13, to: 14 });
  // the order of the public log decides when it is known: an event logged after the bell-12 decision's own transaction
  // (event 1698 carries that transaction's signature) was not handed to it; it is listed under the next decision instead
  const t4 = { ...THREAT, id: 'aaaaaaaaaaaaaaa4', bell: 12, created_bell: 12, src: ['event:1700'] };
  const t5 = { ...THREAT, id: 'aaaaaaaaaaaaaaa5', bell: 12, created_bell: 12, src: ['event:1690'] };
  const eps2 = episodes([SAWMILL, THREAT, t2, t4, t5]);
  const own = heraldOf(DEPART_ROW, heraldRow(1698, 12, 'DEPART', { host_id: HOST_AI }, { arrive_bell: 15, dep_mass: 100000, depart_bell: 12, origin_p: -1, origin_q: 2 }, SIG_TX));
  assert.deepEqual(buildTrace({ rec: rec0(), opened: null, minds: [rec0(), later], episodes: eps2, herald: own, index }).triggers.map(g => g.seq), [1572, 1690]);
  assert.deepEqual(buildTrace({ rec: later, opened: null, minds: [rec0(), later], episodes: eps2, herald: own, index }).triggers.map(g => g.seq), [1700, 1823]);
  // while the log has not been read the looser rule stands (and the note on the page says what the list is)
  assert.deepEqual(buildTrace({ rec: rec0(), opened: null, minds: [rec0(), later], episodes: eps2, index }).triggers.map(g => g.seq), [1572, 1690, 1700]);
  // a decision with no threat or clash wake names no event
  const pulse = normalizeMinds({ records: [sealed({ wake: ['W-PULSE'] })] })[0];
  const none = buildTrace({ rec: pulse, opened: null, minds: [pulse], episodes: eps, index });
  assert.deepEqual(none.triggers, []);
  assert.match(textOf(renderTrace(ctxOf('en'), none)), /wake reason names no public event of another participant \(wake: W-PULSE\)/);
  // the episode list has not loaded: nothing is concluded
  const wait = buildTrace({ rec: rec0(), opened: op0(), minds: [rec0()], episodes: null, index });
  assert.deepEqual([wait.triggers, wait.memory.verdicts, wait.episodesLoaded], [[], [], false]);
  assert.match(textOf(renderTrace(ctxOf('en'), wait)), /The AI’s memory list has not loaded yet\./);
});

test('entry points: the button on model decisions with a threat or clash wake and on opened ones, the deep link by id prefix, the list of decisions after a person\'s action', () => {
  const quiet = normalizeMinds({ records: [sealed({ id: 'ef'.repeat(32), wake: ['W-PULSE'], sealed: false, release_bell: null, choice: { ids: ['c1'], params: {}, council: null, goal_id: null, mem: [] }, retrieved: [], public: { say: [], why: 'x', why_withheld: null } })] })[0];
  const openedMap = new Map([[ID, op0()]]);
  const got = [];
  const list = renderDecisions(ctxOf('ja'), decisionList({ minds: [rec0(), quiet], opened: openedMap }), { onTrace: id => got.push(id) });
  const buttons = byClass(list, 'btn-trace');
  assert.equal(buttons.length, 1, 'the W-THREAT model decision has the button; the W-PULSE one has none');
  assert.equal(textOf(buttons[0]), 'この判断を追う');
  buttons[0].click();
  assert.deepEqual(got, [ID]);
  // sealed and not opened: the button is there too (W-THREAT, by the model)
  assert.equal(byClass(renderDecisions(ctxOf('en'), decisionList({ minds: [rec0()] }), { onTrace: () => {} }), 'btn-trace').length, 1);
  // an opened decision without such a wake still gets it
  const pulseSealed = normalizeMinds({ records: [sealed({ wake: ['W-PULSE'] })] });
  assert.equal(byClass(renderDecisions(ctxOf('en'), decisionList({ minds: pulseSealed, opened: openedMap }), { onTrace: () => {} }), 'btn-trace').length, 1);
  assert.equal(byClass(renderDecisions(ctxOf('en'), decisionList({ minds: pulseSealed }), { onTrace: () => {} }), 'btn-trace').length, 0);

  const env = { minds: [rec0(), quiet], opened: openedMap, episodesByTag: new Map([[AI, episodes()]]), herald: heraldOf(DEPART_ROW), events: eventsOf(departEvent(T.human)), index, bellNow: 16 };
  assert.equal(findRecord(env, '7f6ba8d5e5').rec.id, ID);
  assert.equal(findRecord(env, 'zz'), null);
  assert.equal(findRecord(env, '7f6b'), null, 'too short to name one record');
  assert.equal(traceOf(env, '7f6ba8d5e5').id, ID);
  assert.equal(traceOf(env, '000000000000'), null);
  assert.deepEqual(startedByPeople(env).map(x => x.id), [ID]);
  assert.deepEqual(startedByPeople({ ...env, events: eventsOf(departEvent(T.s0)) }), [], 'a script bot\'s departure is not a person\'s action');
  assert.deepEqual(startedByPeople({ ...env, events: eventsOf(departEvent(T.ai0)) }), []);
  assert.deepEqual(traceNeeds({ ...env, herald: new Map(), episodesByTag: new Map() }, eventTraces({ ...env, herald: new Map(), episodesByTag: new Map() })), { tags: [AI], seqs: [], scanTo: 0 });
  assert.deepEqual(traceNeeds(env, eventTraces({ ...env, herald: new Map() })), { tags: [], seqs: [1572], scanTo: 0 });

  const opens = [];
  const panel = renderTracePanel(ctxOf('ja'), { started: startedByPeople(env), trace: traceOf(env, ID), traceId: ID, onOpen: id => opens.push(id), onClose: () => opens.push(null) });
  const text = textOf(panel);
  assert.match(text, /人の行動から始まった判断/);
  assert.match(text, /ターン11のアステル（人（プレイヤー））の行動のあと/);
  assert.match(text, /選んだ理由を示すものではありません/);
  for (const b of byClass(panel, 'btn-trace')) b.click();
  assert.deepEqual(opens, [ID, null]);
  assert.match(textOf(renderTracePanel(ctxOf('en'), { started: [], trace: null, traceId: 'abcdef123456' })), /None yet\..*The record of decision abcdef123456 has not loaded yet\./);
  assert.match(textOf(renderTracePanel(ctxOf('ja'), { started: [], pending: true })), /公開ログを読み込み中…/);
  assert.doesNotMatch(textOf(renderTracePanel(ctxOf('ja'), { started: [], pending: true })), /まだありません/, 'while the log is being read the list does not say "none"');
});

test('the herald\'s rows: seq, bell and signature; a DEPART in whole troops; hostile fields are dropped or stay text', () => {
  const EVIL = '<img src=x onerror=alert(1)>';
  const rows = normalizeHerald({ events: [DEPART_ROW, CLASH_ROW, heraldRow(7, 1, EVIL, { p: 1, q: 2 }, {}, EVIL), { seq: 'x' }, null, heraldRow(8, 2, 'CAMP', { p: -1, q: 2 }, { troops: 0 }, SIG_EV)] });
  assert.deepEqual(rows.map(r => [r.seq, r.name, r.sig.length > 0]), [[1572, 'DEPART', true], [2395, 'CLASH', true], [7, '', false], [8, 'CAMP', true]]);
  assert.deepEqual([rows[0].hostId, rows[0].troops, rows[0].from, rows[0].arrive, rows[0].depart], [HOST_P, 500, { p: 2, q: 0 }, 14, 11]);
  assert.deepEqual([rows[1].at, rows[1].clashBell, rows[1].engagements], [{ p: -1, q: 2 }, 15, 1]);
  const evil = full({
    opened: op0({ public: { say: [EVIL], why: EVIL, why_withheld: null }, choice: { ids: ['c3'], params: { c3: { [EVIL]: EVIL } }, council: null, goal_id: EVIL, mem: [] }, wake: [EVIL] }),
    rec: rec0({ tx: [{ intent: EVIL, sig: EVIL, status: EVIL }], wake: [EVIL, 'W-THREAT'] }),
    episodes: episodes([SAWMILL, { ...THREAT, kind: EVIL, text: { en: EVIL, ja: EVIL } }, { ...THREAT, id: 'bbbbbbbbbbbbbbbb' }]),
  });
  const node = renderTrace(ctxOf('en'), evil);
  assert.equal(hasActiveContent(node), null);
  assert.equal(byTag(node, 'img').length, 0);
  assert.deepEqual(evil.wake, ['W-THREAT'], 'a wake code that is not a code identifier is dropped');
  assert.equal(evil.result.tx[0].sig, '', 'a signature that is not base58 is not printed');
});

// ------------------------------------------------------------------ the browser's condition: an old event
const SIG_LOG = '5'.repeat(88); // rows of other transactions (not the decision's own)
const decOf = hex => BigInt(`0x${hex}`).toString();
const HP = hostParts(HOST_P); // the province, site and generation the person's host id carries (the real faddr.mjs)
const home = (seq, tag, parts = HP, name = 'HOME_PLACED') => heraldRow(seq, 0, name, { p: parts.p, q: parts.q, site: parts.site }, { citizen_tag: decOf(tag), gen: parts.gen, final_ts: '1' }, SIG_LOG);
const page = (...rows) => ({ v: 1, events: rows, next: String(rows.at(-1).seq) });

test('an old event: absent from events/latest.json, the event, its signature and the actor all come from the herald\'s log', () => {
  assert.deepEqual([HP.p, HP.q], [2, 0], 'the host id of the real run names province (2,0)');
  const log = makeLog();
  const env = () => ({ minds: [rec0()], opened: new Map([[ID, op0()]]), episodesByTag: new Map([[AI, episodes()]]), log, hostParts, events: [], index, bellNow: 40 });
  // 1 nothing read: the page asks for the event by number, and says "being read" (not "not found", not "none yet")
  let tr = traceOf(env(), ID);
  assert.deepEqual([tr.triggers[0].loaded, tr.triggers[0].actorState, tr.wantSeqs, tr.scanTo, tr.pending], [false, 'loading', [1572], 0, true]);
  assert.match(textOf(renderTrace(ctxOf('ja'), tr)), /トランザクション署名：公開ログから読み込み中/);
  // 2 /h/events?after=1571 answered: the row and its signature are there; the actor needs the log from its start up to event 1572
  ingestLog(log, page(DEPART_ROW), 1571);
  tr = traceOf(env(), ID);
  assert.deepEqual([tr.triggers[0].loaded, tr.triggers[0].sig, tr.triggers[0].actorState, tr.wantSeqs, tr.scanTo, log.scanned], [true, SIG_EV, 'loading', [], 1572, 0]);
  assert.deepEqual(traceNeeds(env(), eventTraces(env())), { tags: [], seqs: [], scanTo: 1572 });
  let ja = textOf(renderTrace(ctxOf('ja'), tr));
  assert.match(ja, /他の参加者がしたこと/);
  assert.match(ja, /公開ログから読み込み中/);
  assert.doesNotMatch(ja, /人（プレイヤー）|確認できませんでした/);
  assert.equal(startedByPeople(env()).length, 0);
  assert.equal(eventTraces(env()).some(x => x.pending), true);
  // 3 the first page of the log names the holder of that village site: a tag that is in no list of the roster
  ingestLog(log, page(home(169, T.ai0, { ...HP, site: (HP.site + 1) % 12 }), home(171, T.human)), 0);
  assert.equal(log.scanned, 171);
  assert.deepEqual(hostOwner(log, hostParts, HOST_P, 1572), { state: 'known', tag: T.human });
  tr = traceOf(env(), ID);
  assert.deepEqual([tr.triggers[0].actors.map(a => [a.tag, a.type, a.faction]), tr.triggers[0].actorState, tr.triggers[0].nation, tr.startedByPerson, tr.scanTo, tr.pending], [[[T.human, 'person', 0]], 'known', 0, true, 0, false]);
  ja = textOf(renderTrace(ctxOf('ja'), tr));
  assert.match(ja, /人間がしたこと/);
  assert.match(ja, /国 アステル · .*人（プレイヤー）.*が兵500の軍を\(2,0\)から出した。到着はターン14。/);
  assert.ok(ja.includes(SIG_EV));
  assert.deepEqual(startedByPeople(env()).map(x => x.id), [ID], 'the list at the top works for the old event too');
  assert.match(textOf(renderTracePanel(ctxOf('ja'), { started: startedByPeople(env()) })), /ターン11のアステル（人（プレイヤー））の行動のあと/);
});

test('the holder of a host: by site and generation, only rows before the event; AI, script bot and seat by the roster; read to the event and nobody named = not found', () => {
  const upTo = (...rows) => { const log = makeLog(); ingestLog(log, page(...rows, heraldRow(1571, 11, 'SKIP', {}, {}, SIG_LOG)), 0); ingestLog(log, page(DEPART_ROW), 1571); return log; };
  const typeOf = (log, ix = index) => { const g = buildTrace({ rec: rec0(), opened: op0(), minds: [rec0()], episodes: episodes(), log, hostParts, events: [], index: ix }).triggers[0]; return [g.actorState, ...g.actors.map(a => a.type)]; };
  assert.deepEqual(typeOf(upTo(home(5, T.human))), ['known', 'person']);
  assert.deepEqual(typeOf(upTo(home(5, T.ai0))), ['known', 'ai']);
  assert.deepEqual(typeOf(upTo(home(5, T.s1))), ['known', 'script']);
  assert.deepEqual(typeOf(upTo(home(5, T.seat))), ['known', 'seat']);
  assert.deepEqual(typeOf(upTo(home(5, T.human)), makeRosterIndex(roster(), { scriptTags: [] })), ['known', 'unlisted'], 'the script list could not be checked: not said to be a person');
  assert.deepEqual(typeOf(upTo(home(5, T.human, { ...HP, gen: HP.gen + 1 }))), ['unknown'], 'another generation of the site is another holder');
  assert.deepEqual(typeOf(upTo(home(5, T.ai0, HP, 'OUTPOST_SETTLED'))), ['known', 'ai']);
  assert.deepEqual(typeOf(upTo(heraldRow(5, 0, 'SETTLE', { p: HP.p, q: HP.q, site: HP.site }, { citizen_tag: decOf(T.human), gen: HP.gen, outcome: 2 }, SIG_LOG))), ['unknown'], 'a SETTLE that was taken or expired names no holder');
  assert.deepEqual(typeOf(upTo(heraldRow(5, 0, 'CAPTURE_SETTLED', { p: HP.p, q: HP.q, site: HP.site }, { captor_tag: decOf(T.s0), victim_tag: decOf(T.human), new_gen: HP.gen }, SIG_LOG))), ['known', 'script']);
  assert.deepEqual(typeOf(upTo()), ['unknown']);
  // a holder named AFTER the event does not count
  const late = upTo(); ingestLog(late, page(home(1600, T.human)), 1572);
  assert.deepEqual(typeOf(late), ['unknown']);
  const en = textOf(renderTrace(ctxOf('en'), buildTrace({ rec: rec0(), opened: op0(), minds: [rec0()], episodes: episodes(), log: upTo(), hostParts, events: [], index })));
  assert.match(en, /What another participant did/);
  assert.match(en, /not found in the public log/);
  assert.doesNotMatch(en, /person \(player\)/);
  // a hostile citizen tag is not a tag
  assert.equal(normalizeHerald(page(heraldRow(5, 0, 'HOME_PLACED', { p: 2, q: 0, site: 1 }, { citizen_tag: '<img>', gen: 1 }, SIG_LOG)))[0].own.tag, null);
});

test('a clash wake: the armies that arrived there are the REVEAL rows of that place and turn, their holders typed by the roster', () => {
  const HA = hostParts(HOST_AI);
  const clashEp = { ...WIN, created_bell: 17 };
  const rec = normalizeMinds({ records: [sealed({ id: 'cc'.repeat(32), bell: 18, wake: ['W-CLASH'], sealed: false, release_bell: null, tx: [], choice: { ids: ['c1'], params: {}, council: null, goal_id: null, mem: [] }, retrieved: [], public: { say: [], why: 'x', why_withheld: null } })] })[0];
  const log = makeLog();
  ingestLog(log, page(home(171, T.human), home(247, AI, HA),
    heraldRow(2059, 15, 'REVEAL', { arrive: 15, faction: 0, i: 0, p: -1, q: 2 }, { host_id: HOST_P, tile: 10 }, SIG_EV),
    heraldRow(2124, 15, 'REVEAL', { arrive: 15, faction: 1, i: 0, p: -1, q: 2 }, { host_id: HOST_AI, tile: 29 }, SIG_TX),
    heraldRow(2394, 17, 'CAMP', { p: -1, q: 2 }, { troops: 0 }, SIG_LOG), CLASH_ROW), 0);
  const tr = buildTrace({ rec, opened: null, minds: [rec], episodes: episodes([clashEp]), log, hostParts, events: [], index, bellNow: 18 });
  assert.deepEqual(tr.triggers.map(g => [g.seq, g.kind, g.actorState, g.actors.map(a => a.type)]), [[2394, 'other', 'unknown', []], [2395, 'clash', 'known', ['person', 'ai']]]);
  assert.equal(tr.startedByPerson, true);
  const en = textOf(renderTrace(ctxOf('en'), tr));
  assert.match(en, /Clash at \(-1,2\), turn 15: 1 engagements\./);
  assert.match(en, /person \(player\)/);
  assert.match(en, /Public event of kind CAMP\./);
});

test('candidates: id, label, the chosen mark and the "see Mn" line are shown; every fact stays, inside a closed "details" (詳細)', () => {
  for (const [lang, word] of [['en', 'details'], ['ja', '詳細']]) {
    const node = renderTrace(ctxOf(lang), full());
    const cands = byClass(node, 'cand');
    assert.equal(cands.length, 2);
    const c3 = cands.find(c => textOf(c).startsWith('c3'));
    const box = byClass(c3, 'cand-facts')[0];
    assert.equal(box.tagName, 'DETAILS');
    assert.equal(box.hasAttribute('open'), false, 'closed by default');
    assert.equal(textOf(byTag(box, 'summary')[0]), word);
    assert.equal(textOf(byClass(box, 'facts')[0]), 'enemy_troops: 101target_kind: camptroops: 100', 'no fact is dropped');
    assert.equal(byClass(c3, 'facts')[0].parentNode, box, 'the facts are nowhere outside the details');
    const visible = textOf(c3).replace(textOf(box), '');
    assert.match(visible, lang === 'en' ? /^c3 March H1 \(100 troops\) to a barbarian camp, 2 hexes away; earliest arrival at bell 15chosensee memory M1$/ : /^c3 March H1 .*選択記憶 M1 を参照$/);
  }
  // the decisions list uses the same candidate list
  const list = renderDecisions(ctxOf('en'), decisionList({ minds: [rec0()], opened: new Map([[ID, op0()]]) }));
  assert.equal(byClass(list, 'cand-facts').length, 2);
  assert.equal(byClass(list, 'facts').every(f => f.parentNode.tagName === 'DETAILS'), true);
});
