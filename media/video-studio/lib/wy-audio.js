/* Wylls video studio: procedural score and sound effects.
 *
 * A scene's audio(A) schedules sound against the same clock as the picture;
 * WYAudio.render() runs it in an OfflineAudioContext, so a whoosh at t = 3.20 s
 * lands on the frame at 3.20 s. render.mjs muxes the result and normalises its
 * loudness (EBU R128, -15 LUFS).
 *
 *   audio(A) {
 *     A.music({ style: 'epic', bpm: 92, key: 'D', minor: true,
 *               sections: [[0, .2], [6, .6], [18, 1], [40, .3]],   // [time, intensity 0..1]
 *               end: 44, outro: 'hit' });
 *     A.whoosh(2.0); A.hit(6.0); A.tick(7.5); A.chime(9, { note: 'A5' });
 *   }
 *
 * Every call takes optional { gain } (1 = default level). Everything is
 * deterministic: noise comes from a seeded generator.
 */
(function () {
  'use strict';
  const SR = 48000;
  const NOTE = { C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11 };
  const hz = m => 440 * Math.pow(2, (m - 69) / 12);
  const noteToMidi = s => { const m = /^([A-G][#b]?)(-?\d)$/.exec(s); return m ? NOTE[m[1]] + (parseInt(m[2], 10) + 1) * 12 : 69; };
  function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

  async function render(fn, duration) {
    const len = Math.ceil((duration + 0.05) * SR);
    const ctx = new OfflineAudioContext(2, len, SR);
    const A = makeApi(ctx, duration);
    fn(A);
    A._finish();
    return ctx.startRendering();
  }

  function makeApi(ctx, duration) {
    const R = rng(1234);
    // ---------------------------------------------------------------- buses
    const master = ctx.createGain(); master.gain.value = 0.8;
    const glue = ctx.createDynamicsCompressor();
    glue.threshold.value = -16; glue.ratio.value = 2.5; glue.attack.value = 0.01; glue.release.value = 0.25; glue.knee.value = 8;
    const lim = ctx.createDynamicsCompressor();
    lim.threshold.value = -3; lim.ratio.value = 20; lim.attack.value = 0.002; lim.release.value = 0.08; lim.knee.value = 0;
    master.connect(glue); glue.connect(lim); lim.connect(ctx.destination);
    const music = ctx.createGain(); music.gain.value = 0.62; music.connect(master);
    const sfx = ctx.createGain(); sfx.gain.value = 0.9; sfx.connect(master);
    // reverb
    const verb = ctx.createConvolver(); verb.buffer = impulse(ctx, 3.2, 2.6, R);
    const verbIn = ctx.createGain(); verbIn.gain.value = 1;
    const verbLP = ctx.createBiquadFilter(); verbLP.type = 'lowpass'; verbLP.frequency.value = 6500;
    const verbOut = ctx.createGain(); verbOut.gain.value = 0.42;
    verbIn.connect(verbLP); verbLP.connect(verb); verb.connect(verbOut); verbOut.connect(master);
    // short room for percussion
    const room = ctx.createConvolver(); room.buffer = impulse(ctx, 0.9, 4, R);
    const roomIn = ctx.createGain(); const roomOut = ctx.createGain(); roomOut.gain.value = 0.3;
    roomIn.connect(room); room.connect(roomOut); roomOut.connect(master);
    // stereo delay for plucks/bells
    const dl = ctx.createDelay(2); const dr = ctx.createDelay(2); const fb = ctx.createGain(); fb.gain.value = 0.32;
    const delIn = ctx.createGain(); const delOut = ctx.createGain(); delOut.gain.value = 0.22;
    const merger = ctx.createChannelMerger(2);
    delIn.connect(dl); dl.connect(dr); dr.connect(fb); fb.connect(dl);
    dl.connect(merger, 0, 0); dr.connect(merger, 0, 1); merger.connect(delOut); delOut.connect(music); delOut.connect(verbIn);

    const noiseBuf = (() => { const b = ctx.createBuffer(1, SR * 3, SR); const d = b.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = R() * 2 - 1; return b; })();
    const pinkBuf = (() => { const b = ctx.createBuffer(1, SR * 3, SR); const d = b.getChannelData(0); let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0; for (let i = 0; i < d.length; i++) { const w = R() * 2 - 1; b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852; b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898; d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11; b6 = w * 0.115926; } return b; })();

    const pan = (node, p) => { const s = ctx.createStereoPanner(); s.pan.value = p; node.connect(s); return s; };
    const noise = (t, dur, pink = false) => { const s = ctx.createBufferSource(); s.buffer = pink ? pinkBuf : noiseBuf; s.loop = true; s.start(t, R() * 2, dur + 0.1); s.stop(t + dur + 0.1); return s; };
    const osc = (type, f, t, dur) => { const o = ctx.createOscillator(); o.type = type; o.frequency.setValueAtTime(f, t); o.start(t); o.stop(t + dur + 0.05); return o; };
    const env = (g, t, a, peak, d, sustain, hold, r) => {
      const p = g.gain; p.setValueAtTime(0.00001, t); p.linearRampToValueAtTime(peak, t + a);
      if (d) p.exponentialRampToValueAtTime(Math.max(0.00001, peak * sustain), t + a + d);
      const end = t + a + (d || 0) + (hold || 0);
      p.setValueAtTime(Math.max(0.00001, peak * (d ? sustain : 1)), end);
      p.exponentialRampToValueAtTime(0.00001, end + r);
      return end + r;
    };
    const gainNode = (v = 1) => { const g = ctx.createGain(); g.gain.value = v; return g; };
    const ok = t => t >= -0.01 && t < duration + 0.01;

    // ---------------------------------------------------------------- SFX
    const api = {
      ctx, duration,
      /** airy pass; dir 'up' brightens, 'down' darkens; length dur */
      whoosh(t, { dur = 0.7, gain = 1, dir = 'up', pan: p = 0 } = {}) {
        if (!ok(t)) return;
        const n = noise(t, dur, true); const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 1.2;
        const f0 = dir === 'up' ? 300 : 3500, f1 = dir === 'up' ? 4200 : 250;
        bp.frequency.setValueAtTime(f0, t); bp.frequency.exponentialRampToValueAtTime(f1, t + dur);
        const g = gainNode(0); g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.55 * gain, t + dur * 0.6); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        const ps = ctx.createStereoPanner(); ps.pan.setValueAtTime(p - 0.6, t); ps.pan.linearRampToValueAtTime(p + 0.6, t + dur);
        n.connect(bp); bp.connect(g); g.connect(ps); ps.connect(sfx); const s = gainNode(0.35); ps.connect(s); s.connect(verbIn);
      },
      /** quick whip for text/cards */
      swish(t, { gain = 1, pan: p = 0 } = {}) { api.whoosh(t - 0.18, { dur: 0.32, gain: 0.6 * gain, pan: p }); },
      /** cinematic impact: sub drop + body + noise crack + long reverb tail */
      hit(t, { gain = 1, deep = true, bright = 0.5 } = {}) {
        if (!ok(t)) return;
        const o = osc('sine', 110, t, 2.2); o.frequency.exponentialRampToValueAtTime(deep ? 32 : 48, t + 0.9);
        const g = gainNode(0); env(g, t, 0.004, 1.1 * gain, 0.4, 0.4, 0, 1.6); o.connect(g); g.connect(sfx);
        const o2 = osc('triangle', 220, t, 0.6); o2.frequency.exponentialRampToValueAtTime(70, t + 0.25);
        const g2 = gainNode(0); env(g2, t, 0.002, 0.45 * gain, 0.12, 0.2, 0, 0.35); o2.connect(g2); g2.connect(sfx); g2.connect(roomIn);
        const n = noise(t, 1.2); const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.setValueAtTime(1500 + 7000 * bright, t); lp.frequency.exponentialRampToValueAtTime(300, t + 0.8);
        const g3 = gainNode(0); env(g3, t, 0.002, 0.5 * gain, 0.15, 0.25, 0, 0.9); n.connect(lp); lp.connect(g3); g3.connect(sfx);
        const s = gainNode(0.9 * gain); g3.connect(s); g.connect(s); s.connect(verbIn);
      },
      /** big low boom (trailer stinger) */
      boom(t, { gain = 1 } = {}) { api.hit(t, { gain: 1.25 * gain, deep: true, bright: 0.25 }); api.drum(t, { gain: 0.9 * gain, pitch: 0.7 }); },
      /** taiko-like drum */
      drum(t, { gain = 1, pitch = 1, pan: p = 0 } = {}) {
        if (!ok(t)) return;
        const o = osc('sine', 150 * pitch, t, 1); o.frequency.exponentialRampToValueAtTime(52 * pitch, t + 0.18);
        const g = gainNode(0); env(g, t, 0.003, 0.95 * gain, 0.25, 0.25, 0, 0.5); o.connect(g);
        const n = noise(t, 0.2); const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 900 * pitch; bp.Q.value = 0.8;
        const g2 = gainNode(0); env(g2, t, 0.001, 0.35 * gain, 0.05, 0.1, 0, 0.12); n.connect(bp); bp.connect(g2);
        const out = gainNode(1); g.connect(out); g2.connect(out); pan(out, p).connect(sfx); out.connect(roomIn);
      },
      /** clock tick (two-tone mechanical) */
      tick(t, { gain = 1, pitch = 1, pan: p = 0 } = {}) {
        if (!ok(t)) return;
        const n = noise(t, 0.04); const hp = ctx.createBiquadFilter(); hp.type = 'bandpass'; hp.frequency.value = 3200 * pitch; hp.Q.value = 6;
        const g = gainNode(0); env(g, t, 0.0008, 0.6 * gain, 0.02, 0.05, 0, 0.03); n.connect(hp); hp.connect(g);
        const o = osc('sine', 1800 * pitch, t, 0.05); const g2 = gainNode(0); env(g2, t, 0.0005, 0.12 * gain, 0.01, 0.1, 0, 0.02); o.connect(g2);
        const out = gainNode(1); g.connect(out); g2.connect(out); pan(out, p).connect(sfx); const s = gainNode(0.25); out.connect(s); s.connect(roomIn);
      },
      ticks(t0, t1, every = 0.5, opts = {}) { let k = 0; for (let t = t0; t < t1; t += every, k++) api.tick(t, { ...opts, pitch: (opts.pitch || 1) * (k % 2 ? 0.82 : 1) }); },
      /** UI click / pop */
      click(t, { gain = 1, pitch = 1 } = {}) {
        if (!ok(t)) return;
        const o = osc('sine', 1400 * pitch, t, 0.08); o.frequency.exponentialRampToValueAtTime(600 * pitch, t + 0.05);
        const g = gainNode(0); env(g, t, 0.001, 0.32 * gain, 0.03, 0.1, 0, 0.05); o.connect(g); g.connect(sfx);
      },
      pop(t, opts = {}) { api.click(t, { ...opts, pitch: (opts.pitch || 1) * 0.7 }); },
      /** typing: soft clicks at cps */
      type(t0, t1, { cps = 18, gain = 0.5 } = {}) { const r = rng(Math.floor(t0 * 1000)); for (let t = t0; t < t1; t += 1 / cps * (0.7 + r() * 0.6)) api.tick(t, { gain: gain * (0.6 + r() * 0.4), pitch: 1.6 + r() * 0.6, pan: r() * 0.4 - 0.2 }); },
      /** bell / chime (FM) */
      chime(t, { note = 'A5', gain = 1, dur = 2.4, pan: p = 0 } = {}) {
        if (!ok(t)) return;
        const f = typeof note === 'number' ? note : hz(noteToMidi(note));
        const car = osc('sine', f, t, dur); const mod = osc('sine', f * 3.5, t, dur); const mg = gainNode(0);
        mg.gain.setValueAtTime(f * 2.2, t); mg.gain.exponentialRampToValueAtTime(f * 0.05, t + dur * 0.6); mod.connect(mg); mg.connect(car.frequency);
        const g = gainNode(0); env(g, t, 0.003, 0.28 * gain, dur * 0.3, 0.3, 0, dur * 0.7); car.connect(g);
        const o2 = osc('sine', f * 2.01, t, dur); const g2 = gainNode(0); env(g2, t, 0.002, 0.07 * gain, dur * 0.2, 0.2, 0, dur * 0.4); o2.connect(g2);
        const out = gainNode(1); g.connect(out); g2.connect(out); const pn = pan(out, p); pn.connect(sfx); const s = gainNode(0.6); pn.connect(s); s.connect(verbIn); pn.connect(delIn);
      },
      /** a short rising arpeggio of chimes (success / reveal) */
      sparkle(t, { root = 'D5', gain = 0.7, steps = [0, 4, 7, 12] } = {}) { const m = noteToMidi(root); steps.forEach((s, i) => api.chime(t + i * 0.07, { note: hz(m + s), gain: gain * (1 - i * 0.12), dur: 1.6, pan: -0.3 + i * 0.2 })); },
      /** tension riser from t0 to t1 (noise sweep + rising tone) */
      riser(t0, t1, { gain = 1 } = {}) {
        if (!ok(t0)) return; const d = t1 - t0;
        const n = noise(t0, d, true); const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 2;
        bp.frequency.setValueAtTime(200, t0); bp.frequency.exponentialRampToValueAtTime(6000, t1);
        const g = gainNode(0); g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.45 * gain, t1 - 0.02); g.gain.linearRampToValueAtTime(0, t1 + 0.03);
        n.connect(bp); bp.connect(g); g.connect(sfx); const s = gainNode(0.5); g.connect(s); s.connect(verbIn);
        for (const det of [0, 7, 12]) {
          const o = osc('sawtooth', 110 * Math.pow(2, det / 12), t0, d); o.frequency.exponentialRampToValueAtTime(440 * Math.pow(2, det / 12), t1);
          const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.setValueAtTime(300, t0); lp.frequency.exponentialRampToValueAtTime(3000, t1);
          const og = gainNode(0); og.gain.setValueAtTime(0.0001, t0); og.gain.exponentialRampToValueAtTime(0.05 * gain, t1 - 0.02); og.gain.linearRampToValueAtTime(0, t1 + 0.03);
          o.connect(lp); lp.connect(og); og.connect(sfx); og.connect(verbIn);
        }
      },
      /** reversed swell that peaks exactly at t1 */
      swell(t0, t1, { gain = 1, note = 'D3' } = {}) {
        if (!ok(t0)) return; const m = noteToMidi(note);
        for (const iv of [0, 7, 12, 15]) {
          const o = osc('sawtooth', hz(m + iv), t0, t1 - t0 + 0.1); const lp = ctx.createBiquadFilter(); lp.type = 'lowpass';
          lp.frequency.setValueAtTime(200, t0); lp.frequency.exponentialRampToValueAtTime(2400, t1);
          const g = gainNode(0); g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.06 * gain, t1); g.gain.linearRampToValueAtTime(0, t1 + 0.05);
          o.connect(lp); lp.connect(g); g.connect(sfx); g.connect(verbIn);
        }
      },
      /** wax seal / stamp: thud + paper crack */
      seal(t, { gain = 1 } = {}) {
        if (!ok(t)) return;
        const o = osc('sine', 180, t, 0.4); o.frequency.exponentialRampToValueAtTime(60, t + 0.12);
        const g = gainNode(0); env(g, t, 0.002, 0.9 * gain, 0.1, 0.2, 0, 0.2); o.connect(g); g.connect(sfx); g.connect(roomIn);
        const n = noise(t + 0.01, 0.12); const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 1800;
        const g2 = gainNode(0); env(g2, t + 0.01, 0.001, 0.4 * gain, 0.03, 0.2, 0, 0.08); n.connect(hp); hp.connect(g2); g2.connect(sfx);
      },
      /** lock / latch (time-lock closing) */
      lock(t, { gain = 1 } = {}) { api.click(t, { gain: 1.2 * gain, pitch: 0.5 }); api.tick(t + 0.06, { gain: 1.4 * gain, pitch: 0.6 }); api.seal(t + 0.1, { gain: 0.5 * gain }); },
      /** coin / token */
      coin(t, { gain = 1 } = {}) { api.chime(t, { note: 'E6', gain: 0.6 * gain, dur: 0.8 }); api.chime(t + 0.06, { note: 'B6', gain: 0.5 * gain, dur: 1.2 }); },
      /** digital glitch burst */
      glitch(t, { gain = 1, dur = 0.25 } = {}) {
        if (!ok(t)) return; const r = rng(Math.floor(t * 997));
        for (let k = 0; k < 6; k++) {
          const tt = t + k * dur / 6; const o = osc('square', 200 + r() * 1800, tt, dur / 6);
          const g = gainNode(0); env(g, tt, 0.001, 0.08 * gain, 0, 1, dur / 8, 0.01); o.connect(g); g.connect(sfx);
        }
        const n = noise(t, dur); const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 2500; bp.Q.value = 3;
        const g = gainNode(0); env(g, t, 0.001, 0.2 * gain, 0, 1, dur, 0.02); n.connect(bp); bp.connect(g); g.connect(sfx);
      },
      /** success / verified ping */
      ok(t, { gain = 1 } = {}) { api.chime(t, { note: 'E5', gain: 0.7 * gain, dur: 1.2 }); api.chime(t + 0.09, { note: 'B5', gain: 0.6 * gain, dur: 1.8 }); },
      /** error / tamper buzz */
      bad(t, { gain = 1 } = {}) {
        if (!ok(t)) return;
        for (const f of [130, 138]) { const o = osc('sawtooth', f, t, 0.35); const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1200; const g = gainNode(0); env(g, t, 0.005, 0.12 * gain, 0, 1, 0.25, 0.08); o.connect(lp); lp.connect(g); g.connect(sfx); }
      },
      /** marching feet / army: low rhythmic thumps between t0 and t1 */
      march(t0, t1, { gain = 1, bpm = 120 } = {}) { const step = 60 / bpm; let k = 0; for (let t = t0; t < t1; t += step, k++) api.drum(t, { gain: 0.22 * gain * (k % 2 ? 0.75 : 1), pitch: 1.6, pan: k % 2 ? 0.2 : -0.2 }); },
      /** sword clash: metallic inharmonic partials */
      clash(t, { gain = 1 } = {}) {
        if (!ok(t)) return;
        for (const [f, a] of [[1870, 0.12], [2630, 0.1], [3410, 0.08], [4790, 0.05]]) { const o = osc('sine', f, t, 1.2); const g = gainNode(0); env(g, t, 0.001, a * gain, 0.08, 0.3, 0, 0.9); o.connect(g); g.connect(sfx); g.connect(verbIn); }
        const n = noise(t, 0.1); const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 3000; const g = gainNode(0); env(g, t, 0.001, 0.4 * gain, 0.02, 0.2, 0, 0.05); n.connect(hp); hp.connect(g); g.connect(sfx);
      },
      /** low sustained drone for tension, t0..t1 */
      drone(t0, t1, { note = 'D2', gain = 1 } = {}) {
        if (!ok(t0)) return; const m = noteToMidi(note); const d = t1 - t0;
        for (const [iv, det] of [[0, -6], [0, 6], [7, 0], [12, 3]]) {
          const o = osc('sawtooth', hz(m + iv), t0, d + 1); o.detune.value = det;
          const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 380; lp.Q.value = 0.7;
          const g = gainNode(0); g.gain.setValueAtTime(0.0001, t0); g.gain.linearRampToValueAtTime(0.05 * gain, t0 + Math.min(2, d / 3)); g.gain.setValueAtTime(0.05 * gain, t1 - Math.min(2, d / 3)); g.gain.linearRampToValueAtTime(0.0001, t1);
          o.connect(lp); lp.connect(g); g.connect(music); g.connect(verbIn);
        }
      },
      /** a single synth note on the music bus */
      note(t, n, dur, { type = 'triangle', gain = 1, cutoff = 2500, pan: p = 0, verb = 0.4 } = {}) {
        if (!ok(t)) return; const f = typeof n === 'number' ? hz(n) : hz(noteToMidi(n));
        const o = osc(type, f, t, dur + 0.6); const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = cutoff;
        const g = gainNode(0); env(g, t, 0.005, 0.16 * gain, 0.15, 0.6, Math.max(0, dur - 0.15), 0.45); o.connect(lp); lp.connect(g);
        const pn = pan(g, p); pn.connect(music); const s = gainNode(verb); pn.connect(s); s.connect(verbIn);
      },
      _finish() {},
    };

    // ---------------------------------------------------------------- music
    api.music = (opt = {}) => {
      const o = Object.assign({ style: 'epic', bpm: 92, key: 'D', minor: true, sections: [[0, 0.6]], start: 0, end: duration, outro: 'ring', gain: 1, progression: null, barsPerChord: 1 }, opt);
      const beat = 60 / o.bpm, bar = beat * 4;
      const root = NOTE[o.key] + 48; // C3 based octave for chords
      const MINOR = [[0, 3, 7], [-4, 0, 3], [3, 7, 10], [-2, 2, 5]]; // i VI III VII
      const MINOR2 = [[0, 3, 7], [-2, 2, 5], [-4, 0, 3], [-5, -1, 2]]; // i VII VI V
      const MAJOR = [[0, 4, 7], [7, 11, 14], [9, 12, 16], [5, 9, 12]]; // I V vi IV
      const TENSE = [[0, 3, 7], [1, 5, 8], [0, 3, 7], [-1, 3, 6]]; // i bII i vii°
      const prog = o.progression || (o.style === 'heroic' || !o.minor ? MAJOR : o.style === 'tension' ? TENSE : o.style === 'calm' ? MINOR2 : MINOR);
      const inten = t => { const s = o.sections; if (t <= s[0][0]) return s[0][1]; for (let i = 0; i < s.length - 1; i++) { const [a, va] = s[i], [b, vb] = s[i + 1]; if (t < b) { const k = Math.min(1, (t - a) / Math.min(1.2, b - a)); return va + (vb - va) * k; } } return s[s.length - 1][1]; };
      const mg = gainNode(o.gain); mg.connect(music);
      const verbS = gainNode(0.55 * o.gain); verbS.connect(verbIn);
      const voice = (t, midi, dur, kind, g, p = 0) => {
        const f = hz(midi);
        if (kind === 'pad') {
          const out = gainNode(0); const lp = ctx.createBiquadFilter(); lp.type = 'lowpass';
          const i = inten(t); lp.frequency.setValueAtTime(500 + 2600 * i, t); lp.Q.value = 0.5;
          for (const d of [-9, 0, 8]) { const x = osc('sawtooth', f, t, dur + 1.6); x.detune.value = d; x.connect(lp); }
          const a = Math.min(1.2, dur * 0.4); out.gain.setValueAtTime(0.0001, t); out.gain.linearRampToValueAtTime(g, t + a); out.gain.setValueAtTime(g, t + dur); out.gain.linearRampToValueAtTime(0.0001, t + dur + 1.4);
          lp.connect(out); const pn = pan(out, p); pn.connect(mg); pn.connect(verbS);
        } else if (kind === 'pluck') {
          const x = osc('sawtooth', f, t, dur + 0.5); const x2 = osc('square', f * 1.005, t, dur + 0.5); const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 3;
          lp.frequency.setValueAtTime(4200, t); lp.frequency.exponentialRampToValueAtTime(420, t + 0.22);
          const out = gainNode(0); env(out, t, 0.002, g, 0.18, 0.15, 0, 0.25);
          const xg = gainNode(0.5); x2.connect(xg); x.connect(lp); xg.connect(lp); lp.connect(out); const pn = pan(out, p); pn.connect(mg); pn.connect(delIn); const s = gainNode(0.25); pn.connect(s); s.connect(verbIn);
        } else if (kind === 'bass') {
          const x = osc('sine', f, t, dur + 0.3); const x2 = osc('triangle', f * 2, t, dur + 0.3); const out = gainNode(0); env(out, t, 0.01, g, 0.1, 0.75, Math.max(0, dur - 0.15), 0.12);
          const x2g = gainNode(0.25); x2.connect(x2g); x2g.connect(out); x.connect(out); out.connect(mg);
        } else if (kind === 'string') {
          const out = gainNode(0); const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3200;
          const vib = osc('sine', 5.2, t, dur + 1); const vg = gainNode(6); vib.connect(vg);
          for (const d of [-7, 7]) { const x = osc('sawtooth', f, t, dur + 1); x.detune.value = d; vg.connect(x.detune); x.connect(lp); }
          out.gain.setValueAtTime(0.0001, t); out.gain.linearRampToValueAtTime(g, t + Math.min(0.5, dur * 0.4)); out.gain.setValueAtTime(g, t + dur); out.gain.linearRampToValueAtTime(0.0001, t + dur + 0.5);
          lp.connect(out); const pn = pan(out, p); pn.connect(mg); pn.connect(verbS);
        } else if (kind === 'bell') {
          api.chime(t, { note: f, gain: g * 6, dur: 2.2, pan: p });
        } else if (kind === 'brass') {
          const out = gainNode(0); const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 1;
          lp.frequency.setValueAtTime(300, t); lp.frequency.linearRampToValueAtTime(2200, t + 0.25); lp.frequency.linearRampToValueAtTime(1200, t + dur);
          for (const d of [-5, 5]) { const x = osc('sawtooth', f, t, dur + 0.5); x.detune.value = d; x.connect(lp); }
          env(out, t, 0.06, g, 0.2, 0.7, Math.max(0, dur - 0.26), 0.3); lp.connect(out); const pn = pan(out, p); pn.connect(mg); pn.connect(verbS);
        }
      };
      const kick = (t, g) => { const x = osc('sine', 140, t, 0.5); x.frequency.exponentialRampToValueAtTime(42, t + 0.12); const out = gainNode(0); env(out, t, 0.002, g, 0.18, 0.3, 0, 0.2); x.connect(out); out.connect(mg); };
      const hat = (t, g, open = false) => { const n = noise(t, open ? 0.3 : 0.06); const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 7500; const out = gainNode(0); env(out, t, 0.001, g, open ? 0.15 : 0.03, 0.2, 0, open ? 0.15 : 0.03); n.connect(hp); hp.connect(out); pan(out, 0.25).connect(mg); };
      const clap = (t, g) => { for (const dt of [0, 0.012, 0.024]) { const n = noise(t + dt, 0.15); const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 1600; bp.Q.value = 1.2; const out = gainNode(0); env(out, t + dt, 0.001, g, 0.06, 0.2, 0, 0.12); n.connect(bp); bp.connect(out); out.connect(mg); out.connect(roomIn); } };
      const tom = (t, g, p = 1) => api.drum(t, { gain: g, pitch: p });

      const stop = Math.min(o.end, duration);
      let barIdx = 0;
      for (let t = o.start; t < stop - 0.01; t += bar, barIdx++) {
        const I = inten(t);
        if (I <= 0.01) continue;
        const ch = prog[Math.floor(barIdx / o.barsPerChord) % prog.length];
        const len = Math.min(bar, stop - t);
        const chordStart = barIdx % o.barsPerChord === 0;
        // pad: voiced chord
        if (chordStart) {
          const plen = Math.min(bar * o.barsPerChord, stop - t);
          const v = [ch[0] + 12, ch[1] + 12, ch[2] + 12, ch[0] + 24];
          v.forEach((iv, k) => voice(t, root + iv, plen, 'pad', 0.028 * (0.5 + 0.5 * I), -0.4 + k * 0.27));
        }
        // bass
        if (I > 0.2) {
          if (o.style === 'tech' || o.style === 'tension' || I > 0.65) for (let b = 0; b < 8; b++) { const tt = t + b * beat / 2; if (tt < stop) voice(tt, root - 12 + ch[0], beat / 2 * 0.8, 'bass', 0.22 * Math.min(1, I + 0.2) * (b % 2 ? 0.7 : 1)); }
          else voice(t, root - 12 + ch[0], len * 0.95, 'bass', 0.2 * I);
        }
        // arpeggio
        if (I > 0.35 && o.style !== 'heroic-slow') {
          const div = o.style === 'calm' ? 4 : I > 0.75 ? 16 : 8; const step = bar / div;
          const pat = [0, 1, 2, 3, 2, 1, 2, 3];
          const tones = [ch[0] + 24, ch[1] + 24, ch[2] + 24, ch[0] + 36];
          for (let k = 0; k < div; k++) { const tt = t + k * step; if (tt >= stop) break; voice(tt, root + tones[pat[k % 8]], step * 0.9, o.style === 'calm' ? 'bell' : 'pluck', (o.style === 'calm' ? 0.02 : 0.05) * Math.min(1, I + 0.1), (k % 2 ? 0.3 : -0.3)); }
        }
        // strings / brass on top for epic & heroic at high intensity
        if ((o.style === 'epic' || o.style === 'heroic') && I > 0.7 && chordStart) {
          const plen = Math.min(bar * o.barsPerChord, stop - t);
          voice(t, root + 24 + ch[2], plen, 'string', 0.03 * I, 0.3); voice(t, root + 24 + ch[1], plen, 'string', 0.025 * I, -0.3);
          if (I > 0.85) { voice(t, root + 12 + ch[0], beat * 1.5, 'brass', 0.06 * I, -0.1); voice(t + beat * 2, root + 12 + ch[1], beat * 1.8, 'brass', 0.05 * I, 0.1); }
        }
        // drums
        if (I > 0.5) {
          for (let b = 0; b < 4; b++) {
            const tt = t + b * beat; if (tt >= stop) break;
            if (o.style === 'tech' || o.style === 'pulse') { kick(tt, 0.55 * I); if (I > 0.65) hat(tt + beat / 2, 0.08 * I); if (I > 0.8 && (b === 1 || b === 3)) clap(tt, 0.18 * I); }
            else if (o.style === 'tension') { if (b === 0 || b === 2) kick(tt, 0.45 * I); hat(tt, 0.05 * I); hat(tt + beat / 2, 0.035 * I); }
            else if (o.style === 'epic' || o.style === 'heroic') { if (b === 0) tom(tt, 0.55 * I, 0.8); if (b === 2) tom(tt, 0.45 * I, 0.95); if (I > 0.8 && b === 3) { tom(tt, 0.3 * I, 1.2); tom(tt + beat / 2, 0.32 * I, 1.1); } if (I > 0.85 && (b === 1 || b === 3)) clap(tt, 0.1 * I); }
            else if (o.style === 'calm' && I > 0.6) { if (b === 0) kick(tt, 0.25 * I); }
          }
        }
      }
      // ending
      if (o.outro === 'hit' && stop < duration) api.hit(stop, { gain: 0.9 });
      if (o.outro === 'ring' || o.outro === 'hit') {
        const ch = prog[0];
        [ch[0] + 12, ch[1] + 12, ch[2] + 12, ch[0] + 24, ch[0]].forEach((iv, k) => voice(stop, root + iv, Math.max(0.5, Math.min(4, duration - stop - 1.2)), 'pad', 0.03, -0.4 + k * 0.2));
        voice(stop, root - 12 + ch[0], Math.max(0.5, Math.min(3, duration - stop - 0.6)), 'bass', 0.22);
      }
    };
    return api;
  }

  function impulse(ctx, secs, decay, R) {
    const len = Math.floor(SR * secs); const b = ctx.createBuffer(2, len, SR);
    for (let c = 0; c < 2; c++) { const d = b.getChannelData(c); let lp = 0; for (let i = 0; i < len; i++) { const w = (R() * 2 - 1) * Math.pow(1 - i / len, decay); lp = lp * 0.55 + w * 0.45; d[i] = lp; } }
    return b;
  }

  function toWavBase64(buf) {
    const ch = buf.numberOfChannels, len = buf.length, bytes = 44 + len * ch * 2;
    const ab = new ArrayBuffer(bytes), v = new DataView(ab);
    const ws = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    ws(0, 'RIFF'); v.setUint32(4, bytes - 8, true); ws(8, 'WAVE'); ws(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, ch, true);
    v.setUint32(24, SR, true); v.setUint32(28, SR * ch * 2, true); v.setUint16(32, ch * 2, true); v.setUint16(34, 16, true); ws(36, 'data'); v.setUint32(40, len * ch * 2, true);
    const data = [...Array(ch)].map((_, c) => buf.getChannelData(c));
    let o = 44; for (let i = 0; i < len; i++) for (let c = 0; c < ch; c++) { const s = Math.max(-1, Math.min(1, data[c][i])); v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true); o += 2; }
    let bin = ''; const u = new Uint8Array(ab); const CH = 0x8000; for (let i = 0; i < u.length; i += CH) bin += String.fromCharCode.apply(null, u.subarray(i, i + CH));
    return btoa(bin);
  }

  window.WYAudio = { render, toWavBase64, hz, noteToMidi };
})();
