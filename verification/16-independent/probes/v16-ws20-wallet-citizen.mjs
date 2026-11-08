// ⑯ pure probe (2026-11-09): does ⑳'s fcodec change leave a WALLET v2 Citizen's decode unchanged? Encodes one with
// the SDK (profile 2; fixed public bytes as the wallet, no key), decodes it with <worktree>'s fcodec, prints a stable
// JSON. Also a wallet Citizen whose byte 380 has the resident flag set (the program never writes that).
// Usage: node v16-ws20-wallet-citizen.mjs <worktree>
const root = process.argv[2];
const { decode } = await import(`${root}/permutation-server/web/frontier/fcodec.mjs`);
const { encodeAccount } = await import(`${root}/permutation-server/web/sdk/frontier/codec.mjs`);
const wallet = new Uint8Array(32).fill(7);
const bytes = encodeAccount('Citizen', { SEASON_ID: 71n, WALLET: wallet, FACTION: 2 }, { profile: 2 });
const show = b => { try { return JSON.stringify(decode('Citizen', b, { profile: 2 }), (k, v) => typeof v === 'bigint' ? `${v}n` : v instanceof Uint8Array ? Array.from(v).join(',') : v); } catch (e) { return `throws ${e.code ?? ''} ${e.message}`; } };
const flagged = Uint8Array.from(bytes); flagged[380] |= 1;
const crypto = await import('node:crypto');
const plain = show(bytes);
console.log(JSON.stringify({ size: bytes.length, walletDecodeSha256: crypto.createHash('sha256').update(plain).digest('hex'), hasResidentAsset: plain.includes('residentAsset'), walletWithFlagByte: (s => s.startsWith("throws") ? s : (s.match(/"residentAsset":[^,}]*/)?.[0] ?? "no residentAsset"))(show(flagged)) }));
