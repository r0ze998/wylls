// Owner commands (docs/agent-wallet/DESIGN.md §5): everything that changes
// who owns an agent, where its money goes, what it may do or how much it may
// spend is a command signed by the owner's wallet (ed25519 over a fixed
// prefix and the command's canonical JSON). The agent's own key, its
// capability token and any MCP caller can never produce one: they do not
// hold the wallet's key, and the gateway accepts these operations only with
// this signature.
//
//   command = { op, owner, agentId?, nonce, expiresAt (ms), params: {…} }
//
// A command expires (at most 10 minutes ahead) and its nonce is used once.
import { encode as base58 } from '../../../client/src/base58.mjs';
import { fromBase64, utf8 } from '../../../client/src/bytes.mjs';
import { pubkeyBytes } from '../../../client/src/solana-tx.mjs';
import { signTalk, verifyTalk } from '../../../client/src/talk-node.mjs';
import { AgentError, ERR } from './contract.mjs';

export const OWNER_PREFIX = 'Wylls agent wallet command v1\n';
export const OWNER_OPS = Object.freeze(['create', 'policy', 'mode', 'withdraw', 'action', 'rotate-capability']);
export const MAX_COMMAND_MS = 10 * 60_000;

/** Canonical JSON: object keys sorted at every level (so signer and verifier agree byte for byte). */
export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

export const commandBytes = command => utf8(OWNER_PREFIX + canonical(command));

/** Signs a command with the owner's web3.js Keypair (tests, scripts, the browser does the same with its wallet). */
export function signCommand(command, keypair) {
  return Buffer.from(signTalk(commandBytes(command), keypair)).toString('base64');
}

/**
 * Verifies `{command, signature}` for operation `op` and consumes its nonce
 * in `nonces` (`{owner: {nonce: expiresAt}}`, the ledger's). Returns the
 * command. Throws BadOwnerSignature / OwnerCommandExpired / OwnerCommandReplayed.
 */
export function verifyCommand({ command, signature }, { op, nonces, now = Date.now() }) {
  if (!command || typeof command !== 'object' || command.op !== op) throw new AgentError(ERR.BAD_REQUEST, `expected an owner command with op "${op}"`);
  if (typeof command.owner !== 'string' || typeof command.nonce !== 'string' || command.nonce.length < 8 || command.nonce.length > 64) {
    throw new AgentError(ERR.BAD_REQUEST, 'owner command needs owner and an 8–64 char nonce');
  }
  let ok = false;
  try {
    const sig = fromBase64(String(signature ?? ''));
    ok = sig.length === 64 && verifyTalk(commandBytes(command), sig, pubkeyBytes(command.owner));
  } catch { ok = false; }
  if (!ok) throw new AgentError(ERR.BAD_OWNER_SIGNATURE, 'the owner command is not signed by its owner\'s wallet', 401);
  if (!Number.isInteger(command.expiresAt) || command.expiresAt <= now || command.expiresAt > now + MAX_COMMAND_MS) {
    throw new AgentError(ERR.OWNER_COMMAND_EXPIRED, 'the owner command has expired or expires too far ahead', 401);
  }
  const mine = (nonces[command.owner] ??= {});
  for (const [n, exp] of Object.entries(mine)) if (exp <= now) delete mine[n];
  if (mine[command.nonce] !== undefined) throw new AgentError(ERR.OWNER_COMMAND_REPLAYED, 'this owner command was already used', 409);
  mine[command.nonce] = command.expiresAt;
  return command;
}

export const isPubkey = s => { try { return typeof s === 'string' && base58(pubkeyBytes(s)) === s; } catch { return false; } };
