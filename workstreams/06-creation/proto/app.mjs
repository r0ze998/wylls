/**
 * The browser prototype: make → check → publish to the local list → another
 * person picks it → checks what is missing before running → copies and
 * edits. It drives the same modules as the tests; nothing here talks to a
 * network. State lives in this browser's localStorage only.
 */

import { keyFromSeed } from "../src/keys.mjs";
import { Registry, signManifest, signStatus, STATUSES } from "../src/registry.mjs";
import { Ledger } from "../src/ledger.mjs";
import { validateDefinition } from "../src/validate.mjs";
import { describe } from "../src/describe.mjs";
import { preparePlan, preflight } from "../src/plan.mjs";
import { AdoptionBook } from "../src/adoption.mjs";
import { forkManifest } from "../src/fork.mjs";
import { execute, fmt, releaseBatch, requestRun } from "../src/execute.mjs";
import { requiredBump, updateNotices } from "../src/upgrade.mjs";
import { DOMAIN, signHash } from "../src/keys.mjs";
import { bindIdentities, citizenOf } from "../src/world.mjs";
import { TYPES, placeKindsOf } from "../src/types.mjs";
import { TRIGGERS } from "../src/catalog.mjs";
import { compare } from "../src/semver.mjs";
import { DEMO_SEEDS, PEOPLE, demoWorld, editForkForRiver, frontSupply, giveUseLot, mineDelivery } from "../src/scenario.mjs";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const STORE = "wylls06-creation-proto";

const keys = {};
const pubs = {};
const state = { actor: "A", draft: null, draftOrigin: null, selected: null, useTarget: null, lastPlan: null, lastCheck: null, runlog: [] };
let registry, ledger, adoptions, world, signlog, plans, nonce;

// ------------------------------------------------------------------ storage

function save() {
  try { localStorage.setItem(STORE, JSON.stringify({ registry: registry.toJSON(), ledger: ledger.toJSON(), adoptions: adoptions.toJSON(), world, signlog, plans, nonce })); } catch { /* private window: state stays in memory */ }
}

function load() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(STORE) ?? "null"); } catch { saved = null; }
  registry = new Registry(saved?.registry ?? undefined);
  ledger = new Ledger(saved?.ledger ?? undefined);
  adoptions = new AdoptionBook(saved?.adoptions ?? undefined);
  world = saved?.world ?? bindIdentities(demoWorld(), pubs);
  signlog = saved?.signlog ?? [];
  plans = saved?.plans ?? {}; // signed plans the users adopted, by hash (needed to run them)
  nonce = saved?.nonce ?? 0;
}

function resetAll() {
  try { localStorage.removeItem(STORE); } catch { /* ignore */ }
  registry = new Registry();
  ledger = new Ledger();
  adoptions = new AdoptionBook();
  world = bindIdentities(demoWorld(), pubs);
  signlog = [];
  plans = {};
  nonce = 0;
  state.selected = state.useTarget = state.lastPlan = state.lastCheck = null;
  state.runlog = [];
  loadTemplate();
  renderAll();
}

/** The current person's key, wrapped so every signature is logged with who signed what. */
function myKey(what) {
  const who = state.actor;
  const k = keys[who];
  return { pub: k.pub, async sign(bytes) { signlog.push({ who, what, day: world.today }); return k.sign(bytes); } };
}

const whoIs = (pub) => citizenOf(world, pub) ?? `${String(pub).slice(0, 8)}…`;
const personName = (id) => (PEOPLE[id] ? PEOPLE[id].split("（")[0] : id);

// ------------------------------------------------------------------ actor and tabs

function renderActors() {
  $("actors").innerHTML = Object.keys(PEOPLE).map((id) => `<button role="radio" aria-checked="${id === state.actor}" data-actor="${id}" title="${esc(PEOPLE[id])}">${esc(personName(id))}</button>`).join(" ");
  $("keynote").textContent = `このページは5人分の模擬の鍵を別々に持ち、どの操作も「今の人」の鍵だけで署名します（世界と台帳タブの署名の記録で確かめられます）。今：${PEOPLE[state.actor]}`;
}

function showTab(name) {
  for (const b of $("tabs").querySelectorAll("button")) b.setAttribute("aria-selected", String(b.dataset.tab === name));
  for (const s of document.querySelectorAll(".tab")) s.hidden = s.id !== `tab-${name}`;
  if (name === "list") renderList();
  if (name === "use") renderUse();
  if (name === "world") renderWorld();
}

// ------------------------------------------------------------------ make

function ownPlaces(kind) {
  return Object.entries(world.places).filter(([, p]) => p.owner === state.actor && placeKindsOf(kind).includes(p.kind) && (kind !== "workshop" || p.workshops > 0)).map(([id]) => id);
}

/** A template with the current person as author, own-place defaults moved to the person's own places. */
function loadTemplate() {
  const t = $("template").value;
  const m = t === "mine-delivery" ? mineDelivery(pubs[state.actor]) : frontSupply(pubs[state.actor]);
  for (const p of Object.values(m.params)) {
    if (!TYPES[p.type]?.place || !p.own) continue;
    const mine = ownPlaces(p.type);
    if (!mine.includes(p.default)) {
      const same = mine.find((id) => world.places[id].province?.join() === world.places[p.default]?.province?.join());
      if (same ?? mine[0]) p.default = same ?? mine[0]; else delete p.default;
    }
  }
  if (t === "front-supply" && state.actor !== "A") {
    const work = ownPlaces("vault").find((id) => world.places[id].province.join() === "3,-1");
    if (work) m.params.workVault.default = work;
    m.params.receiver.default = ownPlaces("vault")[0] ?? m.params.receiver.default;
  }
  setDraft(m, null);
}

function setDraft(m, origin) {
  $("publish-result").innerHTML = "";
  state.draft = m;
  state.draftOrigin = origin;
  $("json").value = JSON.stringify(m, null, 2);
  renderQuick();
  renderDraftOrigin();
  checkDraft();
}

function renderDraftOrigin() {
  const o = state.draftOrigin;
  if (!o) { $("draft-origin").innerHTML = ""; return; }
  $("draft-origin").innerHTML = `<p>写しの下書き：元は <strong>${esc(o.from)}</strong>。作者は今の人（${esc(personName(state.actor))}）。</p>
    <div class="dropped"><strong>写らなかったもの</strong><ul>${o.dropped.map((d) => `<li>${esc(d.ja)}</li>`).join("")}</ul>
    ${o.kept.map((k) => `<p>${esc(k.ja)}</p>`).join("")}</div>
    ${o.riverable ? `<div class="row"><button id="river-edit">入力元を「鉱山の便が届いた記録」に替える（C）</button></div>` : ""}`;
  $("river-edit")?.addEventListener("click", () => {
    const mine = registry.list({}).find((r) => r.name === "mine-delivery");
    if (!mine) { alert("先に鉱山主Mとして「鉱山の便」を公開してください（見本から始める → 鉱山の便）。"); return; }
    const m = editForkForRiver(state.draft, { mineRef: { author: mine.author, name: "mine-delivery", range: "^1.0.0" } });
    m.name = state.draft.name; m.title = state.draft.title;
    setDraft(m, { ...state.draftOrigin, riverable: false });
  });
}

function placeOptions(type, value, { ownOnly = false, empty = "（未設定）" } = {}) {
  const ids = Object.entries(world.places).filter(([, p]) => placeKindsOf(type).includes(p.kind) && (type !== "workshop" || p.workshops > 0) && (!ownOnly || p.owner === state.actor)).map(([id]) => id);
  return `<option value="">${esc(empty)}</option>` + ids.map((id) => `<option value="${esc(id)}" ${id === value ? "selected" : ""}>${esc(id)}（${esc(world.places[id].ja ?? world.places[id].owner)}）</option>`).join("");
}

function renderQuick() {
  const m = state.draft;
  if (!m || typeof m !== "object") { $("quick").innerHTML = ""; return; }
  const f = [];
  f.push(`<label class="wide">題名<input data-q="title" value="${esc(m.title)}"></label>`);
  f.push(`<label>名前（英小文字）<input data-q="name" value="${esc(m.name)}"></label>`);
  f.push(`<label>版<input data-q="version" value="${esc(m.version)}"></label>`);
  f.push(`<label>合図<select data-q="trigger">${Object.entries(TRIGGERS).map(([k, t]) => `<option value="${k}" ${k === (m.trigger ?? "manual") ? "selected" : ""}>${esc(t.ja)}</option>`).join("")}</select></label>`);
  f.push(`<label>1日の回数<input type="number" min="1" data-q="runsPerDay" value="${esc(m.limits?.runsPerDay)}"></label>`);
  for (const [name, p] of Object.entries(m.params ?? {})) {
    if (!p || typeof p !== "object") continue;
    if (TYPES[p.type]?.place) f.push(`<label>${esc(p.ja ?? name)}の既定${p.own ? "（自分のもの）" : ""}<select data-param="${esc(name)}" data-field="default">${placeOptions(p.type, p.default, { ownOnly: !!p.own })}</select></label>`);
    else if (p.type === "int") {
      f.push(`<label>${esc(p.ja ?? name)}：既定<input type="number" data-param="${esc(name)}" data-field="default" value="${esc(p.default)}"></label>`);
      f.push(`<label>${esc(p.ja ?? name)}：上限<input type="number" data-param="${esc(name)}" data-field="max" value="${esc(p.max)}"></label>`);
    }
  }
  f.push(`<label class="wide">作者の説明（自由文。機械は確かめない）<textarea rows="3" data-q="note">${esc(m.note ?? "")}</textarea></label>`);
  $("quick").innerHTML = f.join("");
}

function onQuick(e) {
  const t = e.target;
  const m = state.draft;
  if (!m || (!t.dataset.q && !t.dataset.param)) return;
  if (t.dataset.q === "runsPerDay") { m.limits ??= {}; m.limits.runsPerDay = t.value === "" ? undefined : Number(t.value); }
  else if (t.dataset.q === "note") { if (t.value) m.note = t.value; else delete m.note; }
  else if (t.dataset.q) m[t.dataset.q] = t.value;
  else {
    const p = m.params[t.dataset.param];
    const field = t.dataset.field;
    if (t.value === "") delete p[field];
    else p[field] = t.type === "number" ? Number(t.value) : t.value;
  }
  $("json").value = JSON.stringify(m, null, 2);
  checkDraft();
}

function onJson() {
  try {
    state.draft = JSON.parse($("json").value);
    renderQuick();
    checkDraft();
  } catch (err) {
    $("findings").innerHTML = findingHtml({ severity: "error", code: "JSON", path: "", message: `JSON として読めない：${err.message}` });
  }
}

function checkDraft() {
  const m = state.draft;
  const v = validateDefinition(m, { features: world.features, today: world.today });
  const reg = v.facts ? registry.checkDependencies(m) : [];
  const all = [...v.findings, ...reg];
  $("findings").innerHTML = all.length ? all.map(findingHtml).join("") : findingHtml({ severity: "ok", code: "OK", path: "", message: "定義・依存先とも問題なし（公開できる）" });
  $("paper").innerHTML = v.facts ? paperHtml(m, v.facts) : `<p>形が整うまで紙は書けません。</p>`;
  return { v, all };
}

function claimsFromFacts() {
  const { v } = checkDraft();
  if (!v.facts) return;
  const f = v.facts;
  const c = { trigger: f.trigger, runsPerDay: f.runsPerDay, outputsPerRun: f.outputsPerRun, grants: [...new Set(f.grants.map((g) => g.kind))].sort(), deliversTo: f.deliversTo, signer: f.signer };
  if (f.consumes.length) c.consumes = f.consumes.map((x) => x.dep).sort();
  state.draft.claims = c;
  $("json").value = JSON.stringify(state.draft, null, 2);
  checkDraft();
}

async function publishDraft() {
  const m = state.draft;
  const out = $("publish-result");
  if (m.author !== pubs[state.actor]) {
    out.innerHTML = findingHtml({ severity: "error", code: "NOT_AUTHOR", path: "$.author", message: `この定義の作者は ${personName(whoIs(m.author))}。今の人（${personName(state.actor)}）の鍵では作者として署名できない。写して自分の定義にするか、作者に切り替えてください。` });
    return;
  }
  const env = await signManifest(m, myKey(`定義 ${m.name}@${m.version} を公開`));
  const r = await registry.publish(env, { features: world.features, today: world.today });
  save();
  if (!r.ok) { out.innerHTML = `<p>公開できませんでした。</p>${r.findings.filter((f) => f.severity === "error").map(findingHtml).join("")}`; return; }
  state.selected = r.ref;
  out.innerHTML = findingHtml({ severity: "ok", code: "PUBLISHED", path: "", message: `ローカルの一覧へ公開した：${m.name}@${m.version}（ハッシュ ${r.ref.hash.slice(0, 16)}…）。このブラウザの外には出ていない。` }) + `<button id="goto-list">一覧で見る</button>`;
  $("goto-list").addEventListener("click", () => showTab("list"));
}

// ------------------------------------------------------------------ list

function renderList() {
  const rows = registry.list({ query: $("query").value, includeHidden: $("show-hidden").checked });
  $("entries").innerHTML = rows.length ? rows.map((r) => `<li><button data-entry="${esc(r.author)}|${esc(r.name)}|${esc(r.version)}">${esc(r.title)}
      <small>${esc(r.name)}@${esc(r.version)} ・ 作者 ${esc(personName(whoIs(r.author)))} ${r.status !== "listed" ? `・ <span class="badge">${esc(STATUSES[r.status])}</span>` : ""}${r.derivedFrom ? ` ・ 元：${esc(r.derivedFrom.name)}` : ""}</small></button></li>`).join("")
    : `<li>まだ何も公開されていません。「1 作る・確かめる」で公開してください。</li>`;
  renderEntry();
}

function renderEntry() {
  const box = $("entry");
  const sel = state.selected;
  const e = sel && registry.entry(sel.author, sel.name);
  if (!e) { box.innerHTML = `<p>一覧から選んでください。</p>`; return; }
  const versions = Object.keys(e.versions).sort(compare);
  const version = versions.includes(sel.version) ? sel.version : versions.at(-1);
  const env = e.versions[version];
  const m = env.manifest;
  const v = validateDefinition(m, { features: world.features, today: world.today });
  const isAuthor = e.author === pubs[state.actor];
  const steps = versions.slice(1).map((ver, i) => {
    const b = requiredBump(e.versions[versions[i]].manifest, e.versions[ver].manifest);
    return `<li>${esc(versions[i])} → ${esc(ver)}：${esc(b.bump)}（${esc(b.reasons.join("、"))}）</li>`;
  }).join("");
  box.innerHTML = `<h2>${esc(m.title)} <small>${esc(m.name)}@${esc(version)}</small></h2>
    <p>作者：${esc(PEOPLE[whoIs(e.author)] ?? whoIs(e.author))}・状態：<span class="badge">${esc(STATUSES[e.status])}</span>
    ${versions.length > 1 ? `・版：<select id="entry-version">${versions.map((x) => `<option ${x === version ? "selected" : ""}>${esc(x)}</option>`).join("")}</select>` : ""}</p>
    ${steps ? `<details><summary>版の変わり方（既存の利用者の扱い）</summary><ul>${steps}</ul></details>` : ""}
    <div class="row">
      <button class="primary" id="entry-use">この定義で使う準備をする（${esc(personName(state.actor))}として）</button>
      <button id="entry-fork">写して編集する（${esc(personName(state.actor))}の定義として）</button>
    </div>
    <div class="row">
      ${["suspended", "withdrawn", "listed"].filter((s) => s !== e.status).map((s) => `<button class="ghost" data-status="${s}">${esc(STATUSES[s])}にする${isAuthor ? "" : "（作者でない人が試す）"}</button>`).join("")}
    </div>
    <div id="entry-status"></div>
    ${v.findings.length ? `<h3>今の世界での確認</h3>${v.findings.map(findingHtml).join("")}` : ""}
    <h3>仕組みの紙</h3><div class="paper">${v.facts ? paperHtml(m, v.facts) : ""}</div>`;
  $("entry-version")?.addEventListener("change", (ev) => { state.selected = { ...sel, version: ev.target.value }; renderEntry(); });
  $("entry-use").addEventListener("click", () => { state.useTarget = { author: e.author, name: e.name, version }; state.lastPlan = state.lastCheck = state.supersedes = null; $("adopt-result").innerHTML = ""; showTab("use"); });
  $("entry-fork").addEventListener("click", () => {
    const f = forkManifest(env, pubs[state.actor], { name: `${m.name}-${state.actor.toLowerCase()}`.slice(0, 40), title: `${m.title}（${personName(state.actor)}の写し）`.slice(0, 60) });
    setDraft(f.manifest, { from: `${m.name}@${version}（${personName(whoIs(e.author))}）`, dropped: f.dropped, kept: f.kept, riverable: m.name === "front-supply" });
    showTab("make");
  });
  for (const b of box.querySelectorAll("[data-status]")) {
    b.addEventListener("click", async () => {
      const status = b.dataset.status;
      const ref = { author: e.author, name: e.name };
      const seq = registry.statusSeq(ref);
      const sig = await signStatus(ref, status, seq, myKey(`${e.name} を「${STATUSES[status]}」にする`));
      const r = await registry.setStatus(ref, status, seq, sig, world.today);
      save();
      $("entry-status").innerHTML = r.ok ? findingHtml({ severity: "ok", code: "STATUS", path: "", message: `${STATUSES[status]}にした` }) : r.findings.map(findingHtml).join("");
      if (r.ok) renderList();
    });
  }
}

// ------------------------------------------------------------------ use

const ctx = () => ({ registry, world, ledger, adoptions });

function currentEnv() {
  const t = state.useTarget;
  return t ? registry.getVersion(t) : null;
}

/** The current person's open batches (rights to consume delivered goods). */
function myBatches() {
  return Object.values(world.batches ?? {}).filter((b) => b.owner === state.actor && b.state === "open");
}

function batchOptions(dep, value) {
  return `<option value="">（未設定）</option>` + myBatches().map((b) => `<option value="${esc(b.id)}" ${b.id === value ? "selected" : ""}>${esc(b.id)}：${esc(fmt(b.remaining))} @ ${esc(b.vault)}（${esc(b.producer?.name ?? "")} の記録 ${esc(String(b.evidence).slice(0, 8))}…）</option>`).join("");
}

function renderUse() {
  $("use-who").textContent = `（${PEOPLE[state.actor]}として）`;
  renderAdopted();
  const env = currentEnv();
  $("helpers").innerHTML = `<span>定義の外の操作（模擬）：</span>
    <button type="button" data-help="lot">工房主Wから使用権の札3枚を得る（引き換え）</button>
    <button type="button" data-help="stock">自分の倉に鉱石60・木材30を足す</button>
    <button type="button" data-help="revoke">Wが使用権を取り消す</button>
    <button type="button" data-help="capture">Wの村が奪われる</button>
    <button type="button" data-help="day">次の日へ</button>`;
  if (!env) {
    $("use-target").innerHTML = `<p>「2 一覧から選ぶ」で定義を選び、「使う準備をする」を押してください。</p>`;
    $("bind").innerHTML = ""; $("preflight").innerHTML = ""; $("adopt").disabled = true;
    return;
  }
  const m = env.manifest;
  const entry = registry.entry(m.author, m.name);
  $("use-target").innerHTML = `<p><strong>${esc(m.title)}</strong> ${esc(m.name)}@${esc(m.version)}（作者 ${esc(personName(whoIs(m.author)))}${entry.status !== "listed" ? `・<span class="badge">${esc(STATUSES[entry.status])}：新しく採用できない</span>` : ""}）。準備に使う鍵は ${esc(personName(state.actor))} のものだけで、作者の秘密鍵は要りません。</p>`;
  const prev = state.lastPlan?.plan.bindings ?? {};
  const f = [];
  for (const [name, p] of Object.entries(m.params)) {
    const val = prev.params?.[name] ?? suggest(name, p);
    if (TYPES[p.type]?.place) f.push(`<label>${esc(p.ja ?? name)}${p.own ? "（自分のもの）" : ""}<select data-bind="params" data-name="${esc(name)}">${placeOptions(p.type, val, { empty: p.default ? `既定：${p.default}` : "（未設定）" })}</select></label>`);
    else f.push(`<label>${esc(p.ja ?? name)}（${esc(p.min ?? 0)}〜${esc(p.max ?? "")}）<input type="number" data-bind="params" data-name="${esc(name)}" value="${esc(val ?? "")}" placeholder="${esc(p.default ?? "")}"></label>`);
  }
  for (const [dep, u] of Object.entries(m.uses)) {
    if (u.relation === "connect") {
      const lots = Object.entries(world.lots);
      f.push(`<label>${esc(u.ja ?? dep)}に使う札（B）<select data-bind="grants" data-name="${esc(dep)}"><option value="">自分の札から自動で探す</option>${lots.map(([id, l]) => `<option value="${esc(id)}" ${prev.grants?.[dep] === id ? "selected" : ""}>${esc(id)}（持ち手 ${esc(personName(l.holder))}・${esc(world.issues[l.issue]?.ja ?? l.issue)}）</option>`).join("")}</select></label>`);
    } else {
      f.push(`<label>${esc(u.ja ?? dep)}（C：消費する束。計画には固定せず、確認と実行ごとに指定）<select data-bind="batches" data-name="${esc(dep)}">${batchOptions(dep)}</select></label>`);
    }
  }
  $("bind").innerHTML = f.join("");
  renderPreflight();
}

function suggest(name, p) {
  if (!TYPES[p.type]?.place) return p.default;
  // an author's default that is someone else's place is not preselected: left unset, the
  // preflight shows it (PARAM_DEFAULT_FOREIGN) instead of quietly sending there
  if (p.default && world.places[p.default]?.owner === state.actor) return p.default;
  if (!p.own) return undefined;
  const mine = ownPlaces(p.type);
  if (name === "workVault") return mine.find((id) => world.places[id].province.join() === "3,-1");
  return mine[0];
}

function readBindings(root = $("bind")) {
  const b = { params: {}, grants: {}, batches: {} };
  for (const el of root.querySelectorAll("[data-bind]")) {
    if (el.value === "") continue;
    b[el.dataset.bind][el.dataset.name] = el.type === "number" ? Number(el.value) : el.value;
  }
  return b;
}

async function prepareAndCheck() {
  const env = currentEnv();
  if (!env) return;
  const b = readBindings();
  state.lastPlan = await preparePlan(env, b, myKey(`${env.manifest.name}@${env.manifest.version} の計画を準備`), { world, supersedes: state.supersedes ?? undefined });
  state.lastInputs = { batches: b.batches };
  state.lastCheck = await preflight(state.lastPlan, ctx(), { inputs: Object.keys(b.batches).length ? state.lastInputs : undefined });
  save();
  renderPreflight();
}

function renderPreflight() {
  const c = state.lastCheck;
  $("adopt").disabled = !c?.ready || !!adoptions.get(state.lastPlan?.hash);
  if (!c) { $("preflight").innerHTML = `<p>まだ確かめていません。</p>`; return; }
  const by = (s) => c.findings.filter((f) => f.severity === s);
  const signers = (c.signers ?? []).map((s) => `<li>${esc(s.step)}：${s.signer === "wallet" ? `ウォレットの署名が要る（届け先 ${esc(s.to)} は ${esc(personName(s.owner))} のもの）` : "ゲーム内の鍵でよい（自分の場所あて）"}</li>`).join("");
  const costs = c.costs ? `<li>荷車の精算預け ${c.costs.feeLamports.toLocaleString("ja-JP")} lamports・取引 ${c.costs.tx} 件（［フェーズ6］の仮の値）</li><li>倉から出す物（手順ごとの合計）：${esc(fmt(c.costs.materials))}</li>` : "";
  $("preflight").innerHTML = `${findingHtml(c.ready ? { severity: "ok", code: "READY", path: "", message: "今の状態では問題なし。採用すると、この版と内容ハッシュに固定される。実行のたびに、実行時点の権利・残高・物をもう一度確かめる" } : { severity: "error", code: "NOT_READY", path: "", message: "足りないものがある" })}
    ${by("error").length ? `<h3>足りないもの</h3>${by("error").map(findingHtml).join("")}` : ""}
    ${by("warning").length ? `<h3>注意</h3>${by("warning").map(findingHtml).join("")}` : ""}
    ${by("info").length ? `<h3>知らせ</h3>${by("info").map(findingHtml).join("")}` : ""}
    ${signers ? `<h3>署名</h3><ul>${signers}</ul>` : ""}
    ${costs ? `<h3>費用</h3><ul>${costs}</ul>` : ""}
    ${c.grantsUsed && Object.keys(c.grantsUsed).length ? `<p>使う札：${esc(Object.values(c.grantsUsed).join("、"))}</p>` : ""}`;
}

async function adoptLast() {
  if (!state.lastPlan) return;
  const a = await adoptions.adopt(state.lastPlan, ctx());
  if (a.ok) { plans[state.lastPlan.hash] = state.lastPlan; state.supersedes = null; }
  $("adopt-result").innerHTML = a.ok ? findingHtml({ severity: "ok", code: "ADOPTED", path: "", message: `採用した：${state.lastPlan.plan.manifest.name}@${state.lastPlan.plan.manifest.version}（ハッシュ ${state.lastPlan.plan.manifest.hash.slice(0, 12)}…）に固定${a.adoption.supersedes ? "。前の計画は置き換わった" : ""}` }) : a.findings.filter((f) => f.severity === "error").map(findingHtml).join("");
  save();
  renderUse();
}

/** The current person's adopted plans: run (with a signed request), end, and update notices. */
function renderAdopted() {
  const mine = adoptions.activeOf(pubs[state.actor]).filter((a) => plans[a.planHash]);
  const notices = Object.fromEntries(updateNotices(adoptions, registry, pubs[state.actor]).map((n) => [n.planHash, n]));
  $("adopted").innerHTML = mine.length ? mine.map((a) => {
    const p = plans[a.planHash];
    const m = registry.getVersion(a.manifest)?.manifest;
    const entry = registry.entry(a.manifest.author, a.manifest.name);
    const consumes = Object.entries(m?.uses ?? {}).filter(([, u]) => u.relation === "consume");
    const n = notices[a.planHash];
    return `<div class="adopted" data-plan="${esc(a.planHash)}">
      <p><strong>${esc(a.manifest.name)}@${esc(a.manifest.version)}</strong> <small>ハッシュ ${esc(a.manifest.hash.slice(0, 12))}…・今日 ${esc(adoptions.runsOn(a.planHash, world.today))}/${esc(m?.limits.runsPerDay)} 回</small>
      ${entry.status !== "listed" ? `<span class="badge">${esc(STATUSES[entry.status])}（採用済みなので続けられる）</span>` : ""}</p>
      ${consumes.map(([dep, u]) => `<label>${esc(u.ja ?? dep)}（この実行で消費する束）<select data-bind="batches" data-name="${esc(dep)}">${batchOptions(dep)}</select></label>`).join("")}
      <div class="row"><button class="primary" data-act="run">自分の鍵で実行を依頼する（模擬）</button><button class="ghost" data-act="end">この計画を止める</button></div>
      ${n ? `<div class="finding info"><strong>更新の通知</strong> ${esc(n.from)} → ${esc(n.to)}（${esc(n.bump)}：${esc(n.reasons.join("、") || "説明だけ")}）。今の計画は確認済みの版のまま動く。${n.canAdopt ? `<button data-act="update">新しい版で準備し直して確認する</button>` : "（公開停止中なので、新しい版にも移れない）"}</div>` : ""}
    </div>`;
  }).join("") : "<p>まだ採用した計画はありません。</p>";
}

async function onAdopted(e) {
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const box = btn.closest("[data-plan]");
  const hash = box.dataset.plan;
  const p = plans[hash];
  if (btn.dataset.act === "run") {
    const { batches } = readBindings(box);
    nonce += 1;
    const request = await requestRun(p, { batches, nonce: `ui-${nonce}` }, myKey(`${p.plan.manifest.name} の実行を依頼（${Object.keys(batches).length ? `束 ${Object.values(batches).join("・")}` : "束なし"}）`));
    const r = await execute(p, ctx(), { request });
    state.runlog.unshift(`<li><span class="badge mock">模擬</span> ${esc(p.plan.manifest.name)}@${esc(p.plan.manifest.version)}：${r.ok ? "完了" : `止まった（${esc(r.failure.code)}${r.stoppedAt ? ` @ ${esc(r.stoppedAt)}` : ""}）`}<ul>${r.log.map((l) => `<li>${esc(l)}</li>`).join("")}${r.ok ? "" : `<li>${esc(r.failure.message)} <code>${esc(JSON.stringify(Object.fromEntries(Object.entries(r.failure).filter(([k]) => !["code", "severity", "stage", "path", "message"].includes(k)))))}</code></li>`}</ul></li>`);
    $("runlog").innerHTML = `<p>チェーンには何も送っていません。記録は模擬の台帳にだけ残ります。実行は、確認の結果ではなく、実行時点の権利・残高・物で決まります。</p><ol>${state.runlog.join("")}</ol>`;
  } else if (btn.dataset.act === "end") {
    await adoptions.end(hash, await signHash(myKey(`${p.plan.manifest.name} の計画を止める`), DOMAIN.end, hash));
  } else if (btn.dataset.act === "update") {
    const e2 = registry.entry(p.plan.manifest.author, p.plan.manifest.name);
    const latest = Object.keys(e2.versions).sort(compare).at(-1);
    state.useTarget = { author: e2.author, name: e2.name, version: latest };
    state.supersedes = hash;
    state.lastPlan = { ...p, plan: { ...p.plan, bindings: p.plan.bindings } }; // prefill the form with the old bindings
    state.lastCheck = null;
    renderUse();
    $("use-target").insertAdjacentHTML("beforeend", `<p class="dropped">更新の確認：前の計画（${esc(p.plan.manifest.version)}）は、新しい計画を採用したときに置き換わる。それまで前の計画はそのまま動く。</p>`);
    return;
  }
  save();
  renderUse();
}

function help(kind) {
  if (kind === "lot") {
    const n = Object.keys(world.lots).filter((k) => k.startsWith(`lot:${state.actor}-`)).length + 1;
    world = giveUseLot(world, { to: state.actor, lotId: `lot:${state.actor}-${n}` });
  } else if (kind === "stock") {
    const v = ownPlaces("vault")[0];
    if (v) { const st = world.places[v].stores ??= {}; st.ore = (st.ore ?? 0) + 60; st.wood = (st.wood ?? 0) + 30; }
  } else if (kind === "revoke") {
    world.issues["issue:W-1"].state = world.issues["issue:W-1"].state === "revoked" ? "live" : "revoked";
  } else if (kind === "capture") {
    world.places["village:W"].gen += 1;
  } else if (kind === "day") {
    world.today += 1;
  }
  save();
  renderUse();
}

// ------------------------------------------------------------------ world

function renderWorld() {
  $("places").innerHTML = `<p>今日：${world.today} 日目・規則：${esc(world.features.join(" + "))}（${esc(world.label)}）</p><div class="scroll"><table><tr><th>場所</th><th>持ち主</th><th>州</th><th>世代</th><th>中身</th></tr>${Object.entries(world.places).map(([id, p]) => `<tr><td><code>${esc(id)}</code><br><small>${esc(p.ja ?? "")}</small></td><td>${esc(personName(p.owner))}</td><td>${esc(p.province?.join(","))}</td><td>${esc(p.gen)}${p.live ? "" : "（閉）"}</td><td>${esc(p.kind === "vault" ? fmt(p.stores ?? {}) : `工房 ${p.workshops ?? 0}`)}${p.kind === "vault" && Object.values(p.held ?? {}).some(Boolean) ? `<br><small>うち束で押さえ：${esc(fmt(p.held))}</small>` : ""}</td></tr>`).join("")}</table></div>
    <p>所持金（lamports）：${Object.entries(world.citizens).map(([id, c]) => `${esc(personName(id))} ${esc((c.lamports ?? 0).toLocaleString("ja-JP"))}`).join("・")}</p>`;
  $("lots").innerHTML = `<div class="scroll"><table><tr><th>束</th><th>持ち手</th><th>発行</th><th>量</th></tr>${Object.entries(world.lots).map(([id, l]) => `<tr><td><code>${esc(id)}</code></td><td>${esc(personName(l.holder))}</td><td>${esc(world.issues[l.issue]?.ja ?? l.issue)}</td><td>${esc(l.amount)}</td></tr>`).join("")}</table></div>`;
  const rs = Object.entries(ledger.data.receipts);
  $("receipts").innerHTML = rs.length ? `<div class="scroll"><table><tr><th>id</th><th>作った定義</th><th>結果</th><th>場所・物</th><th>受け取り手</th></tr>${rs.map(([id, r]) => `<tr><td><code>${esc(id.slice(0, 10))}…</code> <span class="badge mock">模擬</span></td><td>${esc(r.manifest.name)}@${esc(r.manifest.version)}</td><td>${esc(r.outcome)}</td><td>${esc(r.at ?? "")} ${esc(fmt(r.goods ?? {}))}</td><td>${esc(personName(r.beneficiary))}</td></tr>`).join("")}</table></div>` : "<p>まだありません。</p>";
  const bs = Object.values(world.batches ?? {});
  $("batches").innerHTML = bs.length ? `<div class="scroll"><table><tr><th>束</th><th>持ち主</th><th>倉</th><th>残り</th><th>状態</th><th>証明（記録）</th></tr>${bs.map((b) => `<tr><td><code>${esc(b.id)}</code></td><td>${esc(personName(b.owner))}</td><td>${esc(b.vault)}</td><td>${esc(fmt(b.remaining))}</td><td>${esc(b.state)}${b.state === "open" && b.owner === state.actor ? ` <button data-release="${esc(b.id)}">普通の在庫に戻す</button>` : ""}</td><td><code>${esc(String(b.evidence).slice(0, 10))}…</code></td></tr>`).join("")}</table></div>` : "<p>まだありません。</p>";
  $("signlog").innerHTML = signlog.length ? signlog.map((s) => `<li><strong>${esc(personName(s.who))}</strong> の鍵：${esc(s.what)}</li>`).join("") : "<li>まだ署名していません。</li>";
}

// ------------------------------------------------------------------ shared rendering

function findingHtml(f) {
  const { code, severity, stage, path, message, ...rest } = f;
  void stage;
  const extra = Object.keys(rest).length ? ` <code>${esc(JSON.stringify(rest))}</code>` : "";
  return `<div class="finding ${esc(severity)}"><strong>${esc(code)}</strong> ${esc(message)}${extra}${path ? `<div class="path">${esc(path)}</div>` : ""}</div>`;
}

function paperHtml(m, facts) {
  const p = describe(m, facts);
  return p.lines.map((s) => `<h3>${esc(s.title)}</h3><ul>${s.items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>`).join("")
    + `<div class="note"><h3>作者の説明（作者が書いたもの。機械は確かめていない）</h3><p>${esc(p.authorNote ?? "なし")}</p></div>`;
}

function renderAll() {
  renderActors();
  checkDraft();
  renderList();
  renderUse();
  renderWorld();
}

// ------------------------------------------------------------------ start

for (const [id, seed] of Object.entries(DEMO_SEEDS)) { keys[id] = await keyFromSeed(seed); pubs[id] = keys[id].pub; }
load();
loadTemplate();
renderAll();

$("actors").addEventListener("click", (e) => {
  const id = e.target.closest("[data-actor]")?.dataset.actor;
  if (!id) return;
  state.actor = id;
  state.lastPlan = state.lastCheck = state.supersedes = null;
  renderAll();
});
$("tabs").addEventListener("click", (e) => { const t = e.target.closest("[data-tab]"); if (t) showTab(t.dataset.tab); });
$("load-template").addEventListener("click", loadTemplate);
$("quick").addEventListener("change", onQuick);
$("json").addEventListener("input", onJson);
$("claims-from-facts").addEventListener("click", claimsFromFacts);
$("publish").addEventListener("click", publishDraft);
$("query").addEventListener("input", renderList);
$("show-hidden").addEventListener("change", renderList);
$("entries").addEventListener("click", (e) => {
  const b = e.target.closest("[data-entry]");
  if (!b) return;
  const [author, name, version] = b.dataset.entry.split("|");
  state.selected = { author, name, version };
  renderEntry();
});
$("prepare").addEventListener("click", prepareAndCheck);
$("adopt").addEventListener("click", adoptLast);
$("adopted").addEventListener("click", onAdopted);
$("batches").addEventListener("click", (e) => {
  const id = e.target.closest("[data-release]")?.dataset.release;
  if (id && releaseBatch(world, id, state.actor)) { save(); renderWorld(); }
});
$("helpers").addEventListener("click", (e) => { const b = e.target.closest("[data-help]"); if (b) help(b.dataset.help); });
$("reset").addEventListener("click", resetAll);
