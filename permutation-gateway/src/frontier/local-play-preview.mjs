// LOCAL-PLAY ONLY: read departure conditions and inspect a resident of the pinned player.
//
// The page asks `POST /f/expedition/preview` (through the herald's `/gw/*`) with a
// `frontier-original-outbound-snapshot-request-v1`. The general gateway serves that route from
// expedition-preview.mjs; the dedicated relay did not, so the card ended in NotFound. This file is that same
// adapter (createExpeditionPreview: its canonical request checks, its 25 s limit, 64 KiB of output, two at a time,
// cancel and close, and its whole report validation), reused as it is, under the relay's own fixed pins:
//
//   cluster localnet · the local-play program · its Season PDA · program version 0x4804 · the S1 ruleset ·
//   the relay's loopback runner RPC (never a caller's)
//
// and narrowed further before anything is spawned:
//   * only an outbound snapshot or the existing read-only resident inspection request;
//   * only the relay's own pinned player wallet (the request names one wallet: it is the reader's, and here also
//     the one that pays, as local-play-relay.mjs has it); a resident request must name that same payer.
//
// Read only: the one-shot binary is given the request on stdin and `--rpc-url` (plus `--outbound-snapshot` for that kind), no key, no
// environment, and builds no transaction. Nothing here signs, submits or stores.
import { createExpeditionPreview, ExpeditionPreviewError, EXPEDITION_PREVIEW_ROUTE, EXPEDITION_REQUEST_SCHEMA } from './expedition-preview.mjs';
import { OUTBOUND_SNAPSHOT_REQUEST_SCHEMA } from './outbound-snapshot.mjs';
import { DEPART_PREPARE_PROGRAM_VERSION } from './expedition-depart-prepare.mjs';
import { localPlayRelayConfigProblems, LOCAL_PLAY_CLUSTER } from './local-play-relay.mjs';

export const LOCAL_PLAY_PREVIEW_ROUTE = EXPEDITION_PREVIEW_ROUTE;
export { ExpeditionPreviewError };

/**
 * The preview of the dedicated relay over `cfg` (the relay's own configuration, exactly) and `previewBin` (the absolute
 * path of `frontier-original-expedition-preview`, kept apart from the relay's closed configuration). Constructing it spawns and reads nothing. Throws when the relay's pins
 * or the binary's path are not acceptable (fail closed: no route rather than a looser one).
 * → `{inspect(body, {signal}), close()}`.
 */
export function createLocalPlayPreview({ cfg, previewBin, spawn, setTimer, clearTimer }) {
  const problems = localPlayRelayConfigProblems(cfg);
  if (problems.length) throw new Error('local-play preview: ' + problems.join('; '));
  let adapter = null;
  if (typeof previewBin === 'string' && previewBin.length > 0) try {
    adapter = createExpeditionPreview({ cfg: { cluster: LOCAL_PLAY_CLUSTER, programId: cfg.program, expeditionPreviewBin: previewBin, expeditionPreviewRpc: cfg.rpc,
      expeditionPreviewProgramVersion: DEPART_PREPARE_PROGRAM_VERSION, expeditionPreviewRulesetHash: cfg.rulesetHash }, season: cfg.season,
    ...(spawn ? { spawn } : {}), ...(setTimer ? { setTimer } : {}), ...(clearTimer ? { clearTimer } : {}) });
  } catch { adapter = null; }
  if (!adapter) throw new Error('local-play preview: previewBin must be an absolute executable path');
  const wallet = cfg.wallet;
  return Object.freeze({
    async inspect(body, { signal } = {}) {
      // (before the adapter, so before any spawn: another kind of inspection, or another wallet's, is not this relay's)
      if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new ExpeditionPreviewError('ExpeditionPreviewInvalidRequest');
      const outbound = body.schema === OUTBOUND_SNAPSHOT_REQUEST_SCHEMA;
      const resident = body.schema === EXPEDITION_REQUEST_SCHEMA;
      // Resident inspection is still the existing keyless reader, not prepare/submit. Keep both wallet and
      // proposed payer pinned; do not accept the general adapter's nullable/foreign signer forms here.
      if ((!outbound && !resident) || body.wallet !== wallet
          || (outbound ? Object.hasOwn(body, 'payer') : body.payer !== wallet)) {
        throw new ExpeditionPreviewError('ExpeditionPreviewScopeMismatch');
      }
      return adapter.inspect(body, { signal });
    },
    close() { adapter.close(); },
  });
}
