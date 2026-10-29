/**
 * Every finding the validator, the registry and the preflight can report.
 *
 * `stage` says who reports it:
 *   definition  — the manifest alone (and the catalog it is checked against)
 *   registry    — the manifest against the local list (dependencies, versions)
 *   preflight   — one user's prepared plan against the world snapshot
 *   receipt     — a claimed result against the run ledger
 * `severity` is the default; the validator never downgrades an error.
 */

export const CODES = Object.freeze({
  // --- definition ---
  SHAPE: { stage: "definition", severity: "error", ja: "定義の形が正しくない" },
  NUMBER_NOT_INTEGER: { stage: "definition", severity: "error", ja: "数は整数だけ（小数は使えない）" },
  TYPE_UNKNOWN: { stage: "definition", severity: "error", ja: "知らない型" },
  TYPE_MISMATCH: { stage: "definition", severity: "error", ja: "型が合わない" },
  REF_UNKNOWN: { stage: "definition", severity: "error", ja: "存在しない入力・依存・手順を参照している" },
  EFFECT_UNKNOWN: { stage: "definition", severity: "error", ja: "既存の命令にない効果（コア拡張が要る）" },
  EFFECT_UNAVAILABLE: { stage: "definition", severity: "error", ja: "この効果は対象の世界ではまだ使えない" },
  EFFECT_FORBIDDEN: { stage: "definition", severity: "error", ja: "設計で禁止された効果" },
  TRIGGER_UNAVAILABLE: { stage: "definition", severity: "warning", ja: "自動の合図は未実装（段階3）。今は手で実行するだけ" },
  STEP_CYCLE: { stage: "definition", severity: "error", ja: "手順の順番が循環している" },
  GRANT_KIND_MISMATCH: { stage: "definition", severity: "error", ja: "依存先の種類と必要な札の種類が合わない" },
  LIMIT_EXCEEDED: { stage: "definition", severity: "error", ja: "処理量が上限を超える" },
  FLOW_SHORT: { stage: "definition", severity: "warning", ja: "前の手順で届く量だけでは材料が足りない（倉の在庫に頼る）" },
  FLOW_PLACE_MISMATCH: { stage: "definition", severity: "error", ja: "前の手順の届け先と、次の手順が材料を取る場所が違う" },
  CLAIM_UNKNOWN: { stage: "definition", severity: "error", ja: "機械で確かめられない主張（作者の説明へ移す）" },
  CLAIM_MISMATCH: { stage: "definition", severity: "error", ja: "公開者の主張と機械条件が食い違う" },
  NOTE_PROMISE: { stage: "definition", severity: "warning", ja: "作者の説明に保証の言葉がある。定義は履行保証ではない" },
  MANIFEST_EXPIRED: { stage: "definition", severity: "error", ja: "定義の利用期限が過ぎている" },
  // --- publication ---
  SIGNATURE_MISSING: { stage: "registry", severity: "error", ja: "署名がない（写しは新しい作者が署名するまで公開できない）" },
  SIGNATURE_INVALID: { stage: "registry", severity: "error", ja: "署名が作者の鍵と合わない" },
  HASH_MISMATCH: { stage: "registry", severity: "error", ja: "内容と識別子（ハッシュ）が合わない" },
  VERSION_EXISTS: { stage: "registry", severity: "error", ja: "同じ版がもう公開されている（版は書き換えられない）" },
  VERSION_NOT_NEWER: { stage: "registry", severity: "error", ja: "新しい版の番号が前の版より大きくない" },
  VERSION_BUMP_TOO_SMALL: { stage: "registry", severity: "error", ja: "変更の大きさに対して版の上げ方が小さい" },
  NOT_AUTHOR: { stage: "registry", severity: "error", ja: "この定義の作者ではない" },
  DERIVED_FROM_UNKNOWN: { stage: "registry", severity: "warning", ja: "元にした定義が一覧で見つからない" },
  // --- dependencies (registry) ---
  DEPENDENCY_UNKNOWN: { stage: "registry", severity: "error", ja: "依存先の定義が一覧にない" },
  DEPENDENCY_WITHDRAWN: { stage: "registry", severity: "error", ja: "依存先の定義が取り下げられた" },
  DEPENDENCY_SUSPENDED: { stage: "registry", severity: "error", ja: "依存先の定義が停止されている" },
  DEPENDENCY_VERSION: { stage: "registry", severity: "error", ja: "依存先の版が指定と合わない" },
  DEPENDENCY_CYCLE: { stage: "registry", severity: "error", ja: "依存が循環している" },
  // --- preflight (one user, one world snapshot) ---
  ACTOR_UNKNOWN: { stage: "preflight", severity: "error", ja: "計画の署名者が世界の住人と結びついていない" },
  PLAN_SIGNATURE_INVALID: { stage: "preflight", severity: "error", ja: "計画の署名が利用者の鍵と合わない" },
  ENTRY_NOT_LISTED: { stage: "preflight", severity: "error", ja: "この定義は一覧に出ていない（停止・取り下げ）" },
  PARAM_UNBOUND: { stage: "preflight", severity: "error", ja: "入力が未設定" },
  PARAM_TYPE: { stage: "preflight", severity: "error", ja: "入力の値が型に合わない" },
  PARAM_DEFAULT_FOREIGN: { stage: "preflight", severity: "warning", ja: "入力が作者の既定のままで、他人の場所を指している" },
  PLACE_UNKNOWN: { stage: "preflight", severity: "error", ja: "その場所は世界にない" },
  NOT_OWNER: { stage: "preflight", severity: "error", ja: "自分の倉・村ではない" },
  PLACE_MISMATCH: { stage: "preflight", severity: "error", ja: "場所の条件に合わない" },
  MISSING_GRANT: { stage: "preflight", severity: "error", ja: "必要な札を持っていない" },
  GRANT_NOT_HELD: { stage: "preflight", severity: "error", ja: "指定した札の持ち手が自分ではない" },
  GRANT_WRONG: { stage: "preflight", severity: "error", ja: "指定した札の種類・発行元が依存先と合わない" },
  GRANT_EXPIRED: { stage: "preflight", severity: "error", ja: "札の利用期限が過ぎている" },
  GRANT_VOID: { stage: "preflight", severity: "error", ja: "札が無効（発行元が奪われた・建て直された・閉じた）" },
  GRANT_INSUFFICIENT: { stage: "preflight", severity: "error", ja: "札の残りが必要な回数・量に足りない" },
  DEPENDENCY_UNAVAILABLE: { stage: "preflight", severity: "error", ja: "接続先の施設が止まっている・なくなった" },
  CAPACITY: { stage: "preflight", severity: "error", ja: "倉の容量を超える" },
  STOCK_SHORT: { stage: "preflight", severity: "warning", ja: "今の在庫では足りない（実行時に止まりうる）" },
  WALLET_REQUIRED: { stage: "preflight", severity: "info", ja: "他人の場所あての送りがあり、ウォレットの署名が要る" },
  // --- receipts (④ Run/Receipt, mocked here) ---
  RECEIPT_INVALID: { stage: "receipt", severity: "error", ja: "完了結果が台帳で確かめられない" },
});

export function finding(code, path, detail = {}) {
  const def = CODES[code];
  if (!def) throw new Error(`unknown code ${code}`);
  return { code, severity: def.severity, stage: def.stage, path, message: def.ja, ...detail };
}

export function hasErrors(findings) {
  return findings.some((f) => f.severity === "error");
}
