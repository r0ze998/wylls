// llama-server client (contract sections 3.5, 4.4, 7.1). One request shape, temperature 0, top_k 1,
// cache_prompt false, a per-call seed from the pinned rule, response_format json_schema. The exact
// request body text is returned so the record can hash it (request_hash, M9 replay).
// Aborts at the deadline. Never logs prompt text. Loopback only (guards.mjs checks the URL).
import { createHash } from 'node:crypto';

export const KIND_CODE = { session: 0, reaction: 1, reflection: 2, motion: 3, ballot: 4 };

/** u32_le(sha256('wylls-mind-seed/v1' || season u64 || index u32 || bell u32 || kind u8 || attempt u8)[0..4]). */
export function mindSeed({ season, index, bell, kind, attempt = 0 }) {
  const b = Buffer.alloc('wylls-mind-seed/v1'.length + 8 + 4 + 4 + 1 + 1);
  let o = b.write('wylls-mind-seed/v1', 0, 'utf8');
  b.writeBigUInt64LE(BigInt(season), o);
  o += 8;
  b.writeUInt32LE(index >>> 0, o);
  o += 4;
  b.writeUInt32LE(bell >>> 0, o);
  o += 4;
  b.writeUInt8(KIND_CODE[kind] ?? 0, o);
  o += 1;
  b.writeUInt8(attempt & 0xff, o);
  return createHash('sha256').update(b).digest().readUInt32LE(0);
}

/**
 * The llama request body. Key order is fixed (the body text is hashed). requestShape is
 * "response_format" (chat-completions style, measured to work with Gemma 4's jinja template in step 0) or
 * "json_schema" (llama-server's native field, same schema), pinned in the commitments.
 */
export function buildRequestBody({ alias, messages, schemaName, schema, maxTokens, seed, requestShape = 'response_format' }) {
  const body = {
    model: alias,
    messages,
    temperature: 0,
    top_k: 1,
    seed,
    cache_prompt: false,
    max_tokens: maxTokens,
    stream: false,
  };
  if (requestShape === 'json_schema') body.json_schema = schema;
  else body.response_format = { type: 'json_schema', json_schema: { name: schemaName, strict: true, schema } };
  return body;
}

export function createLlm({ url, alias = 'gemma-4-26b-a4b-it', fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
  const base = String(url).replace(/\/+$/, '');
  const tokenCache = new Map();

  async function getJson(path, timeoutMs = 3000) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const r = await fetchImpl(base + path, { signal: ac.signal });
      if (!r.ok) return null;
      return await r.json();
    } catch {
      return null;
    } finally {
      clearTimeout(t);
    }
  }

  return {
    url: base,
    alias,
    /** POST /v1/chat/completions with the given body object; aborts after deadlineMs. */
    async complete(body, { deadlineMs = 60000, signal } = {}) {
      const text = JSON.stringify(body);
      const ac = new AbortController();
      const t0 = now();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        ac.abort();
      }, Math.max(1, deadlineMs));
      if (signal) {
        if (signal.aborted) ac.abort();
        else signal.addEventListener('abort', () => ac.abort(), { once: true });
      }
      const out = { ok: false, request_body: text, latency_ms: 0, error: null };
      try {
        const r = await fetchImpl(base + '/v1/chat/completions', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: text,
          signal: ac.signal,
        });
        out.status = r.status;
        let j = null;
        try {
          j = await r.json();
        } catch {
          out.error = 'parse';
        }
        if (!r.ok) out.error = out.error ?? 'http';
        else if (j) {
          const ch = j.choices?.[0];
          out.ok = Boolean(ch);
          out.content = ch?.message?.content ?? '';
          out.finish_reason = ch?.finish_reason ?? null;
          out.usage = j.usage ?? null;
          out.timings = j.timings ?? null;
          out.fingerprint = j.system_fingerprint ?? null;
          if (!ch) out.error = 'parse';
        }
      } catch (e) {
        out.error = timedOut ? 'timeout' : signal?.aborted ? 'aborted' : 'net';
        out.detail = String(e?.message ?? e).slice(0, 120);
      } finally {
        clearTimeout(timer);
        out.latency_ms = now() - t0;
      }
      return out;
    },
    /** Token count by llama-server /tokenize, cached per text hash. Returns null if the server is unreachable. */
    async countTokens(text) {
      const key = createHash('sha256').update(text).digest('hex');
      if (tokenCache.has(key)) return tokenCache.get(key);
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 5000);
      try {
        const r = await fetchImpl(base + '/tokenize', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content: text }),
          signal: ac.signal,
        });
        if (!r.ok) return null;
        const j = await r.json();
        const n = Array.isArray(j.tokens) ? j.tokens.length : null;
        if (n != null) {
          if (tokenCache.size > 4096) tokenCache.clear();
          tokenCache.set(key, n);
        }
        return n;
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    },
    async health() {
      const j = await getJson('/health');
      return Boolean(j && j.status === 'ok');
    },
    async props() {
      return getJson('/props');
    },
  };
}
