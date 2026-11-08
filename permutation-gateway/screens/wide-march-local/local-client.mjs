// Browser-side request logic of the LOCAL demo, with an injectable fetch (so Node tests drive it with a fake bridge).
// Pure of DOM. Rules:
//   - at most ONE request in flight; mutation controls are disabled by `busy` and a second submit is refused here too;
//   - every request carries a token; a reply whose token is no longer current is discarded (never painted);
//   - a failed/garbled/timed-out fetch CLEARS the shown state (it is no longer known) and never retries a submission;
//     the only recovery is an explicit refresh, which is a GET of /api/state;
//   - every state shown has passed the model (parser, identity, structure) and every POST answer also the transition check.
import {
  PROTOCOL, parseReplyObject, validateState, checkTransition, commandFromBody,
  commandFromQuoteBody, parseRouteQuote, LocalModelError,
} from './local-model.mjs';

export const ACTION_HEADER = 'X-Wylls-Local-Action';
export const ROUTES = Object.freeze({ state: '/api/state', action: '/api/action', reset: '/api/reset', open: '/api/open', quote: '/api/quote', depart_route: '/api/depart_route' });
const MAX_TEXT = 1048576 + 8192;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** A UI intent → [route, body, command]. `expectedRevision` is always the revision currently shown. */
export function bodyFor(intent, revision) {
  if (intent.kind === 'reset') return ['reset', { expectedRevision: revision }];
  // opening carries only canonical coordinate strings; the host decides ring, budget and duplicates
  if (intent.kind === 'open_province') return ['open', { expectedRevision: revision, p: intent.p, q: intent.q }];
  // a chosen march carries only the quoted directions; the host re-quotes them and binds what it walked
  if (intent.kind === 'depart_route') return ['depart_route', { expectedRevision: revision, dirs: intent.dirs }];
  return ['action', { expectedRevision: revision, action: intent.kind }];
}
/** The host's binding must be exactly the quote the player sent from: directions, end province and tile, every
 * step and the provinces entered. Anything else is not the march the player chose. */
export function bindingMatchesQuote(binding, dirs, quote) {
  return !!binding && binding.kind === 'chosen' && binding.directions === dirs && !!quote && quote.reachable === true
    && same({ p: binding.destination.p, q: binding.destination.q, tile: binding.destination.tile }, quote.end)
    && same(binding.steps, quote.steps.map(({ p, q, tile }) => ({ p, q, tile })))
    && same(binding.provincesEntered, quote.provincesEntered);
}

export function createClient({ fetchFn, initial, onChange = () => {}, timeoutMs = 10000 }) {
  let seq = 0, ctrl = null;
  let s = Object.freeze({
    phase: 'init',       // init | loading | ready | error | uncertain
    busy: false, state: null, parsed: null, lastResult: null, notice: null, error: null, reason: null,
    quote: null, quoteDirs: null,   // the last host route quote (non-mutating), cleared whenever state changes
  });
  const set = patch => { s = Object.freeze({ ...s, ...patch }); try { onChange(s); } catch { /* a paint error must not break the client */ } };
  const clear = patch => set({ state: null, parsed: null, quote: null, quoteDirs: null, ...patch });
  const freshQuote = { quote: null, quoteDirs: null };

  // one fetch; resolves {status, json} or throws; a stale token is detected by the caller
  async function send(method, route, body) {
    ctrl?.abort?.();
    ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const init = {
      method, cache: 'no-store', credentials: 'same-origin', redirect: 'error', referrerPolicy: 'no-referrer', signal: ctrl?.signal,
      headers: method === 'POST' ? { 'Content-Type': 'application/json', [ACTION_HEADER]: PROTOCOL } : { Accept: 'application/json' },
    };
    if (method === 'POST') init.body = JSON.stringify(body);
    const activeCtrl = ctrl;
    let timer;
    const work = (async () => { const res = await fetchFn(ROUTES[route], init); return { res, text: await res.text() }; })();
    const timed = new Promise((_, reject) => { timer = setTimeout(() => {
      activeCtrl?.abort?.(); reject(new LocalModelError('Timeout', 'request timed out'));
    }, timeoutMs); });
    let res, text;
    try { ({ res, text } = await Promise.race([work, timed])); } finally { clearTimeout(timer); }
    if (typeof text !== 'string' || text.length > MAX_TEXT) throw new LocalModelError('BadResponse', 'size');
    let json;
    try { json = JSON.parse(text); } catch { throw new LocalModelError('BadResponse', 'not JSON'); }
    return { status: res.status, json };
  }

  // a server view → validated {parsed, state} or the uncertain marker; throws on anything off-schema
  function readView(v) {
    if (!v || typeof v !== 'object' || v.v !== 1 || v.protocol !== PROTOCOL || v.mode !== 'local-simulation' || v.mockAuth !== true) throw new LocalModelError('BadResponse', 'view');
    if (v.uncertain === true) return { uncertain: true, reason: v.reason ?? null, lastResult: v.lastResult ?? null };
    if (v.uncertain !== false || v.phase !== 'ready' || v.reply === null) throw new LocalModelError('BadResponse', 'view phase');
    const parsed = parseReplyObject(v.reply);
    const state = validateState(parsed, initial);
    if (v.revision !== state.revision) throw new LocalModelError('BadResponse', 'view revision');
    return { uncertain: false, parsed, state, lastResult: v.lastResult ?? null };
  }

  const failClosed = (e, what) => clear({ busy: false, phase: 'error', error: { code: e?.code ?? 'Error', message: String(e?.message ?? e), what }, notice: null });

  async function refresh() {
    if (s.busy && s.phase !== 'loading') return { ok: false, reason: 'busy' }; // never refresh over a mutation in flight
    const token = ++seq;
    clear({ phase: 'loading', busy: true, error: null, notice: null });
    try {
      const { status, json } = await send('GET', 'state');
      if (token !== seq) return { ok: false, reason: 'discarded' };
      if (status !== 200) throw new LocalModelError('BadResponse', `HTTP ${status}`);
      const r = readView(json?.view);
      if (r.uncertain) { clear({ busy: false, phase: 'uncertain', reason: r.reason, lastResult: r.lastResult }); return { ok: false, reason: 'uncertain' }; }
      set({ busy: false, phase: 'ready', state: r.state, parsed: r.parsed, lastResult: r.lastResult, error: null, reason: null, ...freshQuote });
      return { ok: true };
    } catch (e) {
      if (token !== seq) return { ok: false, reason: 'discarded' };
      failClosed(e, 'refresh');
      return { ok: false, reason: 'error' };
    }
  }

  async function submit(intent, fromQuote = null) {
    if (s.busy) return { ok: false, reason: 'busy' };
    if (s.phase !== 'ready' || !s.state) return { ok: false, reason: 'no-state' };
    // a chosen march is sent only from the current host quote (departRoute), never as a free intent
    if (intent?.kind === 'depart_route' && fromQuote === null) { set({ notice: { kind: 'input', code: 'QuoteRequired' } }); return { ok: false, reason: 'input' }; }
    let route, body, cmd;
    try {
      [route, body] = bodyFor(intent, s.state.revision);
      cmd = commandFromBody(route, body); // the same exact schema the server enforces
    } catch (e) { set({ notice: { kind: 'input', code: e.code ?? 'BadIntent' } }); return { ok: false, reason: 'input' }; }
    const prev = s.parsed;
    const token = ++seq;
    set({ busy: true, notice: null });
    try {
      const { status, json } = await send('POST', route, body);
      if (token !== seq) return { ok: false, reason: 'discarded' };
      if (status === 429 || status === 400 || status === 403 || status === 411 || status === 413 || status === 415) {
        // refused before reaching the host: nothing changed, the shown state is still the host's
        set({ busy: false, notice: { kind: 'not-sent', code: json?.error ?? `HTTP ${status}` } });
        return { ok: false, reason: 'not-sent' };
      }
      if (status === 409 || status === 200) {
        const r = readView(json?.view);
        if (r.uncertain) throw new LocalModelError('BadResponse', 'uncertain view with a normal status');
        if (status === 409) {
          set({ busy: false, phase: 'ready', state: r.state, parsed: r.parsed, lastResult: r.lastResult, notice: { kind: 'stale' }, ...freshQuote });
          return { ok: false, reason: 'stale' };
        }
        if (json.outcome !== 'ok' && json.outcome !== 'refused') throw new LocalModelError('BadResponse', 'outcome');
        const seen = checkTransition(prev, cmd, r.parsed, initial);
        if (seen !== json.outcome || (r.lastResult?.outcome !== seen)) throw new LocalModelError('BadResponse', 'outcome disagrees with the state');
        if (cmd.kind === 'depart_route' && seen === 'ok' && !bindingMatchesQuote(r.parsed.marchBinding, fromQuote.dirs, fromQuote.quote)) {
          // the host bound something other than the quoted route: not the player's march; show nothing stale
          throw new LocalModelError('BadResponse', 'the bound route is not the quoted route');
        }
        // a refusal as unreachable carries the host's read-only quote of the refused directions: shown, never re-sent
        const refusedQuote = cmd.kind === 'depart_route' && seen === 'refused' && r.parsed.routeQuote ? { quote: r.parsed.routeQuote, quoteDirs: cmd.dirs } : freshQuote;
        set({ busy: false, phase: 'ready', state: r.state, parsed: r.parsed, lastResult: r.lastResult, notice: { kind: json.outcome, code: r.state.error }, ...refusedQuote });
        return { ok: json.outcome === 'ok', reason: json.outcome };
      }
      if (status === 502 || status === 503) {
        const r = readView(json?.view);
        if (!r.uncertain) throw new LocalModelError('BadResponse', 'a host failure without the uncertain marker');
        clear({ busy: false, phase: 'uncertain', reason: r.reason, lastResult: r.lastResult, notice: null });
        return { ok: false, reason: 'uncertain' };
      }
      throw new LocalModelError('BadResponse', `HTTP ${status}`);
    } catch (e) {
      if (token !== seq) return { ok: false, reason: 'discarded' };
      // the outcome of THIS submission is unknown: show nothing stale, never retry it; the player refreshes with a GET
      failClosed(e, 'submit');
      return { ok: false, reason: 'unknown' };
    }
  }

  // A non-mutating route quote: the host validates a chosen path over the really-opened provinces. It never changes
  // the shown state or revision; a transport failure clears the view like any lost request, never a silent retry.
  async function quote(dirs) {
    if (s.busy) return { ok: false, reason: 'busy' };
    if (s.phase !== 'ready' || !s.state) return { ok: false, reason: 'no-state' };
    try { commandFromQuoteBody({ dirs }); } catch (e) { set({ notice: { kind: 'input', code: e.code ?? 'BadIntent' } }); return { ok: false, reason: 'input' }; }
    const token = ++seq;
    const ps = new Set(s.state.map.provinces.map(p => `${p.p},${p.q}`));
    set({ busy: true, notice: null });
    try {
      const { status, json } = await send('POST', 'quote', { dirs });
      if (token !== seq) return { ok: false, reason: 'discarded' };
      if (status === 429 || status === 400 || status === 403 || status === 411 || status === 413 || status === 415) {
        set({ busy: false, notice: { kind: 'not-sent', code: json?.error ?? `HTTP ${status}` } });
        return { ok: false, reason: 'not-sent' };
      }
      if (status === 200) {
        const r = readView(json?.view);
        if (r.uncertain) throw new LocalModelError('BadResponse', 'uncertain view with a normal status');
        if (r.state.revision !== s.state.revision) throw new LocalModelError('BadResponse', 'a quote changed the revision');
        parseRouteQuote(json.routeQuote, ps);   // re-validate shape and the known-province cross-check in the browser
        set({ busy: false, quote: json.routeQuote, quoteDirs: dirs, notice: { kind: 'quote', code: json.routeQuote.reachable ? 'REACHABLE' : json.routeQuote.reason } });
        return { ok: true, quote: json.routeQuote };
      }
      if (status === 502 || status === 503) {
        const r = readView(json?.view);
        if (!r.uncertain) throw new LocalModelError('BadResponse', 'a host failure without the uncertain marker');
        clear({ busy: false, phase: 'uncertain', reason: r.reason, lastResult: r.lastResult, notice: null });
        return { ok: false, reason: 'uncertain' };
      }
      throw new LocalModelError('BadResponse', `HTTP ${status}`);
    } catch (e) {
      if (token !== seq) return { ok: false, reason: 'discarded' };
      failClosed(e, 'quote');
      return { ok: false, reason: 'unknown' };
    }
  }

  // The one explicit chosen-march send: the current, reachable host quote's exact directions at the shown revision.
  // No quote, an unreachable quote, or a stale one (quotes are cleared by every state change) sends nothing.
  async function departRoute() {
    if (s.busy) return { ok: false, reason: 'busy' };
    if (s.phase !== 'ready' || !s.state) return { ok: false, reason: 'no-state' };
    const q = s.quote, dirs = s.quoteDirs;
    if (!q || q.reachable !== true || typeof dirs !== 'string' || !s.state.allowed.includes('depart_route')) {
      set({ notice: { kind: 'input', code: 'NoReachableQuote' } }); return { ok: false, reason: 'input' };
    }
    return submit({ kind: 'depart_route', dirs }, { dirs, quote: q });
  }

  return Object.freeze({ refresh, submit, quote, departRoute, get snapshot() { return s; } });
}
