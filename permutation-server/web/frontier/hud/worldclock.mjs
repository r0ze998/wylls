// The world's continuity and the war period, said apart (workstream 07). The direction of the project: the world does
// not end or reset with a period; a war period (戦期) that bounds war and competition is a separate thing, and how it
// is bounded, what it tallies and what it pays are not decided. The shared core and the move to a continuing world
// are workstream 04's and 08's: this file defines no world and no period. It only says, in words kept apart, what
// their owners register — and, until they do, nothing about either: the page then says only the facts of the
// program it runs on (seasonterms.mjs: the turn after which this program takes no new order, as an old-style
// season's).
//
// Sources (one each; a second registration replaces the first; a source that throws says nothing):
//   continuity  (FS) → {continuous: true} | {continuous: false, endBell} | null     04/08: whether this world ends
//   warPeriod   (FS) → {fromBell, toBell, label?, tally?} | null                      the war period in force, if any
import { html } from '../../util.mjs';
import { L, fmtNum } from '../../lang.mjs';

const sources = new Map();
export const WORLD_SOURCES = Object.freeze({ continuity: '04/08', warPeriod: '04/08' });

/** Register the source of `kind`; returns a function that removes it. */
export function registerWorldSource(kind, fn) {
  if (!Object.hasOwn(WORLD_SOURCES, kind) || typeof fn !== 'function') throw new TypeError(`world source: one of ${Object.keys(WORLD_SOURCES).join(', ')}, and a function`);
  sources.set(kind, fn);
  return () => { if (sources.get(kind) === fn) sources.delete(kind); };
}
/** What the source of `kind` says for this page, or null. */
export function worldFrom(kind, FS) {
  const fn = sources.get(kind);
  if (!fn) return null;
  try { return fn(FS) ?? null; } catch { return null; }
}
/** Whether the owners say this world goes on without an end (only then is the program's end turn not said). */
export const worldContinues = FS => worldFrom('continuity', FS)?.continuous === true;

/**
 * The lines the page says of the world and of the war period, each on its own: `[{key, text}]`. Nothing for what
 * was not registered: no "the world goes on" and no war period are said from a guess.
 */
export function worldLines(FS) {
  const out = [];
  const c = worldFrom('continuity', FS);
  if (c?.continuous === true) out.push({ key: 'world', text: L`世界：期間の区切りで終わったり作り直したりしません` });
  const w = worldFrom('warPeriod', FS);
  if (w && Number.isFinite(Number(w.fromBell)) && Number.isFinite(Number(w.toBell))) {
    const name = w.label ? String(w.label) : L`戦期`;
    out.push({ key: 'warPeriod', text: L`${name}：第${fmtNum(Number(w.fromBell))}〜${fmtNum(Number(w.toBell))}ターン。${w.tally ? L`集計：${String(w.tally)}` : L`集計の方法は未決定です`}（世界はこの区切りで終わりません）` });
  }
  return out;
}

/** The lines as the page draws them (role=note; the world's line and the war period's never share a sentence). */
export function renderWorldLines(FS) {
  const lines = worldLines(FS);
  return lines.length ? html`<ul class="ws07-world" aria-label="${L`世界と戦期`}">${lines.map(x => html`<li data-key="${x.key}">${x.text}</li>`)}</ul>` : '';
}
