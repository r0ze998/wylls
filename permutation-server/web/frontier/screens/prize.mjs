// The prize pool on the page (テストUSDC on the local test chain; no
// value): the join screen's terms (fee, the x402 payment, the pool and its
// 80/20 split, the wallet's balance) and the 賞金 panel of the nation tab
// (the pool, provinces per nation from the chain after the end, the
// confirmed winner, the achievements of attackers and supporters, and the
// ESTIMATED split, always labelled 試算). Nothing here is shown for a
// season without a pool.
import { html } from '../../util.mjs';
import { L, fmtNum } from '../../lang.mjs';
import { factionName } from '../fi18n.mjs';
import { prizeModel, ledgerModel } from '../fprize.mjs';
import { crest, sigChip } from '../hud/keephand.mjs';

const short = s => (s ? `${String(s).slice(0, 6)}…${String(s).slice(-4)}` : '—');

/** The join screen's block: what joining costs and where the fee goes. Empty without a pool. */
export function renderJoinTerms(FS) {
  const m = prizeModel(FS.prize);
  if (!m) return '';
  // Once the count has started the pool takes no entry: show the result instead of the price.
  if (m.final || m.counting) return render(FS);
  const w = m.wallet;
  return html`<section class="prize-terms" aria-labelledby="prize-terms-title">
    <h4 id="prize-terms-title">${L`参加費と賞金プール（テストUSDC）`}</h4>
    <p>${L`参加費は ${m.fee} テストUSDC です。ウォレットが署名する1つの取引で、参加費の支払いと参加が同時に行われます（x402）。`}</p>
    <dl class="prize-figures">
      <div><dt>${L`賞金プールへ（${fmtNum(m.prizePct)}%）`}</dt><dd>${m.feeToPrize}</dd></div>
      <div><dt>${L`運営へ（${fmtNum(m.opsPct)}%）`}</dt><dd>${m.feeToOps}</dd></div>
      <div><dt>${L`いまの賞金プール`}</dt><dd>${m.prize}</dd></div>
      <div><dt>${L`参加者`}</dt><dd>${fmtNum(m.entries)}</dd></div>
    </dl>
    ${w ? html`<p class="prize-wallet">${L`このウォレットのテストUSDC：${w.balance}`}${w.paid ? html` <span class="muted">${L`（参加費は支払い済み）`}</span>` : ''}</p>` : ''}
    ${w && !w.paid && !w.canPay ? html`<p><button type="button" class="btn" data-act="prize-faucet">${L`テストUSDCを受け取る`}</button> <span class="muted">${L`足りない場合は、参加の前に自動で受け取ります。`}</span></p>` : ''}
    <p class="muted">${L`テストUSDCはこのローカルのテスト用チェーンだけの通貨で、価値はありません。季節の終わりに最も多くの州を持つ国が勝ち、賞金プールはその国の参加費を払ったメンバーに分けられます。`}</p>
  </section>`;
}

const kindLabel = { capture: () => L`攻略`, reinforcement: () => L`増援`, defence: () => L`防衛`, resourceSupply: () => L`資源の補給` };

/** A contribution line: who (nation, wallet), where, how much, the turn, and the signature of the record it was derived from. */
function lineRows(lines) {
  return lines.map(l => html`<li class="pz-line kh-n${l.nation}${l.mine ? ' mine' : ''}"><span class="pz-line-top">${crest(l.nation, 18)}<strong>${factionName(l.nation)}</strong><code title="${l.wallet ?? ''}">${short(l.wallet)}</code>${l.mine ? html`<span class="pz-tag">${L`（あなた）`}</span>` : ''}${l.invited ? html`<span class="muted">${L`AI市民・ボット（賞金の対象外）`}</span>` : ''}</span>
    <span class="pz-line-top"><span>${L`州 ${l.p},${l.q}`}</span><span>${l.unit === 'troops' ? L`兵 ${fmtNum(l.quantity)}` : L`砦 ${fmtNum(l.quantity)}`}</span><span>${L`第${fmtNum(l.bell)}ターン`}</span>${l.signature ? sigChip(l.signature, { label: L`記録の署名` }) : ''}</span></li>`);
}

/** The 賞金 panel. Empty without a pool. */
export function render(FS) {
  const m = prizeModel(FS.prize);
  if (!m) return '';
  const g = ledgerModel(FS.prizeLedger, { wallet: FS.wallet?.address ?? null, decimals: FS.prize.decimals });
  const head = html`<header class="pz-head"><h3 id="prize-title">${L`賞金（テストUSDC）`}</h3>
      <div class="pz-pool"><strong>${m.prize}</strong><span>${L`賞金プール · テストUSDC`}</span></div>
      <p class="pz-chain">${L`ローカルのテスト用チェーンのテスト通貨です。価値はありません。`}</p></header>
    <dl class="prize-figures">
      <div><dt>${L`参加費`}</dt><dd>${m.fee}</dd></div>
      <div><dt>${L`集まった参加費`}</dt><dd>${m.collected}</dd></div>
      <div><dt>${L`参加者`}</dt><dd>${fmtNum(m.entries)}</dd></div>
      <div><dt>${L`賞金プール（${fmtNum(m.prizePct)}%）`}</dt><dd>${m.prize}</dd></div>
      <div><dt>${L`運営（${fmtNum(m.opsPct)}%）`}</dt><dd>${m.ops}</dd></div>
    </dl>`;
  const top = m.area ? Math.max(1, ...m.area.map(a => a.provinces)) : 1;
  const area = m.area ? html`<h4>${L`国ごとの州の数（チェーンの集計）`}</h4>
    <ol class="pz-area prize-area">${m.area.map(a => html`<li class="kh-n${a.faction}${a.winner ? ' pz-win winner' : ''}">${crest(a.faction, 20)}<span>${factionName(a.faction)}</span><span class="pz-bar" aria-hidden="true"><i class="w${Math.round(10 * a.provinces / top)}"></i></span><strong>${fmtNum(a.provinces)}</strong>${a.winner ? html`<span class="pz-tag">${L`勝者`}</span>` : html`<span></span>`}</li>`)}</ol>
    ${m.final ? html`<div class="pz-result kh-n${m.winners[0] ?? 6}">${crest(m.winners[0] ?? null, 34)}<p class="callout"><strong>${L`結果は確定しました：${m.winners.map(factionName).join(' / ')}（州の数が最も多い国）。この集計はだれにも変更できません。`}</strong><span>${L`集計（Tally）と確定（Finalize）はチェーンの記録です。`}</span></p></div>`
      : html`<p role="status">${L`集計中です（${fmtNum(m.counted)} / ${fmtNum(m.keepsToCount)} 州）。`}</p>`}`
    : html`<p class="muted">${L`勝者は、季節の終わりに最も多くの州（砦）を持つ国です。季節が終わると、チェーン上の州の記録から集計されます。`}</p>`;
  const ledger = g ? html`<h4>${L`攻略した人`}</h4>
    ${g.attackers.length ? html`<ul class="pz-lines prize-lines">${lineRows(g.attackers)}</ul>` : html`<p class="muted">${L`記録はありません。`}</p>`}
    <h4>${L`増援した人`}</h4>
    ${g.supporters.length ? html`<ul class="pz-lines prize-lines">${lineRows(g.supporters)}</ul>` : html`<p class="muted">${L`記録はありません。`}</p>`}
    <p class="muted">${L`功績の行は、公開されたチェーンの記録から運営のスクリプトが求めたものです。`}</p>
    ${g.hasInvited ? html`<p class="muted">${L`AI市民やボットが取った州も、その国の州の数に入ります（勝者はチェーン上の土地の持ち主で決まります）。AI市民とボットは賞金を受け取りません。`}</p>` : ''}
    ${g.notDerivable.map(k => html`<p class="muted">${L`${(kindLabel[k.kind] ?? (() => k.kind))()}：いまのチェーンの記録からは求められません。`}</p>`)}
    <h4>${L`分配の試算`}</h4>
    ${m.posted ? html`<p class="callout pz-est"><strong>${L`分配の試算`}</strong><span>${L`これは暫定の配点による試算です。この配点はチェーンに登録されており、受け取りは ${fmtNum(m.posted.claims)} 件・合計 ${m.posted.claimed} テストUSDC です。配点と同点・該当者なしの扱いは未決定（暫定）です。`}</span></p>`
      : html`<p class="callout pz-est"><strong>${L`分配の試算 · 送金は行われていません`}</strong><span>${L`これは試算です。送金は行われていません。配点と同点・該当者なしの扱いは未決定（暫定）です。`}</span></p>`}
    ${g.estimate.length ? html`<ul class="pz-split prize-estimate">${g.estimate.map(s => html`<li class="kh-n${s.nation}${s.mine ? ' mine' : ''}">${crest(s.nation, 18)}<span><code title="${s.wallet ?? ''}">${short(s.wallet)}</code>${s.mine ? html` <span class="pz-tag">${L`（あなた）`}</span>` : ''}</span>
      <span>${L`${fmtNum(s.points)} 点`}</span><span class="pz-amt">${L`試算 ${s.amount} テストUSDC`}</span></li>`)}</ul>` : html`<p class="muted">${L`試算できる人がいません。`}</p>`}`
    : (m.final ? html`<p class="muted">${L`功績の記録はまだ公開されていません。`}</p>` : '');
  return html`<section class="prize-panel pz" aria-labelledby="prize-title">${head}${area}${ledger}
    <p><button type="button" class="btn small" data-act="prize-refresh">${L`更新する`}</button></p></section>`;
}
