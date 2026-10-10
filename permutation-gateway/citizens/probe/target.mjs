// The targeted memory comparison (contract section 5.7, one stored decision): the same scene and the same settings, asked
// WITH the Remembered lines of a chosen source and WITHOUT them. It is the one-decision probe of memory.mjs with a target:
//
//   node citizens/probe/memory.mjs --requests DIR --records STATE/records.jsonl --episodes PUB/memory --decision <record id>
//        --target <selector> --llm URL --out-dir DIR [--open PUB/open] [--tokenize] [--dry]
//
// `--target` names the SOURCE of the lines to remove: `entity:nation:2`, `entity:pq:-3,1`, `kind:threat`, `event:<seq>` (an
// episode's `src`) or `id:<episode id>`; several selectors joined by commas are a union. A prompt handle Mn is mapped to an
// episode by the record's `retrieved` list (retrieved[i] is M(i+1): citizens/memory/render.mjs writes `M${i + 1}` for the i-th
// id, citizens/mind/memory.mjs returns `retrieved` in handle order) and the AI's public episodes file; the mapping is
// checked against the bell printed on every Remembered line and refused when it does not hold.
//
// Four variants, each asked ONCE, in this order, with the stored seed and settings:
//   A with        the stored body, byte for byte
//   B without     the targeted Remembered lines removed with their `see Mn` refs and `mem` enum entries, AND the lines of the
//                 situation that state the same event: a THREATS line (prompt.mjs threatLines) or a YOUR RECENT CLASHES line
//                 (prompt.mjs stateLines) is removed only when its numbers equal the `facts` of targeted episodes and of no
//                 untargeted one. A line that names a targeted nation or place but fits no episode exactly is LEFT and listed
//                 in `leak`: the probe does not guess.
//   C control     an equal number of tokens removed from Remembered lines unrelated to the target (memory.mjs buildControl)
//   D with-again  the stored body once more (the nondeterminism baseline)
//
// THE ONLY WORDING of the result: "when the Remembered lines from <selector> were removed from this 1 logged prompt, the
// chosen candidate changed | did not change (rerun: changed | same; control: changed | same)". n = 1. Never "because",
// never "memory changed behaviour". Only the stored decision was executed in a game: the other answers have no result.
//
// No silent retry: the output directory must not exist (an attempt never overwrites another), `attempt.json` is written
// before the first model call, every request body and raw response is kept, and the attempts found next to the output
// directory for the same decision are listed in `attempt.json`.
//
// Everything that selects, removes and compares is pure and tested without a model (test/citizens-probe-target.test.mjs).
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseBody, removeFrom, diffUser, sameOutsideUserAndMem, buildControl, readChoice, citedHandles, approxCount } from './memory.mjs';

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
export const VARIANTS = Object.freeze(['with', 'without', 'control', 'with-again']);
export const CAVEATS = Object.freeze([
  'n = 1: one logged prompt, each variant asked once; no rate is reported',
  'a change of the chosen candidate when lines are removed is not evidence that memory improves play, nor of any intent of the model',
  'only the stored decision was executed in a game; the without, control and with-again answers were re-asked offline and their "result" was not executed',
]);

// ---------------------------------------------------------------- selectors
const SELECTOR_TYPES = ['entity', 'kind', 'event', 'id'];
const SELECTOR = /^(entity|kind|event|id):(.+)$/;
/** `entity:nation:2,entity:pq:-3,1,kind:threat` -> [{type, value, text}] (a comma splits only before a selector type: `pq:-3,1` keeps its comma). */
export function parseTarget(s) {
  const parts = String(s ?? '').split(new RegExp(`,(?=(?:${SELECTOR_TYPES.join('|')}):)`)).map((x) => x.trim()).filter(Boolean);
  if (!parts.length) throw new Error('probe: --target is empty (entity:<e>, kind:<k>, event:<seq> or id:<episode id>)');
  return parts.map((p) => {
    const m = SELECTOR.exec(p);
    if (!m) throw new Error(`probe: unknown target selector "${p}" (entity:<e>, kind:<k>, event:<seq> or id:<episode id>)`);
    const [, type, value] = m;
    if (type === 'event' && !/^\d+$/.test(value)) throw new Error(`probe: event selector needs a sequence number: "${p}"`);
    if (type === 'id' && !/^[0-9a-f]{16}$/.test(value)) throw new Error(`probe: id selector needs a 16-hex episode id: "${p}"`);
    if (type === 'kind' && !/^[a-z_]+$/.test(value)) throw new Error(`probe: kind selector needs an episode kind: "${p}"`);
    if (type === 'entity' && /\s/.test(value)) throw new Error(`probe: entity selector must not hold a space: "${p}"`);
    return { type, value, text: `${type}:${value}` };
  });
}
export const targetText = (selectors) => selectors.map((s) => s.text).join(',');

/** An episode is targeted when ANY selector names its entity, kind, source event or id. */
export function episodeMatches(e, selectors) {
  if (!e) return false;
  return selectors.some((s) => (s.type === 'entity' ? (e.entities ?? []).includes(s.value)
    : s.type === 'kind' ? e.kind === s.value
      : s.type === 'event' ? (e.src ?? []).includes(`event:${s.value}`)
        : e.id === s.value));
}

// ---------------------------------------------------------------- handles <-> episodes
/** The public episodes of one AI: PUB/memory/<tag>/episodes.json -> [episode]. */
export function loadEpisodes(dir, tag) {
  const f = path.join(dir, String(tag), 'episodes.json');
  if (!fs.existsSync(f)) throw new Error(`probe: no episodes file for AI ${tag} (${f})`);
  return JSON.parse(fs.readFileSync(f, 'utf8')).episodes ?? [];
}

/**
 * Remembered line Mn -> the episode it was rendered from: retrieved[n - 1]. Refused when the record's `retrieved` list and the
 * prompt's Remembered lines do not agree in number, handle order or bell. An id that is no longer in the episodes file (evicted
 * or redacted since) maps to `episode: null`: such a line can be targeted by `id:` only.
 */
export function mapHandles(parsed, record, episodes) {
  const retrieved = record?.retrieved;
  if (!Array.isArray(retrieved)) throw new Error('probe: the record has no `retrieved` list: handles cannot be mapped to episodes');
  if (retrieved.length !== parsed.remembered.length) throw new Error(`probe: the record retrieved ${retrieved.length} episodes, the prompt holds ${parsed.remembered.length} Remembered lines`);
  const byId = new Map(episodes.map((e) => [e.id, e]));
  return parsed.remembered.map((r, i) => {
    if (r.handle !== `M${i + 1}`) throw new Error(`probe: Remembered line ${i + 1} carries the handle ${r.handle}, not M${i + 1}`);
    const e = byId.get(retrieved[i]) ?? null;
    if (e && Number(e.bell) !== r.bell) throw new Error(`probe: ${r.handle} is printed with turn ${r.bell}, episode ${e.id} has turn ${e.bell}: the mapping does not hold`);
    return { handle: r.handle, id: retrieved[i], bell: r.bell, text: r.text, line_index: r.line_index, episode: e, text_equal: e ? (e.text?.en ?? null) === r.text : null };
  });
}

/** The mapped lines a target selects (an unmapped line only by its id). */
export function selectHandles(mapped, selectors) {
  return mapped.filter((m) => episodeMatches(m.episode ?? { id: m.id }, selectors)).map((m) => m.handle);
}

// ---------------------------------------------------------------- the same event stated elsewhere in the prompt
// the two code templates of citizens/mind/prompt.mjs (threatLines, stateLines) that restate an event of the public log
const THREAT_LINE = /^  nation (-?\d+) sent an army of (\d+) troops from \((-?\d+),(-?\d+)\); it arrives at bell (\d+); its destination is not known\.$/;
const CLASH_LINE = /^  bell (\d+) at \((-?\d+),(-?\d+)\): you lost (\d+), they lost (\d+) \(.*\)$/;
const THREATS_HEAD = 'THREATS:';
const THREATS_NONE = 'THREATS: none seen.';
const CLASHES_HEAD = 'YOUR RECENT CLASHES:';
const CLASH_KINDS = ['clash_own_win', 'clash_own_loss', 'clash_own_fought'];

/** The THREATS and YOUR RECENT CLASHES lines of a prompt (code-made sections above the MEMORY block), with their numbers. */
export function situationLines(parsed) {
  const end = parsed.lines.indexOf('Remembered:') >= 0 ? parsed.lines.indexOf('Remembered:') : parsed.lines.length;
  const block = (head, re, read) => {
    const at = parsed.lines.slice(0, end).indexOf(head);
    const rows = [];
    if (at >= 0) for (let i = at + 1; i < end && re.test(parsed.lines[i]); i++) rows.push({ line_index: i, line: parsed.lines[i], ...read(re.exec(parsed.lines[i])) });
    return { head: at, rows };
  };
  const threats = block(THREATS_HEAD, THREAT_LINE, (m) => ({ section: 'THREATS', nation: Number(m[1]), mass: Number(m[2]), p: Number(m[3]), q: Number(m[4]), arrive_bell: Number(m[5]) }));
  const clashes = block(CLASHES_HEAD, CLASH_LINE, (m) => ({ section: CLASHES_HEAD.slice(0, -1), bell: Number(m[1]), p: Number(m[2]), q: Number(m[3]), lost_own: Number(m[4]), lost_enemy: Number(m[5]) }));
  return { threats_head: threats.head, threats: threats.rows, clashes_head: clashes.head, clashes: clashes.rows };
}

const sameThreat = (e, t) => e.kind === 'threat' && e.facts && e.facts.nation === t.nation && e.facts.mass === t.mass && e.facts.p === t.p && e.facts.q === t.q && e.facts.arrive_bell === t.arrive_bell;
const sameClash = (e, c) => CLASH_KINDS.includes(e.kind) && e.facts && Number(e.bell) === c.bell && e.facts.p === c.p && e.facts.q === c.q && e.facts.lost_own === c.lost_own && e.facts.lost_enemy === c.lost_enemy;

/**
 * Which situation lines state a targeted event. `episodes` = every episode of the AI (a wake's threat can be younger than the
 * newest retrievable episode, so the Remembered lines alone are not enough).
 *   remove  the line's numbers equal the facts of >= 1 targeted episode and of no untargeted one
 *   leak    the line is left in the prompt although it may state the targeted fact: it fits a targeted AND an untargeted
 *           episode, or it fits no episode exactly while it names a targeted nation or place (or the targeted kind)
 * A line that fits only untargeted episodes is another event: it stays and is no leak.
 */
export function matchSituation(parsed, episodes, selectors) {
  const sit = situationLines(parsed);
  const targeted = episodes.filter((e) => episodeMatches(e, selectors));
  const remove = [];
  const leak = [];
  const decide = (row, same, ents, kinds) => {
    const fits = episodes.filter((e) => same(e, row));
    const hit = fits.filter((e) => episodeMatches(e, selectors));
    if (hit.length && hit.length === fits.length) remove.push({ section: row.section, line_index: row.line_index, line: row.line, episodes: hit.map((e) => e.id) });
    else if (hit.length) leak.push({ section: row.section, line: row.line, why: 'the line fits a targeted and an untargeted episode with the same numbers: it was left in the prompt' });
    else if (!fits.length) {
      const named = selectors.some((s) => (s.type === 'entity' && ents.includes(s.value)) || (s.type === 'kind' && kinds.includes(s.value)))
        || targeted.some((e) => kinds.includes(e.kind) && (e.entities ?? []).some((x) => ents.includes(x)));
      if (named) leak.push({ section: row.section, line: row.line, why: 'no episode has exactly these numbers, and the line names a targeted nation, place or kind: it was left in the prompt' });
    }
  };
  for (const t of sit.threats) decide(t, sameThreat, [`nation:${t.nation}`, `pq:${t.p},${t.q}`], ['threat']);
  for (const c of sit.clashes) decide(c, sameClash, [`pq:${c.p},${c.q}`], CLASH_KINDS);
  return { remove, leak, sit };
}

// ---------------------------------------------------------------- the variants (pure)
/**
 * B: the targeted Remembered lines, their `see` refs and `mem` enum entries, and the situation lines of `situation.remove`.
 * A section left without a line is printed as the mind's renderer prints it empty: "THREATS: none seen.", no clashes heading.
 */
export function buildWithout(parsed, { handles = [], situation = { remove: [], sit: situationLines(parsed) } } = {}) {
  const sit = situation.sit ?? situationLines(parsed);
  const gone = new Set(situation.remove.map((x) => x.line_index));
  const idx = [...gone];
  const noThreats = sit.threats.length > 0 && sit.threats.every((t) => gone.has(t.line_index));
  if (sit.clashes.length > 0 && sit.clashes.every((c) => gone.has(c.line_index))) idx.push(sit.clashes_head);
  const v = removeFrom(parsed, { handles, inboxIdx: idx });
  if (noThreats) {
    const lines = v.body.messages[parsed.userIdx].content.split('\n');
    lines[lines.indexOf(THREATS_HEAD)] = THREATS_NONE;
    v.body.messages[parsed.userIdx].content = lines.join('\n');
  }
  const drop = new Set(handles);
  return {
    body: v.body,
    text: JSON.stringify(v.body),
    removed_remembered: parsed.remembered.filter((r) => drop.has(r.handle)).map((r) => parsed.lines[r.line_index]),
    removed_situation: situation.remove.map((x) => x.line),
    removed_refs: parsed.candidates.map((c) => ({ candidate: c.id, refs: c.refs.filter((h) => drop.has(h)) })).filter((x) => x.refs.length),
    removed_mem_enum: parsed.memEnum.filter((h) => drop.has(h)),
  };
}

/** The model settings a body sends (what the comparison holds equal). `top_p` is null when the body does not send one. */
export function settingsOf(body, alias = null) {
  return {
    model: body.model ?? null, server_model_alias: alias, temperature: body.temperature ?? null, top_k: body.top_k ?? null, top_p: body.top_p ?? null,
    seed: body.seed ?? null, max_tokens: body.max_tokens ?? null, response_format: body.response_format?.json_schema?.name ?? (body.json_schema ? 'json_schema' : null),
    cache_prompt: body.cache_prompt ?? null, stream: body.stream ?? null,
  };
}

/** The only sentence a targeted comparison may be reported in (contract 5.7, n = 1). `control` undefined = no control could be built. */
export function targetWording({ selector, without, rerun, control }) {
  const say = (c) => (c == null ? 'no answer' : c ? 'changed' : 'same');
  return `when the Remembered lines from ${selector} were removed from this 1 logged prompt, the chosen candidate ${without ? 'changed' : 'did not change'} (rerun: ${say(rerun)}; control: ${control === undefined ? 'none available' : say(control)})`;
}

/** The executed branch: the stored choice, its transactions and, when the decision was opened, where the march went. */
export function executedResult(record, tx, opened) {
  return {
    branch: 'with (the stored decision: the only branch that was executed in a game)',
    choice: record?.choice ? { choose: [...(record.choice.ids ?? [])].sort(), params: record.choice.params ?? {}, goal_id: record.choice.goal_id ?? null, mem_ids: record.choice.mem ?? [] } : null,
    why: record?.public?.why ?? null,
    tx: (tx ?? record?.tx ?? []).map((t) => ({ intent: t.intent ?? null, sig: t.sig ?? null, status: t.status ?? null, code: t.code ?? null })),
    opened: opened ? {
      opened_bell: opened.opened_bell ?? null, release_bell: opened.release_bell ?? null,
      destinations: (opened.destinations ?? []).map((d) => ({ state: d.state ?? null, p: d.p ?? null, q: d.q ?? null, depart_bell: d.depart_bell ?? null, arrive_bell: d.arrive_bell ?? null, planned_arrive_bell: d.planned_arrive_bell ?? null })),
    } : null,
    not_executed: 'the without, control and with-again answers were re-asked offline and were NOT executed in a game: they have no transactions, no destination and no outcome',
  };
}

/**
 * planTarget({id, text, record, episodes, target, count, tx, opened, alias}) -> {comparison (no answers yet), variants: [{name, text}]}.
 * Builds the four request bodies and everything the comparison says about them. No model, no file.
 */
export async function planTarget({ id, text, record, episodes, target, count = approxCount, tokenCounter = 'approximate (1 token per 3 characters)', tx = null, opened = null, alias = null }) {
  const selectors = typeof target === 'string' ? parseTarget(target) : target;
  const parsed = parseBody(text);
  const mapped = mapHandles(parsed, record, episodes);
  const handles = selectHandles(mapped, selectors);
  const situation = matchSituation(parsed, episodes, selectors);
  if (!handles.length && !situation.remove.length) throw new Error(`probe: no Remembered line of decision ${id.slice(0, 12)} comes from ${targetText(selectors)}: nothing to remove`);
  const without = buildWithout(parsed, { handles, situation });
  const userOf = (b) => b.messages[parsed.userIdx].content;
  const removedTokens = (await count(parsed.user)) - (await count(userOf(without.body)));
  // the control may take only lines that are neither cited, nor targeted, nor about a targeted episode's nation, place or person
  const hit = new Set(handles);
  const targetEntities = new Set(mapped.filter((m) => hit.has(m.handle)).flatMap((m) => m.episode?.entities ?? []));
  const related = mapped.filter((m) => !m.episode || (m.episode.entities ?? []).some((x) => targetEntities.has(x))).map((m) => m.handle);
  const cited = citedHandles(record) ?? [];
  const ctl = await buildControl(parsed, { targetTokens: removedTokens, count, cited: [...new Set([...cited, ...handles, ...related])] });
  const variants = [{ name: 'with', text }, { name: 'without', text: without.text }];
  if (!ctl.unavailable) variants.push({ name: 'control', text: ctl.text });
  variants.push({ name: 'with-again', text });
  const handleId = Object.fromEntries(mapped.map((m) => [m.handle, m.id]));
  const comparison = {
    v: 1,
    kind: 'memory-probe-target',
    dry_run: true,
    record: id,
    ai: record?.ai ?? null,
    bell: record?.bell ?? null,
    request_sha256: sha256(text),
    request_matches_record: record?.request_hash ? record.request_hash === sha256(text) : null,
    target: targetText(selectors),
    handle_mapping: { rule: 'Mn is retrieved[n - 1] of the record', checked: 'the number of lines, the handle order and the turn of every Remembered line', text_equal: mapped.every((m) => m.text_equal !== false), unmapped: mapped.filter((m) => !m.episode).map((m) => m.handle) },
    targeted_episodes: mapped.filter((m) => hit.has(m.handle)).map((m) => ({ handle: m.handle, id: m.id, kind: m.episode?.kind ?? null, bell: m.bell, text: m.text, src: m.episode?.src ?? null, entities: m.episode?.entities ?? null, cited_by_the_stored_decision: cited.includes(m.handle) })),
    removed: {
      remembered_lines: without.removed_remembered,
      situation_lines: without.removed_situation,
      see_refs: without.removed_refs,
      mem_enum: without.removed_mem_enum,
      diff: diffUser(parsed.user, userOf(without.body)),
      tokens: removedTokens,
      outside_user_and_mem_equal: sameOutsideUserAndMem(text, without.text),
    },
    leak: situation.leak,
    control: ctl.unavailable ? { unavailable: ctl.unavailable } : {
      removed_handles: ctl.removed_handles, removed_inbox_lines: ctl.removed_inbox_lines, removed_lines: diffUser(parsed.user, userOf(ctl.body)).removed,
      removed_tokens: ctl.removed_tokens, target_tokens: ctl.target_tokens, delta_tokens: ctl.delta_tokens, source: ctl.source, outside_user_and_mem_equal: sameOutsideUserAndMem(text, ctl.text),
    },
    token_counter: tokenCounter,
    settings: settingsOf(parsed.body, alias),
    settings_equal_in_every_variant: variants.every((v) => sameOutsideUserAndMem(text, v.text)),
    order: variants.map((v) => v.name),
    asked: 'each variant once, in this order',
    variants: variants.map((v) => ({ name: v.name, request_file: `${v.name}.request.json`, request_sha256: sha256(v.text), same_bytes_as_stored_request: v.text === text })),
    stored: record ? { choose: [...(record.choice?.ids ?? [])].sort(), params: record.choice?.params ?? {}, goal_id: record.choice?.goal_id ?? null, mem: cited, why: record.public?.why ?? null, output_hash: record.output_hash ?? null } : null,
    result: executedResult(record, tx, opened),
    changed_vs_with: null,
    wording: null,
    caveats: [...CAVEATS],
  };
  return { comparison, variants, handleId };
}

/**
 * finishTarget(plan, answers) -> comparison. `answers[name]` = {content, finish_reason, latency_ms, error?, usage?, raw_sha256?} of the
 * one call of that variant. "Changed" = the sorted list of chosen candidate ids differs from variant A's answer in THIS attempt.
 */
export function finishTarget(plan, answers) {
  const c = structuredClone(plan.comparison);
  c.dry_run = false;
  const read = {};
  for (const v of c.variants) {
    const a = answers[v.name];
    if (!a) continue;
    const ch = readChoice(a.content ?? '');
    read[v.name] = ch;
    Object.assign(v, {
      response_file: `${v.name}.response.json`, response_sha256: a.raw_sha256 ?? null,
      choose: ch.choose ?? null, params: ch.params ?? null, goal_id: ch.goal_id ?? null, mem: ch.mem ?? null, mem_ids: (ch.mem ?? []).map((h) => plan.handleId[h] ?? null), why: ch.why ?? null,
      finish_reason: a.finish_reason ?? null, latency_ms: a.latency_ms ?? null, prompt_tokens: a.usage?.prompt_tokens ?? null, completion_tokens: a.usage?.completion_tokens ?? null,
      error: ch.error ?? a.error ?? null,
    });
    if (v.name === 'with') v.same_bytes_as_stored_output = c.stored?.output_hash ? sha256(a.content ?? '') === c.stored.output_hash : null;
    if (v.name === 'with-again') v.same_bytes_as_with = answers.with ? (a.content ?? '') === (answers.with.content ?? '') : null;
  }
  const base = read.with;
  const ok = (x) => x && !x.error;
  const changed = (x) => (ok(base) && ok(x) ? JSON.stringify(x.choose) !== JSON.stringify(base.choose) : null);
  const params = (x) => (ok(base) && ok(x) ? JSON.stringify(sortKeys(x.params)) !== JSON.stringify(sortKeys(base.params)) : null);
  const hasControl = c.order.includes('control');
  c.changed_vs_with = { without: changed(read.without), control: hasControl ? changed(read.control) : null, 'with-again': changed(read['with-again']) };
  c.params_changed_vs_with = { without: params(read.without), control: hasControl ? params(read.control) : null, 'with-again': params(read['with-again']) };
  if (c.changed_vs_with.without == null) c.wording_unavailable = 'the with or the without variant gave no readable answer: nothing is stated';
  else c.wording = targetWording({ selector: c.target, without: c.changed_vs_with.without, rerun: c.changed_vs_with['with-again'], control: hasControl ? c.changed_vs_with.control : undefined });
  if (c.wording && c.removed.situation_lines.length) c.wording_note = `${c.removed.situation_lines.length} situation line(s) stating the same event(s) were removed together with the Remembered lines`;
  return c;
}
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  return v;
}

// ---------------------------------------------------------------- the report a person reads
const cell = (s) => String(s ?? '').replace(/\|/g, '/').replace(/\s+/g, ' ').trim();
export function renderMarkdown(c) {
  const L = [];
  L.push(`# Memory comparison: decision ${c.record.slice(0, 12)}`, '');
  L.push(`Scene: AI ${c.ai}, turn ${c.bell}, one stored model decision (record ${c.record}).`);
  L.push(`Settings (equal in every variant): model ${c.settings.model}, temperature ${c.settings.temperature}, top_k ${c.settings.top_k}, top_p ${c.settings.top_p ?? 'not sent'}, seed ${c.settings.seed}, max_tokens ${c.settings.max_tokens}, response_format ${c.settings.response_format}, cache_prompt ${c.settings.cache_prompt}.`, '');
  L.push(`Removed in "without" (target ${c.target}, ${c.removed.tokens} tokens, ${c.token_counter}):`);
  for (const l of c.removed.remembered_lines) L.push(`- ${l}`);
  for (const l of c.removed.situation_lines) L.push(`- (situation) ${l.trim()}`);
  if (c.removed.see_refs.length) L.push(`- refs: ${c.removed.see_refs.map((r) => `${r.candidate} see ${r.refs.join(', ')}`).join('; ')}`);
  L.push(c.leak.length ? `Leak (lines left in the prompt that may still state the fact): ${c.leak.map((x) => `"${x.line.trim()}"`).join('; ')}` : 'Leak: none found.');
  L.push(c.control.unavailable ? `Control: none available (${c.control.unavailable}).` : `Control: removed ${c.control.removed_handles.join(', ') || 'no Remembered line'}${c.control.removed_inbox_lines ? ` and ${c.control.removed_inbox_lines} inbox line(s)` : ''}: ${c.control.removed_tokens} tokens against ${c.control.target_tokens} (${c.control.delta_tokens >= 0 ? '+' : ''}${c.control.delta_tokens}).`, '');
  L.push('| variant | chosen | params | cited mem | why (model-written, not verified) |', '|---|---|---|---|---|');
  for (const v of c.variants) {
    if (c.dry_run) L.push(`| ${v.name} | not asked (dry run) | | | |`);
    else if (v.error || !v.choose) L.push(`| ${v.name} | no answer (${cell(v.error)}) | | | |`);
    else L.push(`| ${v.name} | ${v.choose.join(', ')} | ${cell(JSON.stringify(v.params))} | ${v.mem.join(', ') || 'none'} | ${cell(v.why)} |`);
  }
  L.push('', c.wording ? `Result: ${c.wording}.` : `Result: ${c.dry_run ? 'not asked (dry run).' : c.wording_unavailable}`);
  if (c.wording_note) L.push(c.wording_note + '.');
  const r = c.result;
  const dest = (r.opened?.destinations ?? []).map((d) => `${d.state} (${d.p},${d.q}), arrival turn ${d.arrive_bell}`).join('; ');
  L.push('', `Executed (the stored decision only): chose ${r.choice ? r.choice.choose.join(', ') : 'unknown'}; tx ${r.tx.length ? r.tx.map((t) => `${t.intent} ${t.status}`).join(', ') : 'none recorded'}${r.opened ? `; opened at turn ${r.opened.opened_bell}: ${dest || 'no destination'}` : ''}.`);
  L.push('The without-memory branch was not executed in a game.', '', 'Caveats:');
  for (const x of c.caveats) L.push(`- ${x}`);
  return L.join('\n') + '\n';
}

// ---------------------------------------------------------------- what the run left, and the trace of an attempt
/** The transactions of one record: the last `tx` journal line (it replaces the list), else the list of the `add` line. */
export function loadTx(file, id) {
  let tx = null;
  if (!file || !fs.existsSync(file)) return tx;
  for (const l of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!l.includes(id)) continue;
    let j;
    try { j = JSON.parse(l); } catch { continue; }
    if (j.op === 'add' && j.entry?.id === id && tx === null) tx = j.entry.full?.tx ?? j.entry.pub?.tx ?? null;
    if (j.op === 'tx' && j.id === id && Array.isArray(j.tx)) tx = j.tx;
  }
  return tx;
}
/** The opened record of a decision in PUB/open/<bell>.json, or null. */
export function loadOpened(dir, id) {
  if (!dir || !fs.existsSync(dir)) return null;
  for (const f of fs.readdirSync(dir).filter((x) => /^\d+\.json$/.test(x)).sort((a, b) => parseInt(a, 10) - parseInt(b, 10))) {
    let j;
    try { j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    const r = (j.records ?? []).find((x) => x.id === id);
    if (r) return r;
  }
  return null;
}

/** Create the output directory of ONE attempt. An existing path is refused: an attempt never overwrites another. */
export function createOutDir(dir) {
  if (!dir) throw new Error('probe: --out-dir DIR is required with --target');
  if (fs.existsSync(dir)) throw new Error(`probe: ${dir} exists: an attempt is never overwritten (give a new --out-dir; the earlier attempt stays as it is)`);
  fs.mkdirSync(path.dirname(path.resolve(dir)), { recursive: true });
  fs.mkdirSync(dir);
  return dir;
}
/** The attempts for the same decision that already lie next to `dir` (each is a directory with an attempt.json). */
export function siblingAttempts(dir, record) {
  const parent = path.dirname(path.resolve(dir));
  const out = [];
  for (const d of fs.existsSync(parent) ? fs.readdirSync(parent).sort() : []) {
    if (path.join(parent, d) === path.resolve(dir)) continue;
    let j;
    try { j = JSON.parse(fs.readFileSync(path.join(parent, d, 'attempt.json'), 'utf8')); } catch { continue; }
    if (j.record === record) out.push({ dir: d, utc: j.utc ?? null, target: j.target ?? null, dry_run: j.dry_run ?? null });
  }
  return out;
}
export const writeJson = (file, v) => fs.writeFileSync(file, JSON.stringify(v, null, 2) + '\n', { flag: 'wx' });
export const writeText = (file, s) => fs.writeFileSync(file, s, { flag: 'wx' });
