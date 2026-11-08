// Workstream 07, brief item 1 (and claim 3): what happened while the viewer
// was away, from the season's records and from nothing else.
//
// Today (hud/feed.mjs diffFeed): a page's first snapshot "is not news", so a
// player who opens the page sees no notification of anything that happened
// before; the chronicle starts CHRONICLE_WINDOW (500) events behind the
// head and keeps 400 (controller.mjs), and diffFeed knows no S1 record — a
// caravan raided or lost, a storehouse or a structure seized, a siege
// declared on the viewer's village, a nation's vote decided. The herald
// keeps every event (/h/events?after=, frontier-node herald server.rs over
// the findex index), and the page decodes every S1 kind (flog.mjs with the
// v2 log table), so the summary needs no new record and no new instruction.
//
// Two marks are kept apart:
//   fetched    the events this page has read (seq range, turns), told as
//              such ("records read up to turn N")
//   confirmed  the last event the player said they have seen, by pressing
//              "確認した"; only that moves the next summary's start
// and the summary says which case it is in: the first time on this device
// for this season and wallet (which is also what another device or a
// cleared browser looks like: the page cannot tell them apart and says so),
// another wallet on this device, a new season, or a gap — events between
// the confirmed mark and the first one read that the page did not get —
// which it names as a gap and never fills in.
//
// A loss is told only from the record that logged it, with the amounts the
// record carries; nothing is estimated.
import { RESOURCES, factionName } from '../../../permutation-server/web/frontier/fi18n.mjs';
import { TRANSIT_OUTCOMES } from '../../../permutation-server/web/frontier/flog.mjs';

const RESOURCE_KEYS = ['Food', 'Wood', 'Stone', 'Ore', 'Horses', 'Gold', 'Science', 'Influence'];

export const STORE_VERSION = 1;
/** nation.rs proposal kinds: 1 a stance, 2 an expulsion, 3 a readmission (screens/s1.mjs PROPOSE_*). */
export const PROPOSAL_KIND = Object.freeze({ 1: 'stance', 2: 'expel', 3: 'readmit' });
/** How many turns back a first summary on a device looks (the page cannot know the player's last visit). */
export const FIRST_LOOK_BELLS = 144;
/** Most items the summary lists before "and N more in the chronicle". */
export const SUMMARY_MAX = 6;

const big = v => { try { return BigInt(v ?? 0); } catch { return null; } };
const same = (a, b) => a !== null && b !== null && a !== undefined && b !== undefined && big(a) === big(b);

/** The cargo of a record (`[u8; 32]`: eight u32 whole units, caravan.rs cargo_log) as numbers. */
export function cargoOf(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length !== 32) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, 32);
  return Array.from({ length: 8 }, (_, i) => v.getUint32(i * 4, true));
}
/** The resource names follow the page's language (fi18n RESOURCES; on S1 the Horses slot reads as arms). */
const cargoWords = (c, lang = 'ja') => (c ? c.map((n, i) => (n > 0 ? `${RESOURCES[RESOURCE_KEYS[i]] ?? `#${i}`} ${n.toLocaleString(lang === 'en' ? 'en' : 'ja')}` : null)).filter(Boolean).join(lang === 'en' ? ', ' : '・') : '');

/** The device's key for a season and a wallet. */
export const storeKey = (seasonId, wallet) => `ws07-return:${seasonId}:${wallet}`;

/** Read the stored marks (`{v, seasonId, wallet, confirmedSeq, confirmedBell, confirmedAt}`), null when none or unreadable. */
export function loadMarks(storage, seasonId, wallet) {
  try {
    const raw = storage?.getItem?.(storeKey(seasonId, wallet));
    const m = raw ? JSON.parse(raw) : null;
    return m && m.v === STORE_VERSION && String(m.seasonId) === String(seasonId) && m.wallet === wallet ? m : null;
  } catch { return null; }
}
/** What this device last used: `{seasonId, wallet}` or null (to tell "another wallet" and "a new season"). */
export function loadLast(storage) {
  try { const m = JSON.parse(storage?.getItem?.('ws07-return:last') ?? 'null'); return m && m.seasonId !== undefined ? m : null; } catch { return null; }
}
/** The player pressed "確認した": the summary's end becomes the next one's start. Returns the marks written, or null when storage refused. */
export function confirm(storage, { seasonId, wallet, toSeq, toBell, at }) {
  const m = { v: STORE_VERSION, seasonId: String(seasonId), wallet, confirmedSeq: String(toSeq), confirmedBell: toBell, confirmedAt: at };
  try {
    storage.setItem(storeKey(seasonId, wallet), JSON.stringify(m));
    storage.setItem('ws07-return:last', JSON.stringify({ seasonId: String(seasonId), wallet }));
    return m;
  } catch { return null; }
}

/**
 * One record as a summary item, or null when it is not the viewer's news.
 * `me`: `{tag (citizen tag), faction, holdings: [{p, q, site}], hostOf(id) →
 * holding or null}`. Items: `{seq, bell, kind, tone ('loss' | 'threat' |
 * 'gain' | 'nation' | 'result'), rank (3 most pressing), facts, at: {p, q,
 * tile?}}`.
 */
export function itemOf({ seq, record: r }, me, holders = null) {
  // (a caravan's records keep the SENDER's tag after a take — caravan.rs: OWNER_TAG "stays the address seed" — so who
  // holds it now comes from the takes read before this record; `holders` is summarize's map, else the sender)
  const key = r.owner_tag !== undefined && r.seq !== undefined ? `${r.owner_tag}:${r.seq}` : null;
  const held = key && holders?.has(key) ? holders.get(key) : r.owner_tag;
  const mineHolding = (p, q, site) => (me.holdings ?? []).some(h => h.p === p && h.q === q && (site === undefined || h.site === site));
  const base = { seq: String(seq), bell: Number(r.bell ?? r.logBell), kind: r.name };
  switch (r.name) {
    case 'CARAVAN_RAIDED':
      // (the raider first: a sender who takes back a caravan taken from it gained, it did not lose)
      if (same(r.raider_tag, me.tag)) return { ...base, tone: 'gain', rank: 1, at: { p: r.p, q: r.q }, facts: { choice: r.choice === 1 ? 'burn' : 'take', byDefault: r.by === 1, cargo: cargoOf(r.taken) } };
      if (same(held, me.tag)) return { ...base, tone: 'loss', rank: 3, at: { p: r.p, q: r.q }, facts: { choice: r.choice === 1 ? 'burn' : 'take', byDefault: r.by === 1, cargo: cargoOf(r.taken), seq: r.seq } };
      return null;
    case 'RAID_OPENED':
      // (the raid is decided within RAID_DECIDE_BELLS by the raider, else by default: the outcome is CARAVAN_RAIDED's)
      return same(held, me.tag) ? { ...base, tone: 'threat', rank: 2, at: { p: r.p, q: r.q }, facts: { seq: r.seq } } : null;
    case 'CARAVAN_SETTLED':
      // (a burned caravan still walks on, empty, and is logged as delivered: nothing arrived for anyone)
      if (!same(held, me.tag)) return null;
      return r.outcome === 1 ? { ...base, tone: 'loss', rank: 3, facts: { lost: true, cargo: cargoOf(r.cargo), seq: r.seq } } : { ...base, tone: 'result', rank: 1, facts: { delivered: true, cargo: cargoOf(r.cargo), seq: r.seq } };
    case 'VAULT_SEIZED':
    case 'STRUCTURE_SEIZED':
      if (same(r.prev_tag, me.tag)) return { ...base, tone: 'loss', rank: 3, at: { p: r.p, q: r.q, tile: r.tile }, facts: { what: r.name === 'VAULT_SEIZED' ? 'vault' : (['', 'tower', 'palisade', 'fort'][r.kind] ?? 'structure') } };
      if (same(r.captor_tag, me.tag)) return { ...base, tone: 'gain', rank: 1, at: { p: r.p, q: r.q, tile: r.tile }, facts: { what: r.name === 'VAULT_SEIZED' ? 'vault' : (['', 'tower', 'palisade', 'fort'][r.kind] ?? 'structure') } };
      return null;
    case 'SIEGE_DECLARED':
      return same(r.owner_tag, me.tag) ? { ...base, tone: 'threat', rank: 3, at: { p: r.p, q: r.q }, facts: { attacker: r.attacker, required: r.required } } : null;
    case 'CAPTURE_SETTLED':
      if (same(r.victim_tag, me.tag)) return { ...base, tone: 'loss', rank: 3, at: { p: r.p, q: r.q }, facts: { village: true } };
      if (same(r.captor_tag, me.tag)) return { ...base, tone: 'gain', rank: 2, at: { p: r.p, q: r.q }, facts: { village: true } };
      return null;
    case 'NATION_DECIDED':
      if (r.faction !== me.faction) return null;
      return { ...base, tone: 'nation', rank: same(r.target_tag, me.tag) ? 3 : 2, facts: { passed: r.passed === 1, proposal: PROPOSAL_KIND[r.kind] ?? 'other', target: r.target_faction, value: r.value, aboutMe: same(r.target_tag, me.tag), yes: r.yes, no: r.no } };
    case 'NATION_PROPOSED':
      if (r.faction !== me.faction) return null;
      return { ...base, tone: 'nation', rank: same(r.target_tag, me.tag) ? 3 : 1, facts: { open: true, proposal: PROPOSAL_KIND[r.kind] ?? 'other', target: r.target_faction, value: r.value, closeBell: r.close_bell, aboutMe: same(r.target_tag, me.tag) } };
    case 'TRANSIT_SETTLED': {
      const h = me.hostOf?.(r.host_id);
      if (!h) return null;
      // (frontier-abi log transit_outcome: 1 Stays … 8 BadSeal, as screens/chronicle.mjs reads them)
      const outcome = TRANSIT_OUTCOMES[Number(r.outcome) - 1] ?? 'Other';
      const bad = outcome === 'Destroyed' || outcome === 'BadSeal' || outcome === 'Routed';
      return { ...base, tone: bad ? 'loss' : 'result', rank: bad ? 3 : 1, facts: { outcome, troops: Math.floor(Number(r.troops ?? 0) / 1000) } };
    }
    case 'CLASH':
      return mineHolding(r.p, r.q) && Number(r.engagements ?? 0) > 0 ? { ...base, tone: 'threat', rank: 2, at: { p: r.p, q: r.q }, facts: { engagements: Number(r.engagements) }, battle: { p: r.p, q: r.q, bell: Number(r.bell) } } : null;
    default:
      return null;
  }
}

/**
 * The summary. `records`: the decoded events read, oldest first (`[{seq,
 * record}]`, flog.mjs decodePage). `read`: `{fromSeq, toSeq, complete}` —
 * the range the page asked for and whether it reached the head. `marks`:
 * loadMarks(); `last`: loadLast(); `season`, `wallet`, `nowBell`.
 * → `{mode, since: {seq, bell} | null, read: {fromSeq, toSeq, fromBell,
 * toBell, n}, gap: {afterSeq, beforeSeq} | null, incomplete, items (most
 * pressing first, at most SUMMARY_MAX), more, counts: {tone: n}}`.
 */
export function summarize({ records, read, marks, last, season, wallet, nowBell, me }) {
  const mode = marks ? 'sinceConfirmed'
    : last && String(last.seasonId) !== String(season) ? 'newSeason'
    : last && last.wallet !== wallet ? 'otherWallet'
    : 'firstOnDevice';
  const since = marks ? { seq: String(marks.confirmedSeq), bell: marks.confirmedBell } : null;
  const after = since ? big(since.seq) : null;
  const firstBell = since ? null : Math.max(0, Number(nowBell ?? 0) - FIRST_LOOK_BELLS);
  const inRange = records.filter(x => (after !== null ? big(x.seq) > after : Number(x.record.bell ?? x.record.logBell) >= firstBell));
  // (a gap: the page read from a cursor later than the confirmed mark, so the events in between were not read)
  const from = read?.after !== undefined && read?.after !== null ? big(read.after) : records.length ? big(records[0].seq) - 1n : null;
  const gap = after !== null && from !== null && from > after ? { afterSeq: String(after), beforeSeq: String(from + 1n) } : null;
  // who holds each caravan, record by record: a take moves it to the raider, a burn leaves nothing to deliver. A take
  // before the records read is not known: such a caravan is taken to be its sender's (REPORT §7)
  const holders = new Map(), items = [], want = new Set(inRange);
  for (const x of records) {
    const r = x.record;
    const it = want.has(x) ? itemOf(x, me, holders) : null;
    if (it) items.push(it);
    if (r?.name === 'CARAVAN_RAIDED') holders.set(`${r.owner_tag}:${r.seq}`, r.choice === 1 ? null : r.raider_tag);
  }
  const counts = {};
  for (const i of items) counts[i.tone] = (counts[i.tone] ?? 0) + 1;
  const sorted = [...items].sort((a, b) => b.rank - a.rank || b.bell - a.bell || (big(b.seq) > big(a.seq) ? 1 : -1));
  const bells = inRange.map(x => Number(x.record.bell ?? x.record.logBell)).filter(Number.isFinite);
  return {
    mode, since, firstBell,
    read: { after: from === null ? null : String(from), toSeq: records.at(-1)?.seq ?? null, fromBell: bells.length ? Math.min(...bells) : null, toBell: bells.length ? Math.max(...bells) : null, n: inRange.length },
    gap, incomplete: read?.complete === false,
    items: sorted.slice(0, SUMMARY_MAX), more: Math.max(0, sorted.length - SUMMARY_MAX), counts,
  };
}

// ------------------------------------------------------------------ words (ja is the source; en for the prototype)
/** A nation's name in the page's language (fi18n factionName). */
const nation = f => (Number.isInteger(f) && f >= 0 && f <= 6 ? factionName(f) : '');
const STANCE_J = ['戦争', '通行', '同盟'], STANCE_E = ['war', 'passage', 'alliance'];
const WHAT_J = { vault: '貯蔵庫', tower: '物見櫓', palisade: '柵', fort: '要塞', structure: '建物' };
const WHAT_E = { vault: 'storehouse', tower: 'watchtower', palisade: 'palisade', fort: 'fort', structure: 'structure' };

/** One item as a sentence. */
export function itemText(i, lang = 'ja') {
  const ja = lang !== 'en', f = i.facts, n = x => Number(x).toLocaleString(ja ? 'ja' : 'en');
  const cargo = f.cargo ? cargoWords(f.cargo, lang) : '';
  switch (i.kind) {
    case 'CARAVAN_RAIDED':
      if (i.tone === 'loss') return ja ? `隊商が略奪されました（ターン ${n(i.bell)}）。${f.choice === 'burn' ? '積荷は焼かれました' : '積荷ごと奪われました'}${cargo ? `：${cargo}` : ''}${f.byDefault ? '（相手が決めず、期限で決着）' : ''}`
        : `Your caravan was raided (turn ${n(i.bell)}). ${f.choice === 'burn' ? 'Its cargo was burned' : 'It was taken with its cargo'}${cargo ? `: ${cargo}` : ''}${f.byDefault ? ' (decided by default)' : ''}`;
      return ja ? `あなたの軍勢が隊商を${f.choice === 'burn' ? '焼きました' : '奪いました'}${cargo ? `：${cargo}` : ''}` : `Your host ${f.choice === 'burn' ? 'burned' : 'took'} a caravan${cargo ? `: ${cargo}` : ''}`;
    case 'RAID_OPENED': return ja ? `隊商が襲われ、相手が奪うか焼くかを決めるところです（ターン ${n(i.bell)}）` : `Your caravan was caught; the raider is deciding whether to take or burn it (turn ${n(i.bell)})`;
    case 'CARAVAN_SETTLED': return f.lost ? (ja ? `隊商の行き先がなくなり、積荷が失われました${cargo ? `：${cargo}` : ''}` : `Your caravan's destination was gone; the cargo was lost${cargo ? `: ${cargo}` : ''}`) : (ja ? `隊商が着きました${cargo ? `：${cargo}` : ''}` : `Your caravan arrived${cargo ? `: ${cargo}` : ''}`);
    case 'VAULT_SEIZED': case 'STRUCTURE_SEIZED':
      return i.tone === 'loss' ? (ja ? `${WHAT_J[f.what]}を奪われました（ターン ${n(i.bell)}）` : `Your ${WHAT_E[f.what]} was seized (turn ${n(i.bell)})`) : (ja ? `${WHAT_J[f.what]}を奪いました` : `You seized a ${WHAT_E[f.what]}`);
    case 'SIEGE_DECLARED': return ja ? `${nation(f.attacker) || '他国'}があなたの村の包囲を宣言しました（ターン ${n(i.bell)}）。陥落には、包囲側がマスを保つターンが ${n(f.required)} 要ります（夜番の時間と、守り手がいるターンは数えません）` : `${nation(f.attacker) || 'Another nation'} declared a siege of your village (turn ${n(i.bell)}). It falls after ${n(f.required)} turns in which the besiegers hold the hex (turns in your vigil, or with a defender there, do not count)`;
    case 'CAPTURE_SETTLED': return i.tone === 'loss' ? (ja ? `村を奪われました（ターン ${n(i.bell)}）` : `Your village was captured (turn ${n(i.bell)})`) : (ja ? `村を奪いました` : `You captured a village`);
    case 'NATION_DECIDED': {
      const what = f.proposal === 'stance' ? (ja ? `${nation(f.target)}への方針を「${STANCE_J[f.value] ?? ''}」に` : `the stance toward ${nation(f.target)} as ${STANCE_E[f.value] ?? ''}`) : f.proposal === 'expel' ? (ja ? (f.aboutMe ? 'あなたの村の追放' : '村の追放') : (f.aboutMe ? 'expelling your village' : 'expelling a village')) : (ja ? '村を国に戻すこと' : 'readmitting a village');
      return ja ? `国の議題が${f.passed ? '可決' : '否決'}されました：${what}（賛成 ${n(f.yes)}・反対 ${n(f.no)}）` : `Your nation ${f.passed ? 'passed' : 'rejected'} ${what} (${n(f.yes)} for, ${n(f.no)} against)`;
    }
    case 'NATION_PROPOSED': { const about = f.aboutMe ? (f.proposal === 'readmit' ? (ja ? '：あなたの村を国に戻すこと' : ': readmitting your village') : (ja ? '：あなたの村の追放' : ': expelling your village')) : ''; return ja ? `国の議題が出ています（ターン ${n(f.closeBell)} まで）${about}` : `A vote is open in your nation (until turn ${n(f.closeBell)})${about}`; }
    case 'TRANSIT_SETTLED': return ja ? `進軍の結果：${({ Stays: '着いた場所に残りました', Withdrew: '退きました', Bounced: '押し戻されました', Retreated: '退却しました', Destroyed: '全滅しました', BouncedUnranked: '押し戻されました', Routed: '敗走しました（体力 0 で戻ります）', BadSeal: '封が正しくなく失われました' })[f.outcome] ?? f.outcome}（残る兵 ${n(f.troops)}）` : `March result: ${f.outcome} (${n(f.troops)} left)`;
    case 'CLASH': return ja ? `あなたの村のある州で戦いがありました（ターン ${n(i.bell)}）` : `A battle in a province of your village (turn ${n(i.bell)})`;
    default: return i.kind;
  }
}

/** The summary's head line: what it covers and what it cannot. */
export function headText(s, lang = 'ja') {
  const ja = lang !== 'en', n = x => Number(x).toLocaleString(ja ? 'ja' : 'en');
  const range = s.read.n ? (ja ? `第${n(s.read.fromBell)}〜${n(s.read.toBell)}ターンの記録 ${n(s.read.n)} 件を読み込みました` : `Read ${n(s.read.n)} records, turns ${n(s.read.fromBell)}–${n(s.read.toBell)}`) : (ja ? '新しい記録はありません' : 'No new records');
  const mode = {
    sinceConfirmed: ja ? `あなたが確認したのは第${n(s.since?.bell ?? 0)}ターンまでです。` : `You confirmed up to turn ${n(s.since?.bell ?? 0)}.`,
    firstOnDevice: ja ? `この端末では、このシーズンとウォレットで確認した記録がありません（初めてか、別の端末か、ブラウザの記録が消えた場合）。直近 ${n(FIRST_LOOK_BELLS)} ターンだけを見ています。` : `This device has no confirmed mark for this season and wallet (first visit, another device, or cleared data). Showing the last ${n(FIRST_LOOK_BELLS)} turns only.`,
    otherWallet: ja ? `この端末で前に使ったウォレットとは別です。そのウォレットの記録は使いません。直近 ${n(FIRST_LOOK_BELLS)} ターンだけを見ています。` : `This is not the wallet last used on this device; its marks are not used. Showing the last ${n(FIRST_LOOK_BELLS)} turns only.`,
    newSeason: ja ? `新しいシーズンです。前のシーズンの出来事は含みません。` : `A new season. Nothing from the earlier season is included.`,
  }[s.mode];
  const gap = s.gap ? (ja ? ' その間の記録の一部を読み込めていません。欠けた分の出来事は推測しません。' : ' Some records in between could not be read; nothing is guessed for them.') : '';
  const more = s.incomplete ? (ja ? ' まだ読み込み中の記録があります。' : ' More records are still loading.') : '';
  return `${mode}${range}。${gap}${more}`.replace('。。', '。');
}
