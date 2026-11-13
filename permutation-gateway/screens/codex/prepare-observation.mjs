// Explicitly synthetic PUBLIC unsigned messages for UI contract tests only.
// No key, signature, transaction envelope, chain observation or execution claim.
import { compileMessage, parseMessage, COMPUTE_BUDGET_PROGRAM } from '../../../permutation-server/web/sdk/solana-tx.mjs';
import { encode } from '../../../permutation-server/web/sdk/base58.mjs';
import { toHex, fromHex, toBase64 } from '../../../permutation-server/web/sdk/bytes.mjs';
import { sha256 } from '../../../permutation-server/web/sdk/sha256.mjs';
import { requestDigest } from '../../../permutation-server/web/frontier/fexpedition.mjs';

export function syntheticPreparation(request) {
  const source = request.source_request, budget = { cu_limit: 200000, cu_price: '0', loaded_limit: 65536, heap: 256 * 1024 };
  const hash = encode(new Uint8Array(32).fill(77));
  const prefix = (op, n, len = 5) => { const data = new Uint8Array(len); data[0] = op; new DataView(data.buffer).setUint32(1, n, true); return { programId: COMPUTE_BUDGET_PROGRAM, keys: [], data }; };
  const instruction = fromHex((request.action === 'Dissolve' ? 'daff0204' : 'dcff0205') + request.proposal.bytes_hex);
  const message = compileMessage({ feePayer: source.payer, recentBlockhash: hash, instructions: [
    prefix(2, budget.cu_limit), prefix(3, 0, 9), prefix(4, budget.loaded_limit), prefix(1, budget.heap),
    { programId: source.program, keys: request.proposal.roles.map(r => ({ pubkey: r.address, isSigner: r.signer, isWritable: r.writable })), data: instruction },
  ] });
  const parsed = parseMessage(message), h = parsed.header, slot = (BigInt(request.source_context_slot) + 1n).toString();
  return { schema: 'frontier-experimental-expedition-prepare-report-v1', status: 'prepared', request: structuredClone(request),
    source: { request_digest: requestDigest(source), context_slot: slot, digest: 'cd'.repeat(32), coherent: true, authority_verified: false },
    blockhash: { hash, latest_context_slot: slot, validity_context_slot: slot, height_min_context_slot: slot,
      block_height: '100', last_valid_block_height: '250', remaining_block_heights: '150', valid: true, commitment: 'confirmed', coherent: false, authority_verified: false },
    prepared: { program: source.program, season: source.season, program_version: '18436', action: request.action,
      fee_payer: source.payer, budget, roles: structuredClone(request.proposal.roles), instruction_hex: toHex(instruction),
      message_b64: toBase64(message), message_digest: toHex(sha256(message)), signers: parsed.signers,
      shape: { bytes: message.length + 1 + 64 * parsed.signers.length, locks: parsed.accountKeys.length,
        writes: parsed.accountKeys.length - h.numReadonlySignedAccounts - h.numReadonlyUnsignedAccounts, sigs: parsed.signers.length },
      proposal_digest: request.proposal.content_digest }, blocker: null,
    host_only: true, ready: false, deployment_verified: false, admitted: false, signed: false,
    enqueued: false, relay_submission_available: false, automatic_send: false };
}
