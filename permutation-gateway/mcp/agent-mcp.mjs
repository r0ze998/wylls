// The agent wallet's MCP connection (docs/agent-wallet/DESIGN.md §11,
// docs/agent-wallet/MCP.md): an MCP server over stdio that lets an outside
// AI ask for actions for ONE agent, through the relay's POST /f/agent/action
// — the same AgentGateway checks as the browser and the operator's runner
// (mode, policy version, mode epoch, allowed actions, the one village, the
// budget, the chain's delegation, the relay's shape rules). There is no MCP
// balance, no MCP payment path and no MCP-only permission: this file holds
// nothing but the agent's capability token, which can only ask for actions
// inside the owner's policy. It cannot create, fund, re-scope, stop, drain or
// rotate the agent (those are owner commands signed by the owner's wallet),
// and it never sees a private key.
//
// Local test assets only. This file starts nothing by itself and connects to
// no outside service: an MCP client (an AI app) runs it as a subprocess with
//
//   WYLLS_AGENT_RELAY=http://127.0.0.1:41630   (the relay; /gw on the herald also works)
//   WYLLS_AGENT_ID=<agent id>
//   WYLLS_AGENT_CAPABILITY=<the token shown once on the owner's page>   (env, not argv: not in `ps`)
//   WYLLS_AGENT_HERALD=http://127.0.0.1:41640  (optional: the public world reads)
//   node permutation-gateway/mcp/agent-mcp.mjs
//
// Transport: newline-delimited JSON-RPC 2.0 on stdin/stdout (the MCP stdio
// transport); logs go to stderr only.
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

export const PROTOCOL_VERSION = '2025-06-18';
export const SERVER_INFO = Object.freeze({ name: 'wylls-agent-wallet', version: '1.0.0' });

/** Retry keys the caller chooses: a retry of one decision reuses it, a new decision takes a new one. */
const REQUEST_ID = /^[A-Za-z0-9._:-]{8,100}$/;

/** The tools, as tools/list answers them. Owner commands are deliberately absent. */
export const TOOLS = Object.freeze([
  {
    name: 'agent_view',
    description: 'The agent\'s public view: mode (manual = stopped by the owner), policyVersion and modeEpoch to decide under, allowed actions, budget, balances (available / reserved / spent by category), the village, recent history and who drives it now. Read this before deciding.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'agent_terms',
    description: 'The relay\'s terms: the per-call inference price, the game price table (empty: game actions stay free or resource-paid), who pays network fees. Test assets only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'agent_act',
    description: 'Ask for one game action for the agent\'s own village. The relay checks it like any other caller (mode, policy version, mode epoch, allowed action, village, budget, on-chain delegation, game rules). Pass the policyVersion and modeEpoch you read with agent_view: a stop or a policy change since then refuses the request. requestId is your retry key: reuse it to retry the same decision (it is never sent twice), use a new one for a new decision.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['requestId', 'policyVersion', 'modeEpoch', 'action'],
      properties: {
        requestId: { type: 'string', pattern: REQUEST_ID.source },
        policyVersion: { type: 'integer', minimum: 1 },
        modeEpoch: { type: 'integer', minimum: 0 },
        reason: { type: 'string', maxLength: 200 },
        action: {
          type: 'object', additionalProperties: false, required: ['name'],
          properties: { name: { type: 'string', maxLength: 32 }, fields: { type: 'object' } },
        },
      },
    },
  },
  {
    name: 'world_read',
    description: 'A public world record from the herald (what every player can read): "season", or "province" with p and q.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['what'],
      properties: { what: { type: 'string', enum: ['season', 'province'] }, p: { type: 'integer' }, q: { type: 'integer' } },
    },
  },
]);

const text = obj => [{ type: 'text', text: JSON.stringify(obj) }];
const ok = obj => ({ content: text(obj), structuredContent: obj, isError: false });
const fail = (code, message, extra = {}) => { const e = { ok: false, error: { code, message, ...extra } }; return { content: text(e), structuredContent: e, isError: true }; };

/**
 * The server's logic, transport-free (tests drive it directly).
 * @param {object} o
 * @param {string} o.relay       the relay's base URL
 * @param {string} o.agentId     the one agent this server acts for (a caller cannot name another)
 * @param {string} o.capability  the agent's capability token (kept here; never returned, never logged)
 * @param {string} [o.herald]    the herald's base URL for world_read
 * @param {Function} [o.fetch]
 */
export function createAgentMcp({ relay, agentId, capability, herald = null, fetch: f = globalThis.fetch, log = () => {} }) {
  if (!relay || !agentId || !capability) throw new Error('relay, agentId and capability are required');
  const base = String(relay).replace(/\/+$/, '');
  const scrub = s => String(s ?? '').split(capability).join('[capability]');

  async function http(method, url, body) {
    let res;
    try {
      res = await f(url, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    } catch (e) {
      // The relay was not reached: nothing is known to have been sent. A retry with the same requestId is safe.
      return { transport: true, error: { code: 'RelayUnreachable', message: scrub(e?.message ?? e), retrySameRequestId: true } };
    }
    let json = null;
    try { json = await res.json(); } catch { json = null; }
    return { status: res.status, json };
  }

  async function view() {
    const r = await http('GET', `${base}/f/agent?id=${encodeURIComponent(agentId)}`);
    if (r.transport) return fail(r.error.code, r.error.message, { retrySameRequestId: true });
    if (r.status !== 200) return fail(r.json?.code ?? 'RelayError', scrub(r.json?.error ?? `HTTP ${r.status}`));
    return ok(r.json);
  }

  async function act(args) {
    if (!args || typeof args !== 'object') return fail('BadRequest', 'arguments are required');
    if (typeof args.requestId !== 'string' || !REQUEST_ID.test(args.requestId)) return fail('BadRequest', 'requestId: 8–100 characters of A–Z a–z 0–9 . _ : -');
    if (!Number.isInteger(args.policyVersion) || args.policyVersion < 1) return fail('BadRequest', 'policyVersion (from agent_view) is required');
    if (!Number.isInteger(args.modeEpoch) || args.modeEpoch < 0) return fail('BadRequest', 'modeEpoch (from agent_view) is required');
    if (!args.action || typeof args.action.name !== 'string') return fail('BadRequest', 'action.name is required');
    // The village is the agent's (the gateway refuses any other); read it rather than trust the caller with it.
    const v = await http('GET', `${base}/f/agent?id=${encodeURIComponent(agentId)}`);
    if (v.transport) return fail(v.error.code, v.error.message, { retrySameRequestId: true });
    if (v.status !== 200) return fail(v.json?.code ?? 'RelayError', scrub(v.json?.error ?? `HTTP ${v.status}`));
    const request = {
      agentId, source: 'mcp',
      // Deterministic: the same requestId is the same idempotency key across retries and restarts of this server.
      idempotencyKey: `mcp:${args.requestId}`,
      policyVersion: args.policyVersion, modeEpoch: args.modeEpoch,
      ...(typeof args.reason === 'string' ? { reason: args.reason.slice(0, 200) } : {}),
      action: { name: args.action.name, holding: v.json.village, fields: args.action.fields ?? {} },
    };
    const r = await http('POST', `${base}/f/agent/action`, { capability, request });
    if (r.transport) return fail(r.error.code, r.error.message, { retrySameRequestId: true });
    if (r.status !== 200) return fail(r.json?.code ?? 'RelayError', scrub(r.json?.error ?? `HTTP ${r.status}`), r.json?.code === 'IdempotencyConflict' ? { hint: 'this requestId was used for a different action: use a new requestId' } : {});
    const res = r.json;
    log(`agent_act ${args.action.name} → ${res.status}${res.error ? ` (${res.error.code})` : ''}`);
    // A refusal is a normal answer (status refused, nothing sent, nothing charged), reported as an error to the model.
    return res.ok ? ok(res) : { content: text(res), structuredContent: res, isError: true };
  }

  async function world(args) {
    if (!herald) return fail('NotConfigured', 'no herald URL was given to this server (WYLLS_AGENT_HERALD)');
    const h = String(herald).replace(/\/+$/, '');
    let path;
    if (args?.what === 'season') path = '/h/season';
    else if (args?.what === 'province' && Number.isInteger(args.p) && Number.isInteger(args.q)) path = `/h/province/${args.p},${args.q}/latest`;
    else return fail('BadRequest', 'what: "season", or "province" with integer p and q');
    const r = await http('GET', `${h}${path}`);
    if (r.transport) return fail(r.error.code, r.error.message);
    if (r.status !== 200) return fail('HeraldError', `HTTP ${r.status}`);
    return ok(r.json);
  }

  async function terms() {
    const r = await http('GET', `${base}/f/agent/terms`);
    if (r.transport) return fail(r.error.code, r.error.message);
    if (r.status !== 200) return fail(r.json?.code ?? 'RelayError', scrub(r.json?.error ?? `HTTP ${r.status}`));
    return ok(r.json);
  }

  const tools = { agent_view: view, agent_terms: terms, agent_act: act, world_read: world };

  /** One JSON-RPC message → the response object (or null for a notification). */
  async function handle(msg) {
    const reply = result => ({ jsonrpc: '2.0', id: msg.id, result });
    const error = (code, message) => ({ jsonrpc: '2.0', id: msg?.id ?? null, error: { code, message } });
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return error(-32600, 'invalid request');
    const notification = msg.id === undefined;
    switch (msg.method) {
      case 'initialize':
        return reply({ protocolVersion: typeof msg.params?.protocolVersion === 'string' ? msg.params.protocolVersion : PROTOCOL_VERSION, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO,
          instructions: 'Acts for one Wylls agent within its owner\'s policy and prepaid test-USDC budget. Read agent_view first; pass its policyVersion and modeEpoch to agent_act; reuse a requestId only to retry the same decision.' });
      case 'notifications/initialized': case 'notifications/cancelled': return null;
      case 'ping': return reply({});
      case 'tools/list': return reply({ tools: TOOLS });
      case 'tools/call': {
        const fn = tools[msg.params?.name];
        if (!fn) return error(-32602, `unknown tool ${String(msg.params?.name).slice(0, 40)}`);
        try { return reply(await fn(msg.params?.arguments ?? {})); } catch (e) { return reply(fail('InternalError', scrub(e?.message ?? e))); }
      }
      default: return notification ? null : error(-32601, `method not found: ${msg.method.slice(0, 40)}`);
    }
  }

  return { handle, tools: Object.keys(tools), toJSON: () => ({ relay: base, agentId, herald, capability: '[held]' }) };
}

/** The stdio transport: one JSON-RPC message per line in, one per line out. */
export function serveStdio(server, { input = process.stdin, output = process.stdout } = {}) {
  const rl = createInterface({ input, crlfDelay: Infinity });
  rl.on('line', async line => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { output.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }) + '\n'); return; }
    const res = await server.handle(msg);
    if (res) output.write(JSON.stringify(res) + '\n');
  });
  return rl;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const env = process.env;
  const server = createAgentMcp({ relay: env.WYLLS_AGENT_RELAY, agentId: env.WYLLS_AGENT_ID, capability: env.WYLLS_AGENT_CAPABILITY, herald: env.WYLLS_AGENT_HERALD ?? null, log: m => process.stderr.write(`[wylls-agent-mcp] ${m}\n`) });
  serveStdio(server);
}
