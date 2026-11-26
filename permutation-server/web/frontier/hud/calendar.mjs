// The player's own timers as a calendar file (.ics, RFC 5545) — playtest priority 2, owner 2026-11-26 15:48 Q-PT-8 (b).
//
// Made in this browser from what the page already holds for the viewer (no read of its own, fog unchanged): when a
// host of theirs can march again, when a march of theirs arrives and when its report is due, when a keep their
// nation is taking is held long enough (or one it holds may fall), and when unpaid land upkeep starts letting tiles
// go. Downloaded as a file the player imports into a calendar app of their choice: nothing is sent anywhere.
// "Updated on demand": each event keeps one UID per subject (a host, a march, a keep, the land), so importing a newer
// file moves the same events instead of adding copies (SEQUENCE grows with the time it was made).
//
// Times are about: a turn's end, a lost battle or a lagging world can move them; the description says so. A chain
// time becomes a wall time by the page's chain clock (clock.mjs ChainClock: `rate` chain seconds per wall second — 1
// on a real cluster, ×N in a fast local world); a world whose clock stands has no times to write.
import { L, fmtNum, lang, inEachLang } from '../../lang.mjs';
import { factionName } from '../fi18n.mjs';
import { bellStart, bellEnd } from '../clock.mjs';
import { hostsIn } from '../fland.mjs';
import { DEPART_STAMINA } from '../fmarch.mjs';
import { keepFromProvince } from '../fconquest.mjs';
import { ownLandView } from '../flocalplay-territory.mjs';
import { holdingName } from '../people/ui.mjs';
import { noticeProvince } from './place.mjs';
import { destPlace, marchArrive } from './feed.mjs';

/** A march's report is read about this long (chain seconds) after its arrival turn ends (anchor + window + margin, clock.mjs). */
export const REPORT_LAG_SECS = 90;
/** Each event is a short block in the calendar. */
export const EVENT_MINUTES = 10;
export const CAL_KINDS = Object.freeze(['hostReady', 'marchArrival', 'reportDue', 'keepHold', 'keepFall', 'upkeep']);

/** The wall time (ms) of chain time `t`, or null when the page's clock cannot say (none yet, or the world stands). */
export function wallMsOf(FS, t, nowMs = Date.now()) {
  const c = FS?.chain;
  const chainNow = typeof c?.now === 'function' ? c.now() : null;
  const rate = Number(c?.rate ?? 1);
  if (!Number.isFinite(chainNow) || !Number.isFinite(t) || !(rate > 0)) return null;
  return Math.round(nowMs + ((t - chainNow) * 1000) / rate);
}

/** Why there are no times: 'noClock' (not read yet), 'stopped' (the world's clock stands), or null. */
export function calendarBlocked(FS) {
  if (!FS?.clock || typeof FS?.chain?.now !== 'function' || !Number.isFinite(FS.chain.now())) return 'noClock';
  if (!(Number(FS.chain.rate ?? 1) > 0) || FS.worldEnded) return 'stopped';
  return null;
}

const marchKey = m => String(m.entry?.host ?? m.transit?.hostId ?? m.expedition?.host ?? '');

/**
 * The viewer's coming timers: `[{uid, kind, startMs, bell, title: {ja, en}, desc: {ja, en}}]`, soonest first, only those
 * after `nowMs`. Everything comes from the page's own state for the viewer.
 */
export function calendarEvents(FS, { nowMs = Date.now() } = {}) {
  if (calendarBlocked(FS)) return [];
  const g = Number(FS.clock.genesisTs), bell = Number.isInteger(FS.nowBell) ? FS.nowBell : null;
  if (!Number.isFinite(g) || bell === null) return [];
  const out = [];
  const add = (kind, subject, b, chainT, title, desc) => {
    const startMs = wallMsOf(FS, chainT, nowMs);
    if (startMs === null || startMs <= nowMs) return;
    out.push({ uid: `${kind}-${String(subject).replace(/[^A-Za-z0-9_.-]/g, '_')}@wylls.invalid`, kind, bell: b, startMs, title: inEachLang(title), desc: inEachLang(desc) });
  };
  const about = () => L`目安の時刻です。ターンの進み方や戦いの結果で前後します。ページを開いて確かめてください。`;
  // a host of the viewer's that can march again: rested (stamina for the longest march) and past its ready turn
  for (const h of FS.holdings ?? []) {
    for (const env of FS.provinces?.values?.() ?? []) {
      for (const r of hostsIn(env.province, h, bell)) {
        if (r.state !== 1 || r.inTransit || r.pending) continue;
        const restBell = bell + Math.max(0, DEPART_STAMINA - Number(r.stamina ?? 0));
        const rb = Math.max(Number(r.readyBell ?? 0), restBell);
        if (rb <= bell) continue;
        add('hostReady', String(r.id), rb, bellStart(g, rb), () => L`Wylls：${holdingName(h)}の軍勢が出陣できます`, () => L`${holdingName(h)}の軍勢が、ターン ${fmtNum(rb)} からまた出陣できます。${about()}`);
      }
    }
  }
  // a march of the viewer's: its arrival turn, and its report after that turn is resolved
  // (fix-loop24, BREAK-2: a local march's row carries its destination from the departure on — controller.mjs
  //  sentMarchDest —, a kept expedition's its own; the place is said as the notifications say it — hud/feed.mjs destPlace)
  for (const m of FS.marches ?? []) {
    const arrive = marchArrive(m), dest = m.dest ?? m.expedition?.dest ?? null;
    if (!Number.isInteger(arrive) || !dest || m.facts?.pipeline === 'resolved' || ['resolved', 'settled'].includes(m.expedition?.stage)) continue;
    const k = marchKey(m);
    if (!k) continue;
    const to = () => destPlace(FS, dest);
    if (arrive > bell) add('marchArrival', k, arrive, bellStart(g, arrive), () => L`Wylls：進軍が${to()}に着きます`, () => L`あなたの進軍が、ターン ${fmtNum(arrive)} に${to()}へ着きます。${about()}`);
    add('reportDue', k, arrive, bellEnd(g, arrive) + REPORT_LAG_SECS, () => L`Wylls：${to()}への進軍の報告`, () => L`ターン ${fmtNum(arrive)} に着く進軍の結果と戦いの報告が、このころ届きます。${about()}`);
  }
  // a keep in a province the page holds: the viewer's nation is taking it, or holds it under a contest
  const faction = FS.citizen?.faction;
  if (Number.isInteger(faction)) {
    for (const env of FS.provinces?.values?.() ?? []) {
      const k = keepFromProvince(env.province);
      if (!k || !(k.contender >= 0 && k.contender <= 5) || k.contender === k.holder) continue;
      const left = Number(k.requiredBells) - Number(k.progress);
      if (!(left > 0)) continue;
      const done = k.asOfBell + left;
      if (k.contender === faction) add('keepHold', `${k.p},${k.q}`, done, bellEnd(g, done), () => L`Wylls：${noticeProvince(k.p, k.q)}の砦を取り終えます`, () => L`あなたの国が攻めている${noticeProvince(k.p, k.q)}の砦は、守りきられなければターン ${fmtNum(done)} の終わりに取れます（早くてこの時刻）。${about()}`);
      else if (k.holder === faction) add('keepFall', `${k.p},${k.q}`, done, bellEnd(g, done), () => L`Wylls：${noticeProvince(k.p, k.q)}の砦が落ちるかもしれません`, () => L`${factionName(k.contender)}が攻めている${noticeProvince(k.p, k.q)}の砦は、守らなければターン ${fmtNum(done)} の終わりに奪われます（早くてこの時刻）。${about()}`);
    }
  }
  // land upkeep unpaid: when tiles start to be let go
  const player = FS.ownLand?.player;
  if (player) {
    const v = ownLandView(player, bell);
    if (v.unpaid && Number.isInteger(v.turnsLeft) && v.turnsLeft > 0) {
      const b = bell + v.turnsLeft;
      add('upkeep', 'land', b, bellStart(g, b), () => L`Wylls：土地の維持費が払えないと、土地を手放し始めます`, () => L`土地の維持費が払えていません。ターン ${fmtNum(b)} から土地を手放し始めます。最初の村に食料を足してください。${about()}`);
    }
  }
  return out.sort((a, b) => a.startMs - b.startMs);
}

// ------------------------------------------------------------------ the file
const pad = n => String(n).padStart(2, '0');
/** RFC 5545 UTC date-time: 20261126T061500Z. */
export const icsTime = ms => { const d = new Date(ms); return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`; };
/** A TEXT value escaped (RFC 5545 3.3.11). */
export const icsEscape = s => String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
/** One content line folded at 75 octets (RFC 5545 3.1), never inside a UTF-8 character. */
export function icsFold(line) {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const parts = [];
  let cur = '', size = 0, limit = 75;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (size + n > limit) { parts.push(cur); cur = ''; size = 0; limit = 74; }
    cur += ch; size += n;
  }
  parts.push(cur);
  return parts.join('\r\n ');
}

/** The title of an event in both languages, the page's language first: "Host ready … / 軍勢が…". */
export const bothLangs = (w, first = lang()) => { const a = w?.[first] ?? w?.ja ?? '', b = w?.[first === 'en' ? 'ja' : 'en'] ?? ''; return b && b !== a ? `${a} / ${b}` : a; };

/** The whole file (CRLF lines). `nowMs` stamps it and orders its updates (SEQUENCE). */
export function icsText(events, { nowMs = Date.now(), first = lang() } = {}) {
  const stamp = icsTime(nowMs), seq = Math.floor(nowMs / 1000) % 2147483647;
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Wylls//Player timers//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', `X-WR-CALNAME:${icsEscape(bothLangs(inEachLang(() => L`Wylls の予定`), first))}`];
  for (const e of events) {
    lines.push('BEGIN:VEVENT', `UID:${e.uid}`, `SEQUENCE:${seq}`, `DTSTAMP:${stamp}`, `DTSTART:${icsTime(e.startMs)}`, `DTEND:${icsTime(e.startMs + EVENT_MINUTES * 60_000)}`,
      `SUMMARY:${icsEscape(bothLangs(e.title, first))}`, `DESCRIPTION:${icsEscape(`${e.desc?.[first] ?? e.desc?.ja ?? ''}\n\n${e.desc?.[first === 'en' ? 'ja' : 'en'] ?? ''}`.trim())}`,
      'TRANSP:TRANSPARENT', 'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsEscape(bothLangs(e.title, first))}`, 'TRIGGER:PT0M', 'END:VALARM', 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(icsFold).join('\r\n') + '\r\n';
}

/** The file's name: wylls-timers-20261126-1515.ics (local time of the browser). */
export function icsFileName(nowMs = Date.now()) {
  const d = new Date(nowMs);
  return `wylls-timers-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.ics`;
}

/** Save the file in the browser (a download of a Blob: nothing leaves the browser). */
export function downloadIcs(text, name, g = globalThis) {
  const blob = new g.Blob([text], { type: 'text/calendar;charset=utf-8' });
  const url = g.URL.createObjectURL(blob);
  const a = g.document.createElement('a');
  a.href = url; a.download = name; a.rel = 'noopener';
  g.document.body.appendChild(a); a.click(); a.remove();
  g.setTimeout(() => g.URL.revokeObjectURL(url), 10_000);
}
