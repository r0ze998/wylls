// Wylls A/B prototype: the map (an SVG string from a state). Shared by the
// game and the replay. It draws only what the viewer may see: another
// nation's march shows where it left from and when it lands, not where.
(function (root) {
  'use strict';
  const E = root.WyllsEngine;
  const T = root.WyllsText;
  const W = 560;
  const C = W / 2;
  const R = 205;

  function pos(i) {
    const a = (-90 + i * 30) * Math.PI / 180;
    return [C + R * Math.cos(a), C + R * Math.sin(a)];
  }
  function hexPath(x, y, r) {
    const p = [];
    for (let k = 0; k < 6; k++) {
      const a = (60 * k - 30) * Math.PI / 180;
      p.push(`${(x + r * Math.cos(a)).toFixed(1)},${(y + r * Math.sin(a)).toFixed(1)}`);
    }
    return `M${p.join('L')}Z`;
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  function render(s, opts) {
    const viewer = opts && opts.viewer != null ? opts.viewer : 0;
    const sel = opts ? opts.selected : null;
    const marks = (opts && opts.marks) || {};
    const out = [];
    out.push(`<svg viewBox="0 0 ${W} ${W}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="地図">`);
    out.push('<defs><marker id="arw" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0L10,5L0,10z" fill="currentColor"/></marker></defs>');
    // roads
    for (let i = 0; i < E.RING; i++) {
      const [x1, y1] = pos(i); const [x2, y2] = pos((i + 1) % E.RING);
      out.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" class="road"/>`);
    }
    out.push(`<text x="${C}" y="${C - 8}" class="center-t">ラウンド ${Math.min(s.round + 1, E.ROUNDS)} / ${E.ROUNDS}</text>`);
    out.push(`<text x="${C}" y="${C + 16}" class="center-s">${T.clock(Math.min(s.round, E.ROUNDS))}</text>`);
    // marches
    for (const h of s.hosts) {
      if (!h.transit) continue;
      const [x1, y1] = pos(h.transit.from);
      const ar = T.roundOfBell(h.transit.arriveBell) + 1;
      const color = E.NATIONS[h.owner].color;
      if ((h.owner === viewer || (opts && opts.reveal)) && h.transit.dest != null) {
        const [x2, y2] = pos(h.transit.dest);
        const mx = (x1 + x2) / 2 * 0.86 + C * 0.14; const my = (y1 + y2) / 2 * 0.86 + C * 0.14;
        out.push(`<path d="M${x1},${y1} Q${mx},${my} ${x2},${y2}" class="march own" style="color:${color}" marker-end="url(#arw)"/>`);
        out.push(`<text x="${mx}" y="${my}" class="march-t" style="fill:${color}">R${ar}</text>`);
      } else {
        const dx = (C - x1) * 0.28; const dy = (C - y1) * 0.28;
        out.push(`<line x1="${x1}" y1="${y1}" x2="${x1 + dx}" y2="${y1 + dy}" class="march foe" style="color:${color}" marker-end="url(#arw)"/>`);
        out.push(`<text x="${x1 + dx * 1.25}" y="${y1 + dy * 1.25 + 4}" class="march-t" style="fill:${color}">? R${ar}</text>`);
      }
    }
    // nodes
    for (let i = 0; i < E.RING; i++) {
      const [x, y] = pos(i);
      const home = E.isHome(i);
      const k = E.keepAt(s, i);
      const holder = home ? E.homeNation(i) : (k ? k.holder : -1);
      const color = holder >= 0 ? E.NATIONS[holder].color : '#888';
      const r = home ? 40 : 33;
      const cls = ['node', sel === i ? 'sel' : '', marks[i] ? 'mark' : '', E.ROUGH[i] ? 'rough' : ''].join(' ');
      out.push(`<g class="${cls}" data-node="${i}" tabindex="0" role="button" aria-label="${esc(T.node(i))}">`);
      out.push(`<path d="${hexPath(x, y, r)}" fill="${color}" class="${home ? 'home' : 'keep'}"/>`);
      if (E.ROUGH[i]) out.push(`<path d="M${x - 14},${y + 22} l7,-9 l5,6 l6,-10 l8,13" class="hill"/>`);
      out.push(`<text x="${x}" y="${y - (home ? 12 : 9)}" class="nname">${esc(T.node(i))}</text>`);
      if (home) {
        const n = s.nations[holder];
        out.push(`<text x="${x}" y="${y + 5}" class="nsub">守備 ${T.troops(n.garrison)}${n.walls ? '・壁' : ''}</text>`);
      } else if (k) {
        out.push(`<text x="${x}" y="${y + 5}" class="nsub">守備 ${T.troops(k.troops)}</text>`);
        if (k.contender >= 0) {
          const frac = k.progress / E.KEEP_BELLS;
          const cc = E.NATIONS[k.contender].color;
          const a0 = -Math.PI / 2; const a1 = a0 + frac * Math.PI * 2;
          const rr = r + 6;
          const large = frac > 0.5 ? 1 : 0;
          out.push(`<circle cx="${x}" cy="${y}" r="${rr}" class="ring-bg"/>`);
          out.push(`<path d="M${x + rr * Math.cos(a0)},${y + rr * Math.sin(a0)} A${rr},${rr} 0 ${large} 1 ${x + rr * Math.cos(a1)},${y + rr * Math.sin(a1)}" class="ring" style="stroke:${cc}"/>`);
        }
        if (s.bell < k.consolidatedUntil) {
          const until = T.roundOfBell(k.consolidatedUntil - 1) + 1;
          out.push(`<text x="${x}" y="${y + 19}" class="nsub small">${until >= E.ROUNDS ? '最後まで守られる' : `R${until}まで守られる`}</text>`);
        }
      }
      // hosts standing here
      const here = {};
      for (const h of s.hosts) if (h.loc === i && !h.transit) here[h.owner] = (here[h.owner] || 0) + h.troops;
      let off = 0;
      for (const f of Object.keys(here).map(Number)) {
        const bx = x + (x < C ? -r - 46 : r + 6); const by = y - 10 + off;
        out.push(`<rect x="${bx}" y="${by}" width="40" height="17" rx="8" fill="${E.NATIONS[f].color}" class="pill"/>`);
        out.push(`<text x="${bx + 20}" y="${by + 12.5}" class="pill-t">${T.troops(here[f])}</text>`);
        off += 20;
      }
      out.push('</g>');
    }
    out.push('</svg>');
    return out.join('');
  }

  root.WyllsMap = { render, pos };
})(window);
