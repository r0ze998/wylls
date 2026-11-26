// The world's goals in a continuous world (docs/design/win-conditions/01-proposal.ja.md, PR #191 rev 2; owner r0ze
// 2026-11-24 accepted every recommendation): four permanent goals without a deadline. FIRST SLICE: only the flag keeps
// are judged (off chain, in a local-play world: permutation-gateway/src/frontier/local-play-world-goals.mjs); the other
// three are shown as coming. No money moves: after an achievement the card says what the prize WOULD have paid, from
// a simulated vault.
//
// This page only READS the judge's answer (`<base>/goals/state`) and shows it: the posting (which keeps carry the
// flag, the need, the hold time), every nation's progress, the viewer's nation's timer, and the achievements with the
// would-have-won breakdown. The flag keeps are also handed to the map (map/keeps.mjs `setGoalFlags`) for their marks.
// A server without the judge answers 404: then nothing is drawn and the path is not asked again until a reload.
import { html } from '../../util.mjs';
import { L, fmtNum } from '../../lang.mjs';
import { factionName } from '../fi18n.mjs';
import { fogActive, fogNow, viewKeeps } from '../map/fog.mjs';
import { termsRate, turnsLine } from '../seasonterms.mjs';
import { said } from './words.mjs';

/** Minutes of the chain's clock in one turn. */
const TURN_MIN = 10;
const nation = f => Number.isInteger(f) && f >= 0 && f < 6;
const int = x => Number.isSafeInteger(x);
const intOrNull = x => x === null || Number.isSafeInteger(x);
/** A loopback host name (the local-play world's proxy): localhost or 127.x.y.z. */
const isLoopbackHost = h => typeof h === 'string' && (h === 'localhost' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h));

/** The launcher-origin base of the goals judge of the world behind `herald` (a loopback proxy origin), or null. */
export function localGoalsBase(herald) {
  let u;
  try { u = new URL(String(herald)); } catch { return null; }
  if (u.protocol !== 'http:' || !isLoopbackHost(u.hostname) || !/^\d{5}$/.test(u.port) || (u.pathname !== '/' && u.pathname !== '') || u.search || u.hash || u.username || u.password) return null;
  return `/goals-world/${u.port}`;
}

const goodFlag = f => f && int(f.p) && int(f.q) && nation(f.nation) && (f.holder === null || nation(f.holder) || int(f.holder)) && intOrNull(f.since) && intOrNull(f.longAt);
// (flag-keeps-v2: `captured` — the flag keeps a nation took from others, the only ones that count — and `capturedLong`)
const goodProgress = x => x && nation(x.nation) && int(x.held) && int(x.captured) && int(x.capturedLong) && int(x.need) && intOrNull(x.reachAt);
const goodRow = r => r && typeof r.wallet === 'string' && nation(r.nation) && int(r.points) && typeof r.eligible === 'boolean' && /^\d+$/.test(String(r.amount));
const goodAchievement = a => a && int(a.round) && int(a.bell) && Array.isArray(a.nations) && a.nations.every(nation) && a.prize && a.prize.simulated === true && Array.isArray(a.prize.rows) && a.prize.rows.every(goodRow)
  && ['vaultBefore', 'payout', 'paid', 'returned'].every(k => /^\d+$/.test(String(a.prize[k])));

/** Whether an answer is the judge's: its kind, no effect on money or the chain, and well-formed parts. */
export function goodAnswer(j) {
  return !!j && j.ok === true && j.v === 1 && j.kind === 'world-goals' && j.ruleset === 'flag-keeps-v2' && j.effects?.money === 'none' && j.effects?.chain === 'none'
    && j.season && typeof j.season.seasonId === 'string' && Array.isArray(j.goals) && intOrNull(j.bell)
    && (j.flagKeeps === null || (int(j.flagKeeps.round) && int(j.flagKeeps.need) && int(j.flagKeeps.holdBells) && Array.isArray(j.flagKeeps.flags) && j.flagKeeps.flags.every(goodFlag) && Array.isArray(j.flagKeeps.progress) && j.flagKeeps.progress.every(goodProgress)))
    && Array.isArray(j.achievements) && j.achievements.every(goodAchievement);
}

/** Read the judge: `{read: 'ok', goals}` | `{read: 'absent'}` | `{read: 'unread', code}`. */
export async function probeGoals({ fetch: f = (...a) => globalThis.fetch(...a), base = '' } = {}) {
  let r;
  try { r = await f(`${base}/goals/state`, { cache: 'no-store' }); } catch { return { read: 'unread', code: 'network' }; }
  if (r.status === 404 || r.status === 204) { try { await r.arrayBuffer?.(); } catch { /* nothing to read */ } return { read: 'absent' }; }
  let j = null;
  try { j = await r.json(); } catch { j = null; }
  if (!r.ok) return { read: 'unread', code: `HTTP${r.status}` };
  return goodAnswer(j) ? { read: 'ok', goals: j } : { read: 'unread', code: 'BadGoals' };
}

/** Whether an answer is of the world this page shows (its Season, and its program when both name one). */
export function sameWorld(FS, g) {
  const season = FS?.season?.seasonId;
  if (season === undefined || season === null || String(g?.season?.seasonId) !== String(season)) return false;
  const program = FS?.pin?.programId ?? null;
  return !(program && typeof g.season.programId === 'string' && g.season.programId !== program);
}

/** Turns as words with their hours: 「12 ターン（2 時間）」; on a faster TEST clock with the real time instead —
 *  「42 ターン（この世界の実時間で約 7 分）」 (fix-loop13, LP13-8: at ×60 the card said "(7 h)" for 7 real minutes; the
 *  keep list and the guide already say the real time, seasonterms.mjs turnsLine). */
export function turnsText(n) {
  const r = termsRate();
  if (r !== null && r > 1) return L`${fmtNum(n)} ターン（${turnsLine(n)}）`;
  const min = n * TURN_MIN;
  const h = min / 60;
  return h >= 1 ? L`${fmtNum(n)} ターン（${fmtNum(Math.round(h * 10) / 10)} 時間）` : L`${fmtNum(n)} ターン（${fmtNum(min)} 分）`;
}

/** Test-USDC base units (6 decimals) as text. */
export function usdc(v) {
  const s = String(v).padStart(7, '0');
  return `${s.slice(0, -6)}.${s.slice(-6)}`.replace(/\.?0+$/, '') || '0';
}

/** The names of the four goals (only the first is live in this slice). */
const GOAL_NAMES = () => ({ 'flag-keeps': L`旗の砦（覇権）`, 'world-first-tech': L`世界初の技術（学術）`, wonder: L`大建造物（大事業）`, 'unexplored-mark': L`未踏の印（探検）` });

/**
 * The viewer's nation's line: `{nation, held, own, captured, capturedLong, need, left}` (`captured`: the flag keeps it
 * took from other nations — the only ones that count; `left`: turns until the need is reached if it keeps what it
 * holds; null when it holds fewer captured flag keeps than the need) or null without a nation.
 */
export function viewerProgress(FS, g) {
  const f = FS?.citizen?.faction;
  if (!nation(f) || !g?.flagKeeps) return null;
  const x = g.flagKeeps.progress.find(p => p.nation === f);
  if (!x) return null;
  return { ...x, left: x.reachAt === null || g.bell === null ? null : Math.max(0, x.reachAt - g.bell) };
}

/** The viewer's line of an achievement's (simulated) prize, or null. */
export function viewerPrize(FS, a) {
  const w = FS?.wallet?.address;
  return typeof w === 'string' ? a.prize.rows.find(r => r.wallet === w) ?? null : null;
}

const whyText = why => ({
  'operator-ai': L`運営の AI 住民は点と称号を得ますが、賞金は受け取りません（その分は人に回ります）`,
  'external-ai-legal-review': L`外部の AI 住民の賞金は法務の確認の後です`,
  'member-too-recent': L`達成の 24 時間前より後に国民になったので、この回の賞金は受け取れません`,
  'not-a-member-read': L`国民の記録が読めませんでした`,
}[why] ?? L`受け取れません`);

/**
 * (verify-pr198) A flag keep as the viewer may see it under the fog of war of a local test world (map/fog.mjs, the
 * rule of the keep board and the conquest screen): a keep in sight is told live; one seen before only by its last-known
 * holder (no timer, no siege — they are live facts); one never seen by its place alone (the posting is public). The
 * judge's answer carries every flag keep's live holder: without this the card told what the map hides.
 */
/**
 * (fix-loop14, LP14-3) The capture in which the viewer's nation LOST the keep of (p, q), when that is the last capture
 * there its nation took part in: `{bell, to}` or null. A capture from or by the viewer's nation is told to it by the
 * page's notices whatever the fog (hud/feed.mjs keepItem, fconquest.mjs keepEventSide), so who took the keep, and when,
 * is something the viewer saw — the last thing it saw of that keep unless the keep came in sight again later.
 */
export function lostFlag(FS, f) {
  const me = FS?.citizen?.faction;
  if (!nation(me) || !Array.isArray(FS?.conquest?.events)) return null;
  let last = null;
  for (const e of FS.conquest.events) {
    if (e?.kind !== 'keep_taken' || e.p !== f.p || e.q !== f.q || !int(e.bell) || (e.from !== me && e.to !== me)) continue;
    if (!last || e.bell >= last.bell) last = e;
  }
  return last && last.from === me && nation(last.to) ? { bell: last.bell, to: last.to } : null;
}

export function seenFlag(FS, f) {
  const hidden = { since: null, from: null, longAt: null, contender: null, progress: 0, required: 0 };
  if (!fogNow().on) {
    // (a fogged page before its first village — the page's fog view is made only once the viewer has one, app.mjs:
    //  nothing is seen yet, so no flag keep is told but by its place; the fog's "show everything" switch is unaffected)
    if (fogActive(FS) && !(FS?.holdings ?? []).length) return { ...f, ...hidden, holder: null, seen: 'never' };
    return { ...f, seen: 'live' };
  }
  // (fix-loop13, LP13-11: the viewer's own nation's keeps are always known — map/fog.mjs fogKeeps — but in `--wide` the
  //  page's keep map lacks most rim keeps, so a flag keep the judge says the viewer's nation holds was told "not seen".
  //  The judge's holder is enough here: telling the viewer that their own nation holds a keep leaks nothing of others)
  if (nation(FS?.citizen?.faction) && f.holder === FS.citizen.faction) return { ...f, seen: 'live' };
  const keeps = viewKeeps(FS?.conquest?.keeps);
  const k = keeps instanceof Map ? keeps.get(`${f.p},${f.q}`) ?? null : null;
  // (fix-loop14, LP14-3: a flag keep the viewer's nation held and lost. In `--wide` the page's keep map lacks most rim
  //  keeps, so once the judge's holder was no longer the viewer's nation the row fell to "not seen yet", as if never
  //  known; and where the keep map remembers it, its memory is of the viewer's nation holding it. What the viewer last
  //  saw is the capture itself: its taker and its turn — no timer and no siege, they are live facts)
  const lost = lostFlag(FS, f);
  const lostRow = lost ? { ...f, ...hidden, holder: lost.to, seen: 'memory', lostAt: lost.bell } : null;
  if (!k) return lostRow ?? { ...f, ...hidden, holder: null, seen: 'never' };
  if (k.fog === 'memory') return lostRow && !(int(k.asOfBell) && k.asOfBell > lost.bell) ? lostRow : { ...f, ...hidden, holder: nation(k.holder) ? k.holder : null, seen: 'memory' };
  return { ...f, seen: 'live' };
}

function flagRow(raw, g, FS) {
  const me = FS?.citizen?.faction;
  const f = seenFlag(FS, raw);
  if (f.seen === 'never') return html`<li class="goal-flag unseen" data-flag="${f.p},${f.q}" data-seen="never"><button type="button" class="link" data-act="goto" data-p="${f.p}" data-q="${f.q}">${L`州 ${f.p},${f.q}`}</button> · <small class="muted">${L`この州の砦は、まだ見ていません。`}</small></li>`;
  const held = nation(f.holder) ? factionName(f.holder) : L`持ち主なし`;
  const long = f.longAt !== null && g.bell !== null && f.longAt <= g.bell;
  const left = f.longAt !== null && g.bell !== null && !long ? f.longAt - g.bell : null;
  // (flag-keeps-v2: a flag keep in the hands of the nation it was drawn for is that nation's starting flag keep — it
  //  does not count, so it has no hold timer; the row says so instead)
  const start = nation(f.holder) && f.holder === f.nation;
  const state = start ? (f.holder === me ? L`初めからあなたの国の旗の砦です（達成には数えません）` : L`初めからこの国の旗の砦です（達成には数えません）`) : long ? L`保持の時間を満たした` : left !== null ? L`満たすまで あと ${turnsText(left)}` : '';
  const contest = nation(f.contender) ? html` <span class="warn">${L`${factionName(f.contender)}が包囲中 ${fmtNum(f.progress)} / ${fmtNum(f.required)}`}</span>` : '';
  return html`<li class="goal-flag${f.holder === me ? ' mine' : ''}" data-flag="${f.p},${f.q}" data-seen="${f.seen}"${int(f.lostAt) ? html` data-lost-at="${f.lostAt}"` : ''}><button type="button" class="link" data-act="goto" data-p="${f.p}" data-q="${f.q}">${L`州 ${f.p},${f.q}`}</button> · ${L`持ち主 ${held}`}${f.holder === me ? html` <span class="mine-mark">${L`（あなたの国）`}</span>` : ''} · <small class="muted">${int(f.lostAt) ? L`あなたの国が失ったとき（第${fmtNum(f.lostAt)}ターン）の持ち主です` : f.seen === 'memory' ? L`前に見たときの持ち主です` : state}</small>${contest}</li>`;
}

function achievementMarkup(a, FS) {
  const me = FS?.citizen?.faction;
  const names = a.nations.map(n => factionName(n)).join(L`、`);
  const mine = nation(me) && a.nations.includes(me);
  const row = viewerPrize(FS, a);
  let you = '';
  if (mine && row) {
    you = row.eligible
      ? html`<p class="goal-prize-you" data-prize-you="${row.amount}"><b>${L`賞金が有効なら、あなたは ${usdc(row.amount)} テスト USDC を受け取っていました`}</b><br><small class="muted">${L`あなたの貢献 ${fmtNum(row.points)} 点（国の中は点に比例して分けます）`}</small></p>`
      : html`<p class="goal-prize-you" data-prize-you="0"><b>${L`賞金が有効でも、あなたの受け取りは 0 です`}</b><br><small class="muted">${whyText(row.why)} · ${L`貢献 ${fmtNum(row.points)} 点`}</small></p>`;
  } else if (mine) you = html`<p class="goal-prize-you" data-prize-you="none"><small class="muted">${L`あなたの財布はこの回の国民の記録にありません`}</small></p>`;
  const others = a.prize.rows.filter(r => r.amount !== '0').length;
  return html`<li class="goal-achieved${mine ? ' mine' : ''}" data-round="${a.round}"><h4>${L`第 ${fmtNum(a.round)} 回：${names}が達成（ターン ${fmtNum(a.bell)}）`}</h4>
    ${you}
    <p class="muted small">${L`もし賞金が有効なら：賞金庫 ${usdc(a.prize.vaultBefore)} のうち ${usdc(a.prize.payout)} テスト USDC を、達成した国の ${fmtNum(others)} 人に分けていました（残り ${usdc(a.prize.returned)} は賞金庫へ）`}</p></li>`;
}

/**
 * (fix-loop13, LP13-9) An achievement told outside the card too: one feed line per achieved round (`goal:<seasonId>:<round>`,
 * so the feed never says it twice), in every language (hud/words.mjs said). `first`: the page's first good read — the
 * achievements already on record then are put in the list quietly (no toast for something long past); later ones are
 * notices. → items for hud/feed.mjs pushFeed, or null when the read is not this world's (nothing is learned from it).
 */
export function achievementNews(FS, b, { first = false } = {}) {
  if (!b || b.read !== 'ok' || !sameWorld(FS, b.goals)) return null;
  const me = FS?.citizen?.faction, sid = String(b.goals.season.seasonId);
  return b.goals.achievements.map(a => {
    const mine = nation(me) && a.nations.includes(me), row = mine ? viewerPrize(FS, a) : null;
    return { id: `goal:${sid}:${a.round}`, kind: 'goal', bell: a.bell, ...(first ? { quiet: true } : {}), ...said(() => {
      // (verify-pr208: "your nation (…)" names the viewer's nation alone — with several nations achieving at one turn it
      //  said 「あなたの国（アステル、ボレアリス、…）」; the card's round line lists them all)
      const names = mine ? factionName(me) : a.nations.map(n => factionName(n)).join(L`、`);
      if (row?.eligible) return L`世界の目標：第 ${fmtNum(a.round)} 回の旗の砦を、あなたの国（${names}）が達成しました（ターン ${fmtNum(a.bell)}）。賞金が有効なら、あなたは ${usdc(row.amount)} テスト USDC を受け取っていました`;
      return mine ? L`世界の目標：第 ${fmtNum(a.round)} 回の旗の砦を、あなたの国（${names}）が達成しました（ターン ${fmtNum(a.bell)}）` : L`世界の目標：第 ${fmtNum(a.round)} 回の旗の砦を ${names}が達成しました（ターン ${fmtNum(a.bell)}）`;
    }) };
  });
}

/** The card for a read `b` (probeGoals' answer, or null before the first read): '' when there is nothing to show. */
export function render(FS, b) {
  if (!b || b.read === 'absent') return '';
  const head = html`<header class="c-head"><span class="c-titles"><h3 id="world-goals-title">${L`世界の目標`}</h3><span class="c-sub">${L`期限のない 4 つの目標。どの国も、いつでも狙えます`}</span></span></header>`;
  if (b.read !== 'ok') return html`<section class="vcard world-goals" aria-labelledby="world-goals-title">${head}<p class="muted read-state" role="status" data-read="unread">${L`世界の目標を読み込めませんでした（${b.code ?? '?'}）`}</p></section>`;
  const g = b.goals;
  if (!sameWorld(FS, g)) return '';
  const names = GOAL_NAMES();
  const goals = html`<ul class="goal-kinds">${g.goals.map(k => html`<li data-goal="${k.id}" class="${k.live ? 'live' : 'coming'}">${names[k.id] ?? k.id} · <small class="muted">${k.live ? L`判定中` : L`準備中`}</small></li>`)}</ul>`;
  const fk = g.flagKeeps;
  let body = html`<p class="muted">${L`旗の砦を選んでいます…`}</p>`;
  if (fk) {
    const vp = viewerProgress(FS, g);
    // (flag-keeps-v2, owner 2026-11-24 22:00: only CAPTURED flag keeps count — the ones taken from another nation; a
    //  nation's own starting flag keeps do not. The line says "captured N / need M", so a nation that has done nothing
    //  reads 0, not the flag keeps it began with)
    const mineLine = vp ? html`<p class="goal-mine" data-held="${vp.held}" data-captured="${vp.captured}" data-captured-long="${vp.capturedLong}" data-need="${vp.need}"><b>${L`あなたの国：奪った旗の砦 ${fmtNum(vp.captured)} / 必要 ${fmtNum(vp.need)}、うち ${fmtNum(vp.capturedLong)} が保持の時間を満たした`}</b>
      ${vp.left !== null ? html`<br><span class="goal-timer" data-left="${vp.left}">${vp.left === 0 ? L`いま達成の条件を満たしています` : L`このまま持てば あと ${turnsText(vp.left)} で達成`}</span>` : html`<br><small class="muted">${L`ほかの国の旗の砦を あと ${fmtNum(vp.need - vp.captured)} 個奪って、${turnsText(fk.holdBells)} 持ち続けると達成`}</small>`}</p>` : '';
    const nations = fk.progress.filter(x => x.captured > 0).sort((a, c) => c.captured - a.captured || c.capturedLong - a.capturedLong || a.nation - c.nation);
    body = html`<p>${L`第 ${fmtNum(fk.round)} 回：ほかの国から奪った旗の砦 ${fmtNum(fk.need)} 個を、同じ国がそれぞれ ${turnsText(fk.holdBells)} 続けて持つと達成（旗の砦は全部で ${fmtNum(fk.flags.length)} 個。初めから自分の国にある旗の砦は数えません）`}</p>
      ${mineLine}
      <ol class="goal-flags">${fk.flags.map(f => flagRow(f, g, FS))}</ol>
      <p class="muted small goal-nations" data-capturing="${nations.length}">${nations.length ? nations.map(x => L`${factionName(x.nation)} 奪った ${fmtNum(x.captured)}（満たした ${fmtNum(x.capturedLong)}）`).join(' · ') : L`まだどの国も、ほかの国の旗の砦を奪っていません`}</p>
      <p class="muted small">${L`旗の砦は地図に金の旗で出ています。国ごとに国境の砦から選ばれ、達成のたびに選び直されます`}</p>`;
  }
  const done = [...g.achievements].reverse();
  const ach = done.length ? html`<ol class="goal-achievements">${done.slice(0, 4).map(a => achievementMarkup(a, FS))}</ol>` : '';
  return html`<section class="vcard world-goals" aria-labelledby="world-goals-title" data-round="${fk?.round ?? 0}">${head}${goals}${body}${ach}
    <p class="muted small">${L`世界の目標を達成しても、いまは賞金は払われません（記録だけです）。お金もチェーンも動きません`}</p></section>`;
}

/** The latest read (null before the first). */
let last = null;
export const current = () => last;

/**
 * Read now and every `every` ms while the judge answers; a server without it is not asked again. `changed(b)` after
 * each read. Installs once. → a function that stops it.
 */
let running = null;
export function installWorldGoals({ fetch, base = '', every = 5_000, changed = () => {}, timers = globalThis } = {}) {
  if (running) return running;
  let stopped = false, timer = null;
  const read = async () => {
    const b = await probeGoals({ fetch, base });
    if (stopped) return;
    last = b;
    changed(b);
    if (b.read !== 'absent') timer = timers.setTimeout?.(read, every) ?? null;
  };
  read();
  running = () => { stopped = true; last = null; running = null; if (timer !== null) timers.clearTimeout?.(timer); };
  return running;
}

/** The flag keeps the map marks: `[{p, q, round}]` of an answer of this world, else []. */
export function mapFlags(FS, b) {
  if (b?.read !== 'ok' || !sameWorld(FS, b.goals) || !b.goals.flagKeeps) return [];
  return b.goals.flagKeeps.flags.map(f => ({ p: f.p, q: f.q, round: b.goals.flagKeeps.round }));
}
