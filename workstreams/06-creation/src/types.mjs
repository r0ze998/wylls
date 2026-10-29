/**
 * The port types a manifest's inputs, dependencies and step outputs carry.
 *
 * Places mirror S1's places (a vault, a village holding); a workshop is a
 * village holding with workshop copies. Grants are the S2 lots a user
 * holds (②'s Grant once it exists). Results are finalized records of a
 * run (④'s Receipt once it exists).
 */

export const RESOURCES = Object.freeze(["food", "wood", "stone", "ore", "arms", "gold", "science", "influence"]);

export const TYPES = Object.freeze({
  int: { ja: "数" },
  vault: { ja: "倉", place: true },
  village: { ja: "村", place: true },
  workshop: { ja: "工房のある村", place: true },
  place: { ja: "倉か村", place: true },
  goods: { ja: "物の組（資源ごとの量）" },
  "grant:use": { ja: "使用権の札" },
  "grant:share": { ja: "持ち分の札" },
  "grant:receipt": { ja: "受け取りの札" },
  "result:delivery": { ja: "確定した配達（荷車が着いた記録）" },
  "result:run": { ja: "確定した生産（工房を動かした記録）" },
});

const PARENT = Object.freeze({ workshop: "village", village: "place", vault: "place" });

export function isType(t) {
  return Object.hasOwn(TYPES, t);
}

/** Whether a value of type `actual` may stand where `expected` is asked. */
export function assignable(actual, expected) {
  for (let t = actual; t; t = PARENT[t]) if (t === expected) return true;
  return false;
}

/** The world kinds a place type accepts. */
export function placeKindsOf(type) {
  switch (type) {
    case "vault": return ["vault"];
    case "village": return ["village"];
    case "workshop": return ["village"];
    case "place": return ["vault", "village"];
    default: return [];
  }
}

/** The grant kind a connect dependency's target type can issue. */
export const GRANT_SOURCE = Object.freeze({ use: "workshop", share: "vault", receipt: "vault" });
