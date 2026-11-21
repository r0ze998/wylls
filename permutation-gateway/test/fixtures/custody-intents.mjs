// One example intent per ⑨ capacity / ⑩ custody preview act (permutation-server/web/frontier/flocalplay-custody.mjs),
// for the tests that walk every coexist act (frontier-local-play-rights.test.mjs) and the preview's own tests.
// Plain data; no key, nothing sent.
import { CARAVAN_FEE } from '../../../permutation-server/web/sdk/frontier/budgets.mjs';

/** `F` a village {p, q, site}, `V` a storehouse {p, q, tile} in the same Province, `owner` another Citizen, `tag` the wallet's Citizen tag, `rentTo` a wallet. */
export function PREVIEW_INTENTS({ F, V, owner, tag, rentTo }) {
  const fac = { ...F, gen: 0 }, vault = { ...V, gen: 0 };
  const path = [9, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], fee = CARAVAN_FEE.toString(), provinces = [{ p: F.p, q: F.q }];
  const home = { kind: 'holding', ...fac };
  return {
    OpenCapacityPool: { name: 'OpenCapacityPool', subject: { facility: fac, open: true }, fields: { policies: [0, 0, 0], lend: 2, seq: 0 } },
    ReclaimCapacity: { name: 'ReclaimCapacity', subject: { facility: fac }, fields: { units: 1, seq: 1 } },
    GrantCapacity: { name: 'GrantCapacity', subject: { facility: fac, user: owner }, fields: { grant: 0, max_units: 2, max_output: '40000', from: '1790000000', until: '1790086400' } },
    RevokeCapacity: { name: 'RevokeCapacity', subject: { facility: fac }, fields: { grant: 0 } },
    ReserveCapacity: { name: 'ReserveCapacity', subject: { facility: fac, vault }, fields: { grant: 0, job: 0, units: 2, start: '1790000120', end: '1790004620', max_output: '10000', ore: 20000, wood: 10000, deposit: 0 } },
    SettleJob: { name: 'SettleJob', subject: { facility: fac }, fields: { grant: 0, job: 0 } },
    CancelJob: { name: 'CancelJob', subject: { facility: fac }, fields: { grant: 0, job: 0 } },
    ClaimJob: { name: 'ClaimJob', subject: { facility: fac, vault }, fields: { grant: 0, job: 0 } },
    RecordFacilityLoss: { name: 'RecordFacilityLoss', subject: { facility: fac, jobs: [{ grant: 0, job: 0 }] }, fields: {} },
    OpenLot: { name: 'OpenLot', subject: { vault, owner }, fields: { quota: 50 } },
    DepositLot: { name: 'DepositLot', subject: { seq: 1, src: home, vault, provinces }, fields: { seq: 1, qty: 10, steps: 2, path, fee } },
    WithdrawLot: { name: 'WithdrawLot', subject: { seq: 2, vault, dst: home, provinces }, fields: { seq: 2, qty: 10, steps: 2, path, fee } },
    SettleCustody: { name: 'SettleCustody', subject: { seq: 1, vault, owner_tag: tag, provinces }, fields: {} },
    ReconcileLot: { name: 'ReconcileLot', subject: { vault, owner_tag: tag, caravans: [{ tag, seq: 1 }] }, fields: {} },
    CloseLot: { name: 'CloseLot', subject: { vault, owner_tag: tag, rent_to: rentTo }, fields: {} },
  };
}
