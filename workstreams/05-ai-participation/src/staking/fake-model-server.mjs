// A FAKE OpenAI-compatible model server on 127.0.0.1, for tests and the demo:
// it answers /v1/models, /props and /v1/chat/completions from a script. It
// is not a model. It exists to drive the real HTTP path of the
// local-openai provider and to show the configured model, the alias the
// server reports and the file it says it loaded as three different things
// (the pinned start script names every GGUF gemma-4-26b-a4b-it).
import { createServer } from 'node:http';

/**
 * @param {object} o
 * @param {string} o.alias      what /v1/models and the answers' `model` field say
 * @param {string} o.modelPath  what /props says was loaded (any path; only its base name is kept by the provider)
 * @param {Function} o.answer   (body, n) => the JSON object the model "answers", or throws to answer HTTP 500
 * @param {number} [o.delayMs]  how long each completion takes
 */
export async function startFakeModelServer({ alias, modelPath, answer, delayMs = 0 }) {
  let n = 0;
  const seen = [];
  const server = createServer(async (req, res) => {
    const send = (status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.method === 'GET' && req.url === '/v1/models') return send(200, { object: 'list', data: [{ id: alias, object: 'model' }] });
    if (req.method === 'GET' && req.url === '/props') return send(200, { model_alias: alias, model_path: modelPath, default_generation_settings: { n_ctx: 16384 } });
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      let raw = '';
      for await (const c of req) raw += c;
      const body = JSON.parse(raw);
      n += 1;
      seen.push({ headers: { ...req.headers }, body });
      if (delayMs) await new Promise(r => setTimeout(r, delayMs));
      try {
        const content = JSON.stringify(await answer(body, n));
        return send(200, { id: `fake-${n}`, object: 'chat.completion', model: alias, system_fingerprint: 'fake', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: Math.ceil(raw.length / 4), completion_tokens: Math.ceil(content.length / 4) } });
      } catch (e) { return send(500, { error: { message: String(e?.message ?? e) } }); }
    }
    send(404, { error: 'not found' });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}`, seen, calls: () => n, close: () => new Promise(r => server.close(r)) };
}
