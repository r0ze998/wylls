// The departures-and-clashes panel and the minimal chronicle (contract §1.3 C9, §6.7, §8.3).
//   /h/ai/events/latest.json   departures and clashes with their actors (the watcher writes it; the row shape is not
//                              pinned by the contract, so the reader below accepts the field names a decoded herald
//                              row uses as well as the short ones, and ignores what it does not know)
//   /h/ai/chronicle/latest.json  {lines:[{kind, bell, actors:[tag], ai:[bool], by, refs, text?}]}
//
// Badges: an actor's badge comes from the roster only. The `ai` flags and `kind` hints in these files are ignored
// (a hostile or mistaken file cannot make a citizen look like an AI, or hide one). A departure shows its
// destination as sealed; a destination appears only when the file carries one (the public REVEAL), never from text.
import { actorEl, int, placeText, tplNodes } from './parts.mjs';
import { tagKey } from './badges.mjs';
import { nationName, pick } from './lang.mjs';

const str = v => (typeof v === 'string' ? v : '');
const num = v => (Number.isFinite(Number(v)) && v !== null && v !== '' && typeof v !== 'boolean' ? Number(v) : null);
const arr = v => (Array.isArray(v) ? v : []);
const pq = o => (o && typeof o === 'object' && num(o.p) !== null && num(o.q) !== null ? { p: num(o.p), q: num(o.q) } : null);

function actorOf(v) {
  if (v && typeof v === 'object') return { tag: tagKey(v.tag ?? v.citizen ?? v.owner), wallet: str(v.wallet) };
  return { tag: tagKey(v), wallet: '' };
}

/** `events/latest.json` → rows `{kind: 'depart'|'clash'|'other', bell, actors:[{tag,wallet}], faction, troops, from, arrive, to, at, engagements, lost:[{faction, n}]}`. */
export function normalizeEvents(file) {
  const rows = Array.isArray(file) ? file : arr(file?.events ?? file?.rows ?? file?.items);
  const out = [];
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const k = str(r.kind).toLowerCase();
    const kind = /depart/.test(k) ? 'depart' : /clash/.test(k) ? 'clash' : 'other';
    const actors = [];
    for (const a of [r.actor, r.tag, r.citizen, r.owner]) if (a !== undefined && a !== null) actors.push(actorOf(a));
    for (const a of arr(r.actors)) actors.push(actorOf(a));
    for (const a of arr(r.fighters)) actors.push(actorOf(a));
    const lost = [];
    if (r.lost && typeof r.lost === 'object' && !Array.isArray(r.lost)) for (const [f, n] of Object.entries(r.lost)) { if (num(f) !== null && num(n) !== null) lost.push({ faction: num(f), n: num(n) }); }
    else for (const l of arr(r.lost ?? r.losses)) if (num(l?.faction ?? l?.nation) !== null && num(l?.n ?? l?.troops ?? l?.lost) !== null) lost.push({ faction: num(l.faction ?? l.nation), n: num(l.n ?? l.troops ?? l.lost) });
    out.push({
      kind, bell: num(r.bell) ?? num(r.arrive_bell) ?? 0, actors: actors.filter(a => a.tag || a.wallet),
      faction: num(r.faction ?? r.nation), troops: num(r.troops ?? r.mass ?? r.dep_mass),
      from: pq(r.from ?? r.origin) ?? (num(r.origin_p) !== null ? { p: num(r.origin_p), q: num(r.origin_q) } : null),
      arrive: num(r.arrive_bell ?? r.arrive), to: pq(r.destination ?? r.to),
      at: pq(r.at) ?? (num(r.p) !== null && num(r.q) !== null ? { p: num(r.p), q: num(r.q) } : null),
      engagements: num(r.engagements), lost,
    });
  }
  out.sort((a, b) => b.bell - a.bell);
  return out;
}

/** `chronicle/latest.json` → lines `{kind, bell, actors:[tag], by, refs, text}`; newest first. */
export function normalizeChronicle(file) {
  const lines = Array.isArray(file) ? file : arr(file?.lines);
  const out = [];
  for (const l of lines) {
    if (!l || typeof l !== 'object') continue;
    const text = l.text && typeof l.text === 'object' ? { en: str(l.text.en) || str(l.text.ja), ja: str(l.text.ja) || str(l.text.en) } : str(l.text) ? { en: str(l.text), ja: str(l.text) } : null;
    out.push({ kind: str(l.kind), bell: num(l.bell) ?? 0, actors: arr(l.actors).map(tagKey).filter(Boolean), by: l.by === 'model' || l.by === 'autopilot' ? l.by : null, refs: arr(l.refs).filter(x => typeof x === 'string'), text });
  }
  out.sort((a, b) => b.bell - a.bell);
  return out;
}

/** Bells of `ai_march_opened` lines: where the release job wrote `open/<bell>.json` (a hint for the page's probes). */
export const openedBellsFromChronicle = lines => lines.filter(l => l.kind === 'ai_march_opened').map(l => l.bell);

/** "Aster lost 120, Ember lost 340" */
export function lostText(ctx, lost) {
  const { t, lang } = ctx;
  if (!lost.length) return t('ev.clash_lost_none');
  return lost.map(l => t('ev.clash_lost', { nation: nationName(l.faction, lang), n: int(l.n) })).join(', ');
}

// ------------------------------------------------------------------ render
export function renderEvent(ctx, e) {
  const { h, t, lang } = ctx;
  const li = h('li', { class: `event event-${e.kind}` });
  li.appendChild(h('span', { class: 'bellmark' }, t('page.bell_n', { n: int(e.bell) })));
  li.appendChild(h('span', { class: 'chip' }, t(`ev.kind.${e.kind}`)));
  if (e.kind === 'depart') {
    const who = e.actors[0] ? actorEl(ctx, e.actors[0], {}) : h('span', { class: 'actor-name' }, t('badge.unlabelled'));
    const from = e.from ? placeText(t, e.from.p, e.from.q) : '?';
    const key = e.to ? 'ev.depart_open' : e.troops !== null ? 'ev.depart' : 'ev.depart_notroops';
    const vars = { troops: int(e.troops), from, arrive: e.arrive !== null ? int(e.arrive) : '?', to: e.to ? placeText(t, e.to.p, e.to.q) : '' };
    li.appendChild(h('span', { class: 'event-text' }, tplNodes(t(key, vars), { who }), e.faction !== null ? h('span', { class: 'muted' }, ` (${t('ev.nation', { name: nationName(e.faction, lang) })})`) : null));
  } else if (e.kind === 'clash') {
    const at = e.at ? placeText(t, e.at.p, e.at.q) : '?';
    const sides = [e.engagements !== null ? t('ev.clash_engagements', { n: int(e.engagements) }) : null, lostText(ctx, e.lost)].filter(Boolean).join('; ');
    li.appendChild(h('span', { class: 'event-text' }, t('ev.clash', { at, bell: int(e.bell), sides })));
    if (e.actors.length) li.appendChild(h('span', { class: 'event-actors' }, e.actors.map(a => h('span', { class: 'event-actor' }, actorEl(ctx, a, {})))));
  } else li.appendChild(h('span', { class: 'event-text' }, e.actors.map(a => actorEl(ctx, a, {}))));
  return li;
}

export function renderEvents(ctx, rows, { limit = 40 } = {}) {
  const { h, t } = ctx;
  const box = h('div', { class: 'events' });
  if (!rows.length) { box.appendChild(h('p', { class: 'empty' }, t('ev.none'))); return box; }
  const ul = h('ul', { class: 'event-list' });
  for (const e of rows.slice(0, limit)) ul.appendChild(renderEvent(ctx, e));
  box.appendChild(ul);
  return box;
}

export function renderChronicle(ctx, lines, { limit = 40 } = {}) {
  const { h, t, lang } = ctx;
  const box = h('div', { class: 'chronicle' });
  if (!lines.length) { box.appendChild(h('p', { class: 'empty' }, t('chron.none'))); return box; }
  const ul = h('ul', { class: 'chron-list' });
  for (const l of lines.slice(0, limit)) {
    const kindKey = `chron.kind.${l.kind}`;
    const label = t(kindKey) === kindKey ? l.kind : t(kindKey);
    const li = h('li', { class: 'chron' },
      h('span', { class: 'bellmark' }, t('page.bell_n', { n: int(l.bell) })),
      h('span', { class: 'chip' }, label),
      l.by ? h('span', { class: `chip ${l.by === 'model' ? 'chip-model' : 'chip-auto'}` }, t(l.by === 'model' ? 'chron.by_model' : 'chron.by_autopilot')) : null,
      l.text ? h('span', { class: 'chron-text' }, pick(l.text, lang)) : null,
      l.actors.length ? h('span', { class: 'event-actors' }, l.actors.map(a => h('span', { class: 'event-actor' }, actorEl(ctx, { tag: a }, {})))) : null);
    ul.appendChild(li);
  }
  box.appendChild(ul);
  return box;
}
