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

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const readOnly = () => ({ status: 403, json: { code: 'ReadOnly', error: 'this MCP server observes a local-play world read-only: it sends nothing' } });

export class LocalPlayGame extends Game {
  /**
   * @param {object} o  as Game: `relay` = the world proxy's `/gw` base (e.g. http://localhost:41412/gw), `herald` =
   *   the world proxy (e.g. http://localhost:41412). Both public, both reads only.
   */
  constructor(o) { super(o); this.readOnly = true; }

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
