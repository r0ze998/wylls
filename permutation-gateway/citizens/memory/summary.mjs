// The self-summary store (contract §5.3). A summary is the ONE model-written
// part of memory: it is validated and sanitised by the reflection validator
// (AC1b) before it gets here, stored as `STATE/summary/<tag>/<bell>.txt`,
// published live as `PUB/memory/<tag>/summary.json` and labelled "written by
// the AI's model; not replayed". It is never replayed and never claimed
// deterministic; its sha256 enters `memory_hash`.
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { canonical, sha256hex } from './config.mjs';
import { tagHex } from '../persona/names.mjs';

export const SUMMARY_LABEL = Object.freeze({
  en: "Written by the AI's model; not verified, not replayed.",
  ja: 'AIのモデルが書いた文章です。確認も再現もされていません。',
});

const writeAtomic = (path, data) => { const tmp = `${path}.${process.pid}.tmp`; writeFileSync(tmp, data); renameSync(tmp, path); };

export function createSummaryStore({ stateDir }) {
  const dirOf = tag => join(stateDir, 'summary', tagHex(tag));
  return {
    /** Store a validated summary (`text` is already sanitised). Returns {bell, text, sha256}. */
    save(tag, bell, text) {
      const dir = dirOf(tag);
      mkdirSync(dir, { recursive: true });
      writeAtomic(join(dir, `${bell}.txt`), text);
      return { bell, text, sha256: sha256hex(text) };
    },
    /** The newest summary of an AI, or null. */
    latest(tag) {
      const dir = dirOf(tag);
      if (!existsSync(dir)) return null;
      const bells = readdirSync(dir).map(f => /^(\d+)\.txt$/.exec(f)?.[1]).filter(Boolean).map(Number).sort((a, b) => b - a);
      if (!bells.length) return null;
      const text = readFileSync(join(dir, `${bells[0]}.txt`), 'utf8');
      return { bell: bells[0], text, sha256: sha256hex(text) };
    },
  };
}

/** The published summary file body (PUB/memory/<tag>/summary.json). */
export const summaryFile = (tag, s) => ({ v: 1, tag: tagHex(tag), bell: s.bell, text: s.text, sha256: s.sha256, label: SUMMARY_LABEL });

/** memory_hash = sha256(ledger canonical ‖ retrieved episode ids ‖ summary sha256) (§7.2). */
export function memoryHash(ledger, retrievedIds, summarySha = '') {
  const l = typeof ledger?.canonical === 'function' ? ledger.canonical() : canonical(ledger);
  return sha256hex(l, canonical(retrievedIds), summarySha ?? '');
}
