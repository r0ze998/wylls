// M9, the bit replay (contract 7.3, 10.2 G8, 6.3 redactions; unit AC8): over the model records of the minds files, 20 sampled by
// sha256(last minds_root || i), the stored request body (PUB/full/requests, written at season end) is re-sent to a llama-server
// started with the committed flags and the output bytes must equal the record's `output_hash`. Reported as n/20 (the gate is
// 18/20, mismatches listed).
//
// Offline sub-checks that need no llama-server and that fail the check outright when they break:
//   * sha256 of the stored body = the record's `request_hash`;
//   * the body's `seed` is the pinned rule u32_le(sha256('wylls-mind-seed/v1' || season || index || bell || kind || attempt)[0..4])
//     for this record (attempt = attempts - 1: the stored body is the last attempt's);
//   * the sampling fields of the body are the committed ones (temperature, top_k, cache_prompt) and its model alias is the committed alias.
// A body that contains the text of a redacted message is stored as {redacted: true, request_hash} and excluded from the sample and
// counted (`m9_excluded_redacted`); it never fails the check.
//
// Without `--llm` the offline sub-checks still run and the check is `pass: null` ("not run: no llama-server"), never PASS.
import { mindSeed } from '../mind/llm.mjs';
import { createCheck, sampleFrom, sha256hex } from './canon.mjs';

export const SAMPLE_REPLAYS = 20;
/** 18 of 20 (G8): the share is applied to the sample actually compared. */
export const PASS_SHARE = 0.9;

async function complete(llm, bodyText, { fetchImpl = fetch, timeoutMs = 300_000 } = {}) {
  const r = await fetchImpl(`${llm.replace(/\/+$/, '')}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: bodyText, signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`llama-server answered ${r.status}`);
  const j = await r.json();
  const ch = j.choices?.[0];
  if (!ch) throw new Error('llama-server answered without a choice');
  return { content: ch.message?.content ?? '', finish_reason: ch.finish_reason ?? null };
}

export async function checkM9({ pub, records, seedHex, commitments, llm = null, sample = SAMPLE_REPLAYS, fetchImpl = fetch, log = () => {} }) {
  const chk = createCheck('M9', 'bit replay');
  const model = records.filter(r => r.mode === 'model' && r.request_hash);
  let excluded = 0;
  const pool = [];
  for (const r of model) {
    const text = pub.fullRequest(r.id);
    let redacted = false;
    if (text) { try { redacted = JSON.parse(text)?.redacted === true; } catch { /* not JSON: the hash check names it */ } }
    if (redacted) { excluded++; continue; }
    pool.push(r);
  }
  pool.sort((a, b) => a.bell - b.bell || a.index - b.index || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0) || (a.id < b.id ? -1 : 1));
  chk.set('m9_excluded_redacted', excluded);
  chk.set('model_records', model.length);
  const picked = sampleFrom(seedHex, pool, sample);
  chk.set('sampled', picked.length);
  if (!picked.length) { chk.note('no model record with a stored request body to replay'); if (!model.length) chk.skip('no model records in this run'); return chk.result(); }
  if (!llm) chk.skip('not run: no --llm (the offline checks of the stored bodies ran)');
  else {
    // the llama-server must be the committed one (7.3: "started with the committed flags"): what /props reports is compared with -c and --alias
    const flags = commitments?.server?.flags ?? [];
    const flag = name => { const i = flags.indexOf(name); return i >= 0 ? flags[i + 1] : undefined; };
    try {
      const r = await fetchImpl(`${llm.replace(/\/+$/, '')}/props`, { signal: AbortSignal.timeout(10_000) });
      const props = r.ok ? await r.json() : null;
      const nCtx = props?.default_generation_settings?.n_ctx ?? props?.n_ctx;
      const mAlias = props?.model_alias ?? props?.alias;
      chk.set('llm_props', { n_ctx: nCtx ?? null, alias: mAlias ?? null });
      if (nCtx !== undefined && flag('-c') !== undefined && Number(nCtx) !== Number(flag('-c'))) chk.fail('llm_flags', { n_ctx: nCtx, committed: Number(flag('-c')), detail: 'the llama-server is not running with the committed context size' });
      if (mAlias !== undefined && flag('--alias') !== undefined && mAlias !== flag('--alias')) chk.fail('llm_flags', { alias: mAlias, committed: flag('--alias') });
    } catch { chk.note('llama-server /props not readable: its flags were not compared with the commitments'); }
  }
  const samp = commitments?.sampling ?? {};
  const alias = commitments?.model?.alias;
  const season = commitments?.season_id;
  let equal = 0, compared = 0;
  const mismatches = [];
  for (const r of picked) {
    chk.count();
    const text = pub.fullRequest(r.id);
    if (text === null) { chk.fail('request_missing', { decision: r.id, bell: r.bell, ai: r.ai }); continue; }
    if (sha256hex(text) !== r.request_hash) { chk.fail('request_hash_mismatch', { decision: r.id, bell: r.bell, ai: r.ai, record: r.request_hash, stored: sha256hex(text) }); continue; }
    let body;
    try { body = JSON.parse(text); } catch { chk.fail('request_not_json', { decision: r.id }); continue; }
    if (season !== undefined && season !== null) {
      const want = mindSeed({ season, index: r.index, bell: r.bell, kind: r.kind, attempt: Math.max(0, (r.attempts ?? 1) - 1) });
      if (body.seed !== want) { chk.fail('seed_rule_broken', { decision: r.id, bell: r.bell, seed: body.seed, rule: want }); continue; }
    }
    const bad = [];
    if (samp.temperature !== undefined && body.temperature !== samp.temperature) bad.push('temperature');
    if (samp.top_k !== undefined && body.top_k !== samp.top_k) bad.push('top_k');
    if (samp.cache_prompt !== undefined && body.cache_prompt !== samp.cache_prompt) bad.push('cache_prompt');
    if (alias && body.model !== alias) bad.push('model');
    if (bad.length) { chk.fail('sampling_not_as_committed', { decision: r.id, bell: r.bell, fields: bad }); continue; }
    if (!llm) continue;
    try {
      const out = await complete(llm, text, { fetchImpl });
      compared++;
      if (sha256hex(out.content) === r.output_hash) equal++;
      else mismatches.push({ decision: r.id, bell: r.bell, ai: r.ai, kind: r.kind, expected_output_hash: r.output_hash, got_output_hash: sha256hex(out.content), finish_reason: out.finish_reason });
      log(`M9 ${compared}/${picked.length}: ${equal} equal`);
    } catch (e) {
      mismatches.push({ decision: r.id, bell: r.bell, ai: r.ai, kind: r.kind, error: String(e?.message ?? e) });
      compared++;
    }
  }
  if (llm) {
    chk.set('equal', equal);
    chk.set('compared', compared);
    chk.set('threshold', Math.ceil(PASS_SHARE * compared));
    chk.set('mismatches', mismatches);
    if (compared && equal < Math.ceil(PASS_SHARE * compared)) chk.fail('replay_below_threshold', { equal, compared, threshold: Math.ceil(PASS_SHARE * compared) });
  }
  return chk.result();
}
