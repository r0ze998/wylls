// The mint's pending record (written before the send, read after a lost answer or a reload), checked before it is
// trusted. No DOM, no network: tested alone (test/mint-record.test.mjs).
//
// A record is {v: 1, genesis, wallet, signature, asset, lastValidBlockHeight, sentAt, seen?}. The page keys it by the
// paying wallet. States:
// - `none`: no record;
// - `ok`: a record of this network (or a `legacy` one, written before the record carried its network: still resolved,
//   since setting it aside could allow a second paid mint while the first is undecided);
// - `otherNetwork`: written against another chain (a local test world restarted on the same address and port). Its
//   signature and asset can never be answered here, so it is set aside instead of blocking the page forever. Setting
//   it aside cannot charge twice on this chain: the other chain's transaction can never land here;
// - `unreadable`: damaged or not this page's record: set aside and said on screen.
export const MINT_PENDING = w => `wylls-mint-pending:${w}`;

export function parseMintRecord(raw, genesis) {
  if (raw === null || raw === undefined) return { state: 'none' };
  let p;
  try { p = JSON.parse(raw); } catch { return { state: 'unreadable' }; }
  if (!p || typeof p !== 'object') return { state: 'unreadable' };
  const str = k => typeof p[k] === 'string' && p[k].length > 0;
  const core = str('signature') && str('asset') && Number.isSafeInteger(p.lastValidBlockHeight);
  if (!core) return { state: 'unreadable' };
  if (p.v === undefined && p.genesis === undefined) return { state: 'ok', p, legacy: true };
  if (p.v !== 1 || !str('genesis') || !str('wallet')) return { state: 'unreadable' };
  if (p.genesis !== genesis) return { state: 'otherNetwork', p };
  return { state: 'ok', p };
}
