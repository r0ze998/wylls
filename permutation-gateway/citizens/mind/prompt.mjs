// Prompt rendering (contract section 5.5 and 5.6). The renderer takes exactly three views, nothing else
// reaches a prompt:  publicView (the same module that answers /f/ai/* and reads /h/*),
// ownState(tag) (ledger, episodes, summary, standing: this AI's alone) and memberView(f) (the sealed
// Call of the AI's own nation). It builds ONE system message (rules brief, identity and disclosure,
// output contract, untrusted and memory rules, persona) and ONE user message with six sections:
//   1 NOW + STATE (<= 550 tokens)  2 THREATS + COUNCIL (<= 300)  3 MEMORY (<= 750, from AC2's renderMemory)
//   4 INBOX + NATION HALL (<= 450) 5 CANDIDATES (<= 900)         6 TASK (<= 50)
// The variable part is capped at 3,000 tokens (counted with llama-server /tokenize, cached per text).
// Over budget: drop a sender's extra inbox lines first (keeping one per sender), then the oldest episodes
// (by re-asking renderMemory for a smaller block, never below the 3 newest: AC2's rule), then the hall,
// never the candidates. Templates live in prompts/*.txt; their concatenated sha256 is
// prompt_templates_sha256 (commitments). One user message, not six: Gemma's chat template alternates roles.
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { buildPeople } from './memory.mjs';
import { maxSayFor } from './schema.mjs';
import { merkleRootHex } from './records.mjs';

export const VARIABLE_BUDGET = 3000;
export const SECTION_BUDGETS = { state: 550, social_council: 300, memory: 750, inbox: 450, candidates: 900, task: 50 };
export const DEFAULT_RESOURCES = ['food', 'wood', 'stone', 'ore', 'horses', 'gold', 'science', 'influence'];
export const DEFAULT_UNITS = ['Spearman', 'Archer', 'Horseman', 'Pikeman', 'Crossbowman', 'Knight', 'Scout'];
const TEMPLATE_FILES = ['system', 'persona', 'session', 'reaction', 'motion', 'ballot', 'reflection'];
const SPEECH_LANG = { ja: 'Japanese', en: 'English' };

export function loadTemplates(dir) {
  const t = {};
  const parts = [];
  for (const k of TEMPLATE_FILES) {
    const text = readFileSync(`${dir}/${k}.en.txt`, 'utf8');
    t[k] = text.replace(/\n+$/, '');
    parts.push(text);
  }
  const extra = readdirSync(dir).filter((f) => f.endsWith('.txt') && !TEMPLATE_FILES.some((k) => f === `${k}.en.txt`)).sort();
  for (const f of extra) parts.push(readFileSync(`${dir}/${f}`, 'utf8'));
  return { t, sha256: createHash('sha256').update(parts.join('\u0000')).digest('hex') };
}

const fill = (tpl, vars) => tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] != null ? String(vars[k]) : ''));
const fmt = (v) => (Array.isArray(v) ? v.join(', ') : typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v));
const words = (k) => k.replace(/_/g, ' ');

/** Rough fallback when /tokenize is unreachable (tests, offline): conservative for English and kana. */
export const estimateTokens = (text) => Math.ceil(String(text).length / 3);

export function createPromptRenderer({ templatesDir, countTokens = null, speech, renderPersona, nameOf = null, config = {}, resources = DEFAULT_RESOURCES } = {}) {
  if (!templatesDir) throw new Error('createPromptRenderer: templatesDir required');
  const { t: T, sha256: templatesSha } = loadTemplates(templatesDir);
  const sanitize = (text, opts) => (speech?.sanitize ? speech.sanitize(text, opts) : String(text));
  const count = async (text) => {
    if (countTokens) {
      const n = await countTokens(text);
      if (n != null) return { n, estimated: false };
    }
    return { n: estimateTokens(text), estimated: true };
  };
  const nm = (tag, lang = 'en') => {
    const n = nameOf?.(tag);
    return (n && (n[lang] ?? n.en)) || `citizen ${String(tag).slice(0, 6)}`;
  };

  const wrap = (text, { from, ch, bell }) =>
    `<untrusted from="${sanitize(from, { limit: 48 })}" ch="${ch}" bell="${bell}">${sanitize(text, { limit: 280, untrusted: true })}</untrusted>`;

  // ---- section 1: NOW and STATE ---------------------------------------------------------------
  function stateLines(sit, { trimNeighbours = 0 } = {}) {
    const out = [];
    const me = sit.me ?? {};
    out.push(`NOW: bell ${sit.bell} (day ${sit.day}, bell ${sit.bell_in_day}/144), ${sit.secs_left} s left in this bell. Season ends at bell ${sit.end_bell}.`);
    out.push(`YOU: nation ${me.faction}${me.doctrine ? ` (${me.doctrine})` : ''}.`);
    const h = me.home;
    if (h) {
      const bits = [`HOME: (${h.p},${h.q}) site ${h.site ?? '?'}, tier ${h.tier ?? '?'}, ${h.final ? 'final' : 'provisional'}`];
      if (h.shield_until_bell != null) bits.push(`your village shield lasts until bell ${h.shield_until_bell}`);
      if (h.walls != null) bits.push(`walls ${h.walls}`);
      out.push(bits.join(', ') + '.');
    }
    if (Array.isArray(me.stores)) {
      const rates = me.rates_per_hour ?? [];
      out.push(`STORES: ${me.stores.map((v, i) => `${resources[i] ?? `r${i}`} ${v}${rates[i] ? ` (${rates[i] >= 0 ? '+' : ''}${rates[i]}/h)` : ''}`).join(', ')}`);
    }
    if (me.queue) {
      const items = (me.queue.items ?? []).map((q) => `${q.what} done in ${q.done_in_min} min`).join('; ');
      out.push(`QUEUE: ${me.queue.busy}/${me.queue.slots} busy${items ? `: ${items}` : ''}.`);
    }
    if (Array.isArray(me.reserve)) {
      const r = me.reserve.map((v, i) => (v > 0 ? `${DEFAULT_UNITS[i] ?? `u${i}`} ${v}` : null)).filter(Boolean).join(', ');
      out.push(`RESERVE (trained, not mustered): ${r || 'none'}.`);
    }
    if (me.home_troops != null) {
      out.push(`TROOPS AT HOME: ${me.home_troops} (garrison ${me.garrison ?? 0}); at the start of this game day: ${me.home_troops_day_start ?? me.home_troops}.`);
    }
    out.push('HOSTS:');
    if (!(me.hosts ?? []).length) out.push('  none');
    for (const x of me.hosts ?? []) {
      let s = `  ${x.handle} ${x.unit ?? ''} ${x.troops} troops at (${x.at?.p},${x.at?.q}), stamina ${x.stamina}, `;
      if (x.in_transit) s += `in transit${x.arrive_bell != null ? `, arrives bell ${x.arrive_bell}` : ''}`;
      else s += x.ready ? 'ready' : `not ready${x.why_not ? ` (${x.why_not})` : ''}`;
      if (x.idle_bells != null && x.ready) s += `, idle ${x.idle_bells} bells`;
      out.push(s);
    }
    out.push(`EXPLORATION: ${me.explore ?? 'idle'}. MUSTER ROOM: ${me.muster_room ?? 0} more host(s).`);
    if (me.quota) out.push(`ACTIONS LEFT: ${me.quota.bucket_left} in your hourly bucket, ${me.quota.relay_left} relay actions today.`);
    const prov = [...(sit.neighbourhood ?? [])];
    const shown = trimNeighbours ? prov.slice(0, Math.max(0, prov.length - trimNeighbours)) : prov;
    if (shown.length) {
      out.push('NEIGHBOURHOOD (provinces you can see; d = distance in provinces):');
      for (const p of shown) {
        const hs = (p.hosts ?? []).map((x) => `nation ${x.nation} ${x.n}/${x.troops}`).join(', ');
        const hd = Object.entries(p.holdings ?? {}).map(([n, c]) => `nation ${n} x${c}`).join(' ');
        out.push(`  (${p.p},${p.q}) d=${p.d}: ${p.camp_troops != null ? `camp ${p.camp_troops} troops` : 'no camp'}${hd ? `; villages ${hd}` : ''}${hs ? `; hosts ${hs} (hosts/troops)` : '; no hosts'}`);
      }
    }
    if ((sit.my_clashes ?? []).length) {
      out.push('YOUR RECENT CLASHES:');
      for (const c of sit.my_clashes) out.push(`  bell ${c.bell} at (${c.p},${c.q}): you lost ${c.own_lost}, they lost ${c.enemy_lost} (${c.result})`);
    }
    return out;
  }

  // ---- section 2: THREATS and COUNCIL ----------------------------------------------------------
  function threatLines(threats) {
    const out = [];
    for (const t of (threats ?? []).slice(0, 5)) {
      out.push(`  nation ${t.nation} sent an army of ${t.mass} troops from (${t.origin?.p},${t.origin?.q}); it arrives at bell ${t.arrive_bell}; its destination is not known.`);
    }
    return out.length ? ['THREATS:', ...out] : ['THREATS: none seen.'];
  }

  function councilLines(council, member, people) {
    if (!council || council.state === 'none' || !council.options?.length) return ['COUNCIL: no council this period.'];
    const out = [`COUNCIL (your nation, ${council.state}): options for this period:`];
    for (const o of council.options) out.push(`  option ${o.option}: ${o.kind} at (${o.p},${o.q}), ${o.ratio ?? 'unknown'} (estimate)`);
    for (const m of (council.motions ?? []).slice(0, 5)) {
      const who = people.people.find((p) => p.wallet === m.wallet)?.handle ?? 'someone';
      out.push(`  ${who} moved option ${m.option}`);
    }
    if (council.closes_bell != null) out.push(`  this window closes at bell ${council.closes_bell}.`);
    if (member?.call) out.push(`  A Strike Order of your nation is live (period ${member.call.period ?? council.period}, strike bell ${member.call.strike_bell}); the candidate flagged Strike Order lists its target.`);
    if (council.adopted && !member?.call) out.push('  A Strike Order was adopted; its target is known only to nation members.');
    return out;
  }

  // ---- section 4: INBOX and HALL ---------------------------------------------------------------
  function pickInbox(rows, perSender = 2, cap = 8) {
    const bySender = new Map();
    for (const r of [...rows].sort((a, b) => b.bell - a.bell || (a.id < b.id ? 1 : -1))) {
      if (!bySender.has(r.tag)) bySender.set(r.tag, []);
      bySender.get(r.tag).push(r);
    }
    const senders = [...bySender.entries()].sort((a, b) => b[1][0].bell - a[1][0].bell || (a[0] < b[0] ? -1 : 1));
    const out = [];
    for (let round = 0; round < perSender && out.length < cap; round++) {
      for (const [, list] of senders) {
        if (list[round] && out.length < cap) out.push(list[round]);
      }
    }
    return out.sort((a, b) => a.bell - b.bell || (a.id < b.id ? -1 : 1));
  }

  const itemLine = (r, people, ownTag, ch) => {
    const handle = r.tag === ownTag ? 'you' : people.handleOfTag(r.tag) ?? 'C?';
    const nameStr = r.tag === ownTag ? 'you' : `${r.name ?? nm(r.tag)} (${handle})`;
    return wrap(r.text, { from: nameStr, ch, bell: r.bell });
  };

  /**
   * render({kind, request, publicView, ownState, memberView, attach, bell, lang, speechLang, messagesLeft,
   *         inbox, hall, threats, goals}) -> {messages, spec, handles, candidates, people, tokens, ...}
   * `attach(budgetTokens, handleOf)` returns {block, handles, retrieved, candidates} (memory.mjs).
   */
  async function render({ kind, request, publicView, ownState, memberView, attach, bell, lang = 'en', speechLang = 'ja', messagesLeft = 99, inbox = [], hall = [], threats = [], goals = null, memoryBudget = config.memory_block_tokens ?? 750 }) {
    const sit = request.situation ?? {};
    const me = sit.me ?? {};
    const council = publicView?.council?.(me.faction) ?? null;
    const member = memberView ?? null;

    // people: inbox senders first, then hall authors, motion authors, then the ledger's strongest relations
    const trust = ownState.doc?.trust?.citizens ?? {};
    const relTags = Object.entries(trust)
      .map(([tag, v]) => ({ tag, mag: Math.abs((v.t_code ?? 0) + (v.t_model ?? 0)) }))
      .sort((a, b) => b.mag - a.mag || (a.tag < b.tag ? -1 : 1))
      .slice(0, 5)
      .map((x) => ({ tag: x.tag, name: nm(x.tag, lang) }));
    const sources = [
      ...inbox.map((r) => ({ tag: r.tag, wallet: r.wallet, name: r.name, faction: r.faction })),
      ...hall.map((r) => ({ tag: r.tag, wallet: r.wallet, name: r.name, faction: r.faction })),
      ...((council?.motions ?? []).map((m) => ({ tag: m.tag, wallet: m.wallet, name: m.name })).filter((x) => x.tag)),
      ...relTags,
    ];
    const people = buildPeople(sources, ownState.tag);
    const handleOf = (tag) => people.handleOfTag(tag);

    let inboxRows = pickInbox(inbox.filter((r) => r.channel === 'direct' || r.channel === 3 || r.channel == null));
    let hallRows = [...hall].sort((a, b) => a.bell - b.bell || (a.id < b.id ? -1 : 1)).slice(-5);

    const trimmed = [];
    let memBudget = memoryBudget;
    let neighbourTrim = 0;
    let attached = attach(memBudget, handleOf);
    const persona = renderPersona ? renderPersona(ownState.persona, lang) : String(ownState.persona?.id ?? '');
    const spec = {
      kind,
      goalIds: goals ?? ['G1', 'G2', 'G3', 'G4'],
      who: [...people.people.map((p) => p.handle), 'N0', 'N1', 'N2', 'N3', 'N4', 'N5'],
      direct: people.people.filter((p) => p.wallet).map((p) => p.handle),
      channels: kind === 'motion' ? ['nation'] : kind === 'ballot' ? [] : ['world', 'nation', ...(people.people.some((p) => p.wallet) ? ['direct'] : [])],
      maxSay: Math.min(maxSayFor(kind), Math.max(0, messagesLeft)),
      motionOptions: [0, ...(council?.options ?? []).map((o) => o.option)],
      ballotOptions: [0, ...(council?.options ?? []).map((o) => o.option)],
    };
    const ownerName = ownState.name?.[lang] ?? ownState.name?.en ?? nm(ownState.tag, lang);
    const system = [
      fill(T.system, { name: ownerName, nation: me.faction }),
      fill(T.persona, { persona_text: persona }),
    ].join('\n\n');

    const taskTpl = T[kind] ?? T.session;
    const task = fill(taskTpl, { bell, max_say: spec.maxSay, speech_lang: SPEECH_LANG[speechLang] ?? 'Japanese' });

    const build = () => {
      const state = stateLines(sit, { trimNeighbours: neighbourTrim }).join('\n');
      const sc = [...threatLines(threats), ...councilLines(council, member, people)].join('\n');
      const legend = people.people.length
        ? `PEOPLE (use these handles in say.to and trust.who): ${people.people.map((p) => `${p.handle} ${p.name ?? nm(p.tag, lang)}${p.faction != null ? ` (nation ${p.faction})` : ''}`).join('; ')}`
        : 'PEOPLE: none named in this prompt.';
      const memory = `${legend}\n${attached.block}`.trim();
      const inboxText = inboxRows.length ? inboxRows.map((r) => itemLine(r, people, ownState.tag, 'direct')).join('\n') : 'none';
      const hallText = hallRows.length ? hallRows.map((r) => itemLine(r, people, ownState.tag, 'nation')).join('\n') : 'none';
      const inboxSec = kind === 'ballot' ? '' : `INBOX (direct messages to you):\n${inboxText}\nNATION HALL (recent messages in your nation channel):\n${hallText}`;
      const cands = kind === 'session' ? candidateLines(attached.candidates).join('\n') : '';
      const candSec = kind === 'session' ? `CANDIDATES:\n${cands}` : '';
      return { state, sc, memory, inboxSec, candSec };
    };

    let parts = build();
    const tally = async () => {
      const res = {};
      let total = 0;
      let est = false;
      for (const [k, v] of [['state', parts.state], ['social_council', parts.sc], ['memory', parts.memory], ['inbox', parts.inboxSec], ['candidates', parts.candSec], ['task', task]]) {
        const c = v ? await count(v) : { n: 0, estimated: false };
        res[k] = c.n;
        total += c.n;
        est ||= c.estimated;
      }
      return { res, total, est };
    };
    let tl = await tally();
    // trimming order (section 5.5): extra inbox lines, oldest episodes, the hall, never candidates
    let guard = 0;
    while (tl.total > VARIABLE_BUDGET && guard++ < 60) {
      const perSenderCount = new Map();
      for (const r of inboxRows) perSenderCount.set(r.tag, (perSenderCount.get(r.tag) ?? 0) + 1);
      const dupSender = [...perSenderCount.entries()].find(([, n]) => n > 1)?.[0];
      if (dupSender) {
        const oldest = inboxRows.filter((r) => r.tag === dupSender).sort((x, y) => x.bell - y.bell)[0];
        inboxRows = inboxRows.filter((r) => r !== oldest);
        trimmed.push('inbox_extra');
      } else if (memBudget > 120 && attached.retrieved.length > 3) {
        memBudget = Math.max(120, memBudget - 100);
        attached = attach(memBudget, handleOf);
        trimmed.push('episodes');
      } else if (hallRows.length) {
        hallRows = hallRows.slice(1);
        trimmed.push('hall');
      } else if (inboxRows.length > 1) {
        inboxRows = inboxRows.slice(1);
        trimmed.push('inbox');
      } else if (neighbourTrim < (sit.neighbourhood ?? []).length) {
        neighbourTrim += 1;
        trimmed.push('neighbourhood');
      } else break;
      parts = build();
      tl = await tally();
    }

    spec.handles = Object.keys(attached.handles).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
    const cands = attached.candidates;
    spec.candidateIds = cands.map((c) => c.id);
    spec.paramsByCandidate = {};
    for (const c of cands) if (c.params && Object.keys(c.params).length) spec.paramsByCandidate[c.id] = c.params;

    const user = [parts.state, parts.sc, parts.memory, parts.inboxSec, parts.candSec, task].filter(Boolean).join('\n\n');
    const messages = [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ];
    const sys = await count(system);
    const inboxLeaves = [...inboxRows, ...hallRows].map((r) => r.inner ?? createHash('sha256').update(String(r.id ?? r.text)).digest('hex'));
    const leaf = (inner) => createHash('sha256').update(Buffer.concat([Buffer.from([0]), Buffer.from(inner, 'hex')])).digest('hex');
    return {
      messages,
      spec,
      handles: attached.handles,
      retrieved: attached.retrieved,
      candidates: cands,
      people,
      inbox_shown: inboxRows.map((r) => r.id),
      hall_shown: hallRows.map((r) => r.id),
      inbox_root: merkleRootHex(inboxLeaves.filter((x) => /^[0-9a-f]{64}$/.test(x)).map(leaf)),
      tokens: { system: sys.n, variable: tl.total, sections: tl.res, estimated: tl.est || sys.estimated },
      over_budget: tl.total > VARIABLE_BUDGET,
      trimmed,
      memory_budget: memBudget,
    };
  }

  function candidateLines(cands) {
    return cands.map((c) => {
      const facts = Object.entries(c.facts ?? {}).map(([k, v]) => `${words(k)} ${fmt(v)}`).join('; ');
      const params = Object.entries(c.params ?? {}).map(([k, v]) => `${k} in {${v.join(',')}}`).join('; ');
      const parts = [`${c.id} [${c.kind}${c.flags?.council ? ', Strike Order' : ''}] ${c.label ?? ''}`.trim()];
      if (c.troops != null) parts.push(`troops ${c.troops}`);
      if (facts) parts.push(facts);
      if (params) parts.push(`params: ${params}`);
      if (c.refs?.length) parts.push(`see ${c.refs.join(', ')}`);
      if (c.goals_served?.length) parts.push(`serves ${c.goals_served.join(', ')}`);
      return parts.join(' | ');
    });
  }

  /** Reflection prompt (AC1b's reflection job calls this; the template is mine, section 5.3). */
  function renderReflection({ bell, previousSummary = null, ledgerDigest = '', goals = [], episodes = [], ownState, persona = '' }) {
    const system = [fill(T.system, { name: ownState.name?.en ?? nm(ownState.tag), nation: ownState.faction ?? '' }), fill(T.persona, { persona_text: persona })].join('\n\n');
    const prev = previousSummary ? `<memory kind="self-summary" bell="${previousSummary.bell}">${sanitize(previousSummary.text, { limit: 1200, summary: true })}</memory>` : 'none yet';
    const user = fill(T.reflection, {
      bell,
      previous_summary: prev,
      ledger_digest: ledgerDigest,
      goals: goals.map((g) => `${g.id}: ${g.text ?? ''} progress ${g.progress}${g.status && g.status !== 'active' ? ` (${g.status})` : ''}`).join('\n'),
      episodes: episodes.map((e) => `<memory kind="episode">[bell ${e.bell}] ${e.text}</memory>`).join('\n') || 'none',
    });
    return { messages: [{ role: 'system', content: system }, { role: 'user', content: user }] };
  }

  return { render, renderReflection, templatesSha256: templatesSha, wrap, pickInbox, candidateLines, stateLines };
}
