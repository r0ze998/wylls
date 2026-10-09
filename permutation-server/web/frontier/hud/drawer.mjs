// The drawer (UX design section 6): `#panel` is closed when nothing is
// selected or open; it slides in from the right on desktop and is the
// bottom sheet on phones (at rest a peek that shows the village plate).
// One function decides what it shows, from the store alone:
//
//   practice | report            a run or a report takes the drawer
//   holding | hosts | marches | more   a dock press (FS.tab)
//   march                        an order being composed on the map
//   inspect                      a selection on the map
//   guide                        the list of the guide's steps, on demand
//   nation | wait | join         the first minute: the six banners, the wait for the village, something to mend
//   null                         closed: the world has the screen
//
// "Map" closes it (closeDrawer). The practice and spectator pages have one
// panel each; it can be put away and brought back from the dock.
import { L } from '../../lang.mjs';

/** The viewer has a village (provisional or final). */
export const holdsLand = FS => ['provisional', 'final'].includes(FS.land?.stage);

/**
 * What the page knows about who is looking (UX design 12.3: no false state at load). `known`: the viewer's
 * record has answered (a village, a request, a nation, or truly nothing), or there is nobody to ask about (no
 * wallet on this device); `pending`: the page is still asking; `unreachable`: it asked and got no answer (the
 * season's record did not come, or the first look at the viewer's record failed: `FS.viewerMissed`, set once by
 * app.mjs when play starts). Until it is `known` the HUD says that it is reading the record and offers nothing
 * that depends on the answer: never "not joined" with a join button for a player who has a village.
 */
export function viewerState(FS) {
  if ((FS.mode ?? 'play') !== 'play') return 'known';
  if (FS.land || FS.citizen || (FS.holdings ?? []).length) return 'known';
  if (!FS.playReady) return FS.error && !FS.record ? 'unreachable' : 'pending';
  return FS.viewerMissed ? 'unreachable' : 'known';
}
export const viewerKnown = FS => viewerState(FS) === 'known';

/**
 * The join flow is open by itself until a village exists (after the first refresh, and only once the viewer's
 * record has answered; never for a spectator), and never while the title scene stands (`FS.titleUp`: nothing
 * of the game opens behind it).
 */
export const joinOpen = FS => !!FS.playReady && viewerKnown(FS) && !holdsLand(FS) && !FS.joinShut && !FS.titleUp;

/** What the drawer shows: `{kind}` or null when it is closed. */
export function drawerOf(FS) {
  const mode = FS.mode ?? 'play';
  if (mode !== 'play') return FS.drawerShut ? null : { kind: mode };
  if (FS.practice) return { kind: 'practice' };
  if (FS.report) return { kind: 'report' };
  const tab = FS.tab ?? 'map';
  if (tab !== 'map') return { kind: tab };
  if (FS.compose) return { kind: 'march' };
  if (FS.selected) return { kind: 'inspect' };
  if (FS.guideOpen) return { kind: 'guide' };
  if (joinOpen(FS)) return { kind: joinKind(FS) };
  return null;
}

/**
 * Which first-minute screen the join flow is at (UX design section 7): `nation` — the six
 * banners, while the viewer has not joined; `wait` — joined, the first village is being
 * placed (the camera rests over the home wedge, the countdown runs, practice is offered);
 * `join` — something to mend first (no wallet after joining, the in-game key).
 */
export function joinKind(FS) {
  const stage = FS.land?.stage ?? 'none';
  if (stage === 'none') return 'nation';
  if (!FS.wallet || !FS.session || FS.sessionProblem) return 'join';
  return ['joined', 'ticket', 'refugee'].includes(stage) ? 'wait' : 'join';
}

/**
 * Close the drawer: the store goes back to "nothing selected or open". A
 * march being composed is an order in progress, not a panel: it stays (its
 * card has its own cancel), so the drawer may still show it.
 */
export function closeDrawer(FS) {
  if ((FS.mode ?? 'play') !== 'play') { FS.drawerShut = true; return FS; }
  FS.tab = 'map';
  FS.report = null;
  FS.practice = null;
  FS.selected = null;
  FS.guideOpen = false;
  if (!holdsLand(FS)) FS.joinShut = true;
  return FS;
}

/** The drawer's title. */
export function drawerTitle(d) {
  return ({ practice: () => L`練習`, report: () => L`衝突の報告`, holding: () => L`村`, hosts: () => L`軍勢`, marches: () => L`進軍`, more: () => L`その他`,
    march: () => L`進軍の準備`, inspect: () => L`選択`, guide: () => L`ガイド`, join: () => L`参加`, nation: () => L`国選び`, wait: () => L`村を待つ`, spectate: () => L`観戦` })[d?.kind]?.() ?? L`地図`;
}

/** The drawer's mark beside its title (hud/icons.mjs). */
export const DRAWER_ICON = Object.freeze({ practice: 'swords', report: 'scroll', holding: 'home', hosts: 'sword', marches: 'banner', more: 'scroll', march: 'seal', inspect: 'eye', guide: 'compass', join: 'banner', nation: 'banner', wait: 'hourglass', spectate: 'eye' });

/**
 * The kinds shown as a document over the map (UX design 8.3: a wide parchment card), not in
 * the side drawer: the battle report and the practice battle. The page marks them with
 * `data-doc="wide"` on the panel and the body; the corner pieces then stay where they are
 * and the camera counts nothing as covered at the right (hud/insets.mjs).
 */
export const WIDE = Object.freeze(new Set(['practice', 'report']));
/** The nation choice is a stage of its own: six banners standing along the foot of the map (`data-doc="stage"`). */
export const STAGE = Object.freeze(new Set(['nation']));

/** The kinds that lift the phone sheet from its peek (a selection or an order stays low: the map is being used). */
export const LIFTS = Object.freeze(new Set(['practice', 'report', 'holding', 'hosts', 'marches', 'more', 'guide', 'join', 'nation', 'wait', 'spectate']));

/** A part of the drawer that scrolls by itself above a foot that stays (the order's body above its seal: `data-scroll`) never rests with a row cut by the foot. */
export const ROW_GAP_MAX = 160;
/** A gap of this many px or more carries the "goes on below" mark. */
export const GAP_MARK_MIN = 36;
/**
 * At rest (not scrolled) such a part ends on a whole row: the room a half-seen row would take is left as bare paper
 * (`--row-gap` on the part, its bottom margin: frontier.css `.order-body`). The second review: a strength bar lay half
 * under the order's summary line. Scrolling shows the rest as before. `rowsOf(part)` gives the rows to look at.
 */
export function settleRows(doc = globalThis.document, rowsOf = part => part.querySelectorAll(':scope > *, :scope .versus > div, :scope .mc-odds > *, :scope .mc-def > li')) {
  let n = 0;
  for (const part of doc?.querySelectorAll?.('[data-scroll]') ?? []) {
    part.style?.setProperty?.('--row-gap', '0px');
    // (a gap tall enough to read as a hole carries a small mark that the page goes on below: frontier.css `[data-gap="more"]`)
    if (part.dataset && part.dataset.gap) part.dataset.gap = '';
    if (!(part.clientHeight > 0) || part.scrollTop > 0 || part.scrollHeight <= part.clientHeight + 1) continue;
    const gap = rowGap(part.clientHeight, [...rowsOf(part)].map(el => { const r = el.getBoundingClientRect(), t = part.getBoundingClientRect().top; return { top: r.top - t, bottom: r.bottom - t, leaf: !el.querySelector?.(':scope > *:not(span):not(strong):not(svg):not(input):not(small)') || el.matches?.('.versus > div, .picks, p, li, header, .stepper, .mc-dest, .c-label'), head: !!el.matches?.('.c-label') }; }));
    if (gap > 0) { part.style.setProperty('--row-gap', `${gap}px`); if (part.dataset && gap >= GAP_MARK_MIN) part.dataset.gap = 'more'; n++; }
  }
  return n;
}
/**
 * The gap for a part `height` px tall whose rows are `[{top, bottom, leaf, head?}]` (px from its top): from the last
 * whole row to its foot when a leaf row is cut there, else 0. A heading (`head`: a label of what follows) is never
 * left as the last whole row above rows that are not whole: it goes below the fold with them.
 */
export function rowGap(height, rows) {
  let last = 0, cut = false;
  const whole = [];
  for (const r of rows) {
    if (!(r.bottom > r.top)) continue;
    if (r.bottom <= height + 0.5) { if (r.leaf) { last = Math.max(last, r.bottom); whole.push(r); } }
    else if (r.top < height - 0.5 && r.leaf) cut = true;
  }
  const end = whole.find(r => r.bottom === last);
  if (end?.head && rows.some(r => r.bottom > r.top && r.top >= end.bottom - 0.5)) {
    cut = true;
    last = whole.filter(r => !r.head && r.bottom <= end.top + 0.5).reduce((a, r) => Math.max(a, r.bottom), 0);
  }
  const gap = Math.ceil(height - last);
  return cut && last > 0 && gap > 0 && gap <= ROW_GAP_MAX ? gap : 0;
}
