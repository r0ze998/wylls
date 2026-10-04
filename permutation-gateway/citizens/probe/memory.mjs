// The memory probe (contract section 5.7, G14 (c); unit AC9). Offline, no new world: it works on STORED request bodies
// (`STATE/requests/<record id>.json`, the exact llama request of a model decision) and re-asks the pinned slot.
//
// For each logged prompt whose MEMORY block held an `attacked_own`, `camp_taken_by` or `threat` episode ("eligible"):
//   (a) rerun    the IDENTICAL stored request body, byte for byte (the nondeterminism baseline: k_rerun)
//   (b) ablated  the same prompt with the Remembered lines removed, and the candidates' `see Mn` refs and the `mem` enum
//                entries of the removed lines removed with them (k)
//   (c) control  the same prompt with an equal number of tokens removed from lines the decision did not cite and that are
//                not an attacked_own / camp_taken_by / threat episode (other Remembered lines first, then inbox lines)
//                (k_control). At T = 0 any shorter prompt can flip an argmax, so (b) alone would mix "the content
//                matters" with "any edit changes the output".
// "The chosen candidate changed" = the sorted list of chosen candidate ids differs from the baseline's. A change of
// the params only is counted separately (params_changed) and is NOT a change of the chosen candidate.
//
// THE ONLY ALLOWED WORDING of the result (contract 5.7): "when the Remembered lines were removed from N logged
// prompts, the chosen candidate changed in k (rerun: k_rerun; control: k_control)". The probe never says "memory
// changed behaviour", "because" or "improves play". N < 40 is printed as underpowered. It measures nothing about
// whether the model "wanted" anything.
//
// Everything that builds a variant is pure and tested without a model (test/citizens-probe.test.mjs); the model is
// reached only through `complete(body)`, which the CLI binds to llama-server on loopback (never to anything else).
//
//   node citizens/probe/memory.mjs --requests DIR [--records STATE/records.jsonl] [--ids a,b] [--max-calls 20]
//        [--llm http://127.0.0.1:41901] [--tokenize] [--dry] [--out FILE]
//   node citizens/probe/memory.mjs --requests DIR --decision <record id> [--only M4] [--records ...] --llm URL   (b2)
//
// `--dry` builds every variant, checks them, counts the calls a live run would need and calls nothing.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLlm } from '../mind/llm.mjs';
import { assertLlamaUrl } from '../mind/guards.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES_EN = JSON.parse(fs.readFileSync(path.join(HERE, '../memory/templates.en.json'), 'utf8'));

export const KEY_KINDS = Object.freeze(['attacked_own', 'camp_taken_by', 'threat']);
export const MIN_N = 40;
export const NOTHING = '(nothing remembered yet)';
const sha256 = (s) => createHash('sha256').update(s).digest('hex');

// ---------------------------------------------------------------- classifying a Remembered line by its code template
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** `At bell {b} ... {x}` -> a regex: every {placeholder} matches one non-empty run. */
export function templateRegex(tpl) {
  const parts = String(tpl).split(/\{[a-z_]+\}/);
  return new RegExp(`^${parts.map(escapeRe).join('.+?')}$`);
}
function buildKindRegexes() {
  const out = [];
  for (const [kind, t] of Object.entries(TEMPLATES_EN.kinds)) {
    const list = typeof t === 'string' ? [t] : Object.values(t);
    for (const tpl of list) out.push({ kind, re: templateRegex(tpl) });
  }
  return out;
}
const KIND_REGEXES = buildKindRegexes();
/** The episode kind a Remembered line's code text was templated from, or null. (Text patterns: a stored body carries no ids.) */
export function classifyText(text) {
  const t = String(text);
  for (const { kind, re } of KIND_REGEXES) if (re.test(t)) return kind;
  return null;
}

// ---------------------------------------------------------------- parsing a stored request body
const REM_LINE = /^M(\d+) \[bell (\d+)\] <memory kind="episode" id="M\1">(.*)<\/memory>$/;
const SEE_SEG = /(^| \| )see (M\d+(?:, M\d+)*)(?= \| |$)/;

/** Where the pieces are in the stored body. `body` may be the text or the object. */
export function parseBody(bodyOrText) {
  const text = typeof bodyOrText === 'string' ? bodyOrText : JSON.stringify(bodyOrText);
  const body = typeof bodyOrText === 'string' ? JSON.parse(bodyOrText) : JSON.parse(text);
  const msgs = body.messages ?? [];
  const userIdx = msgs.map((m) => m.role).lastIndexOf('user');
  if (userIdx < 0) throw new Error('probe: the request has no user message');
  const user = msgs[userIdx].content;
  const lines = user.split('\n');
  const iRem = lines.findIndex((l) => l === 'Remembered:');
  const remembered = [];
  if (iRem >= 0) {
    for (let i = iRem + 1; i < lines.length && lines[i] !== ''; i++) {
      const m = REM_LINE.exec(lines[i]);
      if (!m) continue;
      remembered.push({ handle: `M${m[1]}`, bell: Number(m[2]), text: m[3], line_index: i, kind: classifyText(m[3]) });
    }
  }
  const candidates = [];
  lines.forEach((l, i) => {
    const m = /^(c\d+) \[/.exec(l);
    if (!m) return;
    const see = SEE_SEG.exec(l);
    candidates.push({ id: m[1], line_index: i, refs: see ? see[2].split(', ') : [] });
  });
  const inbox = [];
  const iIn = lines.findIndex((l) => l.startsWith('INBOX '));
  if (iIn >= 0) for (let i = iIn + 1; i < lines.length && !lines[i].startsWith('NATION HALL'); i++) if (lines[i].startsWith('<untrusted ')) inbox.push({ line_index: i, text: lines[i] });
  const schema = schemaOf(body);
  const memEnum = schema?.properties?.mem?.items?.enum ?? [];
  return { body, text, userIdx, user, lines, remembered, candidates, inbox, memEnum, hasNothingMarker: lines.includes(NOTHING) };
}
function schemaOf(body) {
  return body.response_format?.json_schema?.schema ?? body.json_schema ?? null;
}

/** Eligible = the MEMORY block held a key-kind episode (contract 5.7). */
export function eligibility(parsed) {
  const keyHandles = parsed.remembered.filter((r) => KEY_KINDS.includes(r.kind)).map((r) => r.handle);
  const kinds = [...new Set(parsed.remembered.filter((r) => KEY_KINDS.includes(r.kind)).map((r) => r.kind))];
  return { eligible: keyHandles.length > 0, keyHandles, kinds };
}

// ---------------------------------------------------------------- building variants (pure)
/**
 * Remove Remembered lines (`handles`), their `see` refs and their `mem` enum entries; remove inbox lines (`inboxIdx`, line
 * indexes). When no Remembered line is left, the line "(nothing remembered yet)" takes their place, exactly what the mind's
 * renderer prints for an empty memory (`addMarker: false` leaves no marker: the control, which removes only some lines).
 */
export function removeFrom(parsed, { handles = [], inboxIdx = [], addMarker = true } = {}) {
  const drop = new Set(handles);
  const dropLine = new Set([...parsed.remembered.filter((r) => drop.has(r.handle)).map((r) => r.line_index), ...inboxIdx]);
  const left = parsed.remembered.filter((r) => !drop.has(r.handle));
  const out = [];
  parsed.lines.forEach((l, i) => {
    if (dropLine.has(i)) {
      if (addMarker && !left.length && parsed.remembered.some((r) => r.line_index === i) && !out.includes(NOTHING) && parsed.remembered[0].line_index === i) out.push(NOTHING);
      return;
    }
    let line = l;
    if (parsed.candidates.some((c) => c.line_index === i)) {
      const m = SEE_SEG.exec(line);
      if (m) {
        const keep = m[2].split(', ').filter((h) => !drop.has(h));
        line = line.replace(SEE_SEG, keep.length ? `${m[1]}see ${keep.join(', ')}` : '');
      }
    }
    out.push(line);
  });
  const body = JSON.parse(parsed.text);
  body.messages[parsed.userIdx].content = out.join('\n');
  const schema = schemaOf(body);
  if (schema?.properties?.mem) {
    const rest = (schema.properties.mem.items?.enum ?? []).filter((h) => !drop.has(h));
    schema.properties.mem = rest.length ? { ...schema.properties.mem, maxItems: Math.min(3, rest.length), items: { enum: rest } } : { type: 'array', maxItems: 0 };
  }
  return { body, text: JSON.stringify(body), removed_lines: [...dropLine].sort((a, b) => a - b).map((i) => parsed.lines[i]) };
}

/** A line diff of two user messages (they differ by deletions, edits of a `see` segment and one marker line). */
export function diffUser(a, b) {
  const x = a.split('\n');
  const y = b.split('\n');
  const dp = Array.from({ length: x.length + 1 }, () => new Int32Array(y.length + 1));
  for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const removed = [];
  const added = [];
  let i = 0;
  let j = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) { i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) removed.push(x[i++]); else added.push(y[j++]);
  }
  while (i < x.length) removed.push(x[i++]);
  while (j < y.length) added.push(y[j++]);
  return { removed, added };
}

/** Everything in the two bodies except the user message and the `mem` schema property is byte-equal. */
export function sameOutsideUserAndMem(textA, textB) {
  const a = JSON.parse(textA);
  const b = JSON.parse(textB);
  for (const o of [a, b]) {
    o.messages[o.messages.map((m) => m.role).lastIndexOf('user')].content = '';
    const s = schemaOf(o);
    if (s?.properties) delete s.properties.mem;
  }
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The control (c): remove whole lines worth as close to `targetTokens` as possible from lines the decision did not cite
 * that are not key-kind episodes: other Remembered lines first (oldest first), then inbox lines. `count(text) -> tokens`
 * counts the whole user message, so the net removal is measured, not summed per line. Returns {text, removed_*, tokens_*, source}
 * or {unavailable: reason}.
 */
export async function buildControl(parsed, { targetTokens, count, cited = [] }) {
  const citedSet = new Set(cited);
  const pool = parsed.remembered.filter((r) => !KEY_KINDS.includes(r.kind) && !citedSet.has(r.handle)).sort((a, b) => a.bell - b.bell || a.line_index - b.line_index);
  const inboxPool = [...parsed.inbox];
  if (!pool.length && !inboxPool.length) return { unavailable: 'every Remembered line is cited or a key-kind episode, and there is no inbox line' };
  const base = await count(parsed.user);
  const tryRemove = async (hs, idx) => {
    const v = removeFrom(parsed, { handles: hs, inboxIdx: idx, addMarker: false });
    const user = v.body.messages[parsed.userIdx].content;
    return { v, removed_tokens: base - (await count(user)) };
  };
  let best = null;
  const consider = (r, hs, idx) => {
    if (!best || Math.abs(r.removed_tokens - targetTokens) < Math.abs(best.r.removed_tokens - targetTokens)) best = { r, hs: [...hs], idx: [...idx] };
  };
  const hs = [];
  const idx = [];
  for (const r of pool) {
    hs.push(r.handle);
    const t = await tryRemove(hs, idx);
    consider(t, hs, idx);
    if (t.removed_tokens >= targetTokens) break;
  }
  if (best && best.r.removed_tokens < targetTokens) {
    for (const r of inboxPool) {
      idx.push(r.line_index);
      const t = await tryRemove(hs, idx);
      consider(t, hs, idx);
      if (t.removed_tokens >= targetTokens) break;
    }
  } else if (!best) {
    for (const r of inboxPool) {
      idx.push(r.line_index);
      const t = await tryRemove([], idx);
      consider(t, [], idx);
      if (t.removed_tokens >= targetTokens) break;
    }
  }
  const fromInbox = best.idx.length > 0;
  return {
    text: best.r.v.text,
    body: best.r.v.body,
    removed_handles: best.hs,
    removed_inbox_lines: best.idx.length,
    removed_tokens: best.r.removed_tokens,
    target_tokens: targetTokens,
    delta_tokens: best.r.removed_tokens - targetTokens,
    source: best.hs.length && fromInbox ? 'other Remembered lines and inbox lines' : fromInbox ? 'inbox lines' : 'other Remembered lines',
  };
}

/** The tokens an all-lines ablation removes (net of the marker line). */
export async function ablationTokens(parsed, ablatedText, count) {
  const user = JSON.parse(ablatedText).messages[parsed.userIdx].content;
  return (await count(parsed.user)) - (await count(user));
}

// ---------------------------------------------------------------- reading a model answer
/** The choice of an answer content text: {choose (sorted), params, mem, why} or {error}. */
export function readChoice(content) {
  try {
    const j = JSON.parse(content);
    if (!Array.isArray(j.choose)) return { error: 'no choose array' };
    return { choose: [...j.choose].sort(), params: j.params ?? {}, mem: Array.isArray(j.mem) ? [...j.mem] : [], why: typeof j.why === 'string' ? j.why : null, goal_id: j.goal_id ?? null };
  } catch (e) {
    return { error: String(e.message ?? e).slice(0, 80) };
  }
}
const sameChoose = (a, b) => a && b && !a.error && !b.error && JSON.stringify(a.choose) === JSON.stringify(b.choose);
const sameParams = (a, b) => a && b && !a.error && !b.error && JSON.stringify(sortKeys(a.params)) === JSON.stringify(sortKeys(b.params));
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  return v;
}

/** The only sentence the probe's result may be reported in (contract 5.7). */
export function allowedWording({ n, k, k_rerun, k_control }) {
  return `when the Remembered lines were removed from ${n} logged prompts, the chosen candidate changed in ${k} (rerun: ${k_rerun}; control: ${k_control})`;
}
/** The caption of the featured decision (contract 9.1 (b2)): only these two. */
export function decisionCaption(changed) {
  return changed ? 'with this line removed, the choice changed' : 'with the Remembered lines removed, the choice did not change';
}

// ---------------------------------------------------------------- loading what the run left
/** Records of a run: STATE/records.jsonl (private store, op "add" entries) -> Map(record id -> full record). */
export function loadRecords(file) {
  const map = new Map();
  if (!file || !fs.existsSync(file)) return map;
  for (const l of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!l.trim()) continue;
    let j;
    try { j = JSON.parse(l); } catch { continue; }
    if (j.op === 'add' && j.entry?.id) map.set(j.entry.id, j.entry.full ?? j.entry.pub ?? null);
  }
  return map;
}
export function loadRequests(dir, ids = null) {
  const out = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
    const id = f.slice(0, -5);
    if (ids && !ids.includes(id) && !ids.some((x) => id.startsWith(x))) continue;
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    out.push({ id, text, sha256: sha256(text) });
  }
  return out;
}

/** The handles a decision cited, from its stored record: retrieved ids in handle order, choice.mem ids -> M<i+1>. */
export function citedHandles(record) {
  if (!record?.retrieved || !record?.choice?.mem) return null;
  return record.choice.mem.map((id) => record.retrieved.indexOf(id)).filter((i) => i >= 0).map((i) => `M${i + 1}`);
}

// ---------------------------------------------------------------- the probe
export const approxCount = async (text) => Math.ceil([...String(text)].length / 3);

/**
 * runProbe({requests: [{id, text, sha256}], records: Map, complete, count, maxCalls, dry, decision, only}) -> report.
 * `complete(bodyText) -> {content, latency_ms, finish_reason, error?}`; absent when dry. Calls are made in order and stop at
 * maxCalls (the prompts not reached are listed as `not_run`).
 */
export async function runProbe({ requests, records = new Map(), complete = null, count = approxCount, maxCalls = 20, dry = false, decision = null, only = null, tokenCounter = 'approximate (1 token per 3 characters)', load = () => os.loadavg() } = {}) {
  const items = [];
  let calls = 0;
  const stats = { n_requests: requests.length };
  for (const rq of requests) {
    const parsed = parseBody(rq.text);
    const rec = records.get(rq.id) ?? null;
    const el = eligibility(parsed);
    const item = {
      id: rq.id, bell: rec?.bell ?? null, index: rec?.index ?? null, request_sha256: rq.sha256,
      request_matches_record: rec?.request_hash ? rec.request_hash === rq.sha256 : null,
      n_remembered: parsed.remembered.length, remembered_kinds: parsed.remembered.map((r) => r.kind), eligible: el.eligible, key_kinds: el.kinds, key_handles: el.keyHandles,
      stored: rec ? { choose: [...(rec.choice?.ids ?? [])].sort(), mem_ids: rec.choice?.mem ?? [], output_hash: rec.output_hash ?? null } : null,
    };
    items.push({ item, parsed, rec });
  }
  const eligible = decision ? items.filter((x) => x.item.id === decision || x.item.id.startsWith(decision)) : items.filter((x) => x.item.eligible);
  if (decision && !eligible.length) throw new Error(`probe: no stored request for decision ${decision}`);
  const plan = [];
  for (const x of eligible) {
    const { item, parsed, rec } = x;
    if (!parsed.remembered.length) {
      item.skip = 'no Remembered line in this prompt: nothing to remove';
      continue;
    }
    const ab = removeFrom(parsed, { handles: parsed.remembered.map((r) => r.handle) });
    item.ablation = { removed_lines: ab.removed_lines.length, diff: diffUser(parsed.user, ab.body.messages[parsed.userIdx].content), outside_user_and_mem_equal: sameOutsideUserAndMem(parsed.text, ab.text) };
    x.ab = ab;
    item.ablation.tokens_removed_net = await ablationTokens(parsed, ab.text, count);
    x.cited = rec ? citedHandles(rec) : null;
    plan.push(x);
  }
  // the live calls: rerun, ablated, control per prompt (the control is built after the rerun says what the model cited)
  stats.eligible = eligible.length;
  const notRun = [];
  for (const x of plan) {
    const { item, parsed, rec } = x;
    // control variant without the model: when the cited handles are known from the record it can be built now (dry)
    const citedNow = x.cited ?? [];
    const target = item.ablation.tokens_removed_net;
    const ctl = await buildControl(parsed, { targetTokens: target, count, cited: citedNow });
    x.ctl = ctl;
    item.control = ctl.unavailable ? { unavailable: ctl.unavailable } : {
      removed_handles: ctl.removed_handles, removed_inbox_lines: ctl.removed_inbox_lines, removed_tokens: ctl.removed_tokens, target_tokens: ctl.target_tokens, delta_tokens: ctl.delta_tokens, source: ctl.source,
      outside_user_and_mem_equal: sameOutsideUserAndMem(parsed.text, ctl.text),
    };
    if (decision) {
      const handles = only ?? citedNow;
      item.single_line_ablations = [];
      x.single = [];
      for (const h of handles) {
        if (!parsed.remembered.some((r) => r.handle === h)) continue;
        const v = removeFrom(parsed, { handles: [h] });
        x.single.push({ handle: h, v });
        item.single_line_ablations.push({ handle: h, removed: v.removed_lines });
      }
    }
  }
  // planned calls: rerun + ablated + control (when one can be built) per prompt, + one per single-line ablation (one-decision mode)
  stats.planned_calls = plan.reduce((n, x) => n + 2 + (x.ctl?.unavailable ? 0 : 1) + (x.single?.length ?? 0), 0);
  if (dry || !complete) {
    return finish({ items, plan, stats, dry: true, tokenCounter, calls: 0, notRun, decision, load: load() });
  }
  const ask = async (text) => {
    if (calls >= maxCalls) return null;
    calls++;
    const t0 = Date.now();
    const la = load();
    const r = await complete(text);
    return { ...r, wall_ms: Date.now() - t0, loadavg_before: la.map((v) => Math.round(v * 100) / 100) };
  };
  for (const x of plan) {
    const { item, parsed, rec } = x;
    if (calls + 3 > maxCalls && !decision) { notRun.push(item.id); continue; }
    const re = await ask(parsed.text);
    if (!re) { notRun.push(item.id); continue; }
    const reChoice = readChoice(re.content ?? '');
    const sameBytes = rec?.output_hash ? sha256(re.content ?? '') === rec.output_hash : null;
    // baseline: the stored raw output when the rerun reproduced it byte for byte, else the stored final choice (V3 may have dropped a march from it), else the rerun
    let baseline;
    if (sameBytes) baseline = { source: 'stored output (the rerun reproduced it byte for byte)', ...reChoice };
    else if (rec?.choice?.ids) baseline = { source: 'stored final choice (rerun not byte-equal; V3 may have dropped an id)', choose: [...rec.choice.ids].sort(), params: rec.choice.params ?? {}, mem: [] };
    else baseline = { source: 'the rerun itself (no stored record)', ...reChoice };
    item.baseline = { source: baseline.source, choose: baseline.choose ?? null };
    item.rerun = { choose: reChoice.choose ?? null, params: reChoice.params ?? null, error: reChoice.error ?? re.error ?? null, same_bytes_as_stored: sameBytes, changed: !sameChoose(baseline, reChoice), params_changed: !sameParams(baseline, reChoice), latency_ms: re.latency_ms, loadavg_before: re.loadavg_before, finish_reason: re.finish_reason ?? null };
    // cited handles: the stored record's, else the rerun's own `mem` (it is the stored answer when byte-equal)
    const cited = x.cited ?? reChoice.mem ?? [];
    if (!x.cited && cited.length) {
      x.ctl = await buildControl(parsed, { targetTokens: item.ablation.tokens_removed_net, count, cited });
      item.control = x.ctl.unavailable ? { unavailable: x.ctl.unavailable } : { removed_handles: x.ctl.removed_handles, removed_inbox_lines: x.ctl.removed_inbox_lines, removed_tokens: x.ctl.removed_tokens, target_tokens: x.ctl.target_tokens, delta_tokens: x.ctl.delta_tokens, source: x.ctl.source, outside_user_and_mem_equal: sameOutsideUserAndMem(parsed.text, x.ctl.text) };
    }
    item.cited_handles = cited;
    item.cited_from = x.cited ? 'stored record' : 'rerun answer';
    const ab = await ask(x.ab.text);
    if (ab) {
      const c = readChoice(ab.content ?? '');
      item.ablated = { choose: c.choose ?? null, params: c.params ?? null, mem: c.mem ?? null, error: c.error ?? ab.error ?? null, changed: !sameChoose(baseline, c), params_changed: !sameParams(baseline, c), latency_ms: ab.latency_ms, loadavg_before: ab.loadavg_before };
    }
    if (x.ctl && !x.ctl.unavailable) {
      const ct = await ask(x.ctl.text);
      if (ct) {
        const c = readChoice(ct.content ?? '');
        item.control_result = { choose: c.choose ?? null, params: c.params ?? null, error: c.error ?? ct.error ?? null, changed: !sameChoose(baseline, c), params_changed: !sameParams(baseline, c), latency_ms: ct.latency_ms, loadavg_before: ct.loadavg_before };
      }
    }
    for (const s of x.single ?? []) {
      const r1 = await ask(s.v.text);
      if (!r1) continue;
      const c = readChoice(r1.content ?? '');
      (item.single_line_results ??= []).push({ handle: s.handle, choose: c.choose ?? null, error: c.error ?? r1.error ?? null, changed: !sameChoose(baseline, c), caption: decisionCaption(!sameChoose(baseline, c)) });
    }
  }
  return finish({ items, plan, stats, dry: false, tokenCounter, calls, notRun, decision, load: load() });
}

function finish({ items, plan, stats, dry, tokenCounter, calls, notRun, decision, load }) {
  const rows = items.map((x) => x.item);
  const ran = rows.filter((r) => r.ablated);
  const n = ran.length;
  const k = ran.filter((r) => r.ablated.changed).length;
  const kRerun = ran.filter((r) => r.rerun.changed).length;
  const withControl = ran.filter((r) => r.control_result);
  const kControl = withControl.filter((r) => r.control_result.changed).length;
  const out = {
    v: 1,
    kind: 'memory-probe',
    dry_run: dry,
    mode: decision ? 'one-decision' : 'set',
    key_kinds: KEY_KINDS,
    token_counter: tokenCounter,
    stored_requests: stats.n_requests,
    eligible_prompts: stats.eligible,
    planned_calls: stats.planned_calls,
    calls_made: calls,
    not_run: notRun,
    loadavg_at_end: load.map((v) => Math.round(v * 100) / 100),
    items: rows,
  };
  if (!dry) {
    out.summary = { n, k, k_rerun: kRerun, k_control: kControl, n_with_control: withControl.length, n_control_unavailable: ran.filter((r) => r.control?.unavailable).length, underpowered: n < MIN_N };
    out.wording = allowedWording({ n, k, k_rerun: kRerun, k_control: kControl });
    out.not_shown = [
      `n = ${n} (pre-registered N >= ${MIN_N}): ${n < MIN_N ? 'underpowered, no rate is reported' : 'powered'}`,
      'a change of the chosen candidate when lines are removed is not evidence that memory improves play or that the model wants anything',
      `the control removes whole lines to match the token count: ${withControl.length} of ${n} prompts had one; the rest had none available`,
    ];
    if (decision) out.caption = rows[0]?.single_line_results?.[0]?.caption ?? (rows[0]?.ablated ? decisionCaption(rows[0].ablated.changed) : null);
  }
  return out;
}

// ---------------------------------------------------------------- CLI
function isMain() {
  try { return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}
function args(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const k = argv[i].slice(2);
    if (['dry', 'tokenize'].includes(k)) o[k] = true;
    else o[k] = argv[++i];
  }
  return o;
}
if (isMain()) {
  const a = args(process.argv.slice(2));
  if (!a.requests) { console.error('probe: --requests DIR is required'); process.exit(2); }
  const ids = a.ids ? a.ids.split(',').filter(Boolean) : null;
  const requests = loadRequests(a.requests, ids);
  const records = loadRecords(a.records);
  let complete = null;
  let count = approxCount;
  let tokenCounter = 'approximate (1 token per 3 characters)';
  let llm = null;
  let alias = null;
  if (a.llm) {
    assertLlamaUrl(a.llm);
    llm = createLlm({ url: a.llm });
    if (!a.dry) {
      alias = (await llm.props())?.model_alias ?? null;
      complete = (text) => llm.complete(JSON.parse(text), { deadlineMs: 120000 });
    }
    if (a.tokenize) {
      count = async (t) => (await llm.countTokens(t)) ?? approxCount(t);
      tokenCounter = 'llama-server /tokenize';
    }
  }
  const report = await runProbe({ requests, records, complete, count, maxCalls: Number(a['max-calls'] ?? 20), dry: Boolean(a.dry) || !complete, decision: a.decision ?? null, only: a.only ? a.only.split(',') : null, tokenCounter });
  if (alias) report.model_alias = alias;
  const text = JSON.stringify(report, null, 2);
  if (a.out) fs.writeFileSync(a.out, text + '\n');
  console.log(text);
}
