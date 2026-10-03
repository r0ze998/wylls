#!/usr/bin/env bash
# Makes N one-time invites for the playtest (PT-A) and writes them to a CSV:
#
#   scripts/playtest-invite.sh N [--label NAME] [--base-url URL] [--out FILE] [--stdout] [--game-page]
#
#   N           1..1000
#   --label     a short tag the relay's event log keeps with the batch
#               (default friends-<yyyymmdd>); letters, digits, . _ -
#   --base-url  the tunnel's https://<words>.trycloudflare.com. Without it the URL
#               is read from the cloudflared log (<data>/logs/cloudflared.log, written by
#               the command playtest-up.sh prints) when a tunnel is running; failing that
#               the url column holds the literal {BASE_URL} placeholder, for a mail merge
#   --out       the CSV (default $PLAYTEST_DATA/invites/invites-<label>-<time>.csv, mode 0600)
#   --stdout    also print the CSV (the codes are bearer secrets: one code = one join)
#   --game-page use the game page itself instead of the playtest landing page (see below)
#
# The CSV has two columns, `invite_code,url`, and nothing personal: no name,
# no e-mail, no note. An invite maps to a pseudonymous citizen (the wallet the
# browser makes when the friend joins), never to a person; who you gave a code
# to is yours to remember, not ours to record. The relay keeps only the
# batch's label and the codes' nonces (docs/frontier/playtest/PT-A-OPS.md s.6).
#
# The url is the playtest landing page with the code in the URL *fragment*:
#   <base>/frontier/frontier/playtest/#i=<code>
# (a fragment is never sent to a server and never reaches a log; the landing
# page checks the invite without spending it, says in plain words what to do,
# and takes the friend on to the game). That page is PT-B's
# (permutation-server/web/frontier/playtest/); when it is not in the tree, or
# with --game-page, the url is the game page, <base>/frontier/frontier/?invite=<code>,
# which does not read the parameter yet (request R1 in PT-A-NOTES.md): the friend
# opens it and pastes the code into the join screen's field, so send the code in
# the message too.
#
# Needs the stack up (the relay's operator route on 127.0.0.1); the operator
# token is read from the run directory and never printed or put on a
# command line.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=playtest-lib.sh
. "$HERE/playtest-lib.sh"

n=""; label=""; base=""; out=""; to_stdout=0; game_page=0
while [ $# -gt 0 ]; do
  case "$1" in
    --label) label="$2"; shift 2 ;;
    --base-url) base="$2"; shift 2 ;;
    --out) out="$2"; shift 2 ;;
    --stdout) to_stdout=1; shift ;;
    --game-page) game_page=1; shift ;;
    -h|--help) pt_help "$0"; exit 0 ;;
    -*) echo "unknown argument $1" >&2; exit 2 ;;
    *) [ -z "$n" ] && n="$1" || { echo "unexpected argument $1" >&2; exit 2; }; shift ;;
  esac
done
case "$n" in ''|*[!0-9]*) echo "usage: playtest-invite.sh N [--label NAME] [--base-url URL] [--out FILE] [--stdout]" >&2; exit 2 ;; esac
[ "$n" -ge 1 ] && [ "$n" -le 1000 ] || { echo "N must be 1..1000" >&2; exit 2; }
label="${label:-friends-$(date +%Y%m%d)}"
case "$label" in *[!A-Za-z0-9_.-]*|'') echo "label: letters, digits, . _ - only" >&2; exit 2 ;; esac
[ "${#label}" -le 40 ] || { echo "label: at most 40 characters" >&2; exit 2; }
if [ -n "$base" ]; then
  case "$base" in https://*|http://127.0.0.1:*|http://localhost:*) ;; *) echo "--base-url must be https://... (the tunnel) or a local http://127.0.0.1:PORT" >&2; exit 2 ;; esac
  base="${base%/}"
fi
if [ -z "$base" ] && [ -f "$PT_LOGS/cloudflared.log" ]; then
  base="$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$PT_LOGS/cloudflared.log" | tail -1)"
  [ -n "$base" ] && echo "using the tunnel URL from the cloudflared log: $base" >&2
fi
tokfile="$(pt_operator_token_file)"
[ -f "$tokfile" ] || { echo "no operator token at $tokfile: is the run started (scripts/playtest-up.sh)?" >&2; exit 1; }
umask 077
hdr="$(mktemp)"; trap 'rm -f "$hdr"' EXIT
printf 'Authorization: Bearer %s\n' "$(tr -d '\n' < "$tokfile")" > "$hdr"

seasonjson="$(curl -sf --max-time 5 "http://127.0.0.1:$((PT_BASE_PORT + $(pt_cfg_in ports relay_public)))/f/season" || true)"
if [ -z "$seasonjson" ]; then echo "the relay does not answer: is the stack up? (scripts/playtest-status.sh)" >&2; exit 1; fi
case "$seasonjson" in *'"inviteRequired":true'*) ;; *) echo "WARNING: the season is not invite-gated; invites change nothing" >&2 ;; esac

resp="$(curl -sf --max-time 20 -H "@$hdr" -H 'Content-Type: application/json' \
  -d "{\"count\": $n, \"label\": \"$label\"}" "http://127.0.0.1:$PT_RELAY_OP_PORT/f/operator/invites")" || { echo "the relay refused or did not answer (operator route 127.0.0.1:$PT_RELAY_OP_PORT)" >&2; exit 1; }

mkdir -p -m 700 "$PT_DATA/invites"
[ -n "$out" ] || out="$PT_DATA/invites/invites-$label-$(date +%Y%m%dT%H%M%S).csv"
form="landing"
if [ $game_page -eq 1 ] || [ ! -f "$PT_ROOT/permutation-server/web/frontier/playtest/index.html" ]; then form="game"; fi
printf '%s' "$resp" | BASE="$base" FORM="$form" "$PT_NODE" -e '
  let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
    const j = JSON.parse(s); const b = process.env.BASE || "{BASE_URL}";
    if (!Array.isArray(j.invites)) { console.error("no invites in the answer"); process.exit(1); }
    const url = c => (process.env.FORM === "landing" ? `${b}/frontier/frontier/playtest/#i=${c}` : `${b}/frontier/frontier/?invite=${c}`);
    const rows = ["invite_code,url", ...j.invites.map(c => `${c},${url(c)}`)];
    process.stdout.write(rows.join("\n") + "\n");
  });' > "$out.tmp" && mv "$out.tmp" "$out" && chmod 600 "$out" || { rm -f "$out.tmp"; echo "could not write $out" >&2; exit 1; }
echo "wrote $(($(wc -l < "$out") - 1)) invites (label $label, $form page urls) to $out" >&2
[ $to_stdout -eq 1 ] && cat "$out"
exit 0
