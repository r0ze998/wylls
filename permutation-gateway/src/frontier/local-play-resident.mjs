// LOCAL-PLAY ONLY: the two player-signed steps of the existing return of an original host that stays in wide land,
//
//   OwnerDissolve (action "Dissolve")  →  [ResolveVoluntaryLeave: the bell's own processing, not signed here]
//                                      →  ReturnOriginalReserve (action "Return")
//
// served by the dedicated loopback relay beside Depart:
//
//   POST /f/local-play/resident/prepare   the existing `frontier-experimental-expedition-prepare-request-v1`, whole
//   POST /f/local-play/resident/submit    {schema, message_digest, transaction_b64}
//   POST /f/local-play/resident/status    {schema, signature}
//
// Nothing new is decided here. The preparation is the existing keyless adapter (expedition-prepare.mjs:
// `frontier-experimental-expedition-prepare`, its canonical request, its whole independent check of the unsigned
// message, 30 s, 32 KiB, two at a time, cancel and close), under the relay's own fixed pins (localnet, the local-play
// program, its Season PDA, version 0x4804, the S1 ruleset, the relay's loopback runner, the relay's compute limits)
// with the relay's one pinned wallet as the acting wallet AND the fee payer. Submit and status are the Depart
// relay's own machinery (local-play-relay.mjs `flow`): the exact prepared message signed once by that wallet, a
// replay barrier kept until the chain's block height has really passed the message's last valid height, ONE send,
// and an outcome that is not known answered by status only. The general gateway's `POST /f/expedition/prepare`
// (unsigned review, no send) is not served by this relay and is not changed.
//
// No key is held, nothing is signed here, nothing is sent anywhere but the loopback runner.
import { createExpeditionPrepare, ExpeditionPrepareError } from './expedition-prepare.mjs';
import { createLocalPlayRelay, localPlayRelayConfigProblems, fetchRpc, LOCAL_PLAY_CLUSTER } from './local-play-relay.mjs';

export const RESIDENT_SUBMIT_SCHEMA = 'frontier-local-play-resident-submit-v1';
export const RESIDENT_STATUS_SCHEMA = 'frontier-local-play-resident-status-v1';
export const RESIDENT_ROUTES = Object.freeze({
  prepare: 'POST /f/local-play/resident/prepare',
  submit: 'POST /f/local-play/resident/submit',
  status: 'POST /f/local-play/resident/status',
});
export { ExpeditionPrepareError };

/**
 * The resident routes over `cfg` (the relay's own closed configuration) and `residentBin` (the absolute path of
 * `frontier-experimental-expedition-prepare`, kept apart from it). Constructing it spawns and reads nothing. Throws
 * when the pins or the path are not acceptable. `prepare` (tests) replaces the CLI adapter, `rpc` the JSON-RPC client.
 * → `{prepare(body, {signal}), submit(body), status(body), stats(), close()}`.
 */
// (`runnerInstance`: handed on to the relay machinery unchanged — see createLocalPlayRelay. No start gives one today.)
export function createLocalPlayResident({ cfg, residentBin, prepare = null, rpc = (m, p) => fetchRpc(cfg.rpc, m, p), now = () => Date.now(), spawn, setTimer, clearTimer, runnerInstance = null }) {
  const problems = localPlayRelayConfigProblems(cfg);
  if (problems.length) throw new Error('local-play resident: ' + problems.join('; '));
  let adapter = prepare;
  if (!adapter) {
    if (typeof residentBin === 'string' && residentBin.length > 0) try {
      adapter = createExpeditionPrepare({ cfg: { cluster: LOCAL_PLAY_CLUSTER, programId: cfg.program, expeditionPrepareBin: residentBin, expeditionPrepareRpc: cfg.rpc,
        expeditionPrepareFeePayer: cfg.wallet, expeditionPrepareRulesetHash: cfg.rulesetHash, expeditionPrepareCuLimit: cfg.cuLimit, expeditionPrepareLoadedLimit: cfg.loadedLimit },
      season: cfg.season, ...(spawn ? { spawn } : {}), ...(setTimer ? { setTimer } : {}), ...(clearTimer ? { clearTimer } : {}) });
    } catch { adapter = null; }
    if (!adapter) throw new Error('local-play resident: residentBin must be an absolute executable path');
  }
  // (the pinned scope of a resident request is its inspection request: cluster, program, Season, deployment, wallet, payer)
  const relay = createLocalPlayRelay({ cfg, prepare: adapter, rpc, now, runnerInstance,
    flow: { routes: RESIDENT_ROUTES, submitSchema: RESIDENT_SUBMIT_SCHEMA, statusSchema: RESIDENT_STATUS_SCHEMA, scopeOf: body => body.source_request } });
  return Object.freeze({
    routes: RESIDENT_ROUTES,
    prepare: (body, o) => relay.prepare(body, o),
    submit: body => relay.submit(body),
    status: body => relay.status(body),
    stats: () => relay.stats(),
    close: () => relay.close(),
  });
}
