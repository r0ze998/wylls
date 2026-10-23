// Wylls A/B prototype: deterministic rule bots.
//
// A bot decides from `publicView` only: it sees what a player sees (hosts
// standing on the map, departures with their origin, size and arrival
// round) and never the destination of another nation's march. The same
// code runs in versions A and B; the bots do not know which version they
// are in. They are opponents for the prototype, not models of people.
(function (root) {
  'use strict';
  const E = root.WyllsEngine || (typeof require !== 'undefined' ? require('./engine.js') : null);

  const POLICIES = {
    turtle: {
      label: '守り重視',
      econ: ['farm', 'mine', 'lumber', 'quarry', 'farm', 'mint', 'walls', 'mine', 'farm', 'tier', 'lumber', 'quarry', 'mint', 'walls', 'workshop'],
      attack: false, attackRatio: 0, startRound: 99, defend: true, park: 3, garrisonTarget: 600, retreat: 0,
    },
    raider: {
      label: '攻め重視',
      econ: ['farm', 'mine', 'farm', 'mine', 'lumber'],
      attack: true, attackRatio: 1.5, startRound: 0, defend: false, park: 0, garrisonTarget: 100, retreat: 0,
    },
    balanced: {
      label: '釣り合い',
      econ: ['farm', 'mine', 'lumber', 'quarry', 'farm', 'mint', 'workshop', 'mine', 'tier', 'walls'],
      attack: true, attackRatio: 2.0, startRound: 6, defend: true, park: 1, garrisonTarget: 300, retreat: 1.0,
    },
    // Attacks like raider, and uses the current rules' shortcut (F2):
    // a tired host away from home is dissolved (its troops are home next
    // turn) and mustered again with full stamina. Only for the checks of
    // the player's seat; no opponent in the playtest plays this.
    exploiter: {
      label: '抜け道',
      econ: ['farm', 'mine', 'farm', 'mine', 'lumber'],
      attack: true, attackRatio: 1.5, startRound: 0, defend: false, park: 0, garrisonTarget: 100, retreat: 0, remuster: true,
    },
    // Defends hard and goes after the keeps it lost first.
    counter: {
      label: '取り返し',
      econ: ['farm', 'mine', 'farm', 'lumber', 'mine', 'quarry', 'mint', 'walls'],
      attack: true, attackRatio: 1.5, startRound: 4, defend: true, park: 2, garrisonTarget: 200, retreat: 1.0, revenge: true,
    },
  };

  // Per-seed variation, so different condition numbers give different
  // opponents (the same seed always gives the same ones). Each knob moves
  // at most ±20–25% or ±2 rounds around the policy's value.
  function knobs(view, n, p) {
    const u = k => (E.h32(`${view.seed}|bot|${n}|${k}`) % 10000) / 10000;
    return {
      attackRatio: p.attackRatio * (0.8 + 0.4 * u('ratio')),
      startRound: Math.max(0, p.startRound + Math.floor(u('start') * 5) - 2),
      garrisonTarget: Math.round(p.garrisonTarget * (0.75 + 0.5 * u('garrison')) / 100) * 100,
      phase: u('phase') < 0.5 ? 0 : 1,
    };
  }
  // Rotation-invariant order of map places: counted clockwise from the
  // bot's own village, so every seat breaks ties the same way.
  function rel(n, node) { return (node - E.homeOf(n) + E.RING) % E.RING; }

  function unitFor(view, n, policy, kb) {
    const nat = view.nations[n];
    if (policy === 'raider' || policy === 'exploiter') return ((view.round + kb.phase) % 2 === 0) ? 'horse' : 'spear';
    if (policy === 'turtle') return 'spear';
    return nat.res.arms >= 50 ? 'pike' : 'spear';
  }

  function maxAffordable(nat, unit, extraReserve) {
    const c = E.UNITS[unit].cost;
    let lots = Infinity;
    for (const r in c) {
      const have = nat.res[r] - ((extraReserve && extraReserve[r]) || 0);
      lots = Math.min(lots, Math.floor(Math.max(0, have) / c[r]));
    }
    return lots === Infinity ? 0 : lots * 100;
  }

  function strengthAt(view, node, owner) {
    let x = 0;
    for (const h of view.hosts) if (h.loc === node && !h.transit && h.owner !== owner) x += h.troops * E.UNITS[h.unit].str;
    const k = E.keepAt(view, node);
    if (k && k.holder !== owner && k.holder >= 0) x += k.troops * 10 * 1.5; // walls
    const hn = E.homeNation(node);
    if (hn >= 0 && hn !== owner) x += view.nations[hn].garrison * 10 * (view.nations[hn].walls > 0 ? 1.5 : 1);
    return x;
  }

  function reserveStrength(nat, unit) { return nat.reserve[unit] * E.UNITS[unit].str; }

  // Decide this round's actions. Returns a list of actions; the caller
  // applies them in order (some may fail, as a player's would).
  function decide(view, n) {
    const nat = view.nations[n];
    const p = POLICIES[nat.policy];
    if (!p) return [];
    const acts = [];
    // A scratch copy to keep the bot's plan consistent with what it can pay.
    const s = E.clone(view);
    const me = s.nations[n];
    const tryDo = a => { const r = E.apply(s, n, a); if (r.ok) acts.push(a); return r.ok; };

    // 1. Economy: the first unmet item of the build list, if affordable.
    const want = {};
    for (const kind of p.econ) {
      want[kind] = (want[kind] || 0) + 1;
      const have = kind === 'tier' ? me.tier + me.queue.filter(q => q.kind === 'tier').length
        : kind === 'walls' ? me.walls / E.WALLS.points + me.queue.filter(q => q.kind === 'walls').length
          : me.bld[kind] + me.queue.filter(q => q.kind === kind).length;
      if (have >= want[kind]) continue;
      if (me.queue.length >= E.TIERS[me.tier].slots) break;
      if (!tryDo({ type: 'build', kind })) break; // save up for it
    }

    // 2. Keep the home garrison at its target.
    const kb = knobs(s, n, p);
    const unit = unitFor(s, n, nat.policy, kb);
    if (me.garrison < kb.garrisonTarget * E.MILLI) {
      const need = Math.ceil((kb.garrisonTarget * E.MILLI - me.garrison) / E.MILLI / 100) * 100;
      const can = Math.min(need, maxAffordable(me, 'spear'));
      if (can >= 100) tryDo({ type: 'train', unit: 'spear', troops: can });
      const g = Math.floor(me.reserve.spear / E.MILLI);
      if (g > 0) tryDo({ type: 'garrison', troops: Math.min(g, need) });
    }

    // 3. Train with what is left (keep a little for the next building).
    const keepBack = { food: 60, wood: 0, stone: 0, ore: 20, gold: 10 };
    const t = maxAffordable(me, unit, (nat.policy === 'raider' || nat.policy === 'exploiter') ? null : keepBack);
    if (t >= 100) tryDo({ type: 'train', unit, troops: t });

    const home = E.homeOf(n);
    const idle = () => s.hosts.filter(h => h.owner === n && !h.transit && h.stamina >= E.DEPART_STAMINA
      && !s.pending.some(q => q.host === h.id));
    const musterAll = () => {
      // Muster the biggest reserve into a host at home.
      let best = null;
      for (const u of E.UNIT_KEYS) if (!best || reserveStrength(me, u) > reserveStrength(me, best)) best = u;
      const troops = Math.floor(me.reserve[best] / E.MILLI);
      if (troops >= E.MIN_HOST && tryDo({ type: 'muster', unit: best, troops })) {
        return s.hosts[s.hosts.length - 1];
      }
      return null;
    };
    const myKeeps = s.keeps.filter(k => k.holder === n).sort((a, b) => rel(n, a.node) - rel(n, b.node));

    // 4. Defend: a hostile host standing on one of my keeps.
    if (p.defend) {
      for (const k of myKeeps) {
        const enemy = strengthAt(s, k.node, n) - k.troops * 15;
        if (enemy <= 0) continue;
        const already = s.hosts.some(h => h.owner === n && h.transit && h.transit.dest === k.node);
        if (already) continue;
        let h = idle().filter(x => E.ringDist(x.loc, k.node) <= E.MAX_REACH)
          .sort((a, b) => E.hostStrength(b) - E.hostStrength(a))[0];
        if (!h || E.hostStrength(h) < enemy * 1.2) h = musterAll() || h;
        if (h && E.hostStrength(h) >= enemy * 1.2) tryDo({ type: 'depart', host: h.id, dest: k.node, rounds: 1, retreat: 0 });
      }
    }

    // 5. Park hosts on my keeps (a defender on the keep stops any contest).
    if (p.park > 0) {
      const empty = myKeeps.filter(k => !s.hosts.some(h => h.owner === n && (h.loc === k.node || (h.transit && h.transit.dest === k.node))))
        .sort((a, b) => (E.ROUGH[b.node] ? 1 : 0) - (E.ROUGH[a.node] ? 1 : 0) || rel(n, a.node) - rel(n, b.node));
      const parked = myKeeps.length - empty.length;
      for (const k of empty.slice(0, Math.max(0, p.park - parked))) {
        let h = idle().filter(x => x.loc === home)[0] || musterAll();
        if (h && E.ringDist(h.loc, k.node) <= E.MAX_REACH) tryDo({ type: 'depart', host: h.id, dest: k.node, rounds: 1, retreat: 0 });
      }
    }

    // 6. Attack the weakest enemy keep that can be taken.
    if (p.attack && s.round >= kb.startRound) {
      const targets = s.keeps.filter(k => k.holder !== n && s.bell + E.BELLS_PER_ROUND >= k.consolidatedUntil)
        .filter(k => !s.hosts.some(h => h.owner === n && (h.loc === k.node || (h.transit && h.transit.dest === k.node))))
        .filter(k => E.ringDist(home, k.node) <= E.MAX_REACH)
        .map(k => ({ k, def: strengthAt(s, k.node, n) }))
        .sort((a, b) => (p.revenge ? (b.k.lastFrom === n) - (a.k.lastFrom === n) : 0) || a.def - b.def || rel(n, a.k.node) - rel(n, b.k.node));
      // One new attack per round, on the weakest target it can beat; if
      // none, it keeps saving troops at home.
      for (const { k, def } of targets) {
        const need = Math.max(def * kb.attackRatio, 1);
        let h = idle().filter(x => x.loc === home).sort((a, b) => E.hostStrength(b) - E.hostStrength(a))[0];
        if (!h || E.hostStrength(h) < need) {
          let best = null;
          for (const u of E.UNIT_KEYS) if (!best || reserveStrength(me, u) > reserveStrength(me, best)) best = u;
          if (reserveStrength(me, best) < need) continue;
          h = musterAll();
        }
        if (h && E.hostStrength(h) >= need) {
          tryDo({ type: 'depart', host: h.id, dest: k.node, rounds: 1, retreat: p.retreat });
          break;
        }
      }
    }

    // 6b. The shortcut: tired hosts away from home that hold nothing are
    // dissolved, to be mustered again fresh next round.
    if (p.remuster) {
      for (const h of s.hosts.filter(x => x.owner === n && !x.transit && x.loc !== home && x.stamina < E.DEPART_STAMINA)) {
        const k = E.keepAt(s, h.loc);
        const holding = k && k.contender === n;
        if (!holding) tryDo({ type: 'dissolve', host: h.id });
      }
    }

    // 7. Hosts left idle away from home with nothing to hold go back.
    for (const h of idle()) {
      const k = E.keepAt(s, h.loc);
      const useful = h.loc === home || (k && (k.holder === n || k.contender === n));
      if (!useful && E.ringDist(h.loc, home) <= E.MAX_REACH) tryDo({ type: 'depart', host: h.id, dest: home, rounds: 1, retreat: 0 });
    }
    return acts;
  }

  function decideAll(state) {
    const out = [];
    for (const nat of state.nations) {
      if (!nat.policy) continue;
      out.push([nat.id, decide(E.publicView(state, nat.id), nat.id)]);
    }
    return out;
  }

  const api = { POLICIES, decide, decideAll };
  root.WyllsBots = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
