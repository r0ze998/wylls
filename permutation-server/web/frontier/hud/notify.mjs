// Notices outside the page while a tab is open (playtest priority 2, owner 2026-11-26 15:48 Q-PT-8 (a), Q-PT-10).
//
// The page already turns every change it reads into a line of the feed (hud/feed.mjs, app.mjs tickFeed / clashTold).
// This module sorts those lines into six kinds of event the player can switch on or off, and says how each new one
// is told:
//   - the tab is in front (visible and focused): nothing more — the feed's own card over the map is the notice;
//   - the tab is behind and the player allowed browser notifications: one system notification (Notification API);
//   - the tab is behind and notifications are not allowed (or not available): a count in the tab's title, "(2) Wylls".
// One event is told once (a key per event, kept for DEDUP_BELLS turns): a keep contest the herald's alert and the
// keep events both carry, a march's report and its result to collect, are one notice each.
//
// Defaults (Q-PT-10): ON for "attacked" (a siege on a village of yours, your nation's keep contested or taken, a
// village or land of yours taken, a caravan or storehouse of yours raided or seized, a host of yours attacked) and for
// "battle report ready"; OFF but available: a hostile march may reach a village, a host can march again, land upkeep
// unpaid, a keep capture done. The browser is asked for permission only after the player presses the button (a user
// gesture), never on load.
//
// Sources are only what the page already reads for this player (fog unchanged, no new route): the feed, the herald's
// own alerts in the `/h/me` answer the page already reads (conquest worlds: `alerts`), the hosts of the viewer's
// villages, and the viewer's own land record (FS.ownLand). Nothing leaves the browser: the preferences are kept in
// this browser's storage, and a notification is the browser's own, made here.
import { L, fmtNum, lang } from '../../lang.mjs';
import { factionName } from '../fi18n.mjs';
import { noticeText, worded } from './words.mjs';

export const NOTIFY_KINDS = Object.freeze(['attacked', 'report', 'incoming', 'hostReady', 'upkeep', 'keepHeld']);
/** Q-PT-10: ON for "attacked" and "battle report ready"; the rest opt-in. */
export const NOTIFY_DEFAULTS = Object.freeze({ attacked: true, report: true, incoming: false, hostReady: false, upkeep: false, keepHeld: false });
/** Device-wide (a player's own preference, not a world's): `{v: 1, enabled, on: {kind: bool}}`. */
export const NOTIFY_KEY = 'ps-fnotify:v1';
/** An event's key is not told again for this many turns. */
export const DEDUP_BELLS = 6;

/** The settings' words for each kind (a function: the language can change). */
export const KIND_LABEL = Object.freeze({
  attacked: () => L`攻撃を受けたとき（村の包囲・砦への攻撃・村や領地を奪われた・隊商や貯蔵庫を奪われた・軍勢が襲われた）`,
  report: () => L`戦いの報告が届いたとき`,
  incoming: () => L`敵の軍勢が村に来るかもしれないとき`,
  hostReady: () => L`軍勢がまた出陣できるようになったとき`,
  upkeep: () => L`土地の維持費が払えていないとき`,
  keepHeld: () => L`砦を取り終えたとき`,
});
/** A system notification's title per kind. */
export const KIND_TITLE = Object.freeze({
  attacked: () => L`攻撃を受けました`,
  report: () => L`戦いの報告が届きました`,
  incoming: () => L`敵が来るかもしれません`,
  hostReady: () => L`軍勢が出陣できます`,
  upkeep: () => L`土地の維持費が払えていません`,
  keepHeld: () => L`砦を取りました`,
});

// ------------------------------------------------------------------ preferences
/** The stored preferences, every field checked (a missing or damaged record reads as the defaults, not enabled). */
export function loadNotify(storage) {
  let v = null;
  try { v = JSON.parse(storage?.get?.(NOTIFY_KEY) ?? 'null'); } catch { v = null; }
  const on = { ...NOTIFY_DEFAULTS };
  if (v && typeof v === 'object' && v.v === 1 && v.on && typeof v.on === 'object') for (const k of NOTIFY_KINDS) if (typeof v.on[k] === 'boolean') on[k] = v.on[k];
  return { v: 1, enabled: !!(v && v.v === 1 && v.enabled === true), on };
}
/** Save a patch (`{enabled}` and/or `{on: {kind: bool}}`) over the stored preferences; returns the new ones. */
export function saveNotify(storage, patch) {
  const was = loadNotify(storage);
  const merged = { v: 1, enabled: typeof patch?.enabled === 'boolean' ? patch.enabled : was.enabled, on: { ...was.on } };
  for (const k of NOTIFY_KINDS) if (typeof patch?.on?.[k] === 'boolean') merged.on[k] = patch.on[k];
  try { storage?.set?.(NOTIFY_KEY, JSON.stringify(merged)); } catch { /* a storage that refuses only costs the preference */ }
  return loadNotify(storage) ?? merged;
}

// ------------------------------------------------------------------ which event a feed line is
const LOSS_TONES = new Set(['loss', 'uncertain']);
/** The away-summary kinds (hud/returnwords.mjs) that are an attack on the viewer when their tone is a loss. */
const AWAY_ATTACK = new Set(['CARAVAN_RAIDED', 'RAID_OPENED', 'VAULT_SEIZED', 'STRUCTURE_SEIZED', 'CAPTURE_SETTLED']);
const at = x => `${x?.p},${x?.q}`;

/**
 * The event a feed line is, or null: `{kind, key}`. `key` is the same for the same event told by two sources (a
 * keep contest from the keep events and from the herald's alert; a march's clash and its result to collect).
 * Lines about others (`quiet`), the away summary's head, and the turn's summary are no event.
 */
export function noticeOf(x) {
  if (!x || typeof x.id !== 'string' || x.quiet || x.kind === 'summary' || x.kind === 'away') return null;
  const id = x.id;
  if (id.startsWith('kp:keep_taken:')) return x.side === 'loss' ? { kind: 'attacked', key: `keeplost:${at(x)}` } : x.side === 'gain' ? { kind: 'keepHeld', key: `keepwon:${at(x)}` } : null;
  if (id.startsWith('kp:keep_contest:')) return x.side === 'defend' ? { kind: 'attacked', key: `contest:${at(x)}` } : null;
  if (id.startsWith('tr:')) return x.lost ? { kind: 'attacked', key: `land:${id.slice(3)}` } : null;
  if (id.startsWith('hg:')) return x.lost ? { kind: 'attacked', key: `lost:${at(x)}` } : null;
  if (id.startsWith('cl:')) return x.attacked ? { kind: 'attacked', key: `clash:${at(x)}:${x.battle?.bell ?? x.bell}` } : null;
  if (id.startsWith('rs:')) return x.kind === 'battle' ? { kind: 'report', key: `report:${id.slice(3)}` } : null;
  if (id.startsWith('st:')) return { kind: 'report', key: `report:${id.slice(3)}` };
  if (id.startsWith('in:')) return { kind: 'incoming', key: id };
  if (id.startsWith('al:')) return x.notice ?? null;
  if (id.startsWith('hr:')) return { kind: 'hostReady', key: id };
  if (id.startsWith('up:')) return { kind: 'upkeep', key: id };
  if (id.startsWith('aw:') && x.awayOf) {
    const a = x.awayOf;
    if (a.kind === 'SIEGE_DECLARED') return { kind: 'attacked', key: `siege:${at(a.at ?? x)}` };
    if (AWAY_ATTACK.has(a.kind) && LOSS_TONES.has(a.tone)) return { kind: 'attacked', key: a.kind === 'CAPTURE_SETTLED' ? `lost:${at(a.at ?? x)}` : `away:${a.seq}` };
  }
  return null;
}

/** How a new event of `kind` is told: 'toast' (in front: the feed's card), 'system', 'badge', or null (switched off). */
export function channelFor({ kind, prefs, focused, permission }) {
  if (!prefs?.on?.[kind]) return null;
  if (focused) return 'toast';
  return prefs.enabled && permission === 'granted' ? 'system' : 'badge';
}

/** The tab's title with the count of notices told while it was behind: "(2) Wylls"; the count 0 gives the title back. */
export function badgeTitle(title, n) {
  const base = String(title ?? '').replace(/^\(\d+\)\s+/, '');
  return n > 0 ? `(${n > 99 ? '99+' : n}) ${base}` : base;
}

// ------------------------------------------------------------------ new lines from what the page reads
/** The herald's alert kinds (frontier-node herald conquest.rs: `alerts` of `/h/me`) that are an attack on the viewer. */
export const ALERT_KINDS = Object.freeze(['horn', 'keep_contest', 'occupied', 'captured']);
const nation = f => (Number.isInteger(f) && f >= 0 && f <= 5 ? factionName(f) : L`他国`);

/**
 * The herald's alerts as feed lines (`al:<kind>:<seq>`), in every language, each with its event (`notice`).
 * `names`: `{village(p, q, site), province(p, q)}` — the page's own names for a place.
 */
export const alertItems = (alerts, names) => worded(() => (alerts ?? []).filter(a => a && ALERT_KINDS.includes(a.kind) && Number.isInteger(a.p) && Number.isInteger(a.q) && a.seq !== undefined).map(a => {
  const bell = Number.isInteger(a.bell) ? a.bell : null, turn = fmtNum(bell ?? 0), who = nation(a.faction);
  const village = Number.isInteger(a.site) ? names.village(a.p, a.q, a.site) : names.province(a.p, a.q);
  const base = { id: `al:${a.kind}:${a.seq}`, kind: a.kind === 'keep_contest' ? 'keep' : 'holding', bell, p: a.p, q: a.q, ...(Number.isInteger(a.site) ? { site: a.site } : {}) };
  if (a.kind === 'horn') return { ...base, notice: { kind: 'attacked', key: `siege:${a.p},${a.q}` }, text: L`${who}が${village}の包囲を宣言しました（ターン ${turn}）` };
  if (a.kind === 'keep_contest') return { ...base, side: 'defend', notice: { kind: 'attacked', key: `contest:${a.p},${a.q}` }, text: L`${names.province(a.p, a.q)}の砦を${who}が攻めはじめました（ターン ${turn}）` };
  if (a.kind === 'occupied') return { ...base, notice: { kind: 'attacked', key: `occupied:${a.p},${a.q}` }, text: L`${village}が${who}に占領されました（ターン ${turn}）` };
  return { ...base, notice: { kind: 'attacked', key: `lost:${a.p},${a.q}` }, text: L`${village}を${who}に奪われました（ターン ${turn}）` };
}));

/**
 * What changes between reads that is no feed line of its own: the herald's alerts, a host that can march again,
 * land upkeep that went unpaid. The first read of each is what was so — not news. Returns new feed lines.
 */
export function createWatch() {
  let alertsSeen = null, readyHosts = null, unpaid = null;
  return {
    /** `alerts`: the `/h/me` answer's list (null: not a conquest world, or not read) → its new lines. */
    alerts(alerts, names) {
      if (!Array.isArray(alerts)) return [];
      const ids = new Set(alerts.map(a => `al:${a?.kind}:${a?.seq}`));
      const first = alertsSeen === null;
      const fresh = first ? [] : alertItems(alerts.filter(a => !alertsSeen.has(`al:${a?.kind}:${a?.seq}`)), names);
      alertsSeen = new Set([...(alertsSeen ?? []), ...ids]);
      return fresh;
    },
    /**
     * `rows`: `[{id, ready, busy, village, p, q}]` of every host of the viewer's villages the page holds; `busy`: resting
     * (stamina or its ready turn) or on the road. A host last seen busy and now ready is news (one line for all of them in
     * a read); a host first seen, or one that only waited for its muster, is not (live, pt-notify: a host just formed was
     * told "can march again").
     */
    hosts(rows, bell) {
      const now = new Map((rows ?? []).map(r => [String(r.id), r]));
      const fresh = readyHosts === null ? [] : [...now.values()].filter(r => r.ready && readyHosts.get(String(r.id)) === 'busy');
      readyHosts = new Map([...now.values()].map(r => [String(r.id), r.ready ? 'ready' : r.busy ? 'busy' : 'other']));
      if (!fresh.length) return [];
      const r0 = fresh[0];
      return worded(() => [{ id: `hr:${fresh.map(r => r.id).join('+')}:${bell}`, kind: 'march', bell, p: r0.p, q: r0.q, ...(Number.isInteger(r0.tile) ? { tile: r0.tile } : {}),
        text: fresh.length === 1 ? L`${r0.village}の軍勢が、また出陣できます` : L`軍勢 ${fmtNum(fresh.length)} が、また出陣できます` }]);
    },
    /** `view`: flocalplay-territory.mjs ownLandView of the viewer's land, or null (not a territory world / not read). */
    upkeep(view, bell, where = null) {
      if (!view) return [];
      const was = unpaid;
      unpaid = !!view.unpaid;
      if (was !== false || !view.unpaid) return [];
      return worded(() => [{ id: `up:${bell}`, kind: 'territory', bell, ...(where ? { p: where.p, q: where.q } : {}),
        text: Number.isInteger(view.turnsLeft) && view.turnsLeft > 0 ? L`土地の維持費が払えていません。あと ${fmtNum(view.turnsLeft)} ターンで土地を手放し始めます` : L`土地の維持費が払えていません` }]);
    },
  };
}

// ------------------------------------------------------------------ the notifier
/**
 * The notifier of one page. `env` (injected; the page's is browserEnv below):
 *   focused() → bool   the tab is visible and has focus
 *   permission() → 'granted' | 'denied' | 'default' | 'unsupported'
 *   show(title, {body, tag, lang}, onClick) → void   one system notification
 *   title() → string, setTitle(s)   the tab's title
 * `prefs()` → the current preferences (loadNotify).
 */
export function createNotifier({ env, prefs }) {
  let seen = null, startBell = null, badge = 0;
  const told = new Map();
  const notifier = {
    /** The events told so far, newest last (tests and the settings card): `[{kind, key, channel, id, at}]`. */
    log: [],
    /**
     * Look at the feed (newest first, hud/feed.mjs pushFeed) and tell each new event once. `onOpen(x)`: what a click on a
     * system notification does (the page goes to the line's place). The first look is what was there: not news.
     */
    observe(feed, { bell = null, onOpen = null } = {}) {
      const list = Array.isArray(feed) ? feed : [];
      if (seen === null) { seen = new Set(list.map(x => x?.id)); startBell = bell; return []; }
      const out = [];
      for (const x of [...list].reverse()) {
        if (!x || seen.has(x.id)) continue;
        seen.add(x.id);
        // (the away summary tells, when the page opens, what happened before it: that is no event of now)
        if (x.awayOf && Number.isInteger(startBell) && Number.isInteger(x.awayOf.bell) && x.awayOf.bell < startBell) continue;
        const ev = noticeOf(x);
        if (!ev) continue;
        const b = Number.isInteger(bell) ? bell : Number.isInteger(x.bell) ? x.bell : 0;
        const last = told.get(ev.key);
        if (last !== undefined && b - last < DEDUP_BELLS) continue;
        const p = prefs();
        const channel = channelFor({ kind: ev.kind, prefs: p, focused: env.focused(), permission: env.permission() });
        if (!channel) continue;
        told.set(ev.key, b);
        if (channel === 'system') {
          try { env.show(`${KIND_TITLE[ev.kind]()} — Wylls`, { body: noticeText(x), tag: `wylls:${ev.key}`, lang: lang() }, () => onOpen?.(x)); } catch { /* a refused notification: the badge still counts it */ }
        }
        if (channel !== 'toast') { badge += 1; env.setTitle(badgeTitle(env.title(), badge)); }
        const rec = { kind: ev.kind, key: ev.key, channel, id: x.id, at: b };
        out.push(rec);
        notifier.log.push(rec);
        if (notifier.log.length > 50) notifier.log.shift();
      }
      return out;
    },
    /** Whether an event with this key was told in the last DEDUP_BELLS turns (a source that adds feed lines asks first). */
    toldRecently(key, bell) { const last = told.get(key); return last !== undefined && (Number(bell) || 0) - last < DEDUP_BELLS; },
    /** The tab is in front again: the count in its title goes. */
    clearBadge() { if (badge) { badge = 0; env.setTitle(badgeTitle(env.title(), 0)); } },
    /** The title's count (tests, and the title after a language switch rewrote it). */
    badge: () => badge,
    reapplyBadge() { if (badge) env.setTitle(badgeTitle(env.title(), badge)); },
  };
  return notifier;
}

/** The browser's side of the notifier (not used by tests). */
export function browserEnv(g = globalThis) {
  return {
    focused: () => { const d = g.document; return !!d && d.visibilityState !== 'hidden' && (typeof d.hasFocus !== 'function' || d.hasFocus()); },
    permission: () => (typeof g.Notification === 'function' ? g.Notification.permission : 'unsupported'),
    show(title, opts, onClick) {
      const n = new g.Notification(title, { body: opts.body, tag: opts.tag, lang: opts.lang });
      n.onclick = () => { try { g.focus?.(); onClick?.(); } finally { n.close(); } };
    },
    title: () => g.document?.title ?? '',
    setTitle: s => { if (g.document) g.document.title = s; },
  };
}

/**
 * Ask the browser for permission. Call ONLY from a click (a user gesture): browsers refuse or penalise a prompt on
 * load. → 'granted' | 'denied' | 'default' | 'unsupported'.
 */
export async function askPermission(g = globalThis) {
  if (typeof g.Notification !== 'function') return 'unsupported';
  if (g.Notification.permission !== 'default') return g.Notification.permission;
  try { return await g.Notification.requestPermission(); } catch { return g.Notification.permission ?? 'default'; }
}

/** What the settings card says of the permission. */
export function permissionText(state, enabled) {
  if (state === 'unsupported') return enabled ? L`このブラウザではブラウザ通知を使えません。このタブが後ろにあるあいだは、タブの題名に件数を出します。` : L`このブラウザではブラウザ通知を使えません。オンにすると、このタブが後ろにあるあいだはタブの題名に件数を出します。`;
  if (state === 'denied') return enabled ? L`ブラウザ通知は、このブラウザの設定で拒否されています。このタブが後ろにあるあいだは、タブの題名に件数を出します（許可はブラウザのサイト設定から変えられます）。` : L`ブラウザ通知は、このブラウザの設定で拒否されています。オンにすると、このタブが後ろにあるあいだはタブの題名に件数を出します（許可はブラウザのサイト設定から変えられます）。`;
  if (state === 'granted' && enabled) return L`ブラウザ通知はオンです。このタブが開いているあいだ（後ろにあっても）、選んだ出来事を知らせます。タブが前にあるときは、地図の上のお知らせだけです。`;
  if (state === 'granted') return L`ブラウザ通知は許可されていますが、オフにしています。`;
  return L`ブラウザ通知はまだオンにしていません。オンにすると、このタブが後ろにあるあいだも知らせます。`;
}
