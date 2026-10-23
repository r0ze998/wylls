// The comparison page: each direction paints the same scene in the same frame; its panel (the HUD and the decision)
// carries the same words in that direction's materials. Query: ?dir=A|B|C|all&frame=rest|select|result.
import * as A from './dirA.mjs';
import * as B from './dirB.mjs';
import * as C from './dirC.mjs';
import { FRAMES, still } from './common.mjs';
import { panelHtml, NOTES } from './panels.mjs';

const DIRS = { A, B, C };
const q = new URLSearchParams(location.search);
let dir = q.get('dir') ?? 'A', frame = q.get('frame') ?? 'rest';
const stages = document.getElementById('stages');

function build() {
  stages.innerHTML = '';
  stages.dataset.layout = dir === 'all' ? 'all' : 'one';
  const list = dir === 'all' ? ['A', 'B', 'C'] : [dir];
  for (const id of list) {
    const D = DIRS[id];
    const fig = document.createElement('figure');
    fig.className = `pv-stage pv-dir-${id}`;
    fig.innerHTML = `<div class="pv-board"><canvas></canvas><div class="pv-ui">${panelHtml(id, frame)}</div></div><figcaption><b>${id} ${D.META.title}</b> <span>${D.META.sub}</span><br>${D.META.idea}</figcaption>`;
    stages.append(fig);
    const cv = fig.querySelector('canvas');
    const draw = (t = 0) => {
      const r = cv.getBoundingClientRect(), dpr = Math.min(2, devicePixelRatio || 1);
      if (!r.width) return;
      cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr);
      const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
      const t0 = performance.now();
      D.paint(g, r.width, r.height, { frame: FRAMES[frame], state: ['rest', 'select', 'result'].includes(frame) ? frame : 'rest', t, redraw: () => queue() });
      fig.dataset.ms = (performance.now() - t0).toFixed(1);
    };
    let pending = false;
    const queue = () => { if (pending) return; pending = true; requestAnimationFrame(t => { pending = false; draw(t); }); };
    fig._draw = queue;
    queue();
    if (!still() && D.animated) { const loop = t => { if (!fig.isConnected) return; draw(t); requestAnimationFrame(loop); }; requestAnimationFrame(loop); }
  }
  document.getElementById('notes').innerHTML = NOTES;
  for (const b of document.querySelectorAll('[data-dir]')) b.setAttribute('aria-pressed', String(b.dataset.dir === dir));
  for (const b of document.querySelectorAll('[data-frame]')) b.setAttribute('aria-pressed', String(b.dataset.frame === frame));
  history.replaceState(null, '', `?dir=${dir}&frame=${frame}`);
}
document.addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.dir) { dir = b.dataset.dir; build(); }
  if (b.dataset.frame) { frame = b.dataset.frame; build(); }
});
addEventListener('resize', () => { for (const f of stages.children) f._draw?.(); });
build();
