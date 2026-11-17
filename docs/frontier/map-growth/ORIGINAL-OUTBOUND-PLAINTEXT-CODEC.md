# Original outbound plaintext and geometry

`permutation-server/web/frontier/fexpedition-seal.mjs` is a pure, browser-compatible
review module. Its name refers to the plaintext of the wide seal; it does **not**
produce a seal. It does not construct transactions, contact a server, read chain
state, determine terrain/passability, calculate travel cost, verify arrival
eligibility, admit an order, or enable the original-to-wide dispatch gate.

## Public API

- `canonicalWideProvinceKey({world,p,q})`: canonical 50-byte ProvinceKey as
  lowercase hex. The namespace is nonzero, coordinates are canonical decimal
  strings inside ±2^62, and the ring sort key is lossless.
- `canonicalOriginalHostRef({world,p,q,site,gen,seq})`: full 56-byte original host
  reference as lowercase hex; issuer province ring ≤128, site 0..11, gen u8,
  seq u32. `decodeWideHostRef` also accepts canonical wide issuers for generic
  codec parity. An issuer province does not determine the current standing tile.
- `packWidePlain(fields)` and `unpackWidePlain(Uint8Array)`: exactly 136 bytes,
  matching `frontier-abi/src/world_index/seal.rs`. Names are `version`, `host`,
  `arriveBell`, `dest`, `destTile`, `stance`, `retreatBps`, `pathLen`, `path`,
  `reserved`. Identities and byte fields are lowercase hex. `pack` checks field
  widths but preserves typed invalid semantic values, as Rust does; `unpack`
  requires strict canonical identities but does not imply semantic validity.
- `validateWidePlain(fields,{host,arriveBell})`: checks version 2, reserved zero,
  full expected host and bell, same world, path length ≤32, unused path bits zero,
  directions 0..5, destination tile 0..60, stance 0..3, retreat ≤60,000. This is
  plaintext validation, not dispatch validation. Zero steps and original-region
  destinations are valid at this codec layer, just as in Rust.
- `encodeWideDirections(directions)`: the deployed 32 × 3-bit path in 12 bytes,
  as immutable `{pathLen,path}`. It never computes route eligibility.
- `wideTileAt({world,p,q,tile})` / `locateWideTile({world,tileQ,tileR})`: exact
  forward/inverse radius-4 lattice geometry. All global coordinates and
  intermediate arithmetic use BigInt; returned coordinates are decimal strings.
- `traceWideDirections({world,origin,directions,destination?})`: bounded geometry
  from an explicit current origin `{p,q,tile}`. A supplied destination must match
  the exact endpoint. The result contains immutable `origin`, `endpoint`, `steps`,
  `directions`, `accountKeys`, and `pathComplete`. Tile rows are
  `{world,key,p,q,tile,tileQ,tileR,ring}`. `accountKeys` contains **ProvinceKeys,
  not account addresses**: destination first, then other first-entered provinces,
  with at most four. Origin is included only when a step enters it. This matches
  `wide_expedition_route.rs::path_tiles`, without that handler's land/authority
  checks. An empty UI preview has origin=endpoint, no steps or account keys,
  and `pathComplete:false`; it is not a march.
- `prepareOriginalOutboundPlain({program,season,host,origin,directions,
  arriveBell,stance,retreatBps})`: derives the world from canonical public
  program/season addresses, binds the full original issuer, requires an original
  current origin, 1..32 directions and a wide endpoint, and validates/encodes the
  candidate. The caller must pin the actual selected resident and current tile;
  supplying coordinates does not authenticate them. Arrival remains supplied
  input, not an estimate from geometry.

Every trace/review result is deeply immutable, reports `verification:'geometry-only'`,
`executable:false`, and `admitted:false`. Prepared reviews additionally report
`terrainVerified:false`, `costVerified:false`, and `arrivalVerified:false`.
No secret material or encryption API is accepted or produced. The legacy
`seal.mjs` is unchanged.

## Verification scope

The exact test target is
`permutation-gateway/test/web-frontier-expedition-seal.test.mjs`, run from
`permutation-gateway` with:

```sh
node --import ../scripts/ci/no-keys-guard.mjs --test test/web-frontier-expedition-seal.test.mjs
```

The target covers the literal Rust WidePlain sample, public Rust-generated
outbound/geometry/generic-plaintext fixtures, invalid fields/identities, 32-step
packing, all 61 tile indices at negative/large/world-edge coordinates, ring
128→129, exact endpoints, destination-first ordering, the four-province bound,
world-edge refusal and immutable review-only results. It requires its public
Rust fixture; missing fixtures fail rather than silently skip. The fixture
provenance is synthetic public codec data, not native execution evidence.

A passing target is not a full repository test, live browser check, decryption
check, runtime execution proof, or proof that original-to-wide gameplay is enabled.
