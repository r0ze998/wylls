// ⑯ v2 web key hook: the loader (module.register). See v16-web-key-hook2.mjs.
const RULES = [
  ['/permutation-server/web/session.mjs', ['publicKeyOf', 'keyFromSeed', 'importBackup']],
  ['/permutation-server/web/wallet.mjs', ['devWallet', 'enableDevWallet']],
  ['/permutation-server/web/frontier/fsession.mjs', ['importBackup']],
];
const refusal = (file, n) => `\nexport function ${n}() { const what = ${JSON.stringify(`${file} ${n}`)}; const log = process.env.V16_KEY_HOOK_LOG; if (log) process.getBuiltinModule('node:fs').appendFileSync(log, process.pid + ' ' + what + '\\n'); throw new Error('⑯ key hook: ' + what + ' refused'); }\n`;
export async function load(url, context, next) {
  const r = await next(url, context);
  const rule = RULES.find(([suffix]) => url.endsWith(suffix));
  if (!rule || r.format !== 'module') return r;
  let src = String(r.source);
  for (const n of rule[1]) {
    const re = new RegExp(`export (async )?function ${n}\\(`);
    if (!re.test(src)) { src += `\nexport const __v16_HOOK_MISS_${n} = true;\n`; continue; }
    src = src.replace(re, (_m, a) => `${a ?? ''}function __v16_${n}(`);
    src += refusal(rule[0].split('/').pop(), n);
  }
  return { ...r, source: src };
}
