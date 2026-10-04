// The MEMORY block of the prompt (contract §5.5, §4.7):
//
//   renderMemory(ownState, focus, budget) -> {block, handles, ids, chandles, tokens, cut}
//
// ownState = {tag, bell, ledger (a Ledger snapshot), episodes (Episodes), summary ({bell,text}|null), persona (goals),
//             progress ({G1: n}) }   -- only the AI's OWN state reaches here (§5.6); nothing of any other AI.
// focus    = the entity strings of §5.2 ("<tag>", "nation:<f>", "pq:p,q"), as an array or a Set.
// budget   = {tokens = 750, count?: text -> tokens (llama /tokenize in the mind), handleOf?: who -> "C2" | "N3"}
//
// Content: goals with progress; open grievances (<= 3); RELATIONS (<= 5 citizens or nations the focus names, trust
// with its code and model parts); the self-summary (wrapped, absent when none); the Remembered lines M1..Mk
// (episodes, oldest first, "Mn [bell b] <memory kind="episode" id="Mn">code text</memory>"). Episode text is
// code-templated (no player text) and passes the sanitiser again here; the summary is model-written and is
// sanitised as such (braces, brackets and M<digits> imitations neutralised, step 5b).
// Over budget: drop the oldest Remembered lines first (never below the 3 newest, never an open-grievance source),
// then trim RELATIONS and grievances, then the summary. Candidates are never in this block (never cut).
import { retrieve, protectedIds, focusSet } from './retrieve.mjs';
import { safeText } from './safe.mjs';
import { nameOf, nationName } from '../persona/names.mjs';

export const MEMORY_BUDGET_TOKENS = 750;
/** A coarse token estimate for tests and a tokenizer-less run: 1 token per 3 characters (the mind passes llama /tokenize counts). */
export const estimateTokens = s => Math.ceil([...String(s)].length / 3);

const sgn = n => (n > 0 ? `+${n}` : String(n));
const clampTrust = v => Math.min(100, Math.max(-100, v));

function whoLabel(who) {
  if (String(who).startsWith('nation:')) return `nation ${nationName(Number(String(who).slice(7))).en}`;
  return nameOf(who).en;
}

export function renderMemory(ownState, focus, budget = {}) {
  const count = budget.count ?? estimateTokens;
  const limit = budget.tokens ?? MEMORY_BUDGET_TOKENS;
  const bell = ownState.bell ?? 0;
  const led = ownState.ledger ?? { goals: [], grievances: [], trust: { citizens: {}, nations: {} } };
  const episodes = ownState.episodes;
  const f = focusSet(focus);
  const all = typeof episodes.list === 'function' ? episodes.list() : episodes;
  const byId = new Map(all.map(e => [e.id, e]));
  const grievances = (led.grievances ?? []).map(g => ({ event: g.event, bell: g.bell, answered: g.answered }));
  const ids = retrieve(all, f, bell, { grievances });
  const keep = protectedIds(byId, ids, grievances);

  // handles for citizens and nations in RELATIONS
  const chandles = {};
  const handleFor = who => {
    const given = budget.handleOf?.(who);
    if (given) { chandles[given] = who; return given; }
    let h = String(who).startsWith('nation:') ? `N${String(who).slice(7)}` : null;
    if (!h) { const n = Object.keys(chandles).filter(k => k.startsWith('C')).length + 1; h = `C${n}`; }
    chandles[h] = who;
    return h;
  };

  const relationsAll = [];
  for (const [t, e] of Object.entries(led.trust?.citizens ?? {})) if (f.has(t)) relationsAll.push([t, e]);
  for (const [n, e] of Object.entries(led.trust?.nations ?? {})) if (f.has(`nation:${n}`)) relationsAll.push([`nation:${n}`, e]);
  relationsAll.sort((a, b) => Math.abs(clampTrust(b[1].t_code + b[1].t_model)) - Math.abs(clampTrust(a[1].t_code + a[1].t_model)) || (a[0] < b[0] ? -1 : 1));
  const openG = (led.grievances ?? []).filter(g => !g.answered).sort((a, b) => b.bell - a.bell || (a.id < b.id ? -1 : 1));

  const goalLines = (ownState.persona?.goals ?? []).map(g => {
    const lg = (led.goals ?? []).find(x => x.id === g.id);
    const p = ownState.progress?.[g.id] ?? lg?.progress ?? 0;
    const status = lg && lg.status !== 'active' ? ` [${lg.status}]` : '';
    return safeText(`${g.id} ${g.text.en} (progress ${p}%)${status}`);
  });

  const build = ({ ids: use, nRel, nGriev, withSummary }) => {
    for (const k of Object.keys(chandles)) delete chandles[k];
    const handles = {};
    const lines = ['MEMORY'];
    if (goalLines.length) lines.push('Goals:', ...goalLines.map(l => `- ${l}`));
    if (nGriev > 0 && openG.length) {
      lines.push('Open grievances:');
      for (const g of openG.slice(0, nGriev)) lines.push(`- against ${safeText(whoLabel(g.against))} since bell ${g.bell} (weight ${g.weight})`);
    }
    if (nRel > 0 && relationsAll.length) {
      lines.push('Relations:');
      for (const [who, e] of relationsAll.slice(0, nRel)) {
        const total = clampTrust(e.t_code + e.t_model);
        lines.push(`- ${handleFor(who)} ${safeText(whoLabel(who))}: ${sgn(total)} (code ${sgn(e.t_code)}, model ${sgn(e.t_model)})`);
      }
    }
    if (withSummary && ownState.summary?.text) {
      lines.push(`<memory kind="self-summary" bell="${Number(ownState.summary.bell)}">${safeText(ownState.summary.text, { kind: 'summary', limit: 1200 })}</memory>`);
    }
    lines.push('Remembered:');
    if (!use.length) lines.push('(nothing remembered yet)');
    use.forEach((id, i) => {
      const e = byId.get(id), h = `M${i + 1}`;
      handles[h] = id;
      lines.push(`${h} [bell ${e.bell}] <memory kind="episode" id="${h}">${safeText(e.text.en, { kind: 'trusted' })}</memory>`);
    });
    return { block: lines.join('\n'), handles };
  };

  const state = { ids, nRel: Math.min(5, relationsAll.length), nGriev: Math.min(3, openG.length), withSummary: true };
  const cut = { episodes: 0, relations: 0, grievances: 0, summary: false };
  let r = build(state);
  while (count(r.block) > limit) {
    const drop = state.ids.find(id => !keep.has(id));
    if (drop !== undefined) { state.ids = state.ids.filter(id => id !== drop); cut.episodes++; }
    else if (state.nRel > 3) { state.nRel = 3; cut.relations++; }
    else if (state.nGriev > 2) { state.nGriev = 2; cut.grievances++; }
    else if (state.withSummary && ownState.summary?.text) { state.withSummary = false; cut.summary = true; }
    else if (state.nRel > 0) { state.nRel = 0; cut.relations++; }
    else break;
    r = build(state);
  }
  return { block: r.block, handles: r.handles, ids: state.ids, chandles: { ...chandles }, tokens: count(r.block), cut };
}
