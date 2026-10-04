// `prompt_templates_sha256` of the commitments (contract 7.1): ONE definition for the mind (prompt.mjs) and the registrar.
// sha256 over the lines `<name>\0<sha256 of the file's bytes>\n` of every `*.txt` directly in `dir`, sorted by name.
// (The first versions had two: the mind hashed the file texts in load order, the registrar hashed name and file hash lines.)
// A module of its own with no imports but node builtins, so the registrar (which runs outside the sandbox) does not have to
// load the mind's code to compute a commitment.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';

export function promptTemplatesSha256(dir) {
  const lines = readdirSync(dir)
    .filter((n) => n.endsWith('.txt'))
    .sort()
    .map((n) => `${n}\0${createHash('sha256').update(readFileSync(`${dir}/${n}`)).digest('hex')}\n`);
  return createHash('sha256').update(lines.join('')).digest('hex');
}
