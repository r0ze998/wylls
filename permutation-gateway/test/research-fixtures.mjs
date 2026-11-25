// Research record fixtures as the program writes them (frontier-abi world_index/research.rs offsets, pinned there by
// `layout_offsets_are_pinned_for_the_js_mirror`). Shared by the research tests.
/** A world record as the program writes it (frontier-abi research_world offsets). */
export function worldBytes({ era = 1, startBell = 2, first = {}, known = {}, firstNations = {} } = {}) {
  const b = new Uint8Array(256), dv = new DataView(b.buffer);
  b.set([...'PSFXWRW1'].map(c => c.charCodeAt(0)));
  dv.setUint16(16, 1, true); b[18] = 1; dv.setUint32(52, startBell, true); b[56] = era;
  for (let i = 0; i < 3; i++) dv.setUint32(68 + 4 * i, i === 0 ? startBell : 0xffffffff, true);
  for (let t = 0; t < 16; t++) dv.setUint32(80 + 4 * t, first[t] ?? 0xffffffff, true);
  for (const [t, m] of Object.entries(firstNations)) b[144 + Number(t)] = m;
  for (const [t, m] of Object.entries(known)) b[160 + Number(t)] = m;
  return b;
}
/** A nation record (nation_research offsets). */
export function nationBytes(f, { learned = {}, pledged = {} } = {}) {
  const b = new Uint8Array(384), dv = new DataView(b.buffer);
  b.set([...'PSFXWRN1'].map(c => c.charCodeAt(0)));
  dv.setUint16(16, 1, true); b[18] = 1; b[19] = f;
  let known = 0;
  for (let t = 0; t < 16; t++) {
    dv.setUint32(56 + 4 * t, pledged[t] ?? 0, true);
    dv.setUint32(120 + 4 * t, 0xffffffff, true);
    dv.setUint32(184 + 4 * t, learned[t] ?? 0xffffffff, true);
    if (learned[t] !== undefined) known |= 1 << t;
  }
  dv.setUint16(52, known, true);
  return b;
}

