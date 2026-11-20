// Workstream 12: the deterministic fixture (scenario-core.mjs) with a KEY-FREE signer. The fixture's TEST-ONLY
// ed25519 keys are deterministic and so are their signatures, so every signature the key-free tests need was made
// once by tools/presign.mjs (with fixtures/scenario.mjs's keys) and committed to presigned-signatures.json beside the
// public halves. This module only looks them up: it never generates, derives or uses a key, and what memory does
// with them (verifyAllocation: createPublicKey + verify of a signature someone else made) is unchanged.
//   - a signature or public key that is not in the table throws, naming the regeneration command;
//   - WS12_PRESIGN_RECORD=<file> (tools/presign.mjs only) appends each missing entry to <file> as a JSON line and
//     returns a placeholder instead, so one pass collects what to sign.
// test/presigned-table.test.mjs (a key test, not run key-free) re-signs every entry with the fixture keys.
import { appendFileSync, readFileSync } from 'node:fs';
import { installSigner } from './scenario-core.mjs';

export const PRESIGNED_FORMAT = 'wylls.memory12.presigned/v1';
// WS12_PRESIGN_TABLE: another table (tools/presign.mjs builds the new one beside the committed one, never over it).
export const PRESIGNED_PATH = process.env.WS12_PRESIGN_TABLE || new URL('./presigned-signatures.json', import.meta.url);
const table = JSON.parse(readFileSync(PRESIGNED_PATH, 'utf8'));
if (table.format !== PRESIGNED_FORMAT) throw new Error(`fixtures/presigned-signatures.json: format ${table.format}, want ${PRESIGNED_FORMAT}`);
const publics = new Map(Object.entries(table.public));
const sigs = new Map(table.signatures.map(e => [`${e.tag}\n${e.bytes}`, e.sig]));
const record = process.env.WS12_PRESIGN_RECORD || null;
const REGEN = 'node workstreams/12-memory/tools/presign.mjs';

function missing(entry, placeholder) {
  if (!record) throw new Error(`fixtures/presigned: no ${entry.kind} for ${entry.tag} in presigned-signatures.json (a new signed allocation in a key-free test: run ${REGEN})`);
  appendFileSync(record, JSON.stringify(entry) + '\n');
  return placeholder;
}

installSigner({
  name: 'presigned',
  publicHex: tag => publics.get(tag) ?? missing({ kind: 'public', tag }, '00'.repeat(32)),
  signatureHex: (tag, bytes) => {
    const text = bytes.toString('utf8');
    return sigs.get(`${tag}\n${text}`) ?? missing({ kind: 'signature', tag, bytes: text }, '00'.repeat(64));
  },
});
export * from './scenario-core.mjs';
