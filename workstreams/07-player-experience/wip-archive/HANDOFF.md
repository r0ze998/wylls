# WIP archive (workstream 07): UNREVIEWED, UNRUN

Base: `5a5e5cf25567afe940c7b5280145ac9412cfe0c7` (head of `claude/wylls-ui-ux-visual-oixhgs`). Archive only: nothing here is integrated, reviewed or run.

## loadtime_ts.py
- Static load-time audit of the game page's module graph, for workstream 16's REPORT §29.39 D item 2.
- How it works: it reads git blobs at a given revision and parses them with tree-sitter's JavaScript grammar (Python packages `tree-sitter==0.23.2`, `tree-sitter-javascript==0.23.1`). It executes no project code, no node and no browser.
- What it reports: the module graph from `frontier/app.mjs` (the only `<script>` of `frontier/index.html`), and every top-level statement and call evaluated at import, followed conservatively through same-module and imported functions. It flags any key entry, sealMarch, or `new Worker`.
- Status: **written, never run; no output exists; not reviewed by 16.** Its heuristics (call resolution, depth limits, class static members) need review before its result counts.
- Usage after review, from a checkout: `python -I loadtime_ts.py <rev> > out.json`.

## Open (see the branch head's commits and INTEGRATION §0o.2f)
- 5f8e68b1 (ws07-conquest-s1, ws07-grow-s1 404s from the golden): unverified, not run, not approved by 16.
- §29.39 D still open:
  - item 2 (this audit): run, then review;
  - item 3 (Node side): a short static note;
  - item 4 (4's runner).
- 19's regenerated KEEP goldens: c2acd3a9 on `claude/ecstatic-cannon-d0jfc4`. They await 16's review. The only status change is keep/4,0 404 → 200. The palisade golden's province bytes also changed.
- No screen runs until 16 approves. No ws07-guard or direct HUD runs. No keys, signing or CI.
