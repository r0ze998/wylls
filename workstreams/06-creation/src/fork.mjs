/**
 * A: copying a published definition to edit it as one's own.
 *
 * A copy takes the definition only — params, dependencies, steps, limits,
 * outputs. It cannot take what the definition never held: grants (lots
 * are held by people, not by manifests), resources (stores are in vaults),
 * signatures (the copy is a new author's draft) or the run record. It also
 * drops what belonged to the original author's situation or voice: place
 * defaults that point at the original's places, the claims and the note.
 * `dropped` lists each of these so the paper can show it.
 */

import { clone } from "./canonical.mjs";
import { TYPES } from "./types.mjs";

export function forkManifest(env, newAuthorPub, { name, title } = {}) {
  const src = env.manifest;
  const m = clone(src);
  const dropped = [
    { what: "signature", ja: "元の作者の署名（写しは新しい作者が署名するまで公開できない）" },
    { what: "grants", ja: "札（使用権・持ち分・受け取り）は持ち手のもので、定義には入っていない。写しても持ち手は変わらない" },
    { what: "resources", ja: "倉の中身は倉のもので、定義には入っていない" },
    { what: "record", ja: "実行の記録・実績は元の定義のもの。写しは記録なしから始まる" },
  ];
  for (const [pname, p] of Object.entries(m.params)) {
    if (TYPES[p.type]?.place && p.default != null) {
      dropped.push({ what: `params.${pname}.default`, value: p.default, ja: `入力「${p.ja ?? pname}」の既定の場所（元の作者の場所）` });
      delete p.default;
    }
  }
  if (m.claims) { dropped.push({ what: "claims", value: m.claims, ja: "元の作者の主張（新しい作者が自分で述べ直す）" }); delete m.claims; }
  if (m.note) { dropped.push({ what: "note", value: m.note, ja: "元の作者の説明" }); delete m.note; }
  const literal = findPlaceLiterals(m);
  m.author = newAuthorPub;
  m.name = name ?? `${src.name}-copy`.slice(0, 40);
  m.title = title ?? `${src.title}（写し）`.slice(0, 60);
  m.version = "0.1.0";
  m.derivedFrom = { author: src.author, name: src.name, version: src.version, hash: env.hash };
  return { manifest: m, dropped, kept: literal.length ? [{ what: "place literals", paths: literal, ja: "手順に直接書かれた場所は残る。自分の場所でなければ実行前の確認で止まる" }] : [] };
}

function findPlaceLiterals(v, path = "$", out = []) {
  if (Array.isArray(v)) v.forEach((x, i) => findPlaceLiterals(x, `${path}[${i}]`, out));
  else if (v && typeof v === "object") {
    if (typeof v.place === "string") out.push({ path, place: v.place });
    for (const [k, x] of Object.entries(v)) findPlaceLiterals(x, `${path}.${k}`, out);
  }
  return out;
}
