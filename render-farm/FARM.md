# Render farm for the Wylls concept renders

This folder holds the scripts that render the concept stills and the intro film for the X thread. Several cloud sessions run them in parallel, each on its own share of the work. Nothing here is part of the game.

The scripts build everything themselves:
- the terrain, buildings and 2.5-head characters are procedural;
- the CC0 assets come from Poly Haven.

## Worker procedure
1. Run `bash render-farm/farm.sh setup`.
   - It takes about 30–60 minutes: venv and `bpy==5.2.2`, about 2 GB of assets, then building the world.
   - It prints a `FINGERPRINT` line and writes `render-farm/out/fingerprint_<host>.txt`.
2. Run the job you were given, for example `bash render-farm/farm.sh video 1 45`.
   - Each job must finish within 2 hours. Split long jobs into several runs; they resume where they stopped.
   - Run long jobs in the background and check on them. Do not render anything you weren't assigned.
3. Commit only `render-farm/out/` and push it to your assigned branch. Do not commit anything from `$HOME/farm`.
4. Reply with:
   - the fingerprint;
   - the files you pushed;
   - the timing per frame or per band;
   - anything that failed.

## Rules
- Never open a pull request.
- Never push to any branch except the one you were assigned.
- Never change scripts to "fix" a look. If something fails, report it with the log tail.
- Use only Poly Haven (CC0) assets. Use no paid services.
