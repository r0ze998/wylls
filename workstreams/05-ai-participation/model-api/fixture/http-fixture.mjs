// A LOCAL HTTP FIXTURE that answers like the two providers' endpoints, on 127.0.0.1 only.
// It is not a model and not a provider: every answer comes from a script, with invented values,
// in the field shapes of the official references (model-api/src/contract.mjs lists them).
//
//   POST /v1/messages   (Anthropic Messages API shape)
//   POST /v1/responses  (OpenAI Responses API shape)
//
// A script step is one of:
//   {answer: <decision JSON>, usage?, stopReason?/status?, model?}   a 200 with that answer as text
//   {status, error: {type?, code?}, headers?}                         an error body of the provider's shape
//   {delayMs}                                                         answer after a delay (for client timeouts)
//   {hangUp: 'before-headers' | 'mid-body'}                           drop the connection
// `script(body, n, path)` returns the step for the n-th request (0-based).
import { createServer } from 'node:http';

const claudeOk = (body, step, n) => ({
  id: `msg_fixture_${n}`, type: 'message', role: 'assistant', model: step.model ?? body.model,
  content: [{ type: 'text', text: JSON.stringify(step.answer) }], stop_reason: step.stopReason ?? 'end_turn', stop_sequence: null, stop_details: null,
  usage: step.usage ?? { input_tokens: 900, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 }, output_tokens: 120, output_tokens_details: { thinking_tokens: 30 }, service_tier: 'standard' },
});
const gptOk = (body, step, n) => ({
  id: `resp_fixture_${n}`, object: 'response', status: step.status ?? 'completed', model: step.model ?? body.model,
  output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(step.answer) }] }],
  usage: step.usage ?? { input_tokens: 900, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, output_tokens: 120, output_tokens_details: { reasoning_tokens: 30 }, total_tokens: 1020 },
});

export async function startHttpFixture(script) {
  let n = 0;
  const seen = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const i = n++;
    let body = null;
    try { body = JSON.parse(raw); } catch { body = null; }
    seen.push({ path: req.url, headers: { ...req.headers }, body });
    const step = (await script(body, i, req.url)) ?? {};
    if (step.delayMs) await new Promise(r => setTimeout(r, step.delayMs));
    if (step.hangUp === 'before-headers') return req.socket.destroy();
    const claude = req.url === '/v1/messages';
    const rid = claude ? { 'request-id': `req_fixture_${i}` } : { 'x-request-id': `req_fixture_${i}` };
    if (step.status && step.status !== 200) {
      const err = claude ? { type: 'error', error: { type: step.error?.type ?? 'api_error', message: 'fixture' }, request_id: `req_fixture_${i}` } : { error: { type: step.error?.type ?? 'server_error', code: step.error?.code ?? null, message: 'fixture' } };
      res.writeHead(step.status, { 'content-type': 'application/json', ...rid, ...(step.headers ?? {}) });
      return res.end(JSON.stringify(err));
    }
    const ok = JSON.stringify(claude ? claudeOk(body, step, i) : gptOk(body, step, i));
    res.writeHead(200, { 'content-type': 'application/json', ...rid });
    if (step.hangUp === 'mid-body') { res.write(ok.slice(0, Math.floor(ok.length / 2))); return setTimeout(() => req.socket.destroy(), 10); }
    res.end(ok);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, seen, requests: () => n, close: () => new Promise(r => { server.closeAllConnections?.(); server.close(r); }) };
}

/** A port on loopback with nothing listening (for "connection refused before sending"). */
export async function closedPort() {
  const s = createServer();
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  const port = s.address().port;
  await new Promise(r => s.close(r));
  return `http://127.0.0.1:${port}`;
}
