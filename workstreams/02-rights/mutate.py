# Workstream 02-rights: mutation check. Run from the repository root after
# applying patches 0001 and 0002: removes one safety check at a time from
# permutation-frontier/src/proc/rights.rs, runs the rights tests, restores.
import subprocess, shutil, sys
p='permutation-frontier/src/proc/rights.rs'
orig=open(p).read()
M=[
("no-grantee-check","if g.grantee != key(citizen) {","if false {"),
("no-expiry","if pl.now.ts >= g.expires_ts {","if false {"),
("no-revoked-check","    if g.state != rt::STATE_ACTIVE {\n        return Err(err(RightsError::Revoked));\n    }\n    if pl.now.ts","    if false {\n        return Err(err(RightsError::Revoked));\n    }\n    if pl.now.ts"),
("no-quota","rt::quota_allows(g.max_swaps, g.swaps, g.max_units, g.units_swapped, x.units).map_err(err)?;",""),
("no-open-check","    if g.open_units != 0 {\n        return Err(err(RightsError::ReservationOpen));","    if false {\n        return Err(err(RightsError::ReservationOpen));"),
("no-address-check","if canonical != key(ai) {","if false {"),
("no-season-check","if r.u64(G::SEASON_ID)? != sid","if false"),
("no-owner-check","if ai.owner != p || d.len()","if d.len()"),
("no-gen-pin","if h.gen != gen ||","if"),
("no-pinned-owner","|| r.arr::<32>(H::OWNER_CITIZEN)? != *owner","|| false"),
("no-wallet-only","    if pl.pc.by_session {\n        return Err(cq(CqError::WalletRequired));","    if false {\n        return Err(cq(CqError::WalletRequired));"),
("no-execute-noreservation","    if g.open_units == 0 {\n        return Err(err(RightsError::NoReservation));\n    }\n    if x.seq","    if false {\n        return Err(err(RightsError::NoReservation));\n    }\n    if x.seq"),
("no-release-auth","        if !crank {","        if false {"),
("no-capture-lock","        hold::capture_lock(h, province)?;","        let _ = h;"),
("no-issuer-on-revoke","    if g.issuer != key(citizen) {","    if false {"),
("no-close-live-check","    if g.open_units != 0 || !done {","    if false {"),
("no-station-province","|| (sh.p, sh.q) != (fh.p, fh.q)",""),
("no-issue-ownership","    let fh = hold::owned_holding(p, &pl, facility, citizen)?;","    let fh = { let fd = facility.try_borrow_data()?; frontier_abi::prologue::check_holding(&view(facility, &fd), &pl.ctx, sid, &{let d=facility.try_borrow_data()?; Ro(&d).arr::<32>(H::OWNER_CITIZEN)?})? };"),
("no-reserve-seq","    if x.seq != g.swaps {\n        return Err(err(RightsError::SeqMismatch));\n    }\n    rt::quota_allows(","    if false {\n        return Err(err(RightsError::SeqMismatch));\n    }\n    rt::quota_allows("),
("no-execute-seq","    if x.seq != g.swaps {\n        return Err(err(RightsError::SeqMismatch));\n    }\n    credit(","    if false {\n        return Err(err(RightsError::SeqMismatch));\n    }\n    credit("),
("burn-instead-of-keep","        write_open(grant, g.open_units, g.open_ts, kept)?;","        write_open(grant, 0, 0, [0; 3])?;"),
("no-return-blocked","    if unwind(p, &ctx, sid, now, &g, grant, facility, station, province)? {","    if unwind(p, &ctx, sid, now, &g, grant, facility, station, province)? || true {"),
]
for name,a,b in M:
    if a not in orig:
        print(f"{name}: PATTERN NOT FOUND"); continue
    open(p,'w').write(orig.replace(a,b,1))
    r=subprocess.run(["cargo","test","--locked","-p","permutation-frontier","--lib","rights"],capture_output=True,text=True)
    out=r.stdout+r.stderr
    res=[l for l in out.splitlines() if l.startswith("test result")]
    if not res:
        print(f"{name}: did not compile (counts as detected)"); continue
    print(f"{name}: {'KILLED' if 'FAILED' in res[0] else 'SURVIVED'} | {res[0][:60]}")
open(p,'w').write(orig)
