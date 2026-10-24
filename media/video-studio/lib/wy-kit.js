/* Wylls video studio: shared pieces every video uses the same way.
 *
 *   const end = WYKit.endCard(stage, { lang: 'ja', line: '意志を持つAIと、ひとつの地図を。' });
 *   end.render(t - 40);                      // local time since the end card starts (<0 hides it)
 *
 *   const subs = WYKit.subtitles(stage, [[1.0, 4.2, '国をひとつ選ぶ。'], ...], { y: 930 });
 *   subs.render(t);
 *
 *   const badge = WYKit.status(stage, 'local', 'ja', { x: 60, y: 60 });   // local | devnet | code | design | planned | sim
 *   badge.render(t, 2, 9);                   // visible between 2 s and 9 s
 *
 *   const dust = WYKit.dust(stage, { count: 70, color: '255,230,180' }); dust.render(t);
 */
(function () {
  'use strict';
  const STATUS = {
    local: { ja: 'ローカルテストチェーンで実行', en: 'Ran on a local test chain', bg: '#2e5b6e', fg: '#e3f6ff' },
    devnet: { ja: 'Solana devnetで実行(旧プロトタイプ)', en: 'Ran on Solana devnet (earlier prototype)', bg: '#2f6b4a', fg: '#e9ffe9' },
    code: { ja: 'コード実装済み・未プレイ', en: 'Built in code, not yet playable', bg: '#5b5a2a', fg: '#fff8d8' },
    design: { ja: '設計のみ', en: 'Design only', bg: '#6b5a2a', fg: '#fff3cf' },
    planned: { ja: '計画', en: 'Planned', bg: '#5a3a6b', fg: '#f5e3ff' },
    sim: { ja: 'シミュレーター出力', en: 'Simulator output', bg: '#4a4a4a', fg: '#f0f0f0' },
    test: { ja: 'テスト用USDC(価値なし)', en: 'Test USDC (no value)', bg: '#3a4a5a', fg: '#e8f0ff' },
  };

  function status(stage, kind, lang = 'ja', { x = 60, y = 60, size = 22, text } = {}) {
    const s = STATUS[kind] || STATUS.local;
    const n = WY.el('div', { class: 'wy-abs' }, stage);
    n.innerHTML = `<span style="display:inline-flex;align-items:center;gap:10px;padding:8px 16px 8px 12px;border-radius:999px;background:${s.bg};color:${s.fg};font:600 ${size}px/1 ${lang === 'ja' ? 'var(--sans-jp)' : 'var(--sans)'};letter-spacing:.02em;box-shadow:0 6px 20px rgba(0,0,0,.35);border:1px solid rgba(255,255,255,.18)"><span style="width:${size * 0.5}px;height:${size * 0.5}px;border-radius:50%;background:${s.fg};opacity:.85"></span>${text || s[lang]}</span>`;
    WY.css(n, { left: x + 'px', top: y + 'px', opacity: 0 });
    return { node: n, render(t, a = 0, b = 1e9) { const k = WY.env(t, a, b, 0.35, 0.35); n.style.opacity = k; n.style.transform = `translateY(${(1 - k) * -10}px)`; } };
  }

  function subtitles(stage, lines, { y = 940, size = 42, lang = 'ja', width = 1600, align = 'center', box = false } = {}) {
    const W = WY.W;
    const nodes = lines.map(([a, b, text]) => {
      const n = WY.el('div', { class: 'wy-abs' }, stage);
      WY.css(n, { left: (W - width) / 2 + 'px', top: y + 'px', width: width + 'px', textAlign: align, font: `${lang === 'ja' ? 700 : 600} ${size}px/1.45 ${lang === 'ja' ? 'var(--sans-jp)' : 'var(--sans)'}`, color: '#fff', textShadow: '0 2px 14px rgba(0,0,0,.85), 0 0 3px rgba(0,0,0,.9)', opacity: 0, letterSpacing: '.02em' });
      n.innerHTML = box ? `<span style="background:rgba(8,16,13,.72);padding:.15em .6em;border-radius:10px;box-decoration-break:clone;-webkit-box-decoration-break:clone">${text}</span>` : text;
      return { n, a, b };
    });
    return { render(t) { for (const { n, a, b } of nodes) { const k = WY.env(t, a, b, 0.25, 0.25); n.style.opacity = k; n.style.transform = `translateY(${(1 - k) * 14}px)`; } } };
  }

  /** The standard end card: logo, a line, the repo, the status line. */
  function endCard(stage, { lang = 'ja', line = '', sub = null, url = 'github.com/r0ze998/wylls', note = null, bg = true } = {}) {
    const W = WY.W, H = WY.H, portrait = H > W;
    const root = WY.el('div', { class: 'wy-fill' }, stage);
    root.style.opacity = 0; root.style.zIndex = 40;
    if (bg) root.style.background = 'radial-gradient(ellipse at 50% 45%, #1d3d31 0%, #0b1512 70%)';
    const box = WY.el('div', { class: 'wy-center' }, root);
    const logo = WY.el('div', { html: WY.logo(portrait ? 120 : 132) }, box);
    const l = WY.el('div', { text: line }, box);
    WY.css(l, { font: `${lang === 'ja' ? 700 : 600} ${portrait ? 54 : 50}px/1.35 ${lang === 'ja' ? 'var(--serif-jp)' : 'var(--serif)'}`, marginTop: '46px', maxWidth: (portrait ? 900 : 1500) + 'px', color: '#fffaf0' });
    const s = WY.el('div', { html: sub || (lang === 'ja' ? 'AIと人が、ひとつの地図を奪い合う戦略ゲーム' : 'A strategy game where people and AI citizens fight for one map') }, box);
    WY.css(s, { font: `500 ${portrait ? 30 : 28}px/1.4 ${lang === 'ja' ? 'var(--sans-jp)' : 'var(--sans)'}`, marginTop: '18px', color: 'rgba(255,250,240,.72)' });
    const u = WY.el('div', { html: `<span style="opacity:.6">▸</span> ${url}` }, box);
    WY.css(u, { font: `600 ${portrait ? 30 : 28}px var(--mono)`, marginTop: '44px', color: '#f0d48a', padding: '12px 26px', border: '1.5px solid rgba(240,212,138,.45)', borderRadius: '12px', background: 'rgba(0,0,0,.25)' });
    const crests = WY.el('div', { html: [0, 1, 2, 3, 4, 5].map(f => WY.crest(f, portrait ? 64 : 58)).join('') }, box);
    WY.css(crests, { marginTop: '46px', display: 'flex', gap: '14px' });
    const n = WY.el('div', { text: note || (lang === 'ja' ? '現在はローカルテストチェーンとテスト用USDCでの開発段階です。' : 'Currently in development on local test chains with valueless test USDC.') }, root);
    WY.css(n, { position: 'absolute', left: 0, right: 0, bottom: portrait ? '120px' : '46px', textAlign: 'center', font: `500 ${portrait ? 24 : 20}px ${lang === 'ja' ? 'var(--sans-jp)' : 'var(--sans)'}`, color: 'rgba(255,250,240,.5)' });
    const parts = [logo, l, s, u, crests];
    const crestEls = [...crests.querySelectorAll('svg')];
    return {
      node: root,
      render(k) {
        if (k < 0) { root.style.opacity = 0; return; }
        root.style.opacity = WY.seg(k, 0, 0.5);
        parts.forEach((p, i) => { const e = WY.seg(k, 0.15 + i * 0.12, 0.85 + i * 0.12, WY.ease.outCubic); p.style.opacity = e; p.style.transform = `translateY(${(1 - e) * 26}px)`; p.style.filter = e < 0.99 ? `blur(${(1 - e) * 8}px)` : 'none'; });
        crestEls.forEach((c, i) => { const e = WY.seg(k, 0.8 + i * 0.07, 1.3 + i * 0.07, WY.ease.outBack); c.style.transform = `scale(${e})`; });
        n.style.opacity = WY.seg(k, 1.2, 1.8) * 1;
        logo.style.transform += ` scale(${1 + 0.02 * Math.sin(k * 1.4)})`;
      },
    };
  }

  /** drifting dust motes / embers on a canvas over the stage */
  function dust(stage, { count = 60, color = '255,236,200', size = [1, 3.2], speed = 18, z = 30, seed = 3 } = {}) {
    const c = WY.canvas(stage, WY.W, WY.H); c.style.zIndex = z; c.style.pointerEvents = 'none';
    const g = c.getContext('2d'); const r = WY.rng(seed);
    const P = [...Array(count)].map(() => ({ x: r() * WY.W, y: r() * WY.H, s: size[0] + r() * (size[1] - size[0]), v: 0.4 + r(), ph: r() * 10, a: 0.25 + r() * 0.6 }));
    return {
      canvas: c,
      render(t, alpha = 1) {
        g.clearRect(0, 0, WY.W, WY.H); if (alpha <= 0) return;
        for (const p of P) {
          const x = (p.x + Math.sin(t * 0.3 + p.ph) * 40 + t * speed * 0.3 * p.v) % (WY.W + 40) - 20;
          const y = ((p.y - t * speed * p.v) % (WY.H + 40) + WY.H + 40) % (WY.H + 40) - 20;
          const tw = 0.6 + 0.4 * Math.sin(t * 2 + p.ph * 3);
          g.fillStyle = `rgba(${color},${p.a * tw * alpha})`; g.beginPath(); g.arc(x, y, p.s, 0, Math.PI * 2); g.fill();
        }
      },
    };
  }

  /** full-frame flash (white or colour) for cuts */
  function flash(stage, { color = '#fff', z = 60 } = {}) {
    const n = WY.el('div', { class: 'wy-fill' }, stage); WY.css(n, { background: color, opacity: 0, zIndex: z, pointerEvents: 'none' });
    return { render(t, at, dur = 0.5, peak = 0.85) { const k = t < at ? 0 : Math.max(0, 1 - (t - at) / dur); n.style.opacity = k * peak; } };
  }

  window.WYKit = { status, subtitles, endCard, dust, flash, STATUS };
})();
