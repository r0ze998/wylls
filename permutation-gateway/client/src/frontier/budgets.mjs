// The Frontier's per-instruction budgets (contract §5.5, §10.2) and the
// compute-budget prefix every transaction carries (§8.3, I-45):
//
//   [SetComputeUnitLimit(cu_limit), SetComputeUnitPrice(price), SetLoadedAccountsDataSizeLimit(L(kind))]
//
// in that order (fclient `TxBudget::instructions`), then the heap frame when
// a keeper retries (I-50; never on a sponsored shape). The numbers come from
// frontier-abi's budgets vector (abi-budgets.mjs, generated): the CU limit to
// request, the loaded-data limit L(kind), the transaction byte ceiling. They
// are placeholders until the wave-5 gate regenerates them from measurements;
// nothing here hard-codes one.
import { BUDGETS } from './abi-budgets.mjs';
import { TAGS } from './abi-tags.mjs';
import { BUDGETS as BUDGETS_V2 } from './abi-v2-budgets.mjs';
import { TAGS as TAGS_V2 } from './abi-v2-tags.mjs';
import { concat, u32le, u64le } from '../bytes.mjs';
import { COMPUTE_BUDGET_PROGRAM } from '../solana-tx.mjs';

export { COMPUTE_BUDGET_PROGRAM };

/** Compute-budget instruction tags (the compute-budget program's own). */
export const CB = Object.freeze({ REQUEST_HEAP_FRAME: 1, SET_COMPUTE_UNIT_LIMIT: 2, SET_COMPUTE_UNIT_PRICE: 3, SET_LOADED_ACCOUNTS_DATA_SIZE_LIMIT: 4 });

/** frontier-abi's budget constants (heap gate, heap frame, CU ladder maximum, lock and packet ceilings, L defaults…). */
export const BUDGET_CONSTANTS = BUDGETS.constants;
/** The lamports a caravan escrows for its settlement (S1, frontier-abi's `caravan::CARAVAN_FEE`). */
export const CARAVAN_FEE = BigInt(BUDGETS_V2.constants.caravan_fee);
/** A transaction's size limit (one packet), in bytes. */
export const PACKET_BYTES = BUDGETS.constants.tx_max;

const byTag = new Map(BUDGETS.instructions.map(b => [b.tag, b]));
const byName = new Map(BUDGETS.instructions.map(b => [b.name, b]));
const tagInfo = new Map([...TAGS.instructions, ...TAGS_V2.instructions].map(t => [t.tag, t]));
const byTagV2 = new Map(BUDGETS_V2.instructions.map(b => [b.tag, b]));
const byNameV2 = new Map(BUDGETS_V2.instructions.map(b => [b.name, b]));

/**
 * The budget row of an instruction (by tag or by its ABI name, e.g.
 * 'Depart'): `{name, tag, class, cuBudget, cuLimit, loadedLimit, txCeiling,
 * heap, writeLocks, accounts: [min, max]}`, or null for an unknown one.
 */
export function budgetOf(which, profile = 1) {
  const b = typeof which === 'number' ? (profile >= 2 ? byTagV2 : byTag).get(which) : (profile >= 2 ? byNameV2 : byName).get(which);
  if (!b) return null;
  // Profile 3 (S1): the v2 rows at the S1 release's loaded limits.
  const loadedLimit = profile === 3 ? (b.loaded_limit_s1 ?? b.loaded_limit) : b.loaded_limit;
  return {
    name: b.name, tag: b.tag, class: b.class, cuBudget: b.cu_budget, cuLimit: b.cu_limit, loadedLimit,
    txCeiling: Math.min(b.tx_ceiling, PACKET_BYTES), heap: b.heap, writeLocks: b.write_locks_worst, accounts: b.accounts,
    topLevelOnly: !!tagInfo.get(b.tag)?.top_level_only,
  };
}

/** Every instruction's budget row, in tag order. */
export const allBudgets = () => [...byTag.keys()].sort((a, b) => a - b).map(tag => budgetOf(tag));

const cbIx = data => ({ programId: COMPUTE_BUDGET_PROGRAM, keys: [], data });
export const setComputeUnitLimit = units => cbIx(concat([CB.SET_COMPUTE_UNIT_LIMIT], u32le(units)));
export const setComputeUnitPrice = microLamports => cbIx(concat([CB.SET_COMPUTE_UNIT_PRICE], u64le(microLamports)));
export const setLoadedAccountsDataSizeLimit = bytes => cbIx(concat([CB.SET_LOADED_ACCOUNTS_DATA_SIZE_LIMIT], u32le(bytes)));
export const requestHeapFrame = bytes => cbIx(concat([CB.REQUEST_HEAP_FRAME], u32le(bytes)));

/**
 * The compute-budget prefix for an instruction kind: its CU limit and
 * L(kind) from the budgets table, `cuPrice` µlamports per CU (0 on every
 * sponsored player shape), and a heap frame only when asked.
 */
export function budgetPrefix(which, { cuPrice = 0n, cuLimit, loadedLimit, heap, profile = 1 } = {}) {
  const b = budgetOf(which, profile);
  if (!b) throw new Error(`no budget for instruction ${which}`);
  const ixs = [setComputeUnitLimit(cuLimit ?? b.cuLimit), setComputeUnitPrice(BigInt(cuPrice)), setLoadedAccountsDataSizeLimit(loadedLimit ?? b.loadedLimit)];
  if (heap) ixs.push(requestHeapFrame(heap));
  return ixs;
}

const le = (d, o, n) => { let v = 0n; for (let i = n - 1; i >= 0; i--) v = (v << 8n) | BigInt(d[o + i]); return v; };

/**
 * A compute-budget instruction read back: `{kind: 'limit'|'price'|'loaded'|'heap', value}`
 * (value a number, the price a bigint), or null if it is not exactly one
 * (wrong program, accounts, tag or length).
 */
export function parseComputeBudgetIx(ix) {
  if (ix.programId !== COMPUTE_BUDGET_PROGRAM || ix.keys.length !== 0) return null;
  const d = ix.data;
  if (d[0] === CB.SET_COMPUTE_UNIT_PRICE) return d.length === 9 ? { kind: 'price', value: le(d, 1, 8) } : null;
  const kind = { [CB.SET_COMPUTE_UNIT_LIMIT]: 'limit', [CB.SET_LOADED_ACCOUNTS_DATA_SIZE_LIMIT]: 'loaded', [CB.REQUEST_HEAP_FRAME]: 'heap' }[d[0]];
  return kind && d.length === 5 ? { kind, value: Number(le(d, 1, 4)) } : null;
}
