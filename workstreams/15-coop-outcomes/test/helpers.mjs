import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluate } from '../src/evaluate.mjs';
import { RULESETS } from '../src/rulesets.mjs';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'scenarios');
/** A committed scenario input. */
export const load = name => JSON.parse(readFileSync(join(dir, `${name}.json`), 'utf8'));
/** Verdicts of A, B and C on one input. */
export const all = input => Object.fromEntries(['A', 'B', 'C'].map(k => [k, evaluate(RULESETS[k], input)]));
export const joint = v => v.achievements.joint[0];
export const project = (v, id = 'P-north') => joint(v).projects.find(p => p.project === id);
export const personal = (v, goal, subject) => v.achievements.personal.find(p => p.goal === goal && p.subject === subject);
export const codes = rs => rs.map(r => r.code);
/** A copy of `input` with `f` applied to its events. */
export const withEvents = (input, f) => ({ ...input, events: f(structuredClone(input.events)) });

/** A small fixed-seed generator (mulberry32) for the few reorderings tried. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
export function shuffled(xs, seed) {
  const r = rng(seed);
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
  return out;
}

/**
 * A copy of `input` in which the events matching `pred` never happened:
 * removed, and each stream renumbered so no gap is left (contrast with
 * filtering, which leaves a gap: a record that happened but was not seen).
 */
export function without(input, pred) {
  const kept = input.events.filter(e => !pred(e));
  const next = {};
  const bySeq = [...kept].sort((a, b) => (a.stream < b.stream ? -1 : a.stream > b.stream ? 1 : a.seq - b.seq));
  const renum = new Map(bySeq.map(e => { const s = next[e.stream] ?? 0; next[e.stream] = s + 1; return [e, s]; }));
  return { ...input, events: kept.map(e => ({ ...e, seq: renum.get(e) })) };
}
