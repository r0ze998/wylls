// The demo overlay (recorder-only; never shipped with the page): a caption
// card for each step of the play flow, a "waiting for the bell" line, a
// visible pointer that glides to each control before it is pressed, and a
// highlight ring on the control. `installOverlay` is passed to Playwright's
// `context.addInitScript`, so it runs in the page before the game's own
// scripts on every load; it touches nothing of the game (a closed shadow
// root on its own host element, pointer-events: none, aria-hidden). The
// recorder's context sets `bypassCSP` because the herald's CSP allows no
// inline style (frontier.css is the page's only stylesheet).
//
// In the page: window.__demo.caption({ n, total, kicker, title, body }),
// .wait(text | null), .pointTo(x, y), .ring(rect), .tap(x, y), .card(title,
// sub) (a full-screen title card) and .hideCard().

/** Runs in the page (serialised by Playwright: no closure over module scope). */
export function installOverlay() {
  if (window.__demo) return;
  const CSS = `
    :host { all: initial; }
    .root { position: fixed; inset: 0; pointer-events: none; z-index: 2147483000; font-family: "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans JP", system-ui, sans-serif; }
    .cap { position: absolute; left: 50%; bottom: 36px; transform: translate(-50%, 16px); width: min(980px, calc(100vw - 720px)); min-width: 620px;
      background: rgba(22, 38, 34, 0.93); color: #f4efe2; border-radius: 16px; padding: 20px 28px 22px; box-shadow: 0 12px 40px rgba(0,0,0,0.35);
      border: 1px solid rgba(244, 239, 226, 0.18); opacity: 0; transition: opacity 420ms ease, transform 420ms ease; }
    .cap.on { opacity: 1; transform: translate(-50%, 0); }
    .kick { display: flex; align-items: center; gap: 12px; font-size: 15px; letter-spacing: 0.08em; color: #d9c48f; text-transform: uppercase; }
    .num { background: #d9c48f; color: #1d302b; border-radius: 999px; padding: 2px 12px; font-weight: 700; letter-spacing: 0.02em; }
    .dots { display: flex; gap: 6px; margin-left: auto; }
    .dot { width: 10px; height: 10px; border-radius: 50%; background: rgba(244,239,226,0.25); }
    .dot.done { background: #d9c48f; }
    .dot.cur { background: #f4efe2; box-shadow: 0 0 0 3px rgba(217,196,143,0.55); }
    .title { font-size: 34px; font-weight: 700; margin: 8px 0 6px; line-height: 1.25; }
    .body { font-size: 21px; line-height: 1.55; color: #e7e1d1; }
    .wait { margin-top: 12px; font-size: 18px; color: #bfe0d2; display: none; align-items: center; gap: 10px; }
    .wait.on { display: flex; }
    .spin { width: 16px; height: 16px; border-radius: 50%; border: 3px solid rgba(191,224,210,0.3); border-top-color: #bfe0d2; animation: spin 900ms linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .ptr { position: absolute; left: 0; top: 0; width: 30px; height: 30px; transform: translate(-100px, -100px); transition: transform 650ms cubic-bezier(.3,.7,.2,1); filter: drop-shadow(0 2px 3px rgba(0,0,0,0.45)); }
    .ring { position: absolute; border: 4px solid #e8b04a; border-radius: 12px; box-shadow: 0 0 0 6px rgba(232,176,74,0.25); opacity: 0; transition: opacity 260ms ease; }
    .ring.on { opacity: 1; }
    .tap { position: absolute; width: 20px; height: 20px; margin: -10px 0 0 -10px; border-radius: 50%; border: 3px solid #e8b04a; animation: tap 600ms ease-out forwards; }
    @keyframes tap { from { transform: scale(0.4); opacity: 1; } to { transform: scale(3); opacity: 0; } }
    .card { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 18px;
      background: radial-gradient(ellipse at center, rgba(22,38,34,0.86), rgba(12,22,20,0.96)); color: #f4efe2; opacity: 0; transition: opacity 700ms ease; text-align: center; }
    .card.on { opacity: 1; }
    .card h1 { margin: 0; font-size: 64px; letter-spacing: 0.04em; }
    .card p { margin: 0; font-size: 26px; color: #d9c48f; max-width: 1200px; line-height: 1.5; }
    .card small { font-size: 18px; color: #bfd3cb; }
  `;
  const mount = () => {
    const host = document.createElement('div');
    host.setAttribute('aria-hidden', 'true');
    host.id = 'demo-overlay-host';
    const sh = host.attachShadow({ mode: 'closed' });
    sh.innerHTML = `<style>${CSS}</style><div class="root">
      <div class="card"><h1></h1><p></p><small></small></div>
      <div class="cap"><div class="kick"><span class="num"></span><span class="kicker"></span><span class="dots"></span></div>
        <div class="title"></div><div class="body"></div><div class="wait"><span class="spin"></span><span class="wtext"></span></div></div>
      <div class="ring"></div>
      <svg class="ptr" viewBox="0 0 24 24"><path d="M3 2 L3 19 L7.5 15 L10.5 22 L13.5 20.8 L10.6 14 L17 14 Z" fill="#fff" stroke="#1d302b" stroke-width="1.6" stroke-linejoin="round"/></svg>
    </div>`;
    document.documentElement.append(host);
    const $ = s => sh.querySelector(s);
    const root = $('.root');
    let ringTimer = 0;
    window.__demo = {
      caption({ n, total, kicker, title, body }) {
        const cap = $('.cap');
        $('.num').textContent = total ? `${n} / ${total}` : '';
        $('.num').style.display = total ? '' : 'none';
        $('.kicker').textContent = kicker ?? '';
        $('.dots').innerHTML = total ? Array.from({ length: total }, (_, i) => `<span class="dot ${i + 1 < n ? 'done' : i + 1 === n ? 'cur' : ''}"></span>`).join('') : '';
        $('.title').textContent = title ?? '';
        $('.body').textContent = body ?? '';
        this.wait(null);
        cap.classList.remove('on');
        void cap.offsetWidth;
        cap.classList.add('on');
      },
      hideCaption() { $('.cap').classList.remove('on'); },
      wait(text) {
        const w = $('.wait');
        if (!text) { w.classList.remove('on'); return; }
        $('.wtext').textContent = text;
        w.classList.add('on');
      },
      pointTo(x, y) { $('.ptr').style.transform = `translate(${x - 4}px, ${y - 2}px)`; },
      ring(r) {
        const g = $('.ring');
        clearTimeout(ringTimer);
        if (!r) { g.classList.remove('on'); return; }
        Object.assign(g.style, { left: `${r.x - 8}px`, top: `${r.y - 8}px`, width: `${r.width + 8}px`, height: `${r.height + 8}px` });
        g.classList.add('on');
        ringTimer = setTimeout(() => g.classList.remove('on'), r.hold ?? 1400);
      },
      tap(x, y) {
        const t = document.createElement('div');
        t.className = 'tap';
        Object.assign(t.style, { left: `${x}px`, top: `${y}px` });
        root.append(t);
        setTimeout(() => t.remove(), 700);
      },
      card(title, sub, small) {
        $('.card h1').textContent = title ?? '';
        $('.card p').textContent = sub ?? '';
        $('.card small').textContent = small ?? '';
        $('.card').classList.add('on');
      },
      hideCard() { $('.card').classList.remove('on'); },
    };
  };
  if (document.documentElement) mount(); else document.addEventListener('DOMContentLoaded', mount, { once: true });
}
