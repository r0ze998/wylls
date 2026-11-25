// READ-ONLY observation of a LOCAL PLAY TEST world (⑤ option B: external AI residents observe over MCP; owner decision
// 2026-11-18: "MCP stays read-only for observation"). The same tools' reads as `Game`, against a local-play world's
// PUBLIC proxy (launcher createWorldProxy): `GET /gw/f/local-play/info` (the relay's public pins: program, Season
// address, cluster) instead of the agent wallet's `GET /f/season`, and the herald's public `/h/*` as before.
//
// There is no agent wallet in a local-play world, and none is made: the connected owner IS the resident. A link is
// owned by the resident's own wallet (it signs the link statement with its own key, auth.mjs), and its `agentId` must
// be that same address (a "self" link). The village is the owner's own first Holding as the public herald reads it.
// Nothing here can write: `submit` and `ownerCommand` answer ReadOnly without any request, there is no capability,
// and the server is built without its write tools (server.mjs `readOnly`). The resident acts — when it acts — only by
// signing its own transactions for the page's own route (`/gw/f/local-play/act/*`), never through this server.
import { Game, GameError } from './game.mjs';
import { createTerritoryReader, claimNow, WIDE_READ_SCHEMA } from './local-play-territory.mjs';
import { storesAt } from '../../../../permutation-server/web/frontier/fland.mjs';
import { RESOURCE_ORDER } from '../../../../permutation-server/web/frontier/resources.mjs';
import { parseWideInventory } from '../../../../permutation-server/web/frontier/fwide.mjs';
import { bellAt } from '../../../../permutation-server/web/frontier/clock.mjs';

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const readOnly = () => ({ status: 403, json: { code: 'ReadOnly', error: 'this MCP server observes a local-play world read-only: it sends nothing' } });

export class LocalPlayGame extends Game {
  /**
   * @param {object} o  as Game: `relay` = the world proxy's `/gw` base (e.g. http://localhost:41412/gw), `herald` =
   *   the world proxy (e.g. http://localhost:41412). Both public, both reads only.
   */
  // (ws13-territory) `pageOrigin`: the launcher page's origin (http://localhost:<launcher port>). With it the server
  // has ONE more read, for get_territory_status: the page's own read-only account read on the world's relay
  // (`POST /gw/f/local-play/act/context` with the schema frontier-local-play-act-wide-read-v1 — one getMultipleAccounts,
  // program-owned accounts only, nothing signed, nothing sent), which the world proxy takes only from the page's origin.
  // Without it (null) the territory tool is not listed and no POST is ever made.
  constructor(o) { super(o); this.readOnly = true; this.pageOrigin = o.pageOrigin ?? null; this.territoryReader = null; }

  get territoryRead() { return this.pageOrigin !== null; }

  /** The relay's read-only account read → `[Uint8Array | null]` (an account of another program is answered as absent). */
  async wideRead(addresses) {
    let res;
    try {
      res = await this.fetch(`${this.relay}/f/local-play/act/context`, { method: 'POST', headers: { 'content-type': 'application/json', origin: this.pageOrigin }, body: JSON.stringify({ schema: WIDE_READ_SCHEMA, addresses }) });
    } catch (e) { throw new GameError('RelayUnreachable', `the world's read-only account read did not answer: ${String(e?.message ?? e).slice(0, 120)}`, { retryable: true }); }
    let j = null; try { j = await res.json(); } catch { j = null; }
    if (res.status !== 200 || j?.schema !== WIDE_READ_SCHEMA || !Array.isArray(j.accounts) || j.accounts.length !== addresses.length) throw new GameError('RelayUnreachable', `the world's read-only account read answered ${res.status}${j?.code ? ` ${j.code}` : ''}`, { retryable: true });
    return j.accounts.map(a => (a && typeof a.data_b64 === 'string' ? new Uint8Array(Buffer.from(a.data_b64, 'base64')) : null));
  }

  /**
   * (ws13-territory) The connected owner's PLAYER TERRITORY as that player sees it (local-play-territory.mjs: its own
   * summary and tiles always; other tiles' owners only in its sight). Read-only: herald GETs and the relay's account read.
   */
  async territory(principal) {
    if (!this.territoryRead) throw new GameError('TerritoryReadOff', 'this server was started without the page origin (WYLLS_MCP_PAGE_ORIGIN): the territory records are not read');
    if (principal.agentId !== principal.owner) throw new GameError('NotOwner', 'a local-play link is the resident\'s own (agentId = owner)');
    const ctx = await this.context();
    const { season, now } = await this.season();
    const me = await this.herald.me(principal.owner);
    if (!me.ok) throw new GameError('HeraldUnavailable', `the owner's record: ${me.code ?? me.error}`, { retryable: true });
    const ring = h => Math.max(Math.abs(Number(h.p)), Math.abs(Number(h.q)), Math.abs(Number(h.p) + Number(h.q)));
    const raw = (me.holdings ?? []).find(h => ring(h) <= 128);
    if (!me.citizen || !raw) throw new GameError('NoVillage', 'the owner has no first village yet (join and place a home first): a tile is paid for by the first home', { retryable: true });
    const tile = Number(raw.tile), home = { p: Number(raw.p), q: Number(raw.q), site: Number(raw.site), tier: Number(raw.tier ?? 0), ...(Number.isInteger(tile) && tile >= 0 && tile <= 60 ? { tile } : {}) };
    // (its own wide villages, with the page's own parser over its own record: the nearest own village names a tile's upkeep distance)
    let villages = [];
    try {
      const inv = parseWideInventory(me.record, { seasonAddress: this.addresses.season, programId: ctx.programId, seasonId: ctx.seasonId, citizen: this.addresses.of('Citizen', { wallet: principal.owner }), citizenRecord: me.citizen, viewerKey: principal.owner });
      if (inv?.status === 'ready') villages = inv.slots.filter(s => s.holding).map(s => ({ p: String(s.holding.p), q: String(s.holding.q), site: Number(s.holding.site) }));
    } catch { villages = []; }
    if (!this.territoryReader || this.territoryReader.key !== ctx.key) {
      const getJson = async url => { const r = await this.json('GET', url); if (r.transport || r.status !== 200) throw new Error(`GET ${url}: ${r.status ?? r.error}`); return r.json; };
      this.territoryReader = { key: ctx.key, reader: createTerritoryReader({ herald: this.heraldBase, addresses: this.addresses, programId: ctx.programId, getJson, read: a => this.wideRead(a) }) };
    }
    const bell = bellAt(Number(season.genesisTs), now);
    const view = await this.territoryReader.reader.view({ wallet: principal.owner, home, faction: Number(me.citizen.faction), villages, bell });
    let ore = null, foodPerHour = null;
    try { const st = storesAt(raw, now, RESOURCE_ORDER); ore = st[3].value; foodPerHour = st[0].perHour; } catch { ore = null; }
    return { view, home, villages, ore, foodPerHour, now, claim: claimNow(view, { ore }) };
  }

  /**
   * The world's context: the relay's public pins (`/f/local-play/info`: localnet only) and the herald's Season id,
   * which must derive the very Season address the relay pins (fail closed otherwise). TTL reuse as Game's.
   */
  async context() {
    const t = this.now();
    if (this.pinned && t - this.pinnedAt < this.contextTtlMs) return this.pinned;
    const info = await this.json('GET', `${this.relay}/f/local-play/info`);
    if (info.transport || info.status !== 200) throw new GameError('RelayUnreachable', 'the world did not answer GET /gw/f/local-play/info', { retryable: true });
    const i = info.json;
    if (!i || i.localPlay !== true || i.cluster !== 'localnet' || !BASE58.test(String(i.program)) || !BASE58.test(String(i.season))) throw new GameError('ContextUnavailable', 'the world\'s pins are not a local-play localnet world', { retryable: false });
    const s = await this.json('GET', `${this.heraldBase}/h/season`);
    const seasonId = s.json?.season;
    if (s.transport || s.status !== 200 || !/^[0-9]{1,20}$/.test(String(seasonId ?? ''))) throw new GameError('HeraldUnavailable', 'the herald\'s season could not be read', { retryable: true });
    const key = `${i.program}:${seasonId}`;
    if (!this.pinned || this.pinned.key !== key) {
      const addresses = this.addressesFor(i.program, String(seasonId));
      if (addresses.season !== undefined && addresses.season !== i.season) throw new GameError('ContextUnavailable', 'the herald\'s Season is not the one the world\'s relay pins', { retryable: false });
      const next = { key, programId: i.program, seasonId: String(seasonId), since: new Date(t).toISOString(), localPlay: true, cluster: 'localnet' };
      this.herald.pin(next.seasonId, addresses);
      if (this.pinned) this.contextChanges.push({ ...this.pinned, until: next.since });
      this.pinned = next; this.addresses = addresses;
    }
    this.pinnedAt = t;
    return this.pinned;
  }

  /** A self link only: the agent of a local-play resident is its own wallet (auth.mjs consent reads this). */
  async agentView(agentId) {
    if (!BASE58.test(String(agentId ?? ''))) return { status: 404, json: { code: 'UnknownAgent' } };
    return { status: 200, json: { owner: String(agentId), agentId: String(agentId), self: true } };
  }

  /** The "agent" view the tools show: the owner itself, with its own first village from the public herald. */
  async agent(principal) {
    if (principal.agentId !== principal.owner) throw new GameError('NotOwner', 'a local-play link is the resident\'s own (agentId = owner)');
    await this.context();
    const me = await this.herald.me(principal.owner);
    if (!me.ok) throw new GameError('HeraldUnavailable', `the owner's record: ${me.code ?? me.error}`, { retryable: true });
    const h = (me.holdings ?? [])[0];
    if (!h) throw new GameError('NoVillage', 'the owner has no village yet (join and place a home first)', { retryable: true });
    return { agentId: principal.owner, owner: principal.owner, village: [h.p, h.q, h.site], mode: 'self', modeEpoch: null,
      policy: { version: null, allowed: [] }, delegation: null, history: [], self: true };
  }

  // Nothing is ever sent from here (no request is made).
  async submit() { return readOnly(); }
  async ownerCommand() { return readOnly(); }
  async actFate() { return null; }
  async agentRecord() { return null; }
}
