// Where another workstream's code is for a cross-workstream test: the environment variable when it is set (a
// restored or separately checked-out tree), else this repository's own tree when it carries that workstream with the
// feature the test needs (an integration tree carries 4, 5 and 12 in place), else nothing (the test skips and says
// which input is missing). `from` names which one was used, for the record.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = fileURLToPath(new URL('../../../', import.meta.url));

const has = (root, rel, mark = null) => {
  const p = path.join(root, rel);
  if (!existsSync(p)) return false;
  return mark === null || readFileSync(p, 'utf8').includes(mark);
};

/**
 * @param envs   variable names, first set wins
 * @param probe  [relative path, marker text or null]: what the in-tree copy must contain to be used
 */
export function rootOf(envs, probe) {
  for (const n of envs) if (process.env[n]) return { root: process.env[n], from: n };
  if (has(REPO, ...probe)) return { root: REPO, from: 'in-tree' };
  return { root: null, from: null };
}

// Workstream 5: the cost ledger, price book and process lease the resident's cost port uses.
export const ws05 = () => rootOf(['WS05_ROOT', 'WS05_E9D1551A'], ['workstreams/05-ai-participation/model-api/src/cost-store.mjs', 'recoverStale']);
// Workstream 12, by the feature a test needs.
export const ws12 = (need = 'canonical') => rootOf(['WS12_ROOT', 'WS12_EA0636EB'], {
  canonical: ['workstreams/12-memory/adapters/canonical.mjs', 'ws12EvidencePort'],         // ea0636eb
  'lazy-fixture': ['workstreams/12-memory/fixtures/scenario.mjs', 'lazyKeys'],               // 1583026f
  'evidence-basis': ['workstreams/12-memory/src/fold.mjs', 'evidence_basis'],               // fa4baf14
}[need]);
// Workstream 4's JS clients (the binary they drive is not in any tree: RUNEXEC_BIN / RUNEXEC_VIEW_BIN).
export const ws04Acts = () => rootOf(['WS04_ACTS_CLIENT'], ['workstreams/04-execution/clients/acts.mjs', 'createActsClient']);
export const ws04Runs = () => rootOf(['WS04_RUNS_CLIENT'], ['workstreams/04-execution/clients/runs.mjs', 'createRunsClient']);
/** A client root resolves to the file itself (env) or to the in-tree file. */
export const clientFile = (r, rel) => (r.root === null ? null : r.from === 'in-tree' ? path.join(r.root, rel) : r.root);
