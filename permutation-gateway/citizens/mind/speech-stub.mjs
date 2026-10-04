// FALLBACK ONLY. AC1b owns the real sanitiser, V5 and V5b (citizens/mind/{sanitize,speech,reason}.mjs).
// AC1b is built in parallel, so AC1a ships this small stand-in with the interface the mind calls:
//   sanitize(text, {limit, untrusted, summary}) -> string                        (section 4.6, all steps)
//   checkSay(text, ctx)  -> {ok, text, reason}                                    (V5 subset)
//   checkWhy(text, ctx)  -> {ok, text, reason}                                    (V5b subset)
// It implements: the sanitiser of section 4.6, the length limits, URL / hex / base58 / coordinate
// patterns, the sealed set (coordinates and names), the pinned pact words and human/operator claims
// (short lists), capture claims, and the memory-claim-without-citation rule. It does NOT implement the
// number-in-facts rule, the 24-code-point echo check, the direction/target-kind word lists, the abuse
// denylist or the language-script rule: server.mjs refuses to start with this stand-in unless
// config.allow_speech_stub is true, and /v1/health reports `speech: "stub"` so a run cannot use it unnoticed.
// The integrator replaces it by AC1b's modules at merge (the three call sites are in validate.mjs and prompt.mjs).
const PACT_WORDS = /\b(betray\w*|pact|treaty|alliance|promise\w*|truce)\b|裏切|約束|同盟|条約|協定/i;
const HUMAN_CLAIMS = /\b(i am (a )?human|i'm (a )?human|not an? (ai|bot)|i am the (operator|admin)|i'm the (operator|admin))\b|人間です|AIではない|運営です/i;
const CAPTURE = /\b(captur\w+|conquer\w*|occup\w+|annex\w*|take over)\b[^.]{0,30}\b(village|land|province)\b|占領|征服した|領土を奪/i;
const MEMORY_CLAIM = /\b(remember|recall|earlier|last time)\b|覚え|以前/i;

export function sanitize(text, { limit = 280, untrusted = false, summary = false } = {}) {
  let s = String(text ?? '').normalize('NFKC');
  s = s.replace(/<\|?[A-Za-z_"/]*\|?>/g, ' ');
  s = s.replace(/\[\/?INST\]|<<\/?SYS>>/gi, ' ');
  s = s.replace(/\p{C}/gu, ' ');
  s = s.replace(/</g, '‹').replace(/>/g, '›').replace(/`/g, "'");
  if (untrusted || summary) {
    s = s.replace(/\{/g, '｛').replace(/\}/g, '｝').replace(/\[/g, '［').replace(/\]/g, '］');
    s = s.replace(/\bM(\d{1,2})\b/g, 'Ｍ$1');
  }
  s = s.replace(/\s+/g, ' ').trim();
  const cps = [...s];
  if (cps.length > limit) s = cps.slice(0, Math.max(0, limit - 1)).join('') + '…';
  return s;
}

function sealedHit(text, sealed = []) {
  for (const e of sealed) {
    const [p, q] = e.pq ?? [];
    if (p != null && new RegExp(`\\(?\\s*${p}\\s*,\\s*${q}\\s*\\)?`).test(text)) return 'sealed_coordinate';
    for (const n of e.names ?? []) if (n && text.toLowerCase().includes(String(n).toLowerCase())) return 'sealed_name';
  }
  return null;
}

function common(text, ctx) {
  const s = sanitize(text, { limit: ctx.limit ?? 280 });
  if (!s) return { ok: false, reason: 'empty' };
  if (/https?:\/\/|www\./i.test(s)) return { ok: false, reason: 'url' };
  if (/\b[0-9a-fA-F]{32,}\b/.test(s) || /\b[1-9A-HJ-NP-Za-km-z]{32,}\b/.test(s)) return { ok: false, reason: 'long_token' };
  const hit = sealedHit(s, ctx.sealed);
  if (hit) return { ok: false, reason: hit };
  if (PACT_WORDS.test(s)) return { ok: false, reason: 'pact_word' };
  if (HUMAN_CLAIMS.test(s)) return { ok: false, reason: 'human_claim' };
  if (CAPTURE.test(s)) return { ok: false, reason: 'capture_claim' };
  if (MEMORY_CLAIM.test(s) && !(ctx.mem?.length > 0)) return { ok: false, reason: 'uncited_memory_claim' };
  return { ok: true, text: s };
}

export function createSpeechStub() {
  return {
    stub: true,
    sanitize,
    checkSay: (text, ctx = {}) => common(text, { ...ctx, limit: 280 }),
    checkWhy: (text, ctx = {}) => common(text, { ...ctx, limit: 200 }),
  };
}
