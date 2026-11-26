// (pt-world-goals-devnet) GET /f/goals/state — the off-chain world-goals judge's answer (devnet-world-goals.mjs), read
// only, on the public listener (the page reads it as `/gw/f/goals/state`). The relay neither judges nor reads the chain
// for it: it serves the judge's answer file (`--world-goals-file`), re-read only when the file changed, and refuses an
// answer that is not a world-goals answer of THIS season with no money and no chain effect.
//
//   404 NotFound              no --world-goals-file (the page shows the goals as planned, not judged)
//   409 WorldGoalsNotYet      the file is missing or not (yet) a good answer (the judge has not written one; 409, not 5xx:
//                             an expected state, not logged as a relay failure)
//   200 {the answer}          wide-flags.mjs answerOf
import { readFile, stat } from 'node:fs/promises';
import { RouteError } from '../../routes/errors.mjs';

export const WORLD_GOALS_ROUTE = 'GET /f/goals/state';

/** Whether `j` may be served for season `seasonId`: the judge's kind, no money, no chain effect, this season. */
export function servableGoals(j, seasonId) {
  return !!j && typeof j === 'object' && j.ok === true && j.v === 1 && j.kind === 'world-goals' && typeof j.ruleset === 'string'
    && j.effects?.money === 'none' && j.effects?.chain === 'none' && String(j.season?.seasonId) === String(seasonId);
}

/** A reader of the answer file that re-reads it only when its size or mtime changed. */
export function goalsFileReader(file, { statImpl = stat, readImpl = readFile } = {}) {
  let key = null, value = null;
  return async () => {
    let s;
    try { s = await statImpl(file); } catch { key = null; value = null; return null; }
    const k = `${s.size}:${s.mtimeMs}`;
    if (k !== key) {
      try { value = JSON.parse(await readImpl(file, 'utf8')); } catch { value = null; }
      key = k;
    }
    return value;
  };
}

const readers = new Map();
export const worldGoalsRoutes = Object.freeze({
  [WORLD_GOALS_ROUTE]: async ctx => {
    const file = ctx.cfg.worldGoalsFile;
    if (!file) throw new RouteError(404, 'not found', 'NotFound');
    if (!readers.has(file)) readers.set(file, goalsFileReader(file));
    const j = await readers.get(file)();
    if (!servableGoals(j, ctx.cfg.seasonId)) throw new RouteError(409, 'the world goals are not judged yet', 'WorldGoalsNotYet');
    return { body: j };
  },
});
