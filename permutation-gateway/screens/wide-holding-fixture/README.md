# Wide-holding browser fixture

A synthetic, read-only fixture of the production wide-holding parser, village
cards, desktop rail, phone resting sheet, language dictionaries and CSS. It is
not a running game or a live account viewer. The map is an explicitly labelled
placeholder. No wallet, session, signer, relay or chain is connected.

From the repository root:

```sh
node --import ./scripts/ci/no-keys-guard.mjs permutation-gateway/screens/wide-holding-fixture/server.mjs
```

Open the exact loopback URL printed by the command. The port is allocated by the
OS; no fixed project port is claimed. Stop with Ctrl-C. The server uses only Node
built-ins, serves GET/HEAD, returns 405 for writes, and confines files to its
fixture allowlist, one fixed Season JSON and the public web root. All routes
have CSP/no-store/nosniff. There are no RPC, relay, proxy or WebSocket routes.

## Browser checks

1. Choose `captured`, then W2 in the desktop rail or phone resting sheet.
2. Collapse **Fixture controls** to inspect the actual card geometry.
3. Read the exact large coordinate, captured/unverified labels, resources,
   construction and reserve. The resource table scrolls horizontally within
   its own card; keyboard arrows work when that region has focus.
4. Go back to the ordinary village, then select W2 repeatedly.
5. Try `missing`, `ambiguous`, `error`, `unavailable`, and `empty`.
6. Retry on the error card restores fixed captured data, not a live read.
7. Switch JA/EN and desktop/phone widths. Fixture sheet controls explicitly set
   peek/half/full; they do not test the production gesture controller.

All ordinary game actions are inert. Only fixture controls, wide selection,
back/home and fixture retry are handled. Forms are prevented. Do not treat an
inert legacy action as a successful game operation.

## Data and dependencies

`data.mjs` uses explicit public bytes and the same account encoder as the key-free
wide UI tests. Public Season PDA, Citizen and with-seed holding addresses are
computed. No key pair or private material is created, derived or used. The fixed
Season JSON is read from `test/fixtures/frontier/season.json`, not regenerated.

`fixture.mjs` imports the real pure renderers and parser. It does not import
`controller.mjs`, `app.mjs`, a wallet/session implementation, or the existing
screens fixture server/world. The existing screens server is deliberately not
used because its startup calls `keyFromSeed`. Some real rendering dependencies
contain unused march/seal functions; this fixture never invokes those functions,
loads a worker, creates a session, or sends an instruction.

Production assets are mapped under `/web/`. Relative `art/` URLs in rendered
markup are rebased only for this fixture's document location. The inspector
bar's CSS does not change panel/card/table dimensions. Holding drawers retain
`data-doc=""`; the wider report/practice layout is not used.

## Limits and recorded result

This tests actual Chrome DOM/CSS rendering and the fixture's minimal navigation,
not the full app boot/controller, wallet/NFT refresh, live herald, chain finality,
phone touch gestures, or executable wide economics. The controller's separate
key-free Node tests remain necessary.

For the 2026-11-08 result, measured widths, fixes and screenshots, see
`docs/frontier/map-growth/WIDE-HOLDING-BROWSER-QA-20261108.md` at repository root.
