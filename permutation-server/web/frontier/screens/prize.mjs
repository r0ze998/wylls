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
import { swatch } from './shell.mjs';

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

function lineRows(lines) {
  return lines.map(l => html`<tr ${l.mine ? html`class="mine"` : ''}><td>${swatch(l.nation)}${factionName(l.nation)}</td><td>${short(l.wallet)}${l.mine ? html` <strong>${L`（あなた）`}</strong>` : ''}</td>
    <td>${L`州 ${l.p},${l.q}`}</td><td>${l.unit === 'troops' ? L`兵 ${fmtNum(l.quantity)}` : L`砦 ${fmtNum(l.quantity)}`}</td><td>${L`第${fmtNum(l.bell)}鐘`}</td><td><code title="${l.signature ?? ''}">${short(l.signature)}</code></td></tr>`);
}

/** The 賞金 panel. Empty without a pool. */
export function render(FS) {
  const m = prizeModel(FS.prize);
  if (!m) return '';
  const g = ledgerModel(FS.prizeLedger, { wallet: FS.wallet?.address ?? null, decimals: FS.prize.decimals });
  const head = html`<h3 id="prize-title">${L`賞金（テストUSDC）`}</h3>
    <p class="muted">${L`ローカルのテスト用チェーンのテスト通貨です。価値はありません。`}</p>
    <dl class="prize-figures">
      <div><dt>${L`集まった参加費`}</dt><dd>${m.collected}</dd></div>
      <div><dt>${L`賞金プール（${fmtNum(m.prizePct)}%）`}</dt><dd>${m.prize}</dd></div>
      <div><dt>${L`運営（${fmtNum(m.opsPct)}%）`}</dt><dd>${m.ops}</dd></div>
      <div><dt>${L`参加者`}</dt><dd>${fmtNum(m.entries)}</dd></div>
    </dl>`;
  const area = m.area ? html`<h4>${L`国ごとの州の数（チェーンの集計）`}</h4>
    <table class="prize-area"><tbody>${m.area.map(a => html`<tr ${a.winner ? html`class="winner"` : ''}><td>${swatch(a.faction)}${factionName(a.faction)}</td><td>${fmtNum(a.provinces)}</td><td>${a.winner ? L`勝者` : ''}</td></tr>`)}</tbody></table>
    ${m.final ? html`<p class="callout">${L`結果は確定しました：${m.winners.map(factionName).join(' / ')}（州の数が最も多い国）。この集計はだれにも変更できません。`}</p>`
      : html`<p role="status">${L`集計中です（${fmtNum(m.counted)} / ${fmtNum(m.expectedKeeps)} 州）。`}</p>`}`
    : html`<p class="muted">${L`勝者は、季節の終わりに最も多くの州（砦）を持つ国です。季節が終わると、チェーン上の州の記録から集計されます。`}</p>`;
  const ledger = g ? html`<h4>${L`攻略した人`}</h4>
    ${g.attackers.length ? html`<table class="prize-lines"><tbody>${lineRows(g.attackers)}</tbody></table>` : html`<p class="muted">${L`記録はありません。`}</p>`}
    <h4>${L`増援した人`}</h4>
    ${g.supporters.length ? html`<table class="prize-lines"><tbody>${lineRows(g.supporters)}</tbody></table>` : html`<p class="muted">${L`記録はありません。`}</p>`}
    ${g.notDerivable.map(k => html`<p class="muted">${L`${(kindLabel[k.kind] ?? (() => k.kind))()}：いまのチェーンの記録からは求められません。`}</p>`)}
    <h4>${L`分配の試算`}</h4>
    ${m.posted ? html`<p class="callout">${L`これは暫定の配点による試算です。この配点はチェーンに登録されており、受け取りは ${fmtNum(m.posted.claims)} 件・合計 ${m.posted.claimed} テストUSDC です。配点と同点・該当者なしの扱いは未決定（暫定）です。`}</p>`
      : html`<p class="callout">${L`これは試算です。送金は行われていません。配点と同点・該当者なしの扱いは未決定（暫定）です。`}</p>`}
    ${g.estimate.length ? html`<table class="prize-estimate"><tbody>${g.estimate.map(s => html`<tr ${s.mine ? html`class="mine"` : ''}><td>${swatch(s.nation)}${factionName(s.nation)}</td><td>${short(s.wallet)}${s.mine ? html` <strong>${L`（あなた）`}</strong>` : ''}</td>
      <td>${L`${fmtNum(s.points)} 点`}</td><td>${L`試算 ${s.amount} テストUSDC`}</td></tr>`)}</tbody></table>` : html`<p class="muted">${L`試算できる人がいません。`}</p>`}`
    : (m.final ? html`<p class="muted">${L`功績の記録はまだ公開されていません。`}</p>` : '');
  return html`<section class="prize-panel" aria-labelledby="prize-title">${head}${area}${ledger}
    <p><button type="button" class="btn small" data-act="prize-refresh">${L`更新する`}</button></p></section>`;
}
