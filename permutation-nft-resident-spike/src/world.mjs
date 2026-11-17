// The world the resident program drives: a minimal village per resident,
// enough to show which data follows the NFT and which does not. It is
// keyed by **resident id**, never by wallet. Nothing here is created at
// publish or at login: `ensure` runs when the program first touches a
// resident (its first operation), and an existing village is never replaced.
//
// Per resident (moves with the NFT):        village (stores, buildings),
//   caravans in transit (arrive later, credit the resident), workshop orders
//   in progress, history, obligations the resident OWES and goods the
//   resident HOLDS FOR OTHERS (these follow the resident but are not the
//   resident's free assets: they stay owed / held).
// Per wallet (stays with the person):       unclaimed rewards keyed by the
//   paying wallet (as the prize program's Entry is today), pending cost
//   approvals (bound to wallet + epoch; void after a transfer).
import { ERR, refuse } from './errors.mjs';

export const CARAVAN_BELLS = 3;
export const ORDER_BELLS = 2;

export class World {
  constructor({ store, now = Date.now } = {}) {
    this.store = store;
    this.now = now;
    this.store.state ??= {};
    this.store.state.world ??= { bell: 0, residents: {}, walletRewards: {}, approvals: {}, seq: 0 };
  }

  get db() { return this.store.state.world; }
  save() { this.store.save(); }

  /** The resident's village, created once (first operation), with a record of when and by which operation. */
  ensure(residentId, { slot = null, signature = null } = {}) {
    let v = this.db.residents[residentId];
    if (!v) {
      v = { residentId, createdAt: { bell: this.db.bell, slot, signature }, stores: { food: 100, wood: 50, ore: 0 }, buildings: [], caravans: [], orders: [], heldForOthers: [], owed: [], history: [] };
      this.db.residents[residentId] = v;
      this.save();
    }
    return v;
  }

  snapshot(residentId) {
    const v = this.db.residents[residentId];
    return v ? JSON.parse(JSON.stringify(v)) : null;
  }

  /**
   * Called by the mock program after its prologue passed (`owner` is the
   * asset's current holder at execution; `actor` the signer). Applies one
   * operation and records who did it and at which slot. Refuses an operation
   * naming another resident than the asset's (`WrongResident`).
   */
  applyFromProgram({ assetId, op, actor, owner, slot, signature, residentId }) {
    const rid = residentId ?? op.residentId;
    if (!rid) refuse(ERR.BAD_DATA, 'op without a resident id');
    const v = this.ensure(rid, { slot, signature });
    this.db.seq += 1;
    const line = { seq: this.db.seq, bell: this.db.bell, slot, signature, actor, holder: owner, op: op.name };
    switch (op.name) {
      case 'Harvest': v.stores.food += 10; break;
      case 'Chop': v.stores.wood += 5; break;
      case 'Build': {
        if (v.stores.wood < 20) refuse(ERR.INSUFFICIENT, 'Build: 20 wood needed');
        v.stores.wood -= 20; v.buildings.push({ kind: op.kind ?? 'farm', builtAt: this.db.bell }); break;
      }
      case 'SendCaravan': {
        const n = Number(op.food ?? 0);
        if (!(n > 0) || v.stores.food < n) refuse(ERR.INSUFFICIENT, 'SendCaravan: not enough food');
        v.stores.food -= n;
        v.caravans.push({ id: `cv-${this.db.seq}`, food: n, to: op.to ?? rid, arrivesAtBell: this.db.bell + CARAVAN_BELLS, sentBy: actor, sentAtSlot: slot });
        break;
      }
      case 'PlaceOrder': {
        if (v.stores.ore < 0) refuse(ERR.INSUFFICIENT, 'ore');
        v.orders.push({ id: `od-${this.db.seq}`, product: 'arms', readyAtBell: this.db.bell + ORDER_BELLS, placedBy: actor });
        break;
      }
      case 'HoldForOther': {
        // Goods another resident deposited with this one: held, not owned.
        const n = Number(op.food ?? 0);
        if (!(n > 0)) refuse(ERR.BAD_DATA, 'HoldForOther: amount');
        v.heldForOthers.push({ id: `hf-${this.db.seq}`, owner: op.owner, food: n, since: this.db.bell });
        break;
      }
      case 'Promise': {
        // An obligation this resident owes another (a debt in food).
        const n = Number(op.food ?? 0);
        if (!(n > 0)) refuse(ERR.BAD_DATA, 'Promise: amount');
        v.owed.push({ id: `ow-${this.db.seq}`, to: op.to, food: n, since: this.db.bell });
        break;
      }
      default: refuse(ERR.BAD_DATA, `unknown operation ${op.name}`);
    }
    v.history.push(line);
    this.save();
    return { seq: line.seq, stores: { ...v.stores } };
  }

  /** The world's bell: caravans arrive, orders finish; everything credits the **resident**, whoever holds it now. */
  tick(bells = 1) {
    for (let i = 0; i < bells; i++) {
      this.db.bell += 1;
      for (const v of Object.values(this.db.residents)) {
        for (const c of [...v.caravans]) {
          if (c.arrivesAtBell <= this.db.bell) {
            const dest = this.db.residents[c.to] ?? v;
            dest.stores.food += c.food;
            dest.history.push({ seq: ++this.db.seq, bell: this.db.bell, op: 'CaravanArrived', caravan: c.id, food: c.food, from: v.residentId });
            v.caravans = v.caravans.filter(x => x !== c);
          }
        }
        for (const o of [...v.orders]) {
          if (o.readyAtBell <= this.db.bell) {
            v.stores.arms = (v.stores.arms ?? 0) + 4;
            v.history.push({ seq: ++this.db.seq, bell: this.db.bell, op: 'OrderDone', order: o.id });
            v.orders = v.orders.filter(x => x !== o);
          }
        }
      }
    }
    this.save();
    return this.db.bell;
  }

  // ------------------------------------------------------------ wallet-side records

  /** An unclaimed reward keyed by the wallet that earned it (the prize Entry today is wallet-keyed). Stays with the wallet. */
  creditWalletReward(wallet, amount, note) {
    const r = (this.db.walletRewards[wallet] ??= { unclaimed: 0, lines: [] });
    r.unclaimed += amount;
    r.lines.push({ amount, note, bell: this.db.bell });
    this.save();
  }
  walletReward(wallet) { return this.db.walletRewards[wallet] ?? { unclaimed: 0, lines: [] }; }

  /** A cost confirmation the holder must give before an operation is sent: bound to wallet and epoch. */
  openApproval({ id, residentId, wallet, epoch, op }) {
    this.db.approvals[id] = { id, residentId, wallet, epoch, op, state: 'waiting', openedAt: this.now() };
    this.save();
    return this.db.approvals[id];
  }
  approval(id) { return this.db.approvals[id] ?? null; }
  /** Resolve an approval; `void` when the holder changed meanwhile. */
  settleApproval(id, state, reason = null) {
    const a = this.db.approvals[id];
    if (!a) refuse(ERR.BAD_REQUEST, 'no such approval');
    a.state = state; a.reason = reason; a.settledAt = this.now();
    this.save();
    return a;
  }
}
