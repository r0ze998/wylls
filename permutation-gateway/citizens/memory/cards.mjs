// The Wyll card (contract §2.4): `renderCard(state) -> card JSON` for PUB/cards/<tag>.json, written by the
// watcher. Pure; every string passes the sanitiser stand-in. Names come from nameOf (never a profile).
//
// state = {
//   tag, wallet, faction, index, bell,
//   persona (deal.mjs personaOf(entry) + name/nation), ledger (snapshot), episodes (Episodes), summary ({bell,text,sha256}|null),
//   progress ({G1: n}), revealed ([{bell, decision_id, by, why, remembered:[{id,bell,text}]}]),
//   budget ({messages_left, reactions_left}), stats ({...§2.4 stats})
// }
// The summary is published live and labelled as written by the model; it is never replayed (§5.3).
import { MAX_GRIEVANCES } from './config.mjs';
import { SUMMARY_LABEL } from './summary.mjs';
import { safeText } from './safe.mjs';
import { nameOf, nationName, tagHex } from '../persona/names.mjs';

export const CARD_LABEL = Object.freeze({
  en: 'AI citizen — run by the operator with Gemma 4 (local). Same rules and quotas as people.',
  ja: 'AI市民（運営がローカルのGemma 4で動かしています）。人と同じルールと回数制限で遊びます。',
});

const clampTrust = v => Math.min(100, Math.max(-100, v));
const t2 = s => ({ en: safeText(s.en), ja: safeText(s.ja) });

function nameOfWho(who) {
  if (String(who).startsWith('nation:')) return nationName(Number(String(who).slice(7)));
  return nameOf(who);
}

/** The cited episodes of a decision as the card and the page show them: code text, bell and age in bells (never model text). */
export function rememberedFor(episodes, ids, decisionBell) {
  const out = [];
  for (const id of ids ?? []) {
    const e = episodes.get ? episodes.get(id) : episodes.find(x => x.id === id);
    if (e && !e.redacted) out.push({ id: e.id, bell: e.bell, age_bells: Math.max(0, decisionBell - e.bell), text: t2(e.text) });
  }
  return out;
}

export function renderCard(st) {
  const led = st.ledger;
  const bell = st.bell ?? 0;
  const dayCounters = led.counters ?? {};
  const relationships = [];
  for (const [t, e] of Object.entries(led.trust?.citizens ?? {})) relationships.push({ who: t, kind: 'citizen', e });
  for (const [n, e] of Object.entries(led.trust?.nations ?? {})) relationships.push({ who: `nation:${n}`, kind: 'nation', e });
  relationships.sort((a, b) => Math.abs(clampTrust(b.e.t_code + b.e.t_model)) - Math.abs(clampTrust(a.e.t_code + a.e.t_model)) || (a.who < b.who ? -1 : 1));
  const list = typeof st.episodes.list === 'function' ? st.episodes.list() : st.episodes;
  const recent = list.filter(e => e.created_bell <= bell && !e.redacted).slice(-5).map(e => ({ id: e.id, bell: e.bell, kind: e.kind, text: t2(e.text) }));
  const grievances = [...(led.grievances ?? [])].sort((a, b) => b.bell - a.bell || (a.id < b.id ? -1 : 1)).slice(0, MAX_GRIEVANCES)
    .map(g => ({ against: g.against, name: nameOfWho(g.against), episode: g.event, bell: g.bell, weight: g.weight, answered: !!g.answered }));
  const budget = st.budget ?? {};
  const messagesLeft = budget.messages_left ?? 0, reactionsLeft = budget.reactions_left ?? 0;
  return {
    v: 1, ai: true, label: { ...CARD_LABEL },
    tag: tagHex(st.tag), wallet: st.wallet, faction: st.faction, index: st.index,
    name: st.persona.name ?? nameOf(st.tag),
    persona: {
      id: st.persona.id, ambition: st.persona.ambition.en, creed: t2(st.persona.creed),
      temperament: { ...st.persona.temperament },
    },
    goals: st.persona.goals.map(g => {
      const lg = (led.goals ?? []).find(x => x.id === g.id);
      // progress null = not computed (the mind has no producer for that goal's facts)
      return { id: g.id, text: t2(g.text), progress: st.progress && g.id in st.progress ? st.progress[g.id] : lg && lg.progress !== undefined ? lg.progress : 0, status: lg?.status ?? 'active', memory: !!g.memory };
    }),
    relationships: relationships.slice(0, 8).map(r => ({
      who: r.who, name: nameOfWho(r.who), kind: r.kind, trust: clampTrust(r.e.t_code + r.e.t_model),
      trust_code: r.e.t_code, trust_model: r.e.t_model, last_event_bell: r.e.last_bell ?? 0,
    })),
    memory: {
      summary: st.summary ? { bell: st.summary.bell, text: safeText(st.summary.text, { kind: 'summary', limit: 1200 }), sha256: st.summary.sha256, label: { ...SUMMARY_LABEL } } : null,
      recent,
      grievances,
    },
    revealed_reasons: (st.revealed ?? []).slice(-5).map(r => ({
      bell: r.bell, decision_id: r.decision_id, by: r.by, why: safeText(r.why, { kind: 'trusted', limit: 200 }),
      remembered: (r.remembered ?? []).map(m => ({ id: m.id, bell: m.bell, age_bells: m.age_bells, text: m.text })),
    })),
    budget: { messages_left: messagesLeft, reactions_left: reactionsLeft, resting: messagesLeft <= 0 || reactionsLeft <= 0 },
    stats: {
      decisions: 0, valid: 0, reflections: 0, reflections_ok: 0, actions_by_model: 0, actions_by_autopilot: 0, model_marches: 0, model_marches_opened: 0,
      messages: dayCounters.messages ?? 0, strikes_declined: 0, decisions_citing_memory: 0, mem_dropped: 0, ...(st.stats ?? {}),
    },
    updated_bell: bell,
  };
}
