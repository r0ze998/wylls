// A spatial index of the keeps for the near-view hit test (map/keeps.mjs
// KeepBoard.at). Before it, every tap or hover scanned every keep row: at the
// legacy radius 128 that is 49,537 provinces per pointer event. The index puts
// each keep's anchor (the fortress foot, `KeepBoard.place(row).x/.y`, which does
// not depend on the zoom) into square buckets of world px, and a query returns
// only the rows whose anchor lies in a box round the pointer, in the rows' own
// order. The caller then runs the very same per-row hit test over those rows,
// so the answer (and which of two equally near keeps wins) is the full scan's.
//
// Pure: no canvas, no records of its own. It is rebuilt from the rows Map it
// is given whenever that Map is another one (KeepBook.read and reset replace
// it: a new reading, a removed province, a sample, another world) or its size
// changed; `clear()` forgets it explicitly. A Map changed in place with its
// size kept (a row replaced under its key, a row's tile changed) is not seen by
// those two checks; nothing in the page does that today (KeepBook only ever
// assigns a new Map), but each query checks its candidates against the Map and
// their anchors again and builds afresh when one disagrees. Two in-place
// changes cannot be seen that way, and whoever makes them must call `clear()`
// (KeepBoard.rowsChanged): a row moved into the box from far away, and a row
// deleted and set again under its key (the same row, the same size, but now
// last in the Map's order, which decides between two equally near keeps).

/** How many bucket cells a query may visit before a full scan is cheaper and is used instead. */
export const KEEP_INDEX_MAX_CELLS = 64;
/** World px added round a query box, so that rounding never leaves out a keep the exact test would take. */
export const KEEP_INDEX_SLACK = 1;

const OFF = 2 ** 20, SPAN = 2 ** 21;
const cellKey = (i, j) => (i + OFF) * SPAN + (j + OFF);

/**
 * The box (world px) that holds the anchor of every keep the hit test can take at pointer (wx, wy), for a fortress
 * unit `u` (world px) and a tilt `rise`; `radius` is the tile's corner radius and `flatten` the board's y squash.
 * The test takes a keep on its tile (`hypot(dx, dy / flatten) <= 0.9 radius`) or on its walls (`|dx| <= 0.95 u`,
 * `-0.5 u <= anchorY - wy <= 1.5 u rise`). Null when the numbers are not finite (the caller scans everything).
 */
export function keepHitBox(wx, wy, { u, rise = 1, radius, flatten }) {
  if (![wx, wy, u, rise, radius, flatten].every(Number.isFinite) || !(flatten > 0) || !(radius > 0)) return null;
  const tileX = radius * 0.9, tileY = radius * 0.9 * flatten, s = KEEP_INDEX_SLACK;
  const dx = Math.max(tileX, Math.abs(u) * 0.95) + s;
  return {
    x0: wx - dx, x1: wx + dx,
    y0: wy + Math.min(-tileY, -0.5 * u) - s,
    y1: wy + Math.max(tileY, 1.5 * u * rise) + s,
  };
}

export class KeepHitIndex {
  /** `cell`: the bucket's side (world px). `anchor(row)`: `{x, y}` of a keep row, or null for one with no place. */
  constructor({ cell, anchor, maxCells = KEEP_INDEX_MAX_CELLS } = {}) {
    if (!(cell > 0) || !Number.isFinite(cell)) throw new Error('KeepHitIndex: cell must be a positive number');
    if (typeof anchor !== 'function') throw new Error('KeepHitIndex: anchor must be a function');
    this.cell = cell; this.anchor = anchor; this.maxCells = maxCells;
    this.clear();
  }
  /** Forget everything: the next query builds again from the rows it is given. */
  clear() { this.src = null; this.n = -1; this.buckets = new Map(); this.entries = 0; this.builds = (this.builds ?? 0); this.last = null; }
  /** Bring the index up to the rows Map `rows` (rebuilt when it is another Map, or the same one with another size). */
  sync(rows) {
    if (rows === this.src && (rows?.size ?? 0) === this.n) return false;
    this.buckets = new Map(); this.entries = 0;
    this.src = rows ?? null; this.n = rows?.size ?? 0;
    let ord = 0;
    for (const [key, row] of rows?.entries?.() ?? []) {
      const at = this.anchor(row), o = ord++;
      if (!at || !Number.isFinite(at.x) || !Number.isFinite(at.y)) continue;
      const k = cellKey(Math.floor(at.x / this.cell), Math.floor(at.y / this.cell));
      let b = this.buckets.get(k);
      if (!b) this.buckets.set(k, (b = []));
      b.push({ ord: o, key, row, x: at.x, y: at.y });
      this.entries += 1;
    }
    this.builds += 1;
    return true;
  }
  /**
   * The rows of `rows` whose anchor lies in `box` (`keepHitBox`), in the rows' own order, each with its anchor:
   * `[{row, x, y}]`. Null when no box was given or it spans more cells than `maxCells`: the caller scans every row.
   * `this.last` keeps what the query did (`{cells, candidates}` or `{full: true}`), for tests.
   */
  query(rows, box) {
    this.sync(rows);
    if (!box) { this.last = { full: true }; return null; }
    const got = this.gather(box);
    if (got === null || this.fresh(rows, got)) return got;
    // (a candidate is no longer the Map's row under its key, or stands elsewhere now: the Map was changed in place)
    this.clear(); this.sync(rows);
    return this.gather(box);
  }
  /** Whether each candidate is still the Map's row under its key, at the anchor it was filed under. */
  fresh(rows, got) {
    for (const e of got) {
      if (rows.get(e.key) !== e.row) return false;
      const at = this.anchor(e.row);
      if (!at || at.x !== e.x || at.y !== e.y) return false;
    }
    return true;
  }
  gather(box) {
    const c = this.cell;
    const i0 = Math.floor(box.x0 / c), i1 = Math.floor(box.x1 / c), j0 = Math.floor(box.y0 / c), j1 = Math.floor(box.y1 / c);
    const cells = (i1 - i0 + 1) * (j1 - j0 + 1);
    if (!(cells > 0) || cells > this.maxCells || Math.abs(i0) >= OFF || Math.abs(i1) >= OFF || Math.abs(j0) >= OFF || Math.abs(j1) >= OFF) { this.last = { full: true }; return null; }
    const out = [];
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const b = this.buckets.get(cellKey(i, j));
      if (b) for (const e of b) if (e.x >= box.x0 && e.x <= box.x1 && e.y >= box.y0 && e.y <= box.y1) out.push(e);
    }
    out.sort((a, b) => a.ord - b.ord);
    this.last = { cells, candidates: out.length };
    return out;
  }
}
