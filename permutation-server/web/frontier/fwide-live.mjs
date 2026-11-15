// An explicit same-origin RPC observation, beside (never replacing) captured history.
// Public bytes only. No projections, ownership authority, orders, or payload URLs.
import { fromBase64, toBase64, toHex, utf8 } from '../sdk/bytes.mjs';
import { decode as unbase58, encode as base58 } from '../sdk/base58.mjs';
import { sha256 } from '../sdk/sha256.mjs';
import { seasonAddresses, withSeed } from './faddr.mjs';
import { ACCOUNTS } from './abi.mjs';
import { decode, decodePrefix } from './fcodec.mjs';
import { citizenBindings, decodeWideHoldingBytes, sortKeyOf, wideHoldingAddress } from './fwide.mjs';
import { worldIdOf, parseU64, ringPosition } from './map/wide.mjs';
import { captureAddress, checkCapturedBytes } from './map/widecapture.mjs';
import { html } from '../util.mjs';
import { L } from '../lang.mjs';
import { RESOURCES, UNITS, TIERS, BUILDINGS } from './fi18n.mjs';
import { UNIT_ORDER, queueBuildingItem, buildItemOf } from './fland.mjs';

const check = (ok, message) => { if (!ok) throw new Error(message); };
const hex32 = /^[0-9a-f]{64}$/;
const u64 = s => { check(typeof s === 'string' && /^(0|[1-9][0-9]*)$/.test(s), 'noncanonical integer'); return parseU64(s); };
const publicAddress = s => { check(typeof s === 'string' && s.length <= 44, 'address'); const b = unbase58(s); check(b.length === 32 && base58(b) === s, 'address'); return b; };
const le = (n, size) => { const b = new Uint8Array(size), v = new DataView(b.buffer); if (size === 8) v.setBigUint64(0, n, true); else v.setUint32(0, n, true); return b; };
const rawBytes = (s, size) => { check(typeof s === 'string' && s.length === 4 * Math.ceil(size / 3), 'data size'); const b = fromBase64(s); check(b.length === size && toBase64(b) === s, 'data encoding'); return b; };
const CLOCK = 'SysvarC1ock11111111111111111111111111111111';
const SYSVAR = 'Sysvar1111111111111111111111111111111111111';

/** No upgrade, alternate source, or response-provided URL can enable this UI.
 * The server's opt-in feature/config is a separate gate; a click may get 404. */
export function wideLiveEnabled({ herald, origin, season, mode, sample } = {}) {
  if (mode !== 'play' || sample || season?.layoutVersion !== 2 || season?.programVersion !== 0x4004 || season?.rulesVersion !== 12) return false;
  if (typeof origin !== 'string' || !origin || typeof herald !== 'string' || !herald) return false;
  try { const target = new URL(herald), page = new URL(origin); return /^https?:$/.test(page.protocol) && target.origin === page.origin && !target.username && !target.password; } catch { return false; }
}

/** Bound bytes as they arrive, before allocating text/JSON. No text() fallback. */
export async function readWideLiveJSON(response, signal) {
  const stream = response.body?.getReader?.(); check(stream, 'streaming response required');
  const chunks = []; let length = 0;
  try {
    while (true) {
      check(!signal?.aborted, 'observation cancelled');
      const { value, done } = await stream.read();
      check(!signal?.aborted, 'observation cancelled');
      if (done) break;
      check(value instanceof Uint8Array && length + value.byteLength <= 32768, 'response too large');
      length += value.byteLength; chunks.push(value);
    }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) {
    try { await stream.cancel(); } catch { /* original refusal wins */ }
    throw error;
  } finally { stream.releaseLock(); }
}

/** Pins are supplied by the existing viewer, not the response: programId,
 * seasonAddress, seasonId, world, rulesetHash, citizen, viewerKey, viewerKind
 * ('wallet' or 'resident'). Holding is the already checked selected capture. */
function selection(pins, h) {
  check(h?.kind === 'WideHolding' && h.readOnly === true && h.executable === false && h.capture?.verification === 'captured-unverified', 'captured selection required');
  check(typeof h.p === 'bigint' && typeof h.q === 'bigint', 'exact coordinates required');
  const a = seasonAddresses(pins.programId, pins.seasonId);
  check(a.season === pins.seasonAddress && pins.world === worldIdOf(a.season, a.programId), 'world pin');
  check(hex32.test(pins.rulesetHash) && pins.rulesetHash !== '0'.repeat(64), 'ruleset pin');
  publicAddress(pins.citizen); publicAddress(pins.viewerKey);
  check(pins.viewerKind === 'wallet' || pins.viewerKind === 'resident', 'viewer kind');
  const citizen = pins.viewerKind === 'resident'
    ? withSeed(a.season, ACCOUNTS.Citizen.tag + toHex(sha256(utf8('PSF-RES'), publicAddress(pins.viewerKey)).slice(0, 15)), a.programId)
    : a.of('Citizen', { wallet: pins.viewerKey });
  check(citizen === pins.citizen && h.ownerCitizen === citizen && h.world === pins.world && h.season === a.seasonId, 'selected identity');
  check(h.inventorySlot === 2 || h.inventorySlot === 3, 'inventory slot');
  check(Number.isInteger(h.site) && h.site >= 0 && h.site < 12 && Number.isInteger(h.generation) && h.generation > 0 && h.generation < 255, 'site generation');
  check(h.capture.address === wideHoldingAddress(a.season, a.programId, h.p, h.q, h.site), 'holding address');
  const min = u64(String(h.capture.slot)); check(min > 0n, 'capture slot');
  return { a, min, identity: [a.programId, a.season, pins.world, pins.rulesetHash, citizen, pins.viewerKind, pins.viewerKey, h.p, h.q, h.site, h.generation, h.inventorySlot, min].join(':') };
}

/** Independently re-read every displayed fact, plus all identity and scope bytes.
 * A matching digest binds response contents, not RPC truth or ownership. */
export function parseWideLive(j, pins, holding) {
  const h = holding, { a, min } = selection(pins, h);
  check(j?.v === 1 && j.kind === 'wide-village-rpc-observation' && j.commitment === 'confirmed' && j.single_response === true, 'observation envelope');
  for (const name of ['current', 'authenticated', 'executable', 'source_complete', 'wallet_ownership_verified']) check(j[name] === false, 'authority claim');
  check(j.program === a.programId && j.season === a.seasonId && j.world === pins.world && j.ruleset_hash === pins.rulesetHash && j.program_version === 0x4004, 'deployment scope');
  check(j.citizen === pins.citizen && j.p === String(h.p) && j.q === String(h.q) && j.site === h.site && j.gen === h.generation && j.slot === h.inventorySlot, 'selection scope');
  const observedSlot = u64(j.observed_slot), minimum = u64(j.min_slot);
  check(minimum >= min && observedSlot >= minimum, 'observation before capture');
  const key = sortKeyOf(h.p, h.q);
  const addresses = [h.capture.address, captureAddress('province', key, h.site, a.season, a.programId), pins.citizen, a.season];
  const kinds = ['holding', 'province', 'citizen', 'season'], sizes = [1344, 4864, 384, 2048];
  check(Array.isArray(j.accounts) && j.accounts.length === 4, 'account set');
  const accounts = j.accounts.map((x, i) => {
    check(x?.kind === kinds[i] && x.address === addresses[i] && x.owner === a.programId && x.executable === false, 'account metadata');
    return { key: publicAddress(x.address), owner: publicAddress(x.owner), lamports: u64(x.lamports), bytes: rawBytes(x.data_b64, sizes[i]) };
  });
  const [hb, pb, cb, sb] = accounts.map(x => x.bytes);
  const hd = decodeWideHoldingBytes(hb), id = hd.identity;
  check(id.world === pins.world && id.season === a.seasonId && id.p === h.p && id.q === h.q && id.site === h.site && id.generation === h.generation && id.inventorySlot === h.inventorySlot && base58(id.ownerCitizenBytes) === pins.citizen, 'holding identity');
  const season = decode('Season', sb, { profile: 2, seasonId: a.seasonId });
  check(season.layoutVersion === 2 && season.bump === a.bump && season.programVersion === 0x4004 && season.rulesVersion === 12 && toHex(season.rulesetHash) === pins.rulesetHash, 'season bytes');
  const citizen = decode('Citizen', cb, { profile: 2, seasonId: a.seasonId });
  check(citizen.layoutVersion === 2 && citizenBindings(citizen)[h.inventorySlot - 1] === 'wide', 'citizen binding');
  check(pins.viewerKind === 'resident' ? citizen.residentAsset instanceof Uint8Array && base58(citizen.residentAsset) === pins.viewerKey : citizen.residentAsset === undefined && base58(citizen.wallet) === pins.viewerKey, 'citizen viewer');
  const province = decodePrefix('Province', pb, { profile: 2 });
  const rp = ringPosition(h.p, h.q);
  // Reuse the strict public wide province validator, with observation-local bounds.
  checkCapturedBytes('province', { region: province.region, openedBell: province.openedBell, keepHolder: pb[4481] },
    { address: addresses[1], slot: observedSlot, archiveSequence: 0n, bytes_b64: j.accounts[1].data_b64 },
    { world: pins.world, p: h.p, q: h.q, ...rp, manifest: { world: pins.world, season: a.seasonId, seasonAddress: a.season, program: a.programId, captureBounds: { lastSlot: observedSlot, foldedThrough: 0n } } });
  check(province.siteMirror[h.site].gen === h.generation && province.siteMirror[h.site].state === 1, 'province mirror');
  check(j.clock?.address === CLOCK && j.clock.owner === SYSVAR && j.clock.executable === false, 'clock metadata');
  const clock = rawBytes(j.clock.data_b64, 40), cv = new DataView(clock.buffer);
  check(cv.getBigUint64(0, true) === observedSlot, 'clock context');
  const sorted = [...accounts].sort((x, y) => { for (let i = 0; i < 32; i++) if (x.key[i] !== y.key[i]) return x.key[i] - y.key[i]; return 0; });
  const digest = sha256(utf8('PSF-KEEPER-WIDE-SNAPSHOT-v1'), le(observedSlot, 8), le(minimum, 8), le(9, 4), utf8('confirmed'), le(4, 4),
    ...sorted.flatMap(x => [x.key, Uint8Array.of(1), le(x.lamports, 8), x.owner, Uint8Array.of(0), le(x.bytes.length, 4), x.bytes]), Uint8Array.of(0xc1), clock, Uint8Array.of(0));
  check(hex32.test(j.snapshot_digest) && toHex(digest) === j.snapshot_digest, 'snapshot digest');
  return Object.freeze({ status: 'observed', observedSlot, clockUnixTimestamp: cv.getBigInt64(32, true).toString(), economy: hd.economy, readOnly: true, executable: false, authenticated: false });
}

/** Fixed same-origin endpoint, with one explicit request and no polling/retries.
 * Host calls sync() on EVERY viewer, source, selection or screen transition.
 * getSelection returns {pins, holding, sourceKey} only while the wide village
 * is visible. sourceKey is the host's local source/reload identity, never a URL
 * used for fetching. clear() must also be called before reloading that source. */
export function createWideLiveReader({ getSelection, onChange = () => {}, fetchImpl = (...args) => fetch(...args), enabled = false }) {
  const isEnabled = () => (typeof enabled === 'function' ? enabled() === true : enabled === true);
  let available = isEnabled(), state = Object.freeze({ status: available ? 'idle' : 'disabled' }), identity = null, abort = null, epoch = 0;
  const publish = next => { state = Object.freeze(next); onChange(state); };
  const current = () => {
    const s = getSelection(); if (!s) return null;
    const selected = selection(s.pins, s.holding);
    check(s.sourceKey === undefined || typeof s.sourceKey === 'string', 'source identity');
    return { ...s, ...selected, identity: JSON.stringify([selected.identity, s.sourceKey ?? '']) };
  };
  function sync() {
    const nextAvailable = isEnabled();
    let s; try { s = current(); } catch { s = null; }
    if ((s?.identity ?? null) !== identity || available !== nextAvailable) {
      available = nextAvailable;
      identity = s?.identity ?? null; epoch++; abort?.abort(); abort = null;
      publish({ status: available ? 'idle' : 'disabled' });
    }
    return s;
  }
  async function refresh() {
    const s = sync(); if (!available || !s) return state;
    abort?.abort(); abort = new AbortController(); const controller = abort, token = ++epoch;
    publish({ status: 'loading' });
    const h = s.holding;
    const query = new URLSearchParams({ citizen: s.pins.citizen, p: String(h.p), q: String(h.q), site: String(h.site), gen: String(h.generation), min_slot: String(s.min) });
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const r = await fetchImpl(`/h/wide-live/village?${query}`, { method: 'GET', signal: controller.signal, credentials: 'same-origin', redirect: 'error', cache: 'no-store', headers: { Accept: 'application/json' } });
      check(r.ok, 'observation unavailable');
      const result = parseWideLive(await readWideLiveJSON(r, controller.signal), s.pins, h);
      check(!controller.signal.aborted, 'observation cancelled');
      sync(); if (token === epoch) publish(result);
    } catch {
      sync(); if (token === epoch) publish({ status: 'unavailable' });
    } finally { clearTimeout(timer); }
    return state;
  }
  return Object.freeze({ sync, refresh, get state() { sync(); return state; }, clear() { epoch++; abort?.abort(); abort = null; identity = null; available = isEnabled(); publish({ status: available ? 'idle' : 'disabled' }); } });
}

const milli = value => { const n = BigInt(value), a = n < 0n ? -n : n; return `${n < 0n ? '−' : ''}${a / 1000n}.${String(a % 1000n).padStart(3, '0')}`; };
const queueName = q => { const item = queueBuildingItem(q); return item === 7 ? L`村の昇格` : item !== null && item !== undefined ? BUILDINGS[buildItemOf(item)?.resource] ?? L`建物` : L`維持費の変更`; };

/** Separate cards: all values are raw observed fields, never simulated. */
export function renderWideLive(state = { status: 'disabled' }) {
  const read = state.status !== 'disabled' && state.status !== 'loading'
    ? html`<button type="button" class="btn" data-act="wide-live-refresh">${L`RPC の記録を読み直す（読み取り専用）`}</button>` : '';
  const note = html`<p>${L`これは RPC 応答の観測値です。現在性・所有権の証明ではありません。履歴の捕捉値は変更せず、生産の加算や命令の送信もしません。`}</p>`;
  if (state.status !== 'observed') return html`<section class="vcard wide-live"><h3>${L`RPC の観測`}</h3><p>${state.status === 'disabled' ? L`RPC 観測は無効です。同じ配信元での明示的な設定と、対応する実験版シーズンが必要です。` : state.status === 'loading' ? L`読み取り中。以前の観測値は表示しません。` : state.status === 'unavailable' ? L`観測値を確認できません。不明であり、0 ではありません。` : L`まだ読み取っていません。`}</p>${note}${read}</section>`;
  const x = state.economy;
  return html`<section class="vcard wide-live"><h3>RPC observed at slot ${String(state.observedSlot)}</h3>${note}${read}
    <h4>${L`資源（観測した保存値）`}</h4><ul>${x.stores.map(s => html`<li>${RESOURCES[s.resource] ?? s.resource}: ${milli(s.value)}</li>`)}</ul>
    <h4>${L`建設（観測した保存値）`}</h4><p>${L`段階`}: ${TIERS[x.tier] ?? String(x.tier)} · ${L`城壁`}: ${x.walls}</p>
    ${x.queue.some(q => q.inUse) ? html`<ul>${x.queue.filter(q => q.inUse).map(q => html`<li>${queueName(q)} · ${L`記録上の完了予定（Unix 秒）`}: ${q.doneAt}</li>`)}</ul>` : html`<p>${L`記録上、建設の列は空です`}</p>`}
    <h4>${L`兵（観測した控えの保存値）`}</h4><ul>${x.reserve.map((count, i) => html`<li>${UNITS[UNIT_ORDER[i]] ?? String(i)}: ${count}</li>`)}</ul></section>`;
}
