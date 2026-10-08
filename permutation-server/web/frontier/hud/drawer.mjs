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
//   join                         the join flow (until the viewer has a village)
//   null                         closed: the world has the screen
//
// "Map" closes it (closeDrawer). The practice and spectator pages have one
// panel each; it can be put away and brought back from the dock.
import { L } from '../../lang.mjs';

/** The viewer has a village (provisional or final). */
export const holdsLand = FS => ['provisional', 'final'].includes(FS.land?.stage);

/** The join flow is open by itself until a village exists (after the first refresh; never for a spectator). */
export const joinOpen = FS => !!FS.playReady && !holdsLand(FS) && !FS.joinShut;

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
  if (joinOpen(FS)) return { kind: 'join' };
  return null;
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
  return ({ practice: () => L`練習モード`, report: () => L`衝突の報告`, holding: () => L`村`, hosts: () => L`軍勢`, marches: () => L`進軍`, more: () => L`その他`,
    march: () => L`進軍の準備`, inspect: () => L`選択`, guide: () => L`ガイド`, join: () => L`参加`, spectate: () => L`観戦` })[d?.kind]?.() ?? L`地図`;
}

/** The kinds that lift the phone sheet from its peek (a selection or an order stays low: the map is being used). */
export const LIFTS = Object.freeze(new Set(['practice', 'report', 'holding', 'hosts', 'marches', 'more', 'guide', 'join', 'spectate']));
