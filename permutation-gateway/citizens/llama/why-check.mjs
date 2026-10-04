// A CHECK, not a gate and not a rate (AC10a, ruling R2): does a march decision keep an informative `why` with real Gemma?
// The real mind (gate, prompt, schema, V0-V3, V5/V5b with the R2 sealed-why rule), the real prompt templates and real Gemma on 41901
// answer the golden decide request (test/fixtures/ai-decide-v1.json) at several bells and personas, with the march candidates'
// numbers varied so that the prompts are not identical. For every decision it prints the model's own `why` BEFORE the checker
// (a wrapper records it), the verdict of the checker as built (R2) and what the wave-A rule (no exemption) would have said about
// the same text. No stack, no herald, no chain: the service runs in test mode on ports from 0 against a temporary AI_DIR.
//
//   node permutation-gateway/citizens/llama/why-check.mjs --tmp DIR [--llm http://127.0.0.1:41901] [--personas conqueror,opportunist,avenger] [--bells 40,64,88]
//
// llama-server is started and stopped by the caller (citizens/llama/start-pinned.sh); the model is the pinned gguf; local only.
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createSpeech } from '../mind/speech.mjs';

const W = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const tmp = arg('tmp');
if (!tmp) throw new Error('--tmp DIR is required (a scratch directory)');
const llm = arg('llm', 'http://127.0.0.1:41901');
const personas = arg('personas', 'conqueror,opportunist,avenger').split(',');
const bells = arg('bells', '40,64,88').split(',').map(Number);
const load = () => execFileSync('uptime', { encoding: 'utf8' }).trim().replace(/^.*load averages?:\s*/, '');

const { createCitizensService } = await import(`${W}/citizens/server.mjs`);
const wire = JSON.parse(readFileSync(`${W}/test/fixtures/ai-decide-v1.json`, 'utf8'));
const cfg = JSON.parse(readFileSync(`${W}/citizens/config/smoke.json`, 'utf8'));
const R = wire.request;

// numbers of the two march candidates, varied per case so that no two prompts are alike (label and facts together)
const VARIANTS = [
  { c3: { enemy: 158, hexes: 4 }, c4: { enemy: 398, hexes: 7 } },
  { c3: { enemy: 120, hexes: 3 }, c4: { enemy: 260, hexes: 6 } },
  { c3: { enemy: 205, hexes: 5 }, c4: { enemy: 330, hexes: 8 } },
  { c3: { enemy: 96, hexes: 2 }, c4: { enemy: 410, hexes: 9 } },
];

const results = [];
for (const [pi, persona] of personas.entries()) {
  const aiDir = mkdtempSync(join(tmp, 'why-'));
  mkdirSync(`${aiDir}/pub`, { recursive: true });
  const roster = { v: 1, ai: [{ index: R.ai.index, wallet: R.ai.wallet, tag: R.ai.tag, faction: 0, persona, ambition: { en: persona, ja: '' }, creed_variant: 0, temperament: { aggression: 80, loyalty: 50, ambition: 85, honesty: 55, risk: 70, sociability: 40, grudge: 60 }, name: { en: 'Test', ja: 'テスト' }, kind: 'ai' }], script: { wallets: [] }, seat: null };
  writeFileSync(`${aiDir}/pub/roster.json`, JSON.stringify(roster));
  const real = createSpeech({ config: cfg });
  const seen = [];
  const speech = {
    ...real,
    checkWhy(text, ctx) {
      const asBuilt = real.checkWhy(text, ctx);
      const waveA = real.checkWhy(text, { ...ctx, sealedRecord: false }); // the same text and context without the R2 exemption
      seen.push({ model_text: text, sealed_record: ctx.sealedRecord === true, as_built: asBuilt.ok ? 'kept' : `withheld:${asBuilt.reason}`, wave_a_rule: waveA.ok ? 'kept' : `withheld:${waveA.reason}` });
      return asBuilt;
    },
  };
  const feed = { cursorBell: () => null, wakeEvents: () => [] };
  const svc = await createCitizensService({ aiDir, herald: 'http://127.0.0.1:41940', llm, mindPort: 0, socialPort: 0, servePort: 0, runId: 'why-check', season: 41, configPath: `${W}/citizens/config/smoke.json`, genesisTs: 1800000000 }, { test: true, noCloserTimer: true, feed, config: cfg, speech });
  for (const [bi, bell] of bells.entries()) {
    const v = VARIANTS[(pi + bi) % VARIANTS.length];
    const req = JSON.parse(JSON.stringify(R));
    req.bell = bell; req.now_game = 1800000000 + bell * 600 + 100; req.deadline_unix_ms = Date.now() + 60_000;
    req.situation.bell = bell; req.situation.day = Math.floor(bell / 144); req.situation.bell_in_day = bell % 144;
    for (const [id, x] of [['c3', v.c3], ['c4', v.c4]]) {
      const c = req.candidates.find((k) => k.id === id);
      c.facts.enemy_troops = x.enemy; c.facts.hexes = x.hexes;
      c.label = c.label.replace(/\d+ hexes away/, `${x.hexes} hexes away`);
    }
    const before = seen.length;
    const t0 = Date.now();
    const r = await fetch(`http://127.0.0.1:${svc.ports.mind}/v1/decide`, { method: 'POST', headers: { authorization: `Bearer ${svc.token}`, 'content-type': 'application/json' }, body: JSON.stringify(req) });
    const j = await r.json();
    const ms = Date.now() - t0;
    const kinds = (j.choice?.ids ?? []).map((id) => req.candidates.find((c) => c.id === id)?.kind ?? id);
    const priv = j.decision_id ? svc.records.getPrivate(j.decision_id) : null;
    const w = seen.slice(before)[0] ?? null;
    results.push({ persona, bell, variant: v, http: r.status, mode: j.mode, reason: j.reason, ms, load: load(), chose: kinds, march: kinds.includes('march'), sealed: priv?.full?.sealed ?? null, mem_cited: (j.choice?.mem ?? []).length, why_published: priv?.full?.public?.why ?? null, ...w });
  }
  await svc.close();
}
for (const x of results) console.log(JSON.stringify(x));
const marches = results.filter((x) => x.march);
console.log(JSON.stringify({
  summary: {
    decisions: results.length,
    model_mode: results.filter((x) => x.mode === 'model').length,
    march_decisions: marches.length,
    march_why_kept_as_built: marches.filter((x) => x.as_built === 'kept').length,
    march_why_kept_under_wave_a_rule: marches.filter((x) => x.wave_a_rule === 'kept').length,
    distinct_why_texts_on_marches: new Set(marches.map((x) => x.model_text)).size,
    load_after: load(),
    note: 'a check on this fixture, not a rate',
  },
}));
process.exit(0);
