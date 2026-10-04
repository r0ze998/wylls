// The roster and the Wyll cards (contract §2.4, §5.5 "What the page prints", §8.3). The roster lists every AI
// citizen with its badge from the signed roster, the script bots as a counted group labelled "script bot: not AI,
// not human", and the presenter seat. A card shows persona and creed, goals (a goal whose progress is `null` prints
// "progress not computed", never 0), relationships (trust split into the code part and the model part), the memory
// block (the model-written self-summary labelled as such, the recent episodes as code-written lines with the roster
// badge beside every citizen name, open and answered grievances), the published reasons with their Remembered lines,
// and the by:model share next to the by:autopilot count.
import { badgeOf } from './badges.mjs';
import { actorEl, badgeEl, int, kv, lineEl } from './parts.mjs';
import { nationName, pick } from './lang.mjs';

const str = v => (typeof v === 'string' ? v : '');
const num = v => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);
const bi = v => (v && typeof v === 'object' ? { en: str(v.en) || str(v.ja), ja: str(v.ja) || str(v.en) } : { en: str(v), ja: str(v) });

export const TEMPERAMENT_KEYS = Object.freeze(['aggression', 'loyalty', 'ambition', 'honesty', 'risk', 'sociability', 'grudge']);
/** §2.1: 0–19 very low, 20–39 low, 40–59 moderate, 60–79 high, 80–100 very high → index 0..4. */
export const temperamentIndex = v => Math.max(0, Math.min(4, Math.floor(Number(v) / 20)));

/** Goal progress for printing: a number 0..100, or null ("progress not computed"). `undefined`, NaN and text are null too. */
export function progressOf(p) {
  if (p === null || p === undefined || typeof p === 'boolean') return null;
  const n = typeof p === 'number' ? p : NaN;
  return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : null;
}

/** `{model, autopilot, total, pct}`; pct is null until an action was sent. */
export function byModelShare(stats) {
  const m = Math.max(0, num(stats?.actions_by_model) ?? 0);
  const a = Math.max(0, num(stats?.actions_by_autopilot) ?? 0);
  const total = m + a;
  return { model: m, autopilot: a, total, pct: total > 0 ? Math.round((100 * m) / total) : null };
}

/** A card file (§2.4) → what the page prints. Anything malformed becomes an empty field, never an exception. */
export function normalizeCard(raw) {
  if (!raw || typeof raw !== 'object' || raw.v !== 1 || typeof raw.tag !== 'string') return null;
  const per = raw.persona && typeof raw.persona === 'object' ? raw.persona : {};
  const mem = raw.memory && typeof raw.memory === 'object' ? raw.memory : {};
  const arr = v => (Array.isArray(v) ? v : []);
  return {
    tag: raw.tag.toLowerCase(),
    faction: Number.isInteger(raw.faction) ? raw.faction : null,
    name: bi(raw.name),
    label: bi(raw.label),
    persona: {
      id: str(per.id),
      ambition: str(per.ambition),
      creed: bi(per.creed),
      temperament: TEMPERAMENT_KEYS.filter(k => num(per.temperament?.[k]) !== null).map(k => ({ key: k, value: num(per.temperament[k]), word: temperamentIndex(per.temperament[k]) })),
    },
    goals: arr(raw.goals).map(g => ({
      id: str(g?.id), text: bi(g?.text), progress: progressOf(g?.progress),
      status: ['active', 'done', 'dropped'].includes(g?.status) ? g.status : 'active', memory: !!g?.memory,
    })),
    relationships: arr(raw.relationships).slice(0, 8).map(r => {
      const trust = num(r?.trust) ?? 0;
      return {
        who: str(r?.who), kind: r?.kind === 'nation' ? 'nation' : 'citizen', name: bi(r?.name), trust,
        code: num(r?.trust_code) ?? 0, model: num(r?.trust_model) ?? 0, lastBell: num(r?.last_event_bell),
      };
    }),
    summary: mem.summary && typeof mem.summary === 'object' && str(mem.summary.text)
      ? { bell: num(mem.summary.bell), text: str(mem.summary.text), sha256: str(mem.summary.sha256), label: bi(mem.summary.label) } : null,
    recent: arr(mem.recent).slice(-5).map(e => ({ id: str(e?.id), bell: num(e?.bell), kind: str(e?.kind), text: bi(e?.text) })),
    grievances: arr(mem.grievances).slice(0, 5).map(g => ({
      against: str(g?.against), name: bi(g?.name), episode: str(g?.episode), bell: num(g?.bell), weight: num(g?.weight) ?? 0, answered: !!g?.answered,
    })),
    reasons: arr(raw.revealed_reasons).slice(-5).map(r => ({
      // FB4: an unknown `by` stays unknown (null): the page never claims "model" for a reason that does not say so
      bell: num(r?.bell), decision_id: str(r?.decision_id), by: r?.by === 'autopilot' ? 'autopilot' : r?.by === 'model' ? 'model' : null, why: str(r?.why),
      remembered: arr(r?.remembered).map(m => ({ id: str(m?.id), bell: num(m?.bell), age: num(m?.age_bells), text: bi(m?.text) })),
    })),
    budget: raw.budget && typeof raw.budget === 'object' ? { messages_left: num(raw.budget.messages_left), reactions_left: num(raw.budget.reactions_left), resting: !!raw.budget.resting } : null,
    stats: raw.stats && typeof raw.stats === 'object' ? raw.stats : {},
    updatedBell: num(raw.updated_bell),
  };
}

/** One row per AI citizen of the roster (ordered by nation, then index), each with its card if one has been published. */
export function rosterModel(index, cards = new Map()) {
  return [...index.ai].sort((a, b) => (a.faction ?? 99) - (b.faction ?? 99) || (a.index ?? 0) - (b.index ?? 0)).map(entry => {
    const card = cards.get(entry.tag) ?? null;
    return { entry, card, share: card ? byModelShare(card.stats) : null, resting: !!card?.budget?.resting };
  });
}

// ------------------------------------------------------------------ render: roster
export function renderRoster(ctx, index, cards, { selected = null, onSelect = () => {} } = {}) {
  const { h, t, lang } = ctx;
  const rows = rosterModel(index, cards);
  const box = h('div', { class: 'roster' });
  if (!index.ready) { box.appendChild(h('p', { class: 'empty' }, t('roster.none'))); return box; }
  box.appendChild(h('h3', null, t('roster.ai_heading', { n: rows.length })));
  box.appendChild(h('p', { class: 'muted' }, t('roster.ai_note'), index.deck ? ` (${t('roster.deck', { deck: index.deck })})` : ''));
  const list = h('ul', { class: 'roster-list' });
  for (const r of rows) {
    const e = r.entry;
    const sh = r.share;
    const shareText = sh && sh.pct !== null ? t('roster.share', { pct: sh.pct }) : t('roster.share_none');
    const btn = h('button', { type: 'button', class: `roster-item${selected === e.tag ? ' selected' : ''}`, 'aria-pressed': selected === e.tag ? 'true' : 'false', 'data-tag': e.tag, on: { click: () => onSelect(e.tag) } },
      h('span', { class: 'roster-main' }, actorEl(ctx, { tag: e.tag, wallet: e.wallet })),
      h('span', { class: 'roster-sub' }, `${nationName(e.faction, lang)} · ${pick(e.ambition, lang)}`),
      h('span', { class: 'roster-sub' }, shareText, r.resting ? ` · ${t('roster.resting')}` : ''));
    list.appendChild(h('li', null, btn));
  }
  box.appendChild(list);
  box.appendChild(h('h3', null, t('roster.script_heading')));
  box.appendChild(h('p', { class: 'roster-group' }, badgeEl(ctx, { look: 'script', labelKey: 'badge.script', shortKey: 'badge.script_short' }), ' ', t('roster.script_body', { n: index.scriptCount })));
  if (index.seat) {
    const b = badgeOf(index, { tag: index.seat.tag, wallet: index.seat.wallet });
    box.appendChild(h('h3', null, t('roster.seat_heading')));
    box.appendChild(h('p', { class: 'roster-group' }, badgeEl(ctx, b, { long: true }), ' ', t(index.seat.scripted ? 'roster.seat_body_scripted' : 'roster.seat_body'), ` (${t('card.nation', { name: nationName(index.seat.faction, lang) })})`));
  }
  return box;
}

// ------------------------------------------------------------------ render: card
function memoryLines(ctx, items, episodesById, tag) {
  const { h, t } = ctx;
  const ul = h('ul', { class: 'lines' });
  for (const e of items) {
    const ep = episodesById?.get?.(e.id);
    ul.appendChild(h('li', null,
      h('span', { class: 'bellmark' }, t('page.bell_n', { n: int(e.bell) })), ' ',
      lineEl(ctx, e.text, ep?.entities ?? [], { cls: 'line' })));
  }
  void tag;
  return ul;
}

/** The "Remembered" lines of a published reason: code text only (see decisions.mjs for the full decision view). */
export function reasonLines(ctx, remembered, episodesById) {
  const { h, t } = ctx;
  if (!remembered.length) return h('p', { class: 'remembered-none' }, t('dec.remembered_none'));
  const ul = h('ul', { class: 'lines remembered' });
  for (const m of remembered) {
    const ep = episodesById?.get?.(m.id);
    ul.appendChild(h('li', null,
      lineEl(ctx, m.text, ep?.entities ?? [], { cls: 'line' }), ' ',
      h('span', { class: 'bellmark' }, `${t('page.bell_n', { n: int(m.bell) })}${m.age !== null && m.age !== undefined ? ` · ${t('page.age_bells', { n: int(m.age) })}` : ''}`)));
  }
  return ul;
}

export function renderCard(ctx, card, entry, { episodesById = null } = {}) {
  const { h, t, lang, index } = ctx;
  const box = h('div', { class: 'card' });
  if (!card) {
    box.appendChild(h('p', { class: 'empty' }, entry ? t('page.unavailable') : t('card.pick')));
    return box;
  }
  const name = entry?.name ?? card.name;
  box.appendChild(h('div', { class: 'card-head' },
    h('h3', null, h('span', { class: 'actor-name' }, pick(name, lang)), ' ', badgeEl(ctx, badgeOf(index, { tag: card.tag }), { long: true })),
    h('p', { class: 'muted' }, pick(card.label, lang) || t('card.label')),
    h('p', { class: 'card-sub' }, `${t('card.nation', { name: nationName(card.faction, lang) })} · ${t('card.persona', { name: entry ? pick(entry.ambition, lang) : card.persona.ambition })}`)));

  // creed and temperament
  if (pick(card.persona.creed, lang)) box.appendChild(h('blockquote', { class: 'creed', 'aria-label': t('card.creed') }, pick(card.persona.creed, lang)));
  if (card.persona.temperament.length) {
    const dl = h('div', { class: 'temper', 'aria-label': t('card.temperament') });
    for (const tr of card.persona.temperament) dl.appendChild(h('span', { class: 'chip' }, `${t(`temp.${tr.key}`)}: ${t(`temp.w${tr.word}`)}`));
    box.appendChild(dl);
  }

  // who acted: the by:model share is always printed with the by:autopilot count
  const sh = byModelShare(card.stats);
  const st = card.stats;
  const stats = h('div', { class: 'section' }, h('h4', null, t('card.stats')),
    h('p', null, t('card.stats_line', { m: sh.model, a: sh.autopilot })),
    h('p', { class: 'muted' }, sh.pct === null ? t('card.stats_share_none') : t('card.stats_share', { pct: sh.pct })),
    h('p', { class: 'muted' }, t('card.stats_marches', { m: int(st.model_marches ?? 0), o: int(st.model_marches_opened ?? 0) })),
    h('p', { class: 'muted' }, t('card.stats_decisions', { d: int(st.decisions ?? 0), v: int(st.valid ?? 0), c: int(st.decisions_citing_memory ?? 0) })),
    h('p', { class: 'muted' }, t('card.stats_reflections', { r: int(st.reflections ?? 0), o: int(st.reflections_ok ?? 0) })),
    h('p', { class: 'muted' }, t('card.stats_messages', { n: int(st.messages ?? 0), s: int(st.strikes_declined ?? 0) })));
  if (card.budget) {
    stats.appendChild(h('p', { class: card.budget.resting ? 'resting' : 'muted' }, card.budget.resting ? t('card.budget_resting') : t('card.budget', { m: int(card.budget.messages_left ?? 0), r: int(card.budget.reactions_left ?? 0) })));
  }
  box.appendChild(stats);

  // goals
  const goals = h('div', { class: 'section' }, h('h4', null, t('card.goals')));
  const gl = h('ul', { class: 'goals' });
  for (const g of card.goals) {
    const pr = g.progress;
    gl.appendChild(h('li', { class: 'goal' },
      h('span', { class: 'goal-id' }, g.id), ' ', h('span', { class: 'goal-text' }, pick(g.text, lang)),
      g.memory ? h('span', { class: 'chip chip-memory' }, t('card.goal_memory')) : null,
      h('span', { class: 'goal-progress' },
        pr === null ? h('span', { class: 'not-computed' }, t('card.progress_not_computed'))
          : h('span', null, h('meter', { min: 0, max: 100, value: pr, 'aria-label': t('card.progress', { n: pr }) }), ' ', t('card.progress', { n: pr })),
        ' ', h('span', { class: 'muted' }, t(`card.status.${g.status}`)))));
  }
  goals.appendChild(gl);
  box.appendChild(goals);

  // relationships
  const rel = h('div', { class: 'section' }, h('h4', null, t('card.relationships')));
  if (!card.relationships.length) rel.appendChild(h('p', { class: 'empty' }, t('card.rel_none')));
  else {
    const ul = h('ul', { class: 'rels' });
    for (const r of card.relationships) {
      const who = r.kind === 'nation'
        ? h('span', { class: 'actor-name' }, pick(r.name, lang) || nationName(Number(r.who.slice(7)), lang))
        : actorEl(ctx, { tag: r.who }, { fallback: r.name });
      ul.appendChild(h('li', null, who, ' ', h('span', { class: 'trust' }, t('card.trust', { n: r.trust })), ' ', h('span', { class: 'muted' }, t('card.trust_split', { code: r.code, model: r.model }))));
    }
    rel.appendChild(ul);
  }
  box.appendChild(rel);

  // memory block
  const mem = h('div', { class: 'section memory' }, h('h4', null, t('card.memory')));
  mem.appendChild(h('h5', null, t('card.summary')));
  if (card.summary) {
    mem.appendChild(h('p', { class: 'summary-text' }, card.summary.text));
    // FB4: the label is the page's own fixed text, never the card file's (a file cannot soften or drop it)
    mem.appendChild(h('p', { class: 'muted' }, `${t('card.summary_label')} ${card.summary.bell !== null ? `(${t('card.summary_bell', { n: int(card.summary.bell) })})` : ''}`));
  } else mem.appendChild(h('p', { class: 'empty' }, t('card.summary_none')));
  mem.appendChild(h('h5', null, t('card.recent')));
  mem.appendChild(card.recent.length ? memoryLines(ctx, card.recent, episodesById, card.tag) : h('p', { class: 'empty' }, t('card.recent_none')));
  mem.appendChild(h('h5', null, t('card.grievances')));
  if (!card.grievances.length) mem.appendChild(h('p', { class: 'empty' }, t('card.grievances_none')));
  else {
    const ul = h('ul', { class: 'grievances' });
    for (const g of card.grievances) {
      const who = String(g.against).startsWith('nation:')
        ? h('span', { class: 'actor-name' }, pick(g.name, lang) || nationName(Number(g.against.slice(7)), lang))
        : actorEl(ctx, { tag: g.against }, { fallback: g.name });
      ul.appendChild(h('li', null, h('span', { class: g.answered ? 'chip chip-answered' : 'chip chip-open' }, t(g.answered ? 'card.grievance_answered' : 'card.grievance_open')), ' ',
        h('span', { class: 'muted' }, t('card.grievance_who')), ' ', who, ' ', h('span', { class: 'muted' }, `${t('page.bell_n', { n: int(g.bell) })} · ${int(g.weight)}`)));
    }
    mem.appendChild(ul);
  }
  box.appendChild(mem);

  // published reasons
  const rs = h('div', { class: 'section' }, h('h4', null, t('card.reasons')));
  if (!card.reasons.length) rs.appendChild(h('p', { class: 'empty' }, t('card.reasons_none')));
  for (const r of [...card.reasons].reverse()) {
    rs.appendChild(h('div', { class: 'reason' },
      h('div', { class: 'reason-head' }, h('span', { class: 'bellmark' }, t('page.bell_n', { n: int(r.bell) })), ' ', h('span', { class: `chip ${r.by === 'model' ? 'chip-model' : r.by === 'autopilot' ? 'chip-auto' : ''}`.trim() }, t(r.by === 'model' ? 'dec.by_model' : r.by === 'autopilot' ? 'dec.by_autopilot' : 'dec.by_unknown'))),
      // FB4: the "model-written" label is printed only where a model could have written the text; an autopilot step has no model words
      r.by === 'autopilot' ? h('p', { class: 'words muted' }, t('dec.words_autopilot')) : [
        h('p', { class: 'words-label' }, t('dec.words')),
        h('p', { class: 'words' }, r.why || t('dec.words_none'))],
      h('p', { class: 'remembered-label' }, t('dec.remembered')),
      reasonLines(ctx, r.remembered, episodesById)));
  }
  box.appendChild(rs);

  box.appendChild(h('p', { class: 'muted small' }, card.updatedBell !== null ? t('card.updated', { n: int(card.updatedBell) }) : '', ' ', t('card.privacy')));
  return box;
}
