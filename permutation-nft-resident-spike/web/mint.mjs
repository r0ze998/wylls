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
import { compileMessage, wireTransaction, parseTransaction, messageOf, findProgramAddress, isOnCurve } from '/sdk/solana-tx.mjs';
import { encode as toBase58 } from '/sdk/base58.mjs';
import { u64le, toBase64, equal, concat, utf8 } from '/sdk/bytes.mjs';
import { decode as fromBase58 } from '/sdk/base58.mjs';
import * as ws from '/web/wallet-standard.mjs';
import { saleState, SALE_TEXT } from '/web/sale.mjs';
import { T, tr, lang, setLang, pickLang, translateStatic } from '/web/mint-lang.mjs';
import { parseMintRecord } from '/web/mint-record.mjs';
import { checkDestination, checkSender, transferInstruction, assetOwnerOf, decidePending, parsePendingRecord, shortAddress, PENDING_TRANSFER } from '/web/transfer.mjs';

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
  // The language: ?lang=en|ja, else the last choice, else the browser's (mint-lang.mjs); a toggle switches it.
  const picked = pickLang();
  setLang(picked.lang, { save: picked.save });
  translateStatic();
  const toggle = $('lang');
  if (toggle) {
    toggle.textContent = lang() === 'en' ? '日本語' : 'English';
    // (the URL's ?lang wins over the saved choice, so the switch rewrites it rather than only saving)
    toggle.addEventListener('click', () => {
      const next = lang() === 'en' ? 'ja' : 'en';
      setLang(next);
      const u = new URL(location.href);
      u.searchParams.set('lang', next);
      location.href = u.toString();
    });
  }
  state.config = await api('/mint/config');
  const c = state.config;
  $('network').textContent = `${c.network} (${c.chainId})${c.mode === 'mock' ? T`［模擬チェーン］` : ''}`;
  // The banner names the network it is really on (devnet; a loopback validator in local verification).
  if (c.mode !== 'mock' && !/devnet/i.test(c.network)) $('notice').textContent = T`ローカル検証ネット（実 program、ループバック validator）のテストです。本番の参加権や金銭的価値を保証しません。テスト用 SOL だけを使ってください。`;
  $('price').textContent = `${fmtSol(c.price.lamports)}${c.price.label ? ` — ${tr(c.price.label)}` : ''}`;
  // A deployment's own notice (the operator's text); the devnet banner otherwise.
  // The companion server also sends `notice` as an object of flags ({ test, noValue, … }): only text replaces the banner.
  if (typeof c.notice === 'string' && c.notice.trim()) $('notice').textContent = c.notice;
  renderTerms();
  $('fee').textContent = T`約 ${fmtSol(c.estimate.feeLamports)}（署名 2 件）`;
  $('rent').textContent = T`約 ${fmtSol(BigInt(c.estimate.rentAssetLamports) + BigInt(c.estimate.rentResidentLamports))}`;
  $('total').textContent = T`約 ${fmtSol(total())}`;
  $('collection').textContent = c.collection;
  if (/Mobi|Android|iPhone/.test(navigator.userAgent)) $('mobile-hint').hidden = false;
  // Network: the RPC must be the configured cluster (genesis hash), or nothing proceeds.
  try {
    const g = await rpc('getGenesisHash');
    state.networkOk = g === c.genesisHash;
    if (!state.networkOk) say(T`接続先ネットワークが違います（RPC の genesis ${g.slice(0, 8)}… ≠ 期待 ${c.genesisHash.slice(0, 8)}…）。この画面は ${c.network} 専用です。`, 'err');
  } catch (e) { say(T`RPC に到達できません：${e.message}`, 'err'); }
  ws.start();
  if (c.testWallet) { const { makeTestWallet } = await import('/web/testwallet.mjs'); const tw = await makeTestWallet({ chain: c.chainId }); ws.registerLocal(tw.wallet); globalThis.__testWallet = { address: tw.address }; }
  ws.onChange(renderWallets);
  renderWallets();
  if (state.networkOk) say(T`ウォレットを接続してください。`);
  $('mint').addEventListener('click', () => mint().catch(e => fail(e)));
  $('recheck').addEventListener('click', () => refresh().catch(e => fail(e)));
  $('t-review').addEventListener('click', () => reviewTransfer().catch(e => tfail(e)));
  $('t-ack').addEventListener('change', () => { $('t-send').disabled = !$('t-ack').checked || tstate.busy || !tstate.review; });
  $('t-cancel').addEventListener('click', () => { if (tstate.busy) return; closeReview(); tsay(T`譲渡をやめました。何も送っていません。住民はこのウォレットのままです。`); });
  $('t-send').addEventListener('click', () => sendTransfer().catch(e => tfail(e)));
  // Changing the destination or the NFT after the review voids the review (the confirmation must show what is sent).
  for (const id of ['t-to', 't-asset']) $(id).addEventListener('input', () => { if (tstate.review && !tstate.busy) closeReview(); });
}
/** The sale terms as the program's config holds them (supply, window, per-wallet limit): the page only shows them. */
function renderTerms(walletMinted = 0) {
  const t = state.config.terms;
  const s = saleState(t, Math.floor(Date.now() / 1000), walletMinted);
  state.sale = s;
  if ($('supply')) $('supply').textContent = !t || BigInt(t.maxSupply) === 0n ? T`未設定` : T`${t.minted} / ${t.maxSupply}（残り ${s.remaining}）`;
  if ($('sale')) {
    const when = v => (BigInt(v) === 0n ? null : new Date(Number(v) * 1000).toLocaleString());
    const win = t ? [when(t.saleStart) && T`開始 ${when(t.saleStart)}`, when(t.saleEnd) && T`終了 ${when(t.saleEnd)}`, Number(t.perWallet) > 0 && T`1 ウォレット ${t.perWallet} 枚まで`].filter(Boolean).join(T`、`) : '';
    $('sale').textContent = s.open ? T`販売中${win ? T`（${win}）` : ''}` : `${tr(SALE_TEXT[s.code]) ?? s.code}${win ? T`（${win}）` : ''}`;
  }
  return s;
}
const total = () => BigInt(state.config.price.lamports) + BigInt(state.config.estimate.feeLamports) + BigInt(state.config.estimate.rentAssetLamports) + BigInt(state.config.estimate.rentResidentLamports);

function renderWallets() {
  const box = $('wallets');
  box.replaceChildren();
  for (const w of ws.list(state.config.chainId)) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'ghost'; b.textContent = `${w.name}${w.why ? T`（${w.why}）` : ''}`; b.dataset.wallet = w.name;
    b.disabled = !!w.why || !state.networkOk;
    b.addEventListener('click', () => connect(w.wallet).catch(e => fail(e)));
    box.appendChild(b);
  }
  if (!box.children.length) { const p = document.createElement('span'); p.className = 'small'; p.textContent = T`ウォレットが見つかりません（Phantom / Solflare / Backpack をインストールするか、スマホはウォレットアプリ内ブラウザで開いてください）`; box.appendChild(p); }
}

async function connect(wallet) {
  // Not while a transaction is being built, signed or sent: its record belongs to the wallet that signs it.
  if (tstate.busy || state.busy) throw Object.assign(new Error(T`取引の処理中はウォレットを切り替えられません。`), { code: 'Busy' });
  const w = await ws.connect(wallet, state.config.chainId);
  state.wallet = w;
  closeReview();
  $('address').textContent = w.address;
  await refresh();
}

/** Re-read everything that decides what the page shows: balance, pending transaction, holdings. */
async function refresh() {
  if (!state.wallet) return;
  const bal = BigInt((await rpc('getBalance', [state.wallet.address, { commitment: 'confirmed' }])).value);
  $('balance').textContent = fmtSol(bal);
  // A transfer whose answer was lost is looked up first (never sent again).
  const tp = readTransferPending();
  if (tp) await resolveTransfer(tp);
  const pending = readPending();
  if (pending) { await resolvePending(pending); return; }
  const mine = await refreshMine();
  if (mine.residents.length) {
    const st = await api(`/mint/status?wallet=${state.wallet.address}&asset=${mine.residents[0].asset}`);
    showResult(st, null);
    say(st.registered ? T`waitlist 登録済みです（チェーンの読取で確認）。公開後はこの NFT で住民へログインします。` : T`保有を確認できません：${st.code ?? 'not holder'}`, st.registered ? 'ok' : 'err');
    $('mint').disabled = true;
    return;
  }
  $('result').hidden = true;
  $('mint').disabled = !state.networkOk || state.busy || !state.sale?.open;
  say(bal < total() ? T`テスト SOL が不足しています（必要 約 ${fmtSol(total())}、残高 ${fmtSol(bal)}）。devnet の faucet で補充してください。` : T`mint できます。ボタンを押すとウォレットで取引を確認・署名します。`, bal < total() ? 'err' : '');
  $('mint').disabled = $('mint').disabled || bal < total();
}

async function refreshMine() {
  const mine = await api(`/mint/mine?wallet=${state.wallet.address}`);
  showMine(mine.residents);
  return mine;
}

/** The holdings list and the transfer section, together (both follow the chain read). */
function showMine(list) { renderMine(list); renderTransfer(list); }

function renderMine(list) {
  const ul = $('mine'); ul.replaceChildren();
  for (const r of list) { const li = document.createElement('li'); li.textContent = `${r.residentId} — ${r.asset}`; ul.appendChild(li); }
  if (!list.length) { const li = document.createElement('li'); li.textContent = T`（このウォレットが保有する住民 NFT はありません）`; ul.appendChild(li); }
}
function showResult(st, signature) {
  $('result').hidden = false;
  $('resident-id').textContent = st.residentId ?? '—';
  $('asset').textContent = st.asset ?? '—';
  $('signature').textContent = signature ?? $('signature').textContent;
  $('holder').textContent = st.holder ? `${st.holder}${st.isHolder ? T`（あなた）` : T`（別のウォレット）`}` : '—';
}
const fail = e => { console.error(e); say(`${e.code ?? 'Error'}: ${e.message}`, 'err'); state.busy = false; $('mint').disabled = !state.networkOk || !state.wallet; };

// ------------------------------------------------------------------ pending (resume after a lost answer, a closed tab, a reload)
/**
 * The paying wallet's pending mint (web/mint-record.mjs). A record of another network (a restarted local world) or an
 * unreadable one is set aside (kept under `…:set-aside`) and said on screen, rather than blocking the page forever.
 */
function loadMintPending(addr = state.wallet?.address) {
  if (!addr) return null;
  let raw = null;
  try { raw = localStorage.getItem(PENDING(addr)); } catch { /* storage blocked: writing fails too, so nothing is sent */ }
  const r = parseMintRecord(raw, state.config.genesisHash);
  if (r.state === 'ok') return r.p;
  if (r.state === 'none') return null;
  try { localStorage.setItem(`${PENDING(addr)}:set-aside`, raw); localStorage.removeItem(PENDING(addr)); } catch { /* */ }
  // Its own line: the status line is rewritten by what follows (the page's next state).
  const note = $('record-note');
  note.textContent = r.state === 'otherNetwork' ? T`別のネットワーク（genesis ${r.p.genesis.slice(0, 8)}…）で記録された mint を照会から外しました（この画面のネットワークでは答えが出ません）。` : T`読めない mint の記録を照会から外しました。`;
  note.hidden = false;
  return null;
}
const readPending = () => loadMintPending();
/** Write, then read back: a storage that refuses or drops the record stops the mint before the send. */
function writePending(p) {
  const key = PENDING(p.wallet ?? state.wallet.address), text = JSON.stringify(p);
  let back = null;
  try { localStorage.setItem(key, text); back = localStorage.getItem(key); } catch (e) { throw Object.assign(new Error(T`mint の記録をブラウザに保存できません（${e.message}）。送っていません（課金なし）。`), { code: 'RecordNotSaved' }); }
  if (back !== text) throw Object.assign(new Error(T`mint の記録をブラウザに保存できません（読み戻しが違います）。送っていません（課金なし）。`), { code: 'RecordNotSaved' });
}
/** Only this mint's own record is removed. */
const clearPending = p => { try { const k = PENDING(p.wallet ?? state.wallet.address); if (JSON.parse(localStorage.getItem(k) ?? 'null')?.signature === p.signature) localStorage.removeItem(k); } catch { /* */ } };

/**
 * The status of a signature once it is at least `confirmed` (or failed). A status that is only `processed`
 * can still be dropped with its fork, so it is not an answer yet: poll a little, then report "not yet".
 */
async function settledStatus(signature, tries = 20) {
  for (let i = 0; i < tries; i++) {
    const [st] = (await rpc('getSignatureStatuses', [[signature], { searchTransactionHistory: true }])).value;
    if (st && (st.err || st.confirmationStatus !== 'processed')) return st;
    await new Promise(r => setTimeout(r, 300));
  }
  return null;
}

async function resolvePending(p) {
  $('mint').disabled = true;
  say(T`進行中の取引を照会しています… ${p.signature.slice(0, 12)}…`);
  const st = await settledStatus(p.signature);
  if (st) {
    if (st.err) { clearPending(p); say(T`前回の取引は失敗しました（${JSON.stringify(st.err)}）。支払いは戻っています。もう一度 mint できます。`, 'err'); $('mint').disabled = !state.networkOk; return; }
    const status = await api(`/mint/status?wallet=${state.wallet.address}&asset=${p.asset}`);
    showResult(status, p.signature);
    if (status.registered) { clearPending(p); say(T`取引が確定し、正規 collection の NFT の保有を確認しました：waitlist 登録完了。`, 'ok'); showMine([{ residentId: status.residentId, asset: status.asset }]); return; }
    say(T`取引は確定しましたが保有を確認できません（${status.code ?? (status.isHolder ? 'unbound' : 'not holder')}）。再確認を押してください。`, 'err');
    return;
  }
  const height = await rpc('getBlockHeight', [{ commitment: 'confirmed' }]);
  if (height > p.lastValidBlockHeight) {
    // Expired: no NEW landing of this signature is possible now. That is not proof it never landed (the RPC may
    // lack the history, or lag). The attempt's own unique account decides: the asset keypair exists only in this
    // attempt and nothing else creates that account, so "present" = landed, "absent" = not landed.
    // "Present" may be read at confirmed. "Absent" is the ground for a retry, so it is read at FINALIZED, and only
    // once the finalized height is past the last valid block (every block that could hold the transaction is then
    // final). An account seen once stays "landed" even if it vanishes later (a burn): the record carries the mark.
    const seen = (await rpc('getAccountInfo', [p.asset, { encoding: 'base64', commitment: 'confirmed' }])).value;
    if (seen || p.seen) {
      if (seen && !p.seen) writePending({ ...p, seen: true });
      const status = await api(`/mint/status?wallet=${state.wallet.address}&asset=${p.asset}`);
      showResult(status, p.signature);
      if (status.registered) { clearPending(p); say(T`取引は確定していました（期限切れ後に口座で確認）：waitlist 登録完了。`, 'ok'); showMine([{ residentId: status.residentId, asset: status.asset }]); return; }
      say(T`${seen ? T`asset の口座はありますが` : T`asset の口座を一度観測したため発行済みとして扱いますが、今は`}保有を確認できません（${status.code ?? (status.isHolder ? 'unbound' : 'not holder')}）。再確認を押してください。再課金・再発行はしません。`, 'err');
      return;
    }
    const finalHeight = await rpc('getBlockHeight', [{ commitment: 'finalized' }]);
    if (finalHeight <= p.lastValidBlockHeight) { say(T`期限は切れましたが、確定済み（finalized）の高さ ${finalHeight} がまだ有効期限 ${p.lastValidBlockHeight} を過ぎていません。再課金・再発行はしません。しばらくして「保有状態を再確認」を押してください。`); return; }
    const finalAcc = (await rpc('getAccountInfo', [p.asset, { encoding: 'base64', commitment: 'finalized' }])).value;
    if (finalAcc) { writePending({ ...p, seen: true }); say(T`asset の口座を finalized で観測しました。再確認を押してください。再課金・再発行はしません。`); return; }
    clearPending(p); say(T`前回の取引は期限切れで、finalized でも asset の口座が無く、着地していません（課金なし）。もう一度 mint できます。`, 'err'); $('mint').disabled = !state.networkOk; return;
  }
  say(T`結果がまだ分かりません（有効期限 block ${p.lastValidBlockHeight}、現在 ${height}）。再課金・再発行はしません。しばらくして「保有状態を再確認」を押してください。`);
}

// ------------------------------------------------------------------ mint
/** One mint per wallet at a time across tabs (Web Locks when the browser has them; the record check otherwise): each click is a new asset, so two tabs would pay twice. */
async function mint() {
  if (state.busy || !state.wallet || !state.networkOk) return;          // a double click is one transaction
  const pp = readPending();
  if (pp) return resolvePending(pp);
  const payer = state.wallet.address;
  if (globalThis.navigator?.locks?.request) {
    return navigator.locks.request(`wylls-mint:${payer}`, { ifAvailable: true }, lock => (lock ? mintLocked(payer)
      : say(T`別のタブでこのウォレットの mint が進行中です。そちらの結果を待ってください（このタブからは送っていません）。`, 'err')));
  }
  return mintLocked(payer);
}
async function mintLocked(payer) {
  if (state.busy) return;
  state.busy = true; $('mint').disabled = true;
  try {
    // Another tab may have sent, or finished, while this one waited: its record, or the holding it made, decides.
    const other = loadMintPending(payer);
    if (other) { state.busy = false; return await resolvePending(other); }
    if ((await api(`/mint/mine?wallet=${payer}`)).residents.length) { state.busy = false; return await refresh(); }
    if (await rpc('getGenesisHash') !== state.config.genesisHash) throw Object.assign(new Error(T`接続先のネットワークが変わりました。画面を再読込してください。何も送っていません。`), { code: 'WrongNetwork' });
    // The price the page shows is the price the instruction carries; the program refuses a mismatch.
    const c = state.config = await api('/mint/config');
    const price = BigInt(c.price.lamports);
    // The sale terms, fresh (the authority may have changed them), with this wallet's count when a limit is set.
    const minterPda = await minterAccountOf(state.wallet.address);
    const minterAcc = Number(c.terms?.perWallet ?? 0) > 0 && minterPda !== 'mock' ? (await rpc('getAccountInfo', [minterPda, { encoding: 'base64', commitment: 'confirmed' }])).value : null;
    const minted = minterAcc ? new DataView(Uint8Array.from(atob(minterAcc.data[0]), ch => ch.charCodeAt(0)).buffer).getUint16(33, true) : 0;
    const sale = renderTerms(minted);
    if (!sale.open) throw Object.assign(new Error(SALE_TEXT[sale.code] ?? sale.code), { code: sale.code });
    const bal = BigInt((await rpc('getBalance', [state.wallet.address, { commitment: 'confirmed' }])).value);
    if (bal < total()) throw Object.assign(new Error(T`テスト SOL が不足しています（必要 約 ${fmtSol(total())}）`), { code: 'InsufficientSol' });
    say(T`取引を作成しています…`);
    const { blockhash, lastValidBlockHeight } = (await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }])).value;
    // A fresh asset keypair (Core asset accounts sign their own creation); it signs here and is then discarded.
    const assetKey = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
    const assetPub = new Uint8Array(await crypto.subtle.exportKey('raw', assetKey.publicKey));
    const asset = toBase58(assetPub);
    const residentPda = await residentAccountOf(asset);
    if (c.mode !== 'mock') {
      const d = derivedPdas();
      if (d.config !== c.configPda || d.collectionAuthority !== c.collectionAuthorityPda) throw Object.assign(new Error(T`設定の PDA がページの導出と一致しません`), { code: 'PdaMismatch' });
    }
    const ix = {
      programId: c.programs.resident,
      keys: [
        { pubkey: state.wallet.address, isSigner: true, isWritable: true }, { pubkey: c.treasury, isSigner: false, isWritable: true },
        { pubkey: asset, isSigner: true, isWritable: true }, { pubkey: c.collection, isSigner: false, isWritable: true },
        { pubkey: c.collectionAuthorityPda, isSigner: false, isWritable: false }, { pubkey: residentPda, isSigner: false, isWritable: true },
        { pubkey: c.configPda, isSigner: false, isWritable: true }, { pubkey: c.programs.core, isSigner: false, isWritable: false }, { pubkey: c.programs.system, isSigner: false, isWritable: false },
        { pubkey: minterPda === 'mock' ? c.configPda : minterPda, isSigner: false, isWritable: true },
      ],
      data: concat([c.instruction.tag], u64le(price)),
    };
    const message = compileMessage({ feePayer: state.wallet.address, recentBlockhash: blockhash, instructions: [ix] });
    const assetSig = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, assetKey.privateKey, message));
    const partial = wireTransaction(message, { [asset]: assetSig });
    if (state.wallet?.address !== payer || !ws.stillOffers(payer, c.chainId)) throw Object.assign(new Error(T`接続中のウォレットまたはネットワークが変わりました。画面を再読込してください。何も送っていません。`), { code: 'WalletChanged' });
    say(T`ウォレットで取引を確認し、署名してください…`);
    const signed = await ws.signTransaction(partial);
    if (!ws.stillOffers(payer, c.chainId)) throw Object.assign(new Error(T`接続中のウォレットまたはネットワークが変わりました。画面を再読込してください。何も送っていません。`), { code: 'WalletChanged' });
    if (!equal(messageOf(signed), message)) throw Object.assign(new Error(T`ウォレットが返した取引の中身が違います`), { code: 'WalletAlteredMessage' });
    const parsed = parseTransaction(signed);
    // The payer's signature must be the payer's own key over this message.
    const payerKey = await crypto.subtle.importKey('raw', fromBase58(payer), { name: 'Ed25519' }, false, ['verify']);
    if (!await crypto.subtle.verify({ name: 'Ed25519' }, payerKey, parsed.signatures[0], message)) throw Object.assign(new Error(T`ウォレットの署名が支払うウォレットの鍵のものではありません。送っていません。`), { code: 'WrongSigner' });
    const signature = toBase58(parsed.signatures[0]);
    // Record first, send second: a lost answer is resolved by this record, never by a second send.
    const record = { v: 1, genesis: c.genesisHash, wallet: payer, signature, asset, lastValidBlockHeight, sentAt: Date.now() };
    if (loadMintPending(payer)) throw Object.assign(new Error(T`別のタブでこのウォレットの mint が進行中です。そちらの結果を待ってください（このタブからは送っていません）。`), { code: 'AnotherMint' });
    writePending(record);
    say(T`送信しています…`);
    try {
      await rpc('sendTransaction', [toBase64(signed), { encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed' }]);
    } catch (e) {
      if (e.code === 'RpcError') {
        // Refused before inclusion (preflight): nothing landed, nothing charged.
        clearPending(record);
        const pe = programError(e);
        const m = /already been processed/.test(e.message) ? T`同じ取引が処理済みです` : /Blockhash not found/.test(e.message) ? T`取引の期限が切れました。もう一度お試しください` : /insufficient|no record of a prior credit|insufficient lamports/i.test(e.message) ? T`テスト SOL が不足しています`
          : SALE_TEXT[pe] ? T`${tr(SALE_TEXT[pe])}（課金なし）` : pe === 'PriceChanged' || /PriceChanged/.test(JSON.stringify(e.data ?? '')) ? T`価格が変わりました。画面を再読込してください（課金なし）` : pe === 'AlreadyInitialized' ? T`この asset は既に発行済みです（課金なし）` : pe ? T`プログラムが拒否しました：${pe}（課金なし）` : e.message;
        throw Object.assign(new Error(m), { code: 'Refused' });
      }
      // No answer (network): the record stays; resolve by signature.
      say(T`応答が消えました。署名でチェーンを照会します（再送はしません）…`);
      await resolvePending(record);                          // this tab's own record
      return;
    }
    say(T`確定を待っています…`);
    await settledStatus(signature, 60);
    await resolvePending(record);
  } finally {
    state.busy = false;
  }
}

// ------------------------------------------------------------------ transfer (TEST): web/transfer.mjs has the checks
const tstate = { busy: false, review: null, shown: false };
const tsay = (text, kind = '') => { const s = $('t-status'); s.textContent = text; s.className = `status ${kind}`; };
const tfail = e => { console.error(e); tsay(`${e.code ?? 'Error'}: ${e.message}`, 'err'); };
/**
 * The pending transfer of wallet `addr` (the record is keyed by the wallet that signed it, never by "whoever is
 * connected now"). A record of another network or one this page did not write is set aside (kept under
 * `…:set-aside`) and said on screen; it never blocks the screen and never allows a double transfer (web/transfer.mjs).
 */
function loadTransferPending(addr = state.wallet?.address) {
  if (!addr) return null;
  let raw = null;
  try { raw = localStorage.getItem(PENDING_TRANSFER(addr)); } catch { /* storage blocked: writing fails too, so nothing is sent */ }
  const r = parsePendingRecord(raw, state.config.genesisHash);
  if (r.state === 'ok') return r.p;
  if (r.state === 'none') return null;
  try { localStorage.setItem(`${PENDING_TRANSFER(addr)}:set-aside`, raw); localStorage.removeItem(PENDING_TRANSFER(addr)); } catch { /* */ }
  tsay(r.state === 'otherNetwork' ? T`別のネットワーク（genesis ${r.p.genesis.slice(0, 8)}…）で記録された譲渡を照会から外しました（この画面のネットワークでは答えが出ません）。` : T`読めない譲渡の記録を照会から外しました。`, 'err');
  return null;
}
const readTransferPending = () => loadTransferPending();
/** Write, then read back: a storage that refuses or silently drops the record stops the transfer before the send. */
function writeTransferPending(p) {
  const key = PENDING_TRANSFER(p.from), text = JSON.stringify(p);
  let back = null;
  try { localStorage.setItem(key, text); back = localStorage.getItem(key); } catch (e) { throw Object.assign(new Error(T`この譲渡の記録をブラウザに保存できません（${e.message}）。送っていません。`), { code: 'RecordNotSaved' }); }
  if (back !== text) throw Object.assign(new Error(T`この譲渡の記録をブラウザに保存できません（読み戻しが違います）。送っていません。`), { code: 'RecordNotSaved' });
}
/** Only this transfer's own record is removed (another tab's record, if any, stays). */
const clearTransferPending = (addr, signature) => { try { const k = PENDING_TRANSFER(addr); if (JSON.parse(localStorage.getItem(k) ?? 'null')?.signature === signature) localStorage.removeItem(k); } catch { /* */ } };
/** What a refusal says (every one is decided before anything is signed). */
const TRANSFER_REFUSAL = code => ({
  NoWallet: T`ウォレットを接続してください。`,
  Empty: T`宛先のウォレットアドレスを入力してください。`,
  NotBase58: T`宛先がウォレットアドレスの形ではありません（base58 の文字だけを使います）。`,
  WrongLength: T`宛先の長さが違います（32 バイトの公開鍵ではありません）。`,
  Self: T`自分自身には譲渡できません。`,
  SystemAccount: T`宛先がこのページの program・collection・treasury などの口座です。人のウォレットを指定してください。`,
  OffCurve: T`宛先は署名できない口座（program が導出したアドレス）です。譲渡すると住民を二度と動かせないため、受け付けません。`,
  NotYours: T`この NFT は今このウォレットのものではありません（チェーンの読取）。譲渡できるのは持ち主だけです。`,
  NotResident: T`この NFT は住民として登録されていません。`,
}[code] ?? T`譲渡できません：${code}`);

function renderTransfer(list) {
  const box = $('transfer');
  box.hidden = !list.length && !tstate.shown;
  const sel = $('t-asset');
  const keep = sel.value;
  sel.replaceChildren();
  for (const r of list) { const o = document.createElement('option'); o.value = r.asset; o.textContent = `${r.residentId} — ${shortAddress(r.asset)}`; sel.appendChild(o); }
  if (list.some(r => r.asset === keep)) sel.value = keep;
  $('t-review').disabled = !list.length || tstate.busy;
  if (!tstate.busy) closeReview();
}
function closeReview() {
  if (tstate.busy) return;
  tstate.review = null;
  $('t-confirm').hidden = true; $('t-ack').checked = false; $('t-send').disabled = true;
  $('t-to').disabled = false; $('t-asset').disabled = false;
}

/** Step 1: check the destination and the sender on the chain, then show exactly what would be sent. Nothing is signed. */
async function reviewTransfer() {
  if (tstate.busy) return;
  const tp = readTransferPending();
  if (tp) return resolveTransferThenRefresh(tp);
  closeReview();
  const from = state.wallet?.address ?? null;
  const asset = $('t-asset').value;
  const d = checkDestination({ input: $('t-to').value, from, asset, config: state.config, decode: fromBase58, isOnCurve });
  if (!d.ok) return tsay(TRANSFER_REFUSAL(d.code), 'err');
  const st = await api(`/mint/status?wallet=${from}&asset=${asset}`);
  const s = checkSender({ from, status: st });
  if (!s.ok) return tsay(TRANSFER_REFUSAL(s.code), 'err');
  let note;
  try { const n = (await api(`/mint/mine?wallet=${d.address}`)).residents.length; note = n ? T`宛先はすでに住民 NFT を ${n} 枚保有しています。` : T`宛先はまだ住民 NFT を保有していません。`; } catch { note = T`宛先の保有は読めませんでした。`; }
  tstate.review = { asset, residentId: st.residentId, from, to: d.address };
  $('t-resident').textContent = st.residentId ?? '—';
  $('t-asset-full').textContent = asset;
  $('t-from').textContent = from;
  $('t-dest').textContent = d.address;
  $('t-dest-note').textContent = note;
  $('t-to').disabled = true; $('t-asset').disabled = true;
  $('t-confirm').hidden = false;
  tsay(T`宛先と NFT を確かめ、チェックを入れてから「譲渡する」を押してください。`);
}

/**
 * Step 2: the owner's wallet signs one TransferResident; the record is written (and read back) before the send.
 * One transfer per wallet at a time across tabs (Web Locks when the browser has them; the record check otherwise).
 */
async function sendTransfer() {
  const rv = tstate.review;
  if (tstate.busy || !rv || !$('t-ack').checked) return;   // a double click is one transaction
  if (state.wallet?.address !== rv.from || ws.connected()?.address !== rv.from || !ws.stillOffers(rv.from, state.config.chainId)) {
    closeReview();
    return tsay(T`接続中のウォレットまたはネットワークが、確認したときと違います。確認からやり直してください。何も送っていません。`, 'err');
  }
  const tp = loadTransferPending(rv.from);
  if (tp) return resolveTransferThenRefresh(tp);
  if (globalThis.navigator?.locks?.request) {
    return navigator.locks.request(`wylls-transfer:${rv.from}`, { ifAvailable: true }, lock => (lock ? sendTransferLocked(rv)
      : tsay(T`別のタブでこのウォレットの譲渡が進行中です。そちらの結果を待ってください（このタブからは送っていません）。`, 'err')));
  }
  return sendTransferLocked(rv);
}
async function sendTransferLocked(rv) {
  if (tstate.busy) return;
  tstate.busy = true; $('t-send').disabled = true; $('t-cancel').disabled = true; $('t-review').disabled = true;
  try {
    const other = loadTransferPending(rv.from);              // another tab may have sent while this one waited
    if (other) { tstate.busy = false; return await resolveTransferThenRefresh(other); }
    // The page's RPC must still be the configured chain (a local world restarted under the same address is another chain).
    if (await rpc('getGenesisHash') !== state.config.genesisHash) throw Object.assign(new Error(T`接続先のネットワークが変わりました。画面を再読込してください。何も送っていません。`), { code: 'WrongNetwork' });
    // Read again just before signing: the NFT may have moved since the review. Its generation goes in the record.
    const st = await api(`/mint/status?wallet=${rv.from}&asset=${rv.asset}`);
    const s = checkSender({ from: rv.from, status: st });
    if (!s.ok) throw Object.assign(new Error(TRANSFER_REFUSAL(s.code)), { code: s.code });
    if (!Number.isSafeInteger(st.gen)) throw Object.assign(new Error(T`住民の世代を読めません。何も送っていません。`), { code: 'NoGeneration' });
    const d = checkDestination({ input: rv.to, from: rv.from, asset: rv.asset, config: state.config, decode: fromBase58, isOnCurve });
    if (!d.ok) throw Object.assign(new Error(TRANSFER_REFUSAL(d.code)), { code: d.code });
    const resident = await residentAccountOf(rv.asset);
    const { blockhash, lastValidBlockHeight } = (await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }])).value;
    const message = compileMessage({ feePayer: rv.from, recentBlockhash: blockhash, instructions: [transferInstruction({ config: state.config, owner: rv.from, asset: rv.asset, resident, to: rv.to })] });
    tsay(T`ウォレットで譲渡の取引を確認し、署名してください…`);
    let signed;
    try { signed = await ws.signTransaction(wireTransaction(message, {})); } catch (e) {
      console.error(e);
      tsay(T`ウォレットが署名しませんでした（${e.code ?? 'WalletError'}）。何も送っていません。住民はこのウォレットのままです。`, 'err');
      return;
    }
    if (!ws.stillOffers(rv.from, state.config.chainId)) throw Object.assign(new Error(T`接続中のウォレットまたはネットワークが、確認したときと違います。確認からやり直してください。何も送っていません。`), { code: 'WalletChanged' });
    if (!equal(messageOf(signed), message)) throw Object.assign(new Error(T`ウォレットが返した取引の中身が違います。送っていません。`), { code: 'WalletAlteredMessage' });
    // The signature must be the sender's own over this message (an account switched inside the wallet signs with another key).
    const sig = parseTransaction(signed).signatures[0];
    const key = await crypto.subtle.importKey('raw', fromBase58(rv.from), { name: 'Ed25519' }, false, ['verify']);
    if (!await crypto.subtle.verify({ name: 'Ed25519' }, key, sig, message)) throw Object.assign(new Error(T`ウォレットの署名が送り主の鍵のものではありません。送っていません。`), { code: 'WrongSigner' });
    const signature = toBase58(sig);
    const record = { v: 1, genesis: state.config.genesisHash, gen: st.gen, signature, asset: rv.asset, residentId: rv.residentId, from: rv.from, to: rv.to, lastValidBlockHeight, sentAt: Date.now() };
    if (loadTransferPending(rv.from)) throw Object.assign(new Error(T`別のタブでこのウォレットの譲渡が進行中です。そちらの結果を待ってください（このタブからは送っていません）。`), { code: 'AnotherTransfer' });
    writeTransferPending(record);
    tsay(T`送信しています…`);
    try {
      await rpc('sendTransaction', [toBase64(signed), { encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed' }]);
    } catch (e) {
      if (e.code === 'RpcError') {
        clearTransferPending(rv.from, signature);
        const pe = programError(e);
        throw Object.assign(new Error(pe === 'NotOwner' ? T`この NFT は今このウォレットのものではありません（プログラムが拒否、何も変わっていません）。` : pe ? T`プログラムが拒否しました：${pe}（何も変わっていません）` : T`拒否されました：${e.message}（何も変わっていません）`), { code: 'Refused' });
      }
      tsay(T`応答が消えました。署名とチェーンで結果を照会します（再送はしません）…`);
      await resolveTransferThenRefresh(record);              // this tab's own record, never whatever is stored now
      return;
    }
    tsay(T`確定を待っています…`);
    await settledStatus(signature, 60);
    await resolveTransferThenRefresh(record);
  } finally {
    tstate.busy = false; $('t-cancel').disabled = false;
    $('t-send').disabled = !$('t-ack').checked || !tstate.review;
    $('t-review').disabled = !!loadTransferPending(rv.from) || !$('t-asset').options.length;
  }
}

/** A pending transfer: the signature first, then the asset's owner on the chain. Only a decided "not landed" allows a new try. */
async function resolveTransfer(p) {
  if (!p) return;
  $('t-review').disabled = true;
  tsay(T`進行中の譲渡を照会しています… ${p.signature.slice(0, 12)}…`);
  const ownerAt = async commitment => assetOwnerOf((await rpc('getAccountInfo', [p.asset, { encoding: 'base64', commitment }])).value, toBase58);
  const settled = await settledStatus(p.signature);
  const owner = await ownerAt('confirmed');
  // The generation now (every transfer raises it): A→B→A ends at A again, but two generations later.
  let gen = null;
  try { const g = (await api(`/mint/status?wallet=${p.from}&asset=${p.asset}`)).gen; gen = Number.isSafeInteger(g) ? g : null; } catch { /* unread: never "not landed" */ }
  let expired = false, finalOwner;
  if (!settled && owner !== p.to) {
    expired = (await rpc('getBlockHeight', [{ commitment: 'confirmed' }])) > p.lastValidBlockHeight;
    if (expired && (await rpc('getBlockHeight', [{ commitment: 'finalized' }])) > p.lastValidBlockHeight) finalOwner = await ownerAt('finalized');
  }
  const out = decidePending({ p, settled, owner, gen, expired, finalOwner });
  if (out === 'unknown') { tsay(T`譲渡の結果がまだ分かりません（有効期限 block ${p.lastValidBlockHeight}）。再送はしません。しばらくして「保有状態を再確認」を押してください。`); return; }
  clearTransferPending(p.from, p.signature);
  $('t-review').disabled = !$('t-asset').options.length;
  if (out === 'landed') {
    tstate.shown = true;
    closeReview(); $('t-to').value = '';
    tsay(T`譲渡しました（チェーンで確認）：住民 ${p.residentId ?? shortAddress(p.asset)} の持ち主は ${p.to} です。このウォレットではもうこの住民を遊べません。`, 'ok');
  } else if (out === 'failed') tsay(T`譲渡の取引は失敗しました（${JSON.stringify(settled.err)}）。何も変わっていません。住民はこのウォレットのままです。`, 'err');
  else if (out === 'returned') tsay(T`譲渡は着地し、その後この住民はこのウォレットに戻っています（世代 ${p.gen} → ${gen}）。譲渡前の署名と session は無効です。再送はしません。`, 'err');
  else if (out === 'notLanded') tsay(T`譲渡の取引は期限切れで、着地していません。住民はこのウォレットのままです。確認からやり直せます。`, 'err');
  else tsay(T`取引は決着しましたが、今の持ち主は ${owner ?? finalOwner ?? '—'} です（宛先ではありません）。再送はしません。`, 'err');
  return out;
}
/** The same, then the whole page read again (holdings, the mint's state) once the transfer is decided. */
async function resolveTransferThenRefresh(p) { await resolveTransfer(p); if (!loadTransferPending(p.from)) await refresh(); }

/**
 * The resident account for an asset. Real program: the PDA `["resident", asset]` of the program, derived here
 * (and `["config"]`, `["collection-authority"]` likewise), so the page depends on no server derivation.
 * Mock mode (`config.mode === 'mock'`) keeps the mock chain's derivation through the server.
 */
async function residentAccountOf(asset) {
  if (state.config.mode === 'mock') return (await api(`/mint/derive?asset=${asset}`)).resident;
  return findProgramAddress([utf8('resident'), fromBase58(asset)], state.config.programs.resident)[0];
}
/** The wallet's per-wallet count account `["minted-by", wallet]` (the mock chain does not model it). */
async function minterAccountOf(wallet) {
  if (state.config.mode === 'mock') return 'mock';
  return findProgramAddress([utf8('minted-by'), fromBase58(wallet)], state.config.programs.resident)[0];
}
function derivedPdas() {
  const p = state.config.programs.resident;
  return { config: findProgramAddress([utf8('config')], p)[0], collectionAuthority: findProgramAddress([utf8('collection-authority')], p)[0] };
}
/** The resident program's custom error names (program/src/lib.rs ResidentError) out of an RPC error. */
const RESIDENT_ERRORS = { 1000: 'BadData', 1001: 'BadAddress', 1002: 'Auth', 1003: 'NotOwner', 1004: 'StaleGen', 1005: 'PriceChanged', 1006: 'WrongTreasury', 1007: 'WrongCollection', 1008: 'AlreadyInitialized', 1009: 'NotInitialized', 1010: 'SessionExpiry',
  1011: 'NotUpgradeAuthority', 1012: 'SaleClosed', 1013: 'SupplyNotSet', 1014: 'SoldOut', 1015: 'SaleNotStarted', 1016: 'SaleEnded', 1017: 'WalletLimit', 1018: 'BadTerms', 1019: 'MetadataNotSet' };
function programError(e) {
  const s = `${e.message} ${JSON.stringify(e.data ?? '')}`;
  const m = /"Custom":(\d+)/.exec(s) || /custom program error: 0x([0-9a-f]+)/i.exec(s);
  if (!m) return null;
  const code = m[0].startsWith('"Custom"') ? Number(m[1]) : parseInt(m[1], 16);
  return RESIDENT_ERRORS[code] ?? `Custom(${code})`;
}

boot().catch(e => fail(e));
