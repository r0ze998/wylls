# Wylls migration checkpoint (2026-11-15)

This is a preservation inventory, NOT a merge or a passing release. Seven snapshot branches preserve 406 previously uncommitted file versions. Existing committed work remains on its original branches. See `worktree-inventory.json` for exact SHA, original base, filenames and content hashes.

## Resume safely
1. Clone `https://github.com/r0ze998/wylls.git` into a new empty directory, then `git fetch origin`.
2. Choose the required branch from the inventory. Use a new worktree, for example `git worktree add ../resume-map -b resume-map origin/migration/20261115-claude2-map-20261110`.
3. Do not merge every snapshot together. Several preserve different experimental versions of the same files. Compare against each recorded base and integrate deliberately.
4. Read the ordinary UI checkpoint `docs/integration/CLAUDE-CHECKPOINT-HANDOVER-20261115.md` from the current canonical branch. Runtime scratch paths and installed dependencies are not portable; recreate dependencies from tracked manifests, not absolute symlinks.
5. No account secrets are stored here. Authenticate separately. Do not copy credentials into Git.

## Coverage and limits
The snapshot builder verified every saved file byte-for-byte by SHA-256 from Git blobs and verified all seven remote refs. It also verified original worktree status and index unchanged. Snapshot commits include the original history as parent; they are not new integration/testing claims.

Not copied to GitHub: two trailer MP4s, six conquest evidence JSON reports pending content review, one before-files.tar archive, node_modules symlinks, ignored build outputs/local runtime data/settings, and unregistered scratch directories. Original copies were not deleted. Therefore this is source-work preservation, not a full machine backup. Some snapshot tests depend on withheld evidence and will not run standalone until that evidence is safely migrated or regenerated.

NFT transfer verification or equivalent procedures, session guard and prize work remain restricted. No tests in those areas were run by this migration. No real funds/public issuance. Preserve existing dirty trees; no reset/clean/stash deletion.

## Supplemental assets now saved
The previously withheld two trailers, six evidence JSON reports and old source archive contents are now on [migration/20261115-assets](https://github.com/r0ze998/wylls/tree/migration/20261115-assets), commit a1484eb0. The owner explicitly approved public upload. One JSON local scratch path was redacted; Apple metadata was omitted from the portable tar. All 16 archive source files retain exact bytes. This supersedes the withheld-assets paragraph above. Dependencies, build caches, runtime state/settings and external scratch are still not a machine backup.

## Original worktree commits
At the owner’s request, all safe saved work was also committed to the original branches as WIP. See `original-worktree-commits.json` for the seven commits and remaining local-only files. Six worktrees are clean; canonical retains only an unsanitized original JSON, original metadata tar and dependency symlink. Those two artifacts have safe copies on the assets branch. No source bytes were altered. WIP does not mean integrated or tested.
