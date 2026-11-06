/**
 * The example of this workstream: a supply plan that runs someone else's
 * workshop, its author A, its user B, the workshop owner W, a mine owner M
 * and B's ally D. The same data drive the tests, the CLI demo and the
 * browser prototype.
 *
 * The seeds below are demo keys written in the repository: they are not
 * secrets and must never hold anything.
 */

import { FORMAT } from "./manifest.mjs";

export const DEMO_SEEDS = Object.freeze({
  A: "a1".repeat(32),
  B: "b2".repeat(32),
  W: "c3".repeat(32),
  M: "d4".repeat(32),
  D: "e5".repeat(32),
});

const LAMPORTS = { A: 1_000_000, B: 400_000, W: 200_000, M: 500_000, D: 100_000 };

export const PEOPLE = Object.freeze({
  A: "作者A（前線補給を作った）",
  B: "利用者B（Aの定義を使い、写して作り変える）",
  W: "工房主W（工房を動かし、使用権の札を出す）",
  M: "鉱山主M（鉱石と木材の定期便を出す）",
  D: "Bの味方D（砦の倉を持つ）",
});

/** The world snapshot: S1 places and S2 issues and lots, as mock data. */
export function demoWorld() {
  const w = {
    label: "模擬の世界。S1 の場所と、未統合ブランチ ccr-184d6862-fqutoz の S2 の札の規則を写したデータ。S2 の効果（工房の使用権など）は main の S1 では動かない",
    features: ["base", "s2-branch"],
    today: 12,
    // lamports: the balance a caravan's settlement fee (CARAVAN_FEE 50,000) is paid from [phase 6]
    citizens: Object.fromEntries(Object.entries(PEOPLE).map(([id, ja]) => [id, { ja, pub: null, lamports: LAMPORTS[id] }])),
    places: {
      "village:W": { kind: "village", owner: "W", province: [3, -1], gen: 1, stamp: 900, live: true, workshops: 2, ja: "Wの村（工房2つ、峠の州）" },
      "village:W2": { kind: "village", owner: "W", province: [6, 1], gen: 1, stamp: 910, live: true, workshops: 1, ja: "Wの川沿いの村（工房1つ）" },
      "village:A": { kind: "village", owner: "A", province: [1, 0], gen: 1, stamp: 100, live: true, workshops: 0, ja: "Aの村" },
      "vault:A-mine": { kind: "vault", owner: "A", province: [1, 0], gen: 1, stamp: 101, live: true, shared: false, cap: 5000, stores: { ore: 200, wood: 100 }, ja: "Aの鉱山の倉" },
      "vault:A-work": { kind: "vault", owner: "A", province: [3, -1], gen: 1, stamp: 102, live: true, shared: false, cap: 5000, stores: {}, ja: "Aの峠の倉（工房と同じ州）" },
      "vault:A-fort": { kind: "vault", owner: "A", province: [4, -2], gen: 1, stamp: 103, live: true, shared: false, cap: 5000, stores: {}, ja: "Aの前線の倉" },
      "village:B": { kind: "village", owner: "B", province: [5, 2], gen: 1, stamp: 200, live: true, workshops: 0, ja: "Bの村" },
      "vault:B-home": { kind: "vault", owner: "B", province: [5, 2], gen: 1, stamp: 201, live: true, shared: false, cap: 5000, stores: { ore: 30, wood: 10 }, ja: "Bの村の倉" },
      "vault:B-work": { kind: "vault", owner: "B", province: [3, -1], gen: 1, stamp: 202, live: true, shared: false, cap: 5000, stores: {}, ja: "Bの峠の倉（工房と同じ州）" },
      "vault:D-fort": { kind: "vault", owner: "D", province: [4, -2], gen: 1, stamp: 500, live: true, shared: false, cap: 5000, stores: { arms: 4 }, ja: "Dの砦の倉" },
      "vault:M-mine": { kind: "vault", owner: "M", province: [2, -1], gen: 1, stamp: 400, live: true, shared: false, cap: 5000, stores: { ore: 600, wood: 300 }, ja: "Mの鉱山の倉" },
    },
    issues: {
      "issue:W-1": { kind: "use", source: "village:W", srcGen: 1, srcStamp: 900, perUnit: 1, untilDay: 30, state: "live", issuer: "W", ja: "Wの工房の使用権（1枚で1日1回、30日まで）" },
      "issue:W-old": { kind: "use", source: "village:W", srcGen: 1, srcStamp: 900, perUnit: 1, untilDay: 10, state: "live", issuer: "W", ja: "Wの工房の使用権（10日まで、期限切れ）" },
    },
    batches: {},
    lots: {
      "lot:A-1": { issue: "issue:W-1", holder: "A", amount: 3, srcGen: 1, state: "live", day: 0, dayUsed: 0, escrow: false },
      "lot:B-old": { issue: "issue:W-old", holder: "B", amount: 3, srcGen: 1, state: "live", day: 0, dayUsed: 0, escrow: false },
    },
  };
  // goods held for batches (rights to consume a delivery), per vault
  for (const p of Object.values(w.places)) if (p.kind === "vault") p.held = {};
  return w;
}

/**
 * Mock of an exchange B makes with W outside any manifest (S2's escrow,
 * 2e): W's use lot of 3 units moves to B. Returns a new world.
 */
export function giveUseLot(world, { to, lotId = `lot:${to}-1`, amount = 3, issue = "issue:W-1" }) {
  const w = structuredClone(world);
  w.lots[lotId] = { issue, holder: to, amount, srcGen: w.issues[issue].srcGen, state: "live", day: 0, dayUsed: 0, escrow: false };
  return w;
}

/** A's definition: haul materials to the workshop's Province, run W's workshop, ship the arms. */
export function frontSupply(authorPub, over = {}) {
  return {
    format: FORMAT,
    name: "front-supply",
    version: "1.0.0",
    author: authorPub,
    title: "前線補給（工房を借りて兵器を送る）",
    note: "工房の州に自分の倉を置き、そこへ鉱石と木材を運び、Wの工房を使用権の札で動かして、できた兵器を前線の倉へ送ります。峠を通るので襲われることがあります。",
    params: {
      source: { type: "vault", own: true, ja: "材料を出す倉", default: "vault:A-mine" },
      workshop: { type: "workshop", ja: "使う工房", default: "village:W" },
      workVault: { type: "vault", own: true, ja: "工房と同じ州の自分の倉", default: "vault:A-work" },
      receiver: { type: "place", ja: "兵器の届け先", default: "vault:A-fort" },
      runs: { type: "int", min: 1, max: 6, default: 3, ja: "1日に工房を動かす回数" },
    },
    uses: {
      ws: { relation: "connect", target: { param: "workshop" }, grant: "use", amount: { param: "runs" }, ja: "工房" },
    },
    steps: [
      { id: "haul", effect: "caravan.send", args: { from: { param: "source" }, to: { param: "workVault" }, cargo: { goods: { ore: { param: "runs", times: 8 }, wood: { param: "runs", times: 4 } } } } },
      { id: "make", effect: "workshop.run", after: ["haul"], args: { via: { use: "ws" }, vault: { param: "workVault" }, runs: { param: "runs" } } },
      { id: "ship", effect: "caravan.send", after: ["make"], args: { from: { param: "workVault" }, to: { param: "receiver" }, cargo: { goods: { arms: { param: "runs", times: 4 } } } } },
    ],
    trigger: "manual",
    limits: { runsPerDay: 1 },
    outputs: { arms: { from: { step: "ship", out: "delivered" } } },
    claims: {
      trigger: "manual",
      runsPerDay: 1,
      outputsPerRun: { arms: 12 },
      grants: ["use"],
      deliversTo: ["receiver"],
      signer: "wallet-unless-own",
    },
    ...over,
  };
}

/** M's definition: ship ore and wood from M's mine to a buyer's vault. */
export function mineDelivery(authorPub, over = {}) {
  return {
    format: FORMAT,
    name: "mine-delivery",
    version: "1.0.0",
    author: authorPub,
    title: "鉱山の便（鉱石と木材を届ける）",
    note: "買い手の倉へ、鉱石と木材を荷車で届けます。代金の受け渡しは引き換えの預かりで別に行います。",
    params: {
      mine: { type: "vault", own: true, ja: "出す鉱山の倉", default: "vault:M-mine" },
      buyer: { type: "vault", ja: "買い手の倉" },
      ore: { type: "int", min: 0, max: 200, default: 24, ja: "鉱石の量" },
      wood: { type: "int", min: 0, max: 100, default: 12, ja: "木材の量" },
    },
    uses: {},
    steps: [
      { id: "ship", effect: "caravan.send", args: { from: { param: "mine" }, to: { param: "buyer" }, cargo: { goods: { ore: { param: "ore" }, wood: { param: "wood" } } } } },
    ],
    trigger: "manual",
    limits: { runsPerDay: 4 },
    outputs: { delivered: { from: { step: "ship", out: "delivered" } } },
    claims: { outputsPerRun: { ore: 24, wood: 12 }, deliversTo: ["buyer"], signer: "wallet-unless-own" },
    ...over,
  };
}

/**
 * B's edit of a fork of front-supply: the materials come from a finished
 * delivery of M's mine-delivery into B's vault (C) instead of B's own
 * haul, and the arms go to a receiver B names. Takes the fork's draft.
 */
export function editForkForRiver(draft, { mineRef }) {
  const m = structuredClone(draft);
  delete m.params.source;
  m.uses.ore = { relation: "consume", manifest: mineRef, output: "delivered", type: "result:delivery", ja: "Mの鉱山の便が届いた記録" };
  m.steps = m.steps.filter((s) => s.id !== "haul");
  m.steps.find((s) => s.id === "make").after = [{ use: "ore" }];
  m.params.receiver.ja = "兵器の届け先（味方の砦など）";
  m.note = "材料は自分で運ばず、Mの鉱山の便が自分の峠の倉へ届けた記録を使います。兵器は名前を挙げた届け先へ送ります。";
  m.claims = { trigger: "manual", runsPerDay: 1, outputsPerRun: { arms: 12 }, grants: ["use"], consumes: ["ore"], deliversTo: ["receiver"], signer: "wallet-unless-own" };
  return m;
}
