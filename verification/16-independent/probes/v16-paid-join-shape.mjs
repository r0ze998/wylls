// ⑯ pure probe (2026-11-09): which transaction shapes the relay's x402 classifier (web/sdk/frontier/prize.mjs
// classifyPaidJoin, used by permutation-gateway/src/frontier/routes/prize.mjs POST /f/x402/join) accepts as a paid
// Join. Built from the SDK's own message builders with FIXED-BYTE public addresses and public PDA / with-seed
// derivations only; no keypair, no signature (wireTransaction with no signatures), no network. Usage:
//   node v16-paid-join-shape.mjs <worktree>
const sdk = `${process.argv[2]}/permutation-server/web/sdk`;
const pz = await import(`${sdk}/frontier/prize.mjs`);
const { compileMessage, wireTransaction, parseTransaction } = await import(`${sdk}/solana-tx.mjs`);
const { encode: b58 } = await import(`${sdk}/base58.mjs`);
const { FrontierAddresses, joinShardOf } = await import(`${sdk}/frontier/addresses.mjs`);
const { setComputeUnitLimit, setComputeUnitPrice, setLoadedAccountsDataSizeLimit } = await import(`${sdk}/frontier/budgets.mjs`);
const { frontierIx } = await import(`${sdk}/frontier/shapes.mjs`);
const addr = n => b58(new Uint8Array(32).fill(n));
const PROGRAM = addr(11), PRIZE_PROGRAM = addr(12), MINT = addr(13), WALLET = addr(14), FEE_PAYER = addr(15), GATE = addr(16), BLOCKHASH = addr(17);
const SEASON = 7n;
const A = new FrontierAddresses({ programId: PROGRAM, seasonId: SEASON });
const prize = pz.prizeAddresses({ prizeProgram: PRIZE_PROGRAM, gameProgram: PROGRAM, seasonId: SEASON, mint: MINT });
const joinAccounts = { wallet: WALLET, season: A.season, frontier: A.frontier, citizen: A.citizen(WALLET), joinshard: A.joinShard(2, joinShardOf(WALLET)), join_gate: GATE };
const joinFields = { faction: 2, session: new Uint8Array(32).fill(9), session_expiry: 1_900_000_000n }; // a fixed 32-byte field, not a key
const b = pz.paidJoinBudget(1);
const budget = () => [setComputeUnitLimit(b.cuLimit), setComputeUnitPrice(0n), setLoadedAccountsDataSizeLimit(b.loadedLimit)];
const pay = () => pz.payIx({ prize, wallet: WALLET, payer: FEE_PAYER });
const join = () => frontierIx(PROGRAM, 'Join', { ...joinAccounts, payer: FEE_PAYER }, joinFields, 1);
const msg = ixs => compileMessage({ feePayer: FEE_PAYER, recentBlockhash: BLOCKHASH, instructions: ixs });
const judge = m => { const r = pz.classifyPaidJoin(parseTransaction(wireTransaction(m)), { programId: PROGRAM, prize, profile: 1 }); return r.ok ? 'ACCEPTED as atomic' : `refused: ${r.problem}`; };
console.log(JSON.stringify({
  'SDK paidJoinMessage [limit, price 0, loaded, Pay, Join]': judge(pz.paidJoinMessage({ programId: PROGRAM, prize, wallet: WALLET, joinAccounts, joinFields, feePayer: FEE_PAYER, recentBlockhash: BLOCKHASH })),
  'Pay without Join': judge(msg([...budget(), pay()])),
  'Join without Pay': judge(msg([...budget(), join()])),
  'Join before Pay': judge(msg([...budget(), join(), pay()])),
  'Pay, Join and a second Pay': judge(msg([...budget(), pay(), join(), pay()])),
}, null, 1));
