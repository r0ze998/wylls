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
//
// Key retention (the contract with workstream 4, see 08-retention-contract.ja.md):
//   retentionBells  how long after a key's fate is final the port still answers status(key) and replays submit
//                   for it. The resident re-queries and re-submits only keys of unfinished journal lines and never
//                   re-creates a key it has finished with, so this must cover one game day after finality (a
//                   resident that was stopped or down for a day still reads its last results). A port that forgets
//                   a key must refuse a later submit under it (KeyExpired), never execute it again.
//   A port that declares less than REQUIRED_KEY_RETENTION_BELLS is refused by the resident.
import { toIdentity } from '../keys.mjs';
import { ACTION_DOMAIN } from '../../world/testworld.mjs';
import { BOARD_DOMAIN } from '../../world/board.mjs';
import { BELLS_PER_DAY } from '../../world/rules.mjs';

export const REQUIRED_KEY_RETENTION_BELLS = BELLS_PER_DAY;

/** The test world's adapter: signs each request with the resident's own key; the world checks the signature. */
export function testWorldExecution(world, who) {
  const id = toIdentity(who);
  const actor = id.address;
  return {
    kind: 'test-world (mock)',
    // The test world never forgets a key.
    retentionBells: Infinity,
    async submit(req) {
      const body = { key: req.idempotencyKey, actor, action: req.action };
      return world.submit({ body, sig: id.sign(ACTION_DOMAIN, body) });
    },
    async status(key) { return world.status(key, actor); },
    async cancel(key) { return world.cancel(key, actor); },
  };
}

export function testWorldBoard(board, who) {
  const id = toIdentity(who);
  const from = id.address;
  return {
    kind: 'test-world board (mock)',
    async post(body) {
      const b = { ...body, from };
      try { return { ok: true, id: board.post({ body: b, sig: id.sign(BOARD_DOMAIN, b) }) }; }
      catch (e) { return { ok: false, error: { code: e.code ?? 'Error', message: e.message } }; }
    },
  };
}

const METHODS = { execution: ['submit', 'status', 'cancel'], board: ['post'] };
export function assertPort(kind, port) {
  for (const m of METHODS[kind]) if (typeof port?.[m] !== 'function') throw new Error(`${kind} port lacks ${m}()`);
  if (kind === 'execution') {
    const r = port.retentionBells;
    if (!(typeof r === 'number' && r >= REQUIRED_KEY_RETENTION_BELLS))
      throw new Error(`execution port keeps keys ${r ?? 'for an undeclared time'}; the resident needs at least ${REQUIRED_KEY_RETENTION_BELLS} bells after a key's fate is final`);
  }
  return port;
}
