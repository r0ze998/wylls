// The execution port: the seam to workstream 4 (run and cancel). The shape
// is the agent wallet's ActionRequest/ActionResult (permutation-gateway
// src/frontier/agent/contract.mjs), so the agent gateway, or workstream 4's
// runner built on it, can take this adapter's place.
//
//   submit(ActionRequest) → ActionResult         idempotent per idempotencyKey: the same key and
//                                                body answers the recorded result with replayed: true
//   status(idempotencyKey) → ActionResult & {fate: 'pending'|'landed'|'failed'|'cancelled', fateError} | null
//   cancel(idempotencyKey) → {cancelled, reason?}  only before it lands; a landed action is never rolled back
//
//   ActionRequest = {agentId, source: 'resident', idempotencyKey, policyVersion, modeEpoch, action: {name, fields}}
//   ActionResult  = {ok, status: 'sent'|'refused'|'failed', signature?, error?: {code, message}, replayed?}
//
// The board port (off-chain requests and replies) is the same idea for
// signed messages: post(body) → {ok, id} | {ok: false, error}.
import { addressOf, signRecord } from '../keys.mjs';
import { ACTION_DOMAIN } from '../../world/testworld.mjs';
import { BOARD_DOMAIN } from '../../world/board.mjs';

/** The test world's adapter: signs each request with the resident's own key; the world checks the signature. */
export function testWorldExecution(world, keypair) {
  const actor = addressOf(keypair);
  return {
    kind: 'test-world (mock)',
    async submit(req) {
      const body = { key: req.idempotencyKey, actor, action: req.action };
      return world.submit({ body, sig: signRecord(ACTION_DOMAIN, body, keypair) });
    },
    async status(key) { return world.status(key, actor); },
    async cancel(key) { return world.cancel(key, actor); },
  };
}

export function testWorldBoard(board, keypair) {
  const from = addressOf(keypair);
  return {
    kind: 'test-world board (mock)',
    async post(body) {
      const b = { ...body, from };
      try { return { ok: true, id: board.post({ body: b, sig: signRecord(BOARD_DOMAIN, b, keypair) }) }; }
      catch (e) { return { ok: false, error: { code: e.code ?? 'Error', message: e.message } }; }
    },
  };
}

const METHODS = { execution: ['submit', 'status', 'cancel'], board: ['post'] };
export function assertPort(kind, port) {
  for (const m of METHODS[kind]) if (typeof port?.[m] !== 'function') throw new Error(`${kind} port lacks ${m}()`);
  return port;
}
