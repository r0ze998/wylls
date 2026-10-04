// Shared test kit of the social-layer tests (AC4): a mutable clock, test
// citizens with deterministic session keys, a fake herald (`me`), body
// builders that sign with node:crypto, and a temp AI_DIR. Not a test file.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  encodeBallot, encodeCallRead, encodeTalk, seqOf, sha256, toBase58, toBase64, toHex,
} from '../../../permutation-server/web/frontier/council/aisocial.mjs';
import { testKey } from '../../citizens/social/vectors.mjs';

export const SEASON = 31;
export const UNIX0 = 1_800_000_000;

export function makeClock({ bell = 402, unix = UNIX0 } = {}) {
  const c = { b: bell, u: unix };
  return { bell: () => c.b, unix: () => c.u, set(b, u) { c.b = b; if (u !== undefined) c.u = u; else c.u = UNIX0 + (b - 402) * 600; }, advance(n = 1) { this.set(c.b + n); } };
}

/** A temp AI_DIR; `dispose()` removes it. */
export function tmpAiDir(prefix = 'ai-social-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, pub: join(dir, 'pub'), state: join(dir, 'state'), dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A test citizen: its session key is the key the herald reports (a fresh `testKey` per name). */
export function makeCitizen(name, { faction = 0, final = true, expiry = UNIX0 + 10 ** 7, tag = null, session = true } = {}) {
  const wallet = testKey(`wallet/${name}`);
  const key = testKey(`session/${name}`);
  const t = tag ?? BigInt(`0x${toHex(sha256(`tag/${name}`)).slice(0, 15)}`);
  return {
    name, key, wallet: wallet.pub, b58: toBase58(wallet.pub), faction, tag: t, expiry, session,
    holdings: final ? [{ state: 2, finalTs: 0n }] : [{ state: 1, finalTs: BigInt(UNIX0 + 10 ** 6) }],
  };
}

/** A herald double: `me(wallet)` as createHerald's client answers it. */
export function fakeHerald(citizens = []) {
  const byWallet = new Map(citizens.map(c => [c.b58, c]));
  const h = {
    calls: 0,
    down: false,
    add(c) { byWallet.set(c.b58, c); },
    async me(wallet) {
      h.calls++;
      if (h.down) return { ok: false, code: 'network', error: 'down' };
      const c = byWallet.get(wallet);
      if (!c) return { ok: false, code: 'NotFound', error: 'no such wallet' };
      return {
        ok: true,
        record: {},
        citizen: { wallet: c.wallet, session: c.session ? c.key.pub : new Uint8Array(32), sessionExpiry: BigInt(c.expiry), faction: c.faction, citizenTag: c.tag, holdingsN: c.holdings.length },
        holdings: c.holdings,
      };
    },
  };
  return h;
}

/** Builders that keep a per-citizen seq counter (k within the bell). */
export function builders(clock, season = SEASON) {
  const seqs = new Map();
  const nextSeq = (c, bell) => {
    const k = (seqs.get(`${c.name}|${bell}`) ?? -1) + 1;
    seqs.set(`${c.name}|${bell}`, k);
    return seqOf(bell, k % 16);
  };
  const sign = (c, bytes) => ({ bytes_b64: toBase64(bytes), sig_b64: toBase64(c.key.sign(bytes)) });
  return {
    /** A signed talk body; `f` overrides any field (`bell`, `seq`, `channel`, `target`, `kind`, `ref`, `origin`, `lang`, `text`). */
    talk(c, f = {}, extra = {}) {
      const bell = f.bell ?? clock.bell();
      const fields = { season, wallet: c.wallet, bell, seq: f.seq ?? nextSeq(c, bell), channel: 0, kind: 0, ref: 0, origin: 0, lang: 'en', text: 'hello', ...f };
      const bytes = encodeTalk(fields);
      return { fields, bytes, body: { ...sign(c, bytes), ...extra } };
    },
    ballot(c, f = {}, extra = {}) {
      const fields = { season, wallet: c.wallet, faction: c.faction, option: 1, nonce: toHex(sha256(`nonce/${c.name}`).subarray(0, 16)), origin: 0, ...f };
      const bytes = encodeBallot(fields);
      return { fields, bytes, body: { ...sign(c, bytes), ...extra } };
    },
    /** The query of a signed Call read. */
    callRead(c, { faction = c.faction, period, unix = clock.unix(), signer = c } = {}) {
      const bytes = encodeCallRead({ season, faction, period, wallet: c.wallet, unix });
      return { faction: String(faction), period: String(period), wallet: c.b58, unix: String(unix), sig: toBase64(signer.key.sign(bytes)) };
    },
  };
}

/** The standard 3-option set of a council period (value, own, ratio as the watcher would send). */
export const OPTIONS = [
  { option: 1, kind: 'strike', p: 3, q: -1, value: 220, own: 480, ratio: 'favourable' },
  { option: 2, kind: 'camp', p: 4, q: 0, value: 120, own: 300, ratio: 'favourable' },
  { option: 3, kind: 'raid', p: 2, q: 2, value: 400, own: 700, ratio: 'even' },
];

export const post = (social, path, body, headers = {}, peer = '127.0.0.1') => social.routes.dispatch({ method: 'POST', path, body: JSON.stringify(body), headers, peer });
export const get = (social, path, query = {}, headers = {}, peer = '127.0.0.1') => social.routes.dispatch({ method: 'GET', path, query, headers, peer });
