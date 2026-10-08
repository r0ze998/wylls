// A small frame-time probe for the map (UX brief §9: 8 ms a frame at 390 px
// wide, 12 ms at 1440 px). It times every draw of the map canvas and says
// which kind of frame it was:
//
//   full   the whole scene was painted (the camera moved or the data changed)
//   live   only the animated layers were painted over the cached still layers
//   far    the province and world views (cached bitmaps)
//
// `?probe=1` shows the last second's numbers in a corner of the canvas;
// `?probe=2` also waits for the pixels (a one-pixel read after each draw), so
// the time includes the browser's own painting and not only this script's
// calls. Reading a pixel every frame slows the canvas: measuring only.
// From the console or a test: `(await import('./map/probe.mjs')).PROBE`.
const now = () => globalThis.performance?.now?.() ?? Date.now();
const KEEP = 600;

export const PROBE = {
  /** 0 off (still counts, shows nothing), 1 readout, 2 readout and pixel wait. */
  level: null,
  samples: [],
  _t: 0,
  mode() {
    if (this.level === null) { const m = /[?&]probe=(\d)/.exec(globalThis.location?.search ?? ''); this.level = m ? Number(m[1]) : 0; }
    return this.level;
  },
  begin() { this._t = now(); },
  /** The draw is over: `kind` 'full' | 'live' | 'far' | 'wait'. `ctx` lets level 2 wait for the pixels. */
  end(kind, ctx = null) {
    const js = now() - this._t;
    if (this.mode() >= 2 && ctx?.getImageData) { try { ctx.getImageData(0, 0, 1, 1); } catch { /* a tainted or lost canvas: the script time only */ } }
    const ms = now() - this._t;
    this.samples.push({ kind, js, ms, at: this._t });
    if (this.samples.length > KEEP) this.samples.splice(0, this.samples.length - KEEP);
    return ms;
  },
  reset() { this.samples.length = 0; },
  /** `{kind: {n, avg, p50, p95, max, js}}` over the kept samples (ms; `js` is the script's share). */
  stats() {
    const out = {};
    for (const kind of new Set(this.samples.map(s => s.kind))) {
      const list = this.samples.filter(s => s.kind === kind), a = list.map(s => s.ms).sort((x, y) => x - y);
      const q = p => a[Math.min(a.length - 1, Math.floor(a.length * p))];
      const r = x => Math.round(x * 100) / 100;
      out[kind] = { n: a.length, avg: r(a.reduce((x, y) => x + y, 0) / a.length), p50: r(q(0.5)), p95: r(q(0.95)), max: r(a[a.length - 1]), js: r(list.reduce((x, s) => x + s.js, 0) / list.length) };
    }
    return out;
  },
  /** The readout in the canvas corner (levels 1 and 2). `ctx` is in CSS px. */
  paint(ctx, size) {
    if (this.mode() < 1 || !ctx?.fillText) return;
    const t = now(), recent = this.samples.filter(s => t - s.at < 1000);
    if (!recent.length) return;
    const of = kind => { const l = recent.filter(s => s.kind === kind); return l.length ? `${kind} ${(l.reduce((x, s) => x + s.ms, 0) / l.length).toFixed(1)} ms x${l.length}` : null; };
    const text = ['full', 'live', 'far'].map(of).filter(Boolean).join('   ');
    ctx.save();
    ctx.font = '600 12px ui-monospace, Menlo, monospace'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    const w = ctx.measureText(text).width + 16;
    ctx.fillStyle = 'rgba(8,16,15,.82)'; ctx.fillRect(size.width / 2 - w / 2, size.height - 30, w, 22);
    ctx.fillStyle = '#f0d48a'; ctx.fillText(text, size.width / 2 - w / 2 + 8, size.height - 19);
    ctx.restore();
  },
};
