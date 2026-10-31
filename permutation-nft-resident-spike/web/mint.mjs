// The mint page: wallet connect → one MintResident transaction (payment,
// Core asset, resident binding) signed by the user's own wallet → confirm on
// chain → verify the asset, the collection and the holder → "registered".
//
// Rules the page keeps (docs/MINT-FLOW.ja.md §3):
// * It never says "registered" from its own memory: `GET /mint/status`
//   (server-side chain read) and the asset account decide, every time, also
//   after a reload or a reconnect.
// * The pending record {signature, asset, lastValidBlockHeight} is written
//   to localStorage BEFORE the transaction is sent. A lost answer, a closed
//   tab or a reload resumes by asking the chain about that signature; the
//   page never sends a second transaction while the first is undecided.
// * A wallet on another network, a genesis hash that is not the configured
//   one, a changed price, insufficient SOL: refused before anything is signed
//   or sent.
import { compileMessage, wireTransaction, parseTransaction, messageOf } from '/sdk/solana-tx.mjs';
import { encode as toBase58 } from '/sdk/base58.mjs';
import { u64le, toBase64, equal, concat } from '/sdk/bytes.mjs';
import * as ws from '/web/wallet-standard.mjs';

const $ = sel => document.querySelector(`[data-testid="${sel}"]`);
const fmtSol = l => `${(Number(l) / 1e9).toFixed(6)} SOL (${l} lamports)`;
const PENDING = w => `wylls-mint-pending:${w}`;
const state = { config: null, wallet: null, busy: false, networkOk: false };

async function rpc(method, params = []) {
  const r = await fetch(state.config.rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  if (!r.ok) throw Object.assign(new Error(`rpc ${method}: http ${r.status}`), { code: 'RpcHttp' });
  const j = await r.json();
  if (j.error) throw Object.assign(new Error(j.error.message), { code: 'RpcError', data: j.error.data });
  return j.result;
}
const api = async (path) => (await fetch(path, { cache: 'no-store' })).json();
const say = (text, kind = '') => { const s = $('status'); s.textContent = text; s.className = `status ${kind}`; };

// ------------------------------------------------------------------ boot
async function boot() {
  state.config = await api('/mint/config');
  const c = state.config;
  $('network').textContent = `${c.network} (${c.chainId})`;
  $('price').textContent = `${fmtSol(c.price.lamports)} — ${c.price.label}`;
  $('fee').textContent = `約 ${fmtSol(c.estimate.feeLamports)}（署名 2 件）`;
  $('rent').textContent = `約 ${fmtSol(BigInt(c.estimate.rentAssetLamports) + BigInt(c.estimate.rentResidentLamports))}`;
  $('total').textContent = `約 ${fmtSol(total())}`;
  $('collection').textContent = c.collection;
  if (/Mobi|Android|iPhone/.test(navigator.userAgent)) $('mobile-hint').hidden = false;
  // Network: the RPC must be the configured cluster (genesis hash), or nothing proceeds.
  try {
    const g = await rpc('getGenesisHash');
    state.networkOk = g === c.genesisHash;
    if (!state.networkOk) say(`接続先ネットワークが違います（RPC の genesis ${g.slice(0, 8)}… ≠ 期待 ${c.genesisHash.slice(0, 8)}…）。この画面は ${c.network} 専用です。`, 'err');
  } catch (e) { say(`RPC に到達できません：${e.message}`, 'err'); }
  ws.start();
  if (c.testWallet) { const { makeTestWallet } = await import('/web/testwallet.mjs'); const tw = await makeTestWallet({ chain: c.chainId }); ws.registerLocal(tw.wallet); globalThis.__testWallet = { address: tw.address }; }
  ws.onChange(renderWallets);
  renderWallets();
  if (state.networkOk) say('ウォレットを接続してください。');
  $('mint').addEventListener('click', () => mint().catch(e => fail(e)));
  $('recheck').addEventListener('click', () => refresh().catch(e => fail(e)));
}
const total = () => BigInt(state.config.price.lamports) + BigInt(state.config.estimate.feeLamports) + BigInt(state.config.estimate.rentAssetLamports) + BigInt(state.config.estimate.rentResidentLamports);

function renderWallets() {
  const box = $('wallets');
  box.replaceChildren();
  for (const w of ws.list(state.config.chainId)) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'ghost'; b.textContent = `${w.name}${w.why ? `（${w.why}）` : ''}`; b.dataset.wallet = w.name;
    b.disabled = !!w.why || !state.networkOk;
    b.addEventListener('click', () => connect(w.wallet).catch(e => fail(e)));
    box.appendChild(b);
  }
  if (!box.children.length) { const p = document.createElement('span'); p.className = 'small'; p.textContent = 'ウォレットが見つかりません（Phantom / Solflare / Backpack をインストールするか、スマホはウォレットアプリ内ブラウザで開いてください）'; box.appendChild(p); }
}

async function connect(wallet) {
  const w = await ws.connect(wallet, state.config.chainId);
  state.wallet = w;
  $('address').textContent = w.address;
  await refresh();
}

/** Re-read everything that decides what the page shows: balance, pending transaction, holdings. */
async function refresh() {
  if (!state.wallet) return;
  const bal = BigInt((await rpc('getBalance', [state.wallet.address])).value);
  $('balance').textContent = fmtSol(bal);
  const pending = readPending();
  if (pending) { await resolvePending(pending); return; }
  const mine = await api(`/mint/mine?wallet=${state.wallet.address}`);
  renderMine(mine.residents);
  if (mine.residents.length) {
    const st = await api(`/mint/status?wallet=${state.wallet.address}&asset=${mine.residents[0].asset}`);
    showResult(st, null);
    say(st.registered ? 'waitlist 登録済みです（チェーンの読取で確認）。公開後はこの NFT で住民へログインします。' : `保有を確認できません：${st.code ?? 'not holder'}`, st.registered ? 'ok' : 'err');
    $('mint').disabled = true;
    return;
  }
  $('result').hidden = true;
  $('mint').disabled = !state.networkOk || state.busy;
  say(bal < total() ? `テスト SOL が不足しています（必要 約 ${fmtSol(total())}、残高 ${fmtSol(bal)}）。devnet の faucet で補充してください。` : 'mint できます。ボタンを押すとウォレットで取引を確認・署名します。', bal < total() ? 'err' : '');
  $('mint').disabled = $('mint').disabled || bal < total();
}

function renderMine(list) {
  const ul = $('mine'); ul.replaceChildren();
  for (const r of list) { const li = document.createElement('li'); li.textContent = `${r.residentId} — ${r.asset}`; ul.appendChild(li); }
  if (!list.length) { const li = document.createElement('li'); li.textContent = '（このウォレットが保有する住民 NFT はありません）'; ul.appendChild(li); }
}
function showResult(st, signature) {
  $('result').hidden = false;
  $('resident-id').textContent = st.residentId ?? '—';
  $('asset').textContent = st.asset ?? '—';
  $('signature').textContent = signature ?? $('signature').textContent;
  $('holder').textContent = st.holder ? `${st.holder}${st.isHolder ? '（あなた）' : '（別のウォレット）'}` : '—';
}
const fail = e => { console.error(e); say(`${e.code ?? 'Error'}: ${e.message}`, 'err'); state.busy = false; $('mint').disabled = !state.networkOk || !state.wallet; };

// ------------------------------------------------------------------ pending (resume after a lost answer, a closed tab, a reload)
const readPending = () => { try { return JSON.parse(localStorage.getItem(PENDING(state.wallet.address)) ?? 'null'); } catch { return null; } };
const writePending = p => localStorage.setItem(PENDING(state.wallet.address), JSON.stringify(p));
const clearPending = () => localStorage.removeItem(PENDING(state.wallet.address));

async function resolvePending(p) {
  $('mint').disabled = true;
  say(`進行中の取引を照会しています… ${p.signature.slice(0, 12)}…`);
  const [st] = (await rpc('getSignatureStatuses', [[p.signature]])).value;
  if (st) {
    if (st.err) { clearPending(); say(`前回の取引は失敗しました（${JSON.stringify(st.err)}）。支払いは戻っています。もう一度 mint できます。`, 'err'); $('mint').disabled = !state.networkOk; return; }
    const status = await api(`/mint/status?wallet=${state.wallet.address}&asset=${p.asset}`);
    showResult(status, p.signature);
    if (status.registered) { clearPending(); say('取引が確定し、正規 collection の NFT の保有を確認しました：waitlist 登録完了。', 'ok'); renderMine([{ residentId: status.residentId, asset: status.asset }]); return; }
    say(`取引は確定しましたが保有を確認できません（${status.code ?? (status.isHolder ? 'unbound' : 'not holder')}）。再確認を押してください。`, 'err');
    return;
  }
  const height = await rpc('getBlockHeight');
  if (height > p.lastValidBlockHeight) {
    // Expired without landing: the chain can never include it now. Not a double charge to try again.
    clearPending(); say('前回の取引は期限切れで、着地していません（課金なし）。もう一度 mint できます。', 'err'); $('mint').disabled = !state.networkOk; return;
  }
  say(`結果がまだ分かりません（有効期限 block ${p.lastValidBlockHeight}、現在 ${height}）。再課金・再発行はしません。しばらくして「保有状態を再確認」を押してください。`);
}

// ------------------------------------------------------------------ mint
async function mint() {
  if (state.busy || !state.wallet || !state.networkOk) return;          // a double click is one transaction
  if (readPending()) return resolvePending(readPending());
  state.busy = true; $('mint').disabled = true;
  try {
    // The price the page shows is the price the instruction carries; the program refuses a mismatch.
    const c = state.config = await api('/mint/config');
    const price = BigInt(c.price.lamports);
    const bal = BigInt((await rpc('getBalance', [state.wallet.address])).value);
    if (bal < total()) throw Object.assign(new Error(`テスト SOL が不足しています（必要 約 ${fmtSol(total())}）`), { code: 'InsufficientSol' });
    say('取引を作成しています…');
    const { blockhash, lastValidBlockHeight } = (await rpc('getLatestBlockhash')).value;
    // A fresh asset keypair (Core asset accounts sign their own creation); it signs here and is then discarded.
    const assetKey = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
    const assetPub = new Uint8Array(await crypto.subtle.exportKey('raw', assetKey.publicKey));
    const asset = toBase58(assetPub);
    const residentPda = await residentAccountOf(asset);
    const ix = {
      programId: c.programs.resident,
      keys: [
        { pubkey: state.wallet.address, isSigner: true, isWritable: true }, { pubkey: c.treasury, isSigner: false, isWritable: true },
        { pubkey: asset, isSigner: true, isWritable: true }, { pubkey: c.collection, isSigner: false, isWritable: true },
        { pubkey: c.collectionAuthorityPda, isSigner: false, isWritable: false }, { pubkey: residentPda, isSigner: false, isWritable: true },
        { pubkey: c.configPda, isSigner: false, isWritable: false }, { pubkey: c.programs.core, isSigner: false, isWritable: false }, { pubkey: c.programs.system, isSigner: false, isWritable: false },
      ],
      data: concat([c.instruction.tag], u64le(price)),
    };
    const message = compileMessage({ feePayer: state.wallet.address, recentBlockhash: blockhash, instructions: [ix] });
    const assetSig = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, assetKey.privateKey, message));
    const partial = wireTransaction(message, { [asset]: assetSig });
    say('ウォレットで取引を確認し、署名してください…');
    const signed = await ws.signTransaction(partial);
    if (!equal(messageOf(signed), message)) throw Object.assign(new Error('ウォレットが返した取引の中身が違います'), { code: 'WalletAlteredMessage' });
    const parsed = parseTransaction(signed);
    const signature = toBase58(parsed.signatures[0]);
    // Record first, send second: a lost answer is resolved by this record, never by a second send.
    writePending({ signature, asset, lastValidBlockHeight, sentAt: Date.now() });
    say('送信しています…');
    try {
      await rpc('sendTransaction', [toBase64(signed), { encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed' }]);
    } catch (e) {
      if (e.code === 'RpcError') {
        // Refused before inclusion (preflight): nothing landed, nothing charged.
        clearPending();
        const m = /already been processed/.test(e.message) ? '同じ取引が処理済みです' : /Blockhash not found/.test(e.message) ? '取引の期限が切れました。もう一度お試しください' : /insufficient|no record of a prior credit/i.test(e.message) ? 'テスト SOL が不足しています' : /PriceChanged/.test(JSON.stringify(e.data ?? '')) ? '価格が変わりました。画面を再読込してください' : e.message;
        throw Object.assign(new Error(m), { code: 'Refused' });
      }
      // No answer (network): the record stays; resolve by signature.
      say('応答が消えました。署名でチェーンを照会します（再送はしません）…');
      await resolvePending(readPending());
      return;
    }
    say('確定を待っています…');
    for (let i = 0; i < 60; i++) {
      const [st] = (await rpc('getSignatureStatuses', [[signature]])).value;
      if (st) break;
      await new Promise(r => setTimeout(r, 300));
    }
    await resolvePending(readPending());
  } finally {
    state.busy = false;
  }
}

/** The resident account address for an asset, as the mock program derives it (the real program: a PDA; see MINT-FLOW §4). */
async function residentAccountOf(asset) {
  const r = await api(`/mint/derive?asset=${asset}`);
  return r.resident;
}

boot().catch(e => fail(e));
