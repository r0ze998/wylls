// Module hook for no-keys-guard.mjs in its STRICT mode (P05_GUARD_DERIVE=1): in the shared modules that make, derive or
// sign, every such export is replaced by one that throws (the source text is rewritten as it loads; nothing on disk
// changes).
const TARGETS = [
  [/\/client\/src\/solana-tx\.mjs$/, ['createProgramAddress', 'findProgramAddress']],
  [/\/client\/src\/keys\.mjs$/, ['loadOrCreateKeypairSync', 'loadOrCreateKeypair']],
  [/\/client\/src\/talk-node\.mjs$/, ['signTalk']],
  [/\/src\/cosign\.mjs$/, ['coSign']],
  [/\/src\/frontier\/agent\/owner-auth\.mjs$/, ['signCommand']],
  [/\/src\/frontier\/routes\/relay\.mjs$/, ['signAs']],
  [/\/client\/src\/frontier\/addresses\.mjs$/, ['withSeed', 'seasonPda', 'programDataAddress']],
  [/\/client\/src\/pda\.mjs$/, []],
];
export async function load(url, context, nextLoad) {
  const r = await nextLoad(url, context);
  const t = TARGETS.find(([re]) => re.test(url));
  if (!t || r.format !== 'module') return r;
  let src = String(r.source);
  for (const name of t[1]) {
    const fn = new RegExp(`^export (async )?function ${name}\\(`, 'm');
    const arrow = new RegExp(`^export const ${name} = (.*);$`, 'm');
    if (fn.test(src)) src = src.replace(fn, `export $1function ${name}() { globalThis.__p05NoKeys('${name}'); }\nfunction __p05_orig_${name}(`);
    else if (arrow.test(src)) src = src.replace(arrow, `export const ${name} = () => globalThis.__p05NoKeys('${name}');`);
    else throw new Error(`no-keys guard: ${name} not found in ${url} (the guard must follow the code)`);
  }
  return { ...r, source: src };
}
