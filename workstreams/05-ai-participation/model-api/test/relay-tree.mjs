// The relay code these tests run against, as the operator would state it to the autopilot (access-check.mjs: the probe
// is sent only to a relay tree whose gate order was verified). RELAY_TREE overrides it for a run on a patched tree.
// `relay-tree.test.mjs` checks that the files the tests import really are that tree, so the statement cannot drift.
import { ProbeBudget } from '../src/access-check.mjs';

export const LOCAL_RELAY_TREE = process.env.RELAY_TREE ?? '560f8659fdc091d6870c35539333acf59381acf8';
export const tokenCheck = (relayTree = LOCAL_RELAY_TREE, perDay) => ({ probe: { enabled: true, relayTree, budget: new ProbeBudget(perDay ? { perDay } : {}) } });
