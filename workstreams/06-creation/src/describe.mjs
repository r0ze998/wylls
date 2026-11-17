/**
 * The paper (仕組みの紙): what the machine can say about a manifest, in
 * plain words, written from the validator's facts. The author's own note is
 * returned apart and labelled as the author's (22-stage4-play §4: the paper
 * is written automatically and the author's description is shown apart).
 */

import { own } from "./canonical.mjs";
import { EFFECTS, LEVELS, TRIGGERS } from "./catalog.mjs";
import { TYPES } from "./types.mjs";
import { RELATIONS } from "./manifest.mjs";

const RJA = { food: "食料", wood: "木材", stone: "石", ore: "鉱石", arms: "兵器", gold: "金", science: "学", influence: "影響" };
const GJA = { use: "使用権の札", share: "持ち分の札", receipt: "受け取りの札" };

function ex(e, m) {
  if (Number.isSafeInteger(e)) return String(e);
  if (!e || typeof e !== "object") return "?";
  if ("param" in e) {
    const label = `〈${own(m.params, e.param)?.ja ?? e.param}〉`;
    return e.times ? `${e.times}×${label}` : label;
  }
  if ("place" in e) return `固定の場所 ${e.place}`;
  if ("use" in e) return `接続先「${own(m.uses, e.use)?.ja ?? e.use}」`;
  if ("step" in e) return `手順 ${e.step} の${e.out}`;
  if ("goods" in e) return Object.entries(e.goods).map(([r, x]) => `${RJA[r] ?? r} ${ex(x, m)}`).join("・");
  return "?";
}

function goodsText(g) {
  const parts = Object.entries(g ?? {}).map(([r, n]) => `${RJA[r] ?? r} ${n}`);
  return parts.length ? parts.join("・") : "なし";
}

export function describe(m, facts) {
  const lines = [];
  const sec = (title, items) => lines.push({ title, items: items.length ? items : ["なし"] });
  sec("名前", [`${m.title}（${m.name} 版 ${m.version}）`, `作者の鍵 ${m.author.slice(0, 16)}…`,
    ...(m.derivedFrom ? [`元にした定義：${m.derivedFrom.name} 版 ${m.derivedFrom.version}（作者の鍵 ${m.derivedFrom.author.slice(0, 16)}…）`] : [])]);
  sec("利用者が決める入力", Object.entries(m.params).map(([n, p]) => {
    const bits = [`${p.ja ?? n}：${own(TYPES, p.type)?.ja ?? p.type}`];
    if (p.own) bits.push("自分のもの");
    if (p.min !== undefined || p.max !== undefined) bits.push(`${p.min ?? 0}〜${p.max ?? "上限なし"}`);
    if (p.default !== undefined) bits.push(`既定 ${p.default}`);
    return bits.join("、");
  }));
  sec("つなぐ先（B：他人が動かしているもの）", facts.grants.map((g) => `${ex(g.target, m)} に、利用者自身の${GJA[g.kind]}で接続${g.amount != null ? `（1回に ${ex(g.amount, m)}）` : ""}`));
  sec("使う成果（C：確定した記録）", facts.consumes.map((c) => `${c.manifest.name}（${c.manifest.range}${c.manifest.hash ? `、ハッシュ固定` : ""}）の出力「${c.output}」の完了記録を、1回ごとに1つ使う`));
  sec("すること（順番どおり）", m.steps.map((s, i) => {
    const spec = own(EFFECTS, s.effect);
    const after = (s.after ?? []).map((a) => (typeof a === "string" ? `手順 ${a}` : `成果「${a.use}」`));
    const wait = after.length ? `（${after.join("・")}が確定してから）` : "";
    if (s.effect === "caravan.send") return `${i + 1}. 荷車で送る：${ex(s.args.from, m)} → ${ex(s.args.to, m)}、${ex(s.args.cargo, m)}${wait}`;
    if (s.effect === "workshop.run") return `${i + 1}. ${ex(s.args.via, m)}の工房を ${ex(s.args.runs, m)} 回動かす。${ex(s.args.vault, m)}の中で 1回に 鉱石8・木材4 → 兵器4${wait}`;
    if (s.effect === "receipt.withdraw") return `${i + 1}. ${ex(s.args.via, m)}から受け取りの札で ${ex(s.args.amount, m)} を ${ex(s.args.to, m)} へ引き出す${wait}`;
    if (s.effect === "shares.withdraw") return `${i + 1}. ${ex(s.args.via, m)}から持ち分の札で ${ex(s.args.to, m)} へ引き出す${wait}`;
    return `${i + 1}. ${spec?.ja ?? s.effect}`;
  }));
  sec("1回の実行で渡すもの", [goodsText(facts.outputsPerRun) + (facts.deliversTo.length ? ` → ${facts.deliversTo.map((d) => `〈${own(m.params, d)?.ja ?? d}〉`).join("・")}` : "")]);
  sec("合図", [facts.declaredTrigger === facts.trigger ? own(TRIGGERS, facts.trigger).ja : `${own(TRIGGERS, facts.declaredTrigger)?.ja}と書かれているが、未実装のため${TRIGGERS.manual.ja}`]);
  sec("上限と費用", [
    `1日 ${facts.runsPerDay} 回まで`,
    `1回に 取引 ${facts.perRun.tx} 件・計算量 約 ${facts.perRun.cu.toLocaleString("ja-JP")} CU・荷車の精算預け ${facts.perRun.feeLamports.toLocaleString("ja-JP")} lamports（［フェーズ6］の仮の値）`,
    ...(facts.perRun.inputs.length ? facts.perRun.inputs.map((i) => `1回の前に ${ex(i.at, m)} にそろえる物：${goodsText(i.goods)}（在庫か、使う成果で）`) : ["前もってそろえる物：なし"]),
  ]);
  sec("署名", [facts.signer === "session" ? "ゲーム内の鍵だけで動く（送り先がすべて利用者自身の場所）" : "送り先が利用者自身の場所でないと、ウォレットの署名が要る"]);
  sec("動く世界", facts.levels.map((l) => LEVELS[l] ?? l));
  sec("失敗するとき（止まって記録に残る）", [...new Set(facts.failures.map((f) => f.text))]);
  sec("この紙について", [
    "定義から機械で書いた。作者の説明とは別。",
    "公開された定義は説明と接続の約束であって、履行の保証でも権利そのものでもない。",
    "使うには、利用者自身の札・場所・署名が要る。",
    ...Object.entries(RELATIONS).map(([k, v]) => `${k}：${v}`),
  ]);
  return { lines, authorNote: m.note ?? null };
}

export function paperText(p) {
  const out = [];
  for (const s of p.lines) {
    out.push(`■ ${s.title}`);
    for (const i of s.items) out.push(`  ${i}`);
  }
  out.push("■ 作者の説明（作者が書いたもの。機械は確かめていない）");
  out.push(`  ${p.authorNote ?? "なし"}`);
  return out.join("\n");
}
