// Which model the agent asks, as configuration, apart from how it is paid
// for (pricing.mjs). Gemma stays one option, not a fixed choice.
//
//   local-openai  any OpenAI-compatible chat server on loopback (llama-server with any GGUF,
//                 the pinned citizens/llama/start-pinned.sh among them). Free of outside cost.
//   scripted      a stand-in that returns prepared answers. Not a model; for tests and demos.
//   external      a hosted API. DECLARED ONLY: this build never sends to one (no credentials are
//                 read, no request is made). Enabling it needs the owner's decision on how its
//                 bill is settled (pricing.mjs SETTLEMENT) and a credential the operator holds.
//
// Every answer carries the CONFIGURED model (what we asked for) and what the
// server SAID it served, kept apart: the pinned start script gives every GGUF
// the alias gemma-4-26b-a4b-it (start-pinned.sh:11), so an alias proves nothing
// about the weights. `identify()` reads the server's own report (/v1/models,
// /props model_path) and keeps only the file's base name.
//
// What each name is worth (ASSURANCE): the configured name is only our request;
// the alias and the file name are the server's SELF-REPORT (a server can say
// anything); only a hash of the weights file, taken on the host and compared
// with a pinned hash, would identify the model. No hash is taken here, so no
// model is ever "verified" by this code.

export const PROVIDERS = Object.freeze({ LOCAL_OPENAI: 'local-openai', SCRIPTED: 'scripted', EXTERNAL: 'external' });

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** How much a model name proves, weakest first. This code reaches 'self-reported' at most. */
export const ASSURANCE = Object.freeze({
  CONFIGURED: 'configured (our request only)',
  SELF_REPORTED: 'self-reported by the server (alias / file name; not verified)',
  HASH_MATCHED: 'file hash matched a pinned hash (NOT IMPLEMENTED here)',
});

export class ProviderError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/** Presets an owner can pick by name (the model field can name any other). Gemma is one of them, not the default of anything. */
export const MODEL_PRESETS = Object.freeze({
  'gemma-4-26b-local': { provider: PROVIDERS.LOCAL_OPENAI, url: 'http://127.0.0.1:41901', model: 'gemma-4-26b-a4b-it', note: 'citizens/llama/start-pinned.sh; the alias is the same whatever GGUF is loaded' },
  'any-local': { provider: PROVIDERS.LOCAL_OPENAI, url: 'http://127.0.0.1:8080', model: 'local' },
  'scripted': { provider: PROVIDERS.SCRIPTED, model: 'scripted-stand-in' },
});

/** The model configuration, checked; throws ProviderError('BadModelConfig'). */
export function parseModelConfig(input) {
  const c = typeof input === 'string' ? MODEL_PRESETS[input] : input;
  if (!c || typeof c !== 'object') throw new ProviderError('BadModelConfig', `unknown model preset or config: ${String(input).slice(0, 40)}`);
  const bad = m => { throw new ProviderError('BadModelConfig', m); };
  const model = typeof c.model === 'string' && c.model.length > 0 && c.model.length <= 120 ? c.model : bad('model must be a name');
  const common = { model, deadlineMs: Number.isInteger(c.deadlineMs) && c.deadlineMs > 0 ? c.deadlineMs : 30_000, maxTokens: Number.isInteger(c.maxTokens) && c.maxTokens > 0 ? c.maxTokens : 400 };
  switch (c.provider) {
    case PROVIDERS.LOCAL_OPENAI: {
      let u;
      try { u = new URL(c.url); } catch { bad('url is required'); }
      if (!LOOPBACK.has(u.hostname)) bad(`${u.hostname}: a local model server on loopback only (an outside host is the external provider, which is not enabled)`);
      return { provider: c.provider, url: u.origin, ...common };
    }
    case PROVIDERS.SCRIPTED: return { provider: c.provider, ...common };
    case PROVIDERS.EXTERNAL:
      // Recorded so the owner can see what was asked for; never usable here. The credential's NAME may be given, its value is never read.
      return { provider: c.provider, vendor: String(c.vendor ?? '').slice(0, 40), credentialEnv: typeof c.credentialEnv === 'string' ? c.credentialEnv.slice(0, 64) : null, enabled: false, ...common };
    default: return bad(`provider must be one of ${Object.values(PROVIDERS).join(', ')}`);
  }
}

const baseName = p => (typeof p === 'string' && p ? p.split(/[\\/]/).pop().slice(0, 120) : null);

/**
 * @param {object} cfg       parseModelConfig's answer
 * @param {object} [deps]    {fetch, answer: (body, n) => object (scripted), now}
 * @returns {{kind, configuredModel, identify(), complete(body, {deadlineMs}), alias}}
 */
export function createProvider(cfg, { fetch: f = globalThis.fetch, answer = null, now = () => Date.now() } = {}) {
  if (cfg.provider === PROVIDERS.EXTERNAL) {
    throw new ProviderError('ProviderNotEnabled', `the external provider (${cfg.vendor || 'unnamed'}) is not enabled in this build: no request is sent and no credential is read. It needs the owner's settlement decision (pricing.mjs) first`);
  }
  if (cfg.provider === PROVIDERS.SCRIPTED) {
    if (typeof answer !== 'function') throw new ProviderError('BadModelConfig', 'the scripted provider needs an answer function');
    let n = 0;
    return {
      kind: cfg.provider, configuredModel: cfg.model, alias: cfg.model, calls: [],
      async identify() { return { reportedAlias: cfg.model, modelFile: null, source: 'scripted (not a model)', assurance: ASSURANCE.CONFIGURED, verified: false }; },
      async complete(body) {
        n += 1;
        this.calls.push(body);
        const t0 = now();
        try {
          const a = await answer(body, n);
          return { ok: true, content: JSON.stringify(a), usage: { prompt_tokens: Math.ceil(JSON.stringify(body.messages ?? '').length / 3), completion_tokens: 40 }, servedModel: cfg.model, latencyMs: now() - t0 };
        } catch (e) { return { ok: false, error: String(e?.message ?? e).slice(0, 120), usage: null, servedModel: cfg.model, latencyMs: now() - t0 }; }
      },
    };
  }
  // local-openai
  const getJson = async (path, ms = 3_000) => {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), ms);
    try { const r = await f(cfg.url + path, { signal: ac.signal }); return r.ok ? await r.json() : null; } catch { return null; } finally { clearTimeout(t); }
  };
  return {
    kind: cfg.provider, configuredModel: cfg.model, alias: cfg.model, url: cfg.url,
    /** What the server says it runs: the alias it answers to and the file it loaded (base name only). Null fields: not reported. */
    async identify() {
      const [models, props] = await Promise.all([getJson('/v1/models'), getJson('/props')]);
      return { reportedAlias: models?.data?.[0]?.id ?? props?.model_alias ?? null, modelFile: baseName(props?.model_path ?? props?.default_generation_settings?.model), source: models || props ? 'server report' : 'not reported',
        assurance: models || props ? ASSURANCE.SELF_REPORTED : ASSURANCE.CONFIGURED, verified: false };
    },
    async complete(body, { deadlineMs = cfg.deadlineMs } = {}) {
      const ac = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; ac.abort(); }, Math.max(1, deadlineMs));
      const t0 = now();
      try {
        const r = await f(cfg.url + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, model: cfg.model }), signal: ac.signal });
        let j = null;
        try { j = await r.json(); } catch { j = null; }
        const ch = j?.choices?.[0];
        if (!r.ok || !ch) return { ok: false, error: !r.ok ? `http ${r.status}` : 'parse', usage: j?.usage ?? null, servedModel: j?.model ?? null, latencyMs: now() - t0 };
        return { ok: true, content: ch.message?.content ?? '', usage: j.usage ?? null, servedModel: j.model ?? null, fingerprint: j.system_fingerprint ?? null, latencyMs: now() - t0 };
      } catch (e) {
        return { ok: false, error: timedOut ? 'timeout' : 'net', usage: null, servedModel: null, latencyMs: now() - t0 };
      } finally { clearTimeout(timer); }
    },
  };
}
