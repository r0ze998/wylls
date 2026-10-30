/**
 * The effect catalog: which existing commands a manifest may compose.
 *
 * ⑥ does not define commands. Each entry names an instruction that already
 * exists (its tag, its CU budget, its errors) and adds only what composing
 * needs: typed arguments, typed outputs, the right it needs, the place
 * rule, what it consumes and makes, and how it fails. When ③ publishes the
 * command-type registry, this table is to be generated from it (see
 * handoff/03-command-types.ja.md).
 *
 * `availability` is where the instruction exists today:
 *   base       on the base commit 4cd901de (S1, merged in main)
 *   s2-branch  only on the unmerged branch `ccr-184d6862-fqutoz` (S2 2a–2e)
 * A world snapshot lists the levels it runs (`world.features`); a manifest
 * that uses an effect of another level is refused with EFFECT_UNAVAILABLE.
 *
 * Numbers marked [phase 6] are the code's placeholders, copied, not chosen here.
 */

/** A frozen lookup table with no prototype: EFFECTS["constructor"] is undefined. */
function table(obj) {
  const out = Object.create(null);
  for (const [k, v] of Object.entries(obj)) {
    out[k] = v && typeof v === "object" && !Array.isArray(v) ? table(v) : v;
  }
  return Object.freeze(out);
}

export const LEVELS = table({
  base: "4cd901de の main（S1）にある",
  "s2-branch": "未統合ブランチ ccr-184d6862-fqutoz（S2）にだけある",
});

export const EFFECTS = table({
  "caravan.send": {
    ja: "荷車で送る",
    commands: ["SendCaravan (0xB1)", "SettleCaravan (0xB2, 誰でも)"],
    availability: "base",
    source: "docs/frontier/stage1b/S1-1B-CONTRACT.md §3.2–3.3; frontier-abi/src/v2/budgets.rs",
    args: {
      from: { type: "place", own: true },
      to: { type: "place" },
      cargo: { type: "goods" },
    },
    outputs: { delivered: { type: "result:delivery", at: "to", goods: "cargo" } },
    takes: { place: "from", goods: "cargo" },
    tx: 2,
    cu: 120_000 + 40_000,
    feeLamports: 50_000, // CARAVAN_FEE [phase 6]
    walletUnlessOwn: "to",
    failures: [
      "経路の州の荷車の枠が満杯（ProvinceBusy）",
      "一つの州に8ターンを超えて留まる経路（TooSlow）",
      "送り元の在庫が足りない",
      "途中で襲われ、奪われる・焼かれる（RaidCaravan）",
      "届け先が奪われた・閉じた（世代が変わった）",
    ],
  },
  "workshop.run": {
    ja: "他人の工房を使用権の札で動かす",
    commands: ["UseRun (0xC8)"],
    availability: "s2-branch",
    source: "docs/frontier/stage2/S2-2D-CONTRACT.md（ブランチ ccr-184d6862-fqutoz）; permutation-rules/src/frontier/arms.rs",
    args: {
      via: { type: "workshop", connect: "use" },
      vault: { type: "vault", own: true, sameProvinceAs: "via", unshared: true },
      runs: { type: "int", min: 1, max: 24 },
    },
    outputs: { made: { type: "result:run", at: "vault", perRun: { arms: 4 } } },
    takes: { place: "vault", perRun: { ore: 8, wood: 4 } }, // WORKSHOP_*_PER_HOUR [phase 6]
    makes: { place: "vault", perRun: { arms: 4 } },
    tx: 1,
    cu: 20_000,
    feeLamports: 0,
    failures: [
      "札か工房の今日の回数を使い切った（UseLimit。工房全体で 工房の数×24回/日）",
      "倉の鉱石・木材が足りない、または受け取りの札のために押さえられている（Insufficient）",
      "兵器が倉の容量に入らない（BadData）",
      "工房の村が奪われ札が無効になった（世代の違い）",
    ],
  },
  "receipt.withdraw": {
    ja: "受け取りの札で他人の倉から引き出す",
    commands: ["ClaimReceipt (0xC6)", "WithdrawReceipt (0xC7)", "SettleCaravan (0xB2)"],
    availability: "s2-branch",
    source: "docs/frontier/stage2/S2-2C-CONTRACT.md（ブランチ ccr-184d6862-fqutoz）",
    args: {
      via: { type: "vault", connect: "receipt" },
      amount: { type: "int", min: 1 },
      to: { type: "place" },
    },
    outputs: { delivered: { type: "result:delivery", at: "to", goods: "receipt" } },
    tx: 3,
    cu: 20_000 + 120_000 + 40_000,
    feeLamports: 50_000,
    walletUnlessOwn: "to",
    failures: [
      "その日の請求が在庫を超え、札の割合で減らされる（翌期の始めに確定）",
      "倉が奪われ札が無効になった",
      "荷車の失敗（caravan.send と同じ）",
    ],
  },
  "shares.withdraw": {
    ja: "持ち分の札で共有の倉から引き出す",
    commands: ["WithdrawShares (0xC4)", "SettleCaravan (0xB2)"],
    availability: "s2-branch",
    source: "docs/frontier/stage2/S2-2B-CONTRACT.md（ブランチ ccr-184d6862-fqutoz）",
    args: {
      via: { type: "vault", connect: "share" },
      to: { type: "place" },
    },
    outputs: { delivered: { type: "result:delivery", at: "to", goods: "basket" } },
    tx: 2,
    cu: 120_000 + 40_000,
    feeLamports: 50_000,
    walletUnlessOwn: "to",
    failures: ["倉が奪われ札が無効になった", "中身は割合でまとめて出る（資源は選べない）", "荷車の失敗（caravan.send と同じ）"],
  },
});

/**
 * Operations that exist but are done once, outside a manifest's steps:
 * acquiring or issuing the rights a manifest then needs.
 */
export const SETUP = table({
  "vault.build": { commands: ["BuildVault (0xB0)"], availability: "base" },
  "tickets.issue": { commands: ["IssueTickets (0xC0)"], availability: "s2-branch" },
  "tickets.give": { commands: ["GiveLot (0xC1)"], availability: "s2-branch", note: "贈与はウォレットの署名（L7）" },
  "escrow.exchange": { commands: ["OpenEscrow (0xC9)", "AcceptEscrow (0xCA)"], availability: "s2-branch" },
});

/**
 * World effects a manifest cannot compose. `class`:
 *   core-extension  needs a new rule in the core (a new season / program version)
 *   forbidden       ruled out by the adopted design
 * The reasons cite the design documents; docs/04-world-effects.ja.md
 * compares how an extension could be added.
 */
export const NOT_COMPOSABLE = table({
  "trigger.schedule": { class: "core-extension", ja: "時刻・量・到着・公開の事実の合図で自動実行（段階3で決定、未実装）", ref: "21-stage3-play.ja.md §2" },
  "owner.ticket": { class: "core-extension", ja: "仕組みの持ち主の権利を札にする（段階4、札の種類が増える）", ref: "22-stage4-play.ja.md §2" },
  "fee.collect": { class: "core-extension", ja: "仕組みの利用者から手数料を自動で受け取る", ref: "22-stage4-play.ja.md §3 場面C" },
  "recipe.custom": { class: "core-extension", ja: "新しい変換（材料→製品）。規則の数値と指紋が変わる", ref: "docs/frontier/MAINTENANCE.md「Changing a rule figure」" },
  "escrow.standing": { class: "core-extension", ja: "出しっぱなしの申し出（決定済み、S2 の預かりは1対1）", ref: "99-decisions.ja.md 2026-10-23 建物の設定" },
  "goods.teleport": { class: "forbidden", ja: "荷車を通さずに物を動かす", ref: "16-primitives.ja.md §2「運ぶには時間がかかり、襲われうる」" },
  "goods.mint": { class: "forbidden", ja: "物を無から増やす", ref: "16-primitives.ja.md §2「無から増えない」" },
  "march.auto": { class: "forbidden", ja: "軍の進軍・攻撃を自動にする", ref: "21-stage3-play.ja.md §5; 99-decisions.ja.md 塔の線引き" },
  "signal.hidden": { class: "forbidden", ja: "移動中の軍など隠れた情報を合図にする", ref: "21-stage3-play.ja.md §2" },
  "code.run": { class: "forbidden", ja: "任意のコードを実行する（本番には入れない。この課題の範囲外）", ref: "課題⑥の制約" },
});

export const TRIGGERS = table({
  manual: { available: true, ja: "手で実行（段階2と同じ）" },
  daily: { available: false, ja: "毎日決まった時刻（段階3、未実装）" },
  below: { available: false, ja: "在庫が下回ったら（段階3、未実装）" },
  arrival: { available: false, ja: "物が届いたら（段階3、未実装）" },
});

/**
 * Caps on what one manifest may ask for [phase 6: placeholders of this
 * workstream, to be set with the core's budgets]. A run is one execution
 * of every step once; includes are expanded before counting.
 */
export const CAPS = table({
  steps: 8,
  caravansPerRun: 4,
  runsPerDay: 24,
  txPerDay: 96,
  cuPerDay: 4_000_000,
  params: 16,
  dependencies: 8,
});
