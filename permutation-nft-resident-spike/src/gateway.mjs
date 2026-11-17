// The relay-side gateway for resident operations: the one path a browser,
// an MCP tool or an AI agent uses to act for a resident. Order of checks
// (each refusal sends nothing):
//
//   credential → fresh holder read at authorization time (OwnerChanged /
//   StaleRead / ChainUnavailable refuse) → the operation names the
//   credential's resident (WrongResident) → cost approval, if the operation
//   needs one (bound to wallet + epoch) → the transaction is built for the
//   signer (the holder's key, or the agent key for a delegation) → a last
//   holder check right before the send (`beforeSend`) → the mock chain
//   executes it, and its prologue checks the holder **again** at execution.
//
// Ordering rule with a transfer (contract §4): the chain's execution order
// decides. An operation that executes before the transfer stands; one that
// executes after it fails in the prologue (NotOwner) whatever credential
// signed it and whenever it was signed. The relay's checks only refuse
// earlier so that nothing is sent that the chain would refuse.
import { ERR, Refusal, refuse } from './errors.mjs';
import { signTx } from './mock-chain.mjs';

export const NEEDS_APPROVAL = Object.freeze(['SendCaravan']);

export class ResidentGateway {
  constructor({ chain, registry, auth, world, store, now = Date.now }) {
    this.chain = chain; this.registry = registry; this.auth = auth; this.world = world; this.store = store; this.now = now;
    this.store.state ??= {};
    this.store.state.gateway ??= { requests: {} };
    /** Signers the relay may use for a credential kind: the holder's own key never leaves the browser (it signs there); the agent keys live here (as the agent wallet's keyring). */
    this.agentKeys = new Map();
  }

  get db() { return this.store.state.gateway; }

  /** Register an agent key the relay holds (the AI's); its public key is what the holder delegates to. */
  holdAgentKey(kp) { this.agentKeys.set(kp.publicKey, kp); return kp.publicKey; }

  /**
   * Submit an operation. `credential`: login/capability token or
   * `{agentKey, assetId}`; `signer`: the keypair that signs the transaction
   * (the browser's holder key, or omitted for a delegation: the relay signs
   * with the agent key); `idempotencyKey`: a repeat returns the recorded
   * result; `minSlot`: how fresh the holder read must be; `approvalId`: the
   * settled approval for an operation that needs one.
   */
  async submit({ credential, op, signer = null, idempotencyKey, minSlot = 0, approvalId = null, presigned = null }) {
    if (!idempotencyKey) refuse(ERR.BAD_REQUEST, 'idempotencyKey');
    const prior = this.db.requests[idempotencyKey];
    if (prior) {
      if (prior.fingerprint !== fingerprint(op)) refuse(ERR.IDEMPOTENCY_CONFLICT, 'a different operation was sent under this key');
      return { ...prior.result, replayed: true };
    }
    const record = result => { this.db.requests[idempotencyKey] = { fingerprint: fingerprint(op), result, at: this.now() }; this.store.save(); return result; };
    try {
      const who = await this.auth.authorize({ credential, minSlot });
      if (op.residentId !== who.residentId) refuse(ERR.WRONG_RESIDENT, 'the operation names a resident this credential does not hold', { credential: who.residentId, op: op.residentId });
      if (NEEDS_APPROVAL.includes(op.name)) {
        const a = approvalId ? this.world.approval(approvalId) : null;
        if (!a) {
          const opened = this.world.openApproval({ id: `ap_${idempotencyKey}`, residentId: who.residentId, wallet: who.wallet, epoch: who.epoch, op });
          return record({ ok: false, status: 'awaiting-approval', approvalId: opened.id, code: 'ApprovalRequired' });
        }
        if (a.residentId !== who.residentId || a.wallet !== who.wallet || a.epoch !== who.epoch || a.state !== 'approved') {
          refuse(ERR.APPROVAL_VOID, 'the cost approval belongs to another holder or epoch, or was not given', { approval: a.state, approvalEpoch: a.epoch, epoch: who.epoch });
        }
      }
      // Build and sign: the holder's own key signs in the browser (passed here as `signer`); a delegation signs with the relay-held agent key.
      let tx = presigned;
      if (!tx) {
        const actor = who.kind === 'delegation' ? who.agentKey : who.wallet;
        const kp = who.kind === 'delegation' ? this.agentKeys.get(who.agentKey) : signer;
        if (!kp || kp.publicKey !== actor) refuse(ERR.BAD_REQUEST, 'no signer for the actor', { actor });
        tx = signTx(this.chain.buildOp({ assetId: who.assetId, actor, op }), [kp]);
      } else if (presigned.message.assetId !== who.assetId) {
        refuse(ERR.WRONG_RESIDENT, 'the presigned transaction names another asset');
      }
      // Last check right before the bytes leave (as the agent wallet's beforeSend): the holder read again.
      const again = await this.registry.holderNow(who.assetId, { minSlot });
      if (again.holder !== who.wallet || again.epoch !== who.epoch) refuse(ERR.OWNER_CHANGED, 'the holder changed between authorization and send; nothing sent', { holder: again.holder });
      const sent = this.chain.send(tx);
      return record({ ok: true, status: 'sent', signature: sent.signature, slot: sent.slot, applied: sent.applied, epoch: who.epoch, by: who.kind });
    } catch (e) {
      if (!(e instanceof Refusal)) throw e;
      // A refusal is recorded too (a retry under the same key must not turn a refusal into a send with a different world state).
      return record({ ok: false, status: e.extra?.signature ? 'failed' : 'refused', code: e.code, message: e.message, ...(e.extra?.signature ? { signature: e.extra.signature } : {}) });
    }
  }

  /** The holder confirms a cost approval: re-authorized at confirmation time, so a transfer in between voids it. */
  async approve({ credential, approvalId }) {
    const a = this.world.approval(approvalId);
    if (!a) refuse(ERR.BAD_REQUEST, 'no such approval');
    let who;
    try {
      who = await this.auth.authorize({ credential });
    } catch (e) {
      if (e instanceof Refusal && e.code === ERR.OWNER_CHANGED) { this.world.settleApproval(approvalId, 'void', 'holder changed'); }
      throw e;
    }
    if (a.wallet !== who.wallet || a.epoch !== who.epoch || a.residentId !== who.residentId) {
      this.world.settleApproval(approvalId, 'void', 'another holder or epoch');
      refuse(ERR.APPROVAL_VOID, 'this approval is not yours to give any more', { approval: a });
    }
    return this.world.settleApproval(approvalId, 'approved');
  }
}

const fingerprint = op => JSON.stringify(op, Object.keys(op).sort());
