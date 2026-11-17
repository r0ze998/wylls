/**
 * The creation manifest: a typed definition that composes existing
 * effects. See docs/02-manifest-format.ja.md for the format in prose.
 *
 * This module holds the shape (what fields exist, of which JSON kind) and
 * the expression forms. Meaning — types, places, rights, limits, claims —
 * is checked in validate.mjs.
 */

export const FORMAT = "wylls.creation.manifest/0";
export const NAME_RE = /^[a-z0-9][a-z0-9-]{2,39}$/;
export const PLACE_ID_RE = /^(vault|village):[A-Za-z0-9_-]{1,40}$/;

export const RELATIONS = Object.freeze({
  connect: "B：他人が動かしている施設・倉へ接続する（札が要る）",
  consume: "C：別の定義の実行で確定した成果を使う（完了記録が要る）",
});

export const CLAIM_KEYS = Object.freeze(["trigger", "runsPerDay", "outputsPerRun", "grants", "signer", "deliversTo", "consumes"]);

const TOP = {
  format: "string", name: "string", version: "string", author: "string", title: "string",
  note: "string?", validUntilDay: "int?", derivedFrom: "object?", params: "object", uses: "object",
  steps: "array", trigger: "string?", limits: "object", outputs: "object", claims: "object?",
};

function kindOf(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "int" : "number";
  return typeof v;
}

/** Shape findings as [code, path, detail] triples; the validator wraps them. */
export function shapeIssues(m) {
  const out = [];
  if (kindOf(m) !== "object") return [["SHAPE", "$", { detail: "manifest must be an object" }]];
  walkNumbers(m, "$", out);
  for (const [key, want] of Object.entries(TOP)) {
    const optional = want.endsWith("?");
    const kind = want.replace("?", "");
    const v = m[key];
    if (v === undefined || (optional && v === null)) {
      if (!optional) out.push(["SHAPE", `$.${key}`, { detail: "missing" }]);
      continue;
    }
    if (kindOf(v) !== kind) out.push(["SHAPE", `$.${key}`, { detail: `expected ${kind}` }]);
  }
  for (const key of Object.keys(m)) if (!Object.hasOwn(TOP, key)) out.push(["SHAPE", `$.${key}`, { detail: "unknown field" }]);
  if (m.format !== FORMAT) out.push(["SHAPE", "$.format", { detail: `expected ${FORMAT}` }]);
  if (typeof m.name === "string" && !NAME_RE.test(m.name)) out.push(["SHAPE", "$.name", { detail: "lowercase letters, digits and '-', 3–40" }]);
  if (typeof m.title === "string" && (m.title.length < 1 || m.title.length > 60)) out.push(["SHAPE", "$.title", { detail: "1–60 characters" }]);
  if (typeof m.note === "string" && m.note.length > 1000) out.push(["SHAPE", "$.note", { detail: "at most 1000 characters" }]);
  for (const section of ["params", "uses", "outputs"]) {
    if (kindOf(m[section]) !== "object") continue;
    for (const [k, v] of Object.entries(m[section])) if (kindOf(v) !== "object") out.push(["SHAPE", `$.${section}.${k}`, { detail: "expected object" }]);
  }
  if (kindOf(m.outputs) === "object") {
    for (const [k, v] of Object.entries(m.outputs)) if (kindOf(v) === "object" && kindOf(v.from) !== "object") out.push(["SHAPE", `$.outputs.${k}.from`, { detail: "{ step, out }" }]);
  }
  if (kindOf(m.uses) === "object") {
    for (const [k, v] of Object.entries(m.uses)) {
      if (kindOf(v) === "object" && v.relation === "connect" && !(kindOf(v.target) === "object" && ("param" in v.target || "place" in v.target))) {
        out.push(["SHAPE", `$.uses.${k}.target`, { detail: "a connect target is { param } or { place, type }" }]);
      }
    }
  }
  if (Array.isArray(m.steps)) {
    m.steps.forEach((s, i) => {
      if (kindOf(s) !== "object" || typeof s.id !== "string" || typeof s.effect !== "string" || kindOf(s.args) !== "object") {
        out.push(["SHAPE", `$.steps[${i}]`, { detail: "a step is { id, effect, args, after? }" }]);
      } else if (s.after !== undefined && !Array.isArray(s.after)) {
        out.push(["SHAPE", `$.steps[${i}].after`, { detail: "expected array" }]);
      } else {
        (s.after ?? []).forEach((a, j) => {
          if (!(typeof a === "string" || (kindOf(a) === "object" && typeof a.use === "string"))) out.push(["SHAPE", `$.steps[${i}].after[${j}]`, { detail: "a step id or { use }" }]);
        });
      }
    });
  }
  return out;
}

function walkNumbers(v, path, out) {
  if (typeof v === "number" && !Number.isSafeInteger(v)) out.push(["NUMBER_NOT_INTEGER", path, {}]);
  else if (Array.isArray(v)) v.forEach((x, i) => walkNumbers(x, `${path}[${i}]`, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walkNumbers(x, `${path}.${k}`, out);
}

/** A manifest's reference as the registry names it. */
export function refOf(m) {
  return { author: m.author, name: m.name, version: m.version };
}

export function keyOf(ref) {
  return `${ref.author}/${ref.name}`;
}

export function shortKey(ref) {
  return `${String(ref.author).slice(0, 8)}…/${ref.name}`;
}

/** The step ids and consume-dependency ids an `after` list names. */
export function afterRefs(step) {
  return (step.after ?? []).map((a) => (typeof a === "string" ? { step: a } : a));
}

/** The steps in an order that respects `after` (listed order otherwise). */
export function stepOrder(m) {
  const done = new Set();
  const order = [];
  const byId = new Map(m.steps.map((s) => [s.id, s]));
  const visit = (s, depth = 0) => {
    if (done.has(s.id) || depth > m.steps.length) return;
    for (const r of afterRefs(s)) if (r.step && byId.has(r.step)) visit(byId.get(r.step), depth + 1);
    done.add(s.id);
    order.push(s);
  };
  m.steps.forEach((s) => visit(s));
  return order;
}
