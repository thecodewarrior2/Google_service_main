#!/usr/bin/env bash
# S.P.R.U.C.E Mail Protection Service: clear what the dashboard shows, and start counting again
# (docs/INSTALL.md, "Clearing the dashboard's data"). Run in Cloud Shell from the folder you installed
# or last upgraded from:
#     bash deploy/clear-data.sh                    # asks you to type the project ID first
#     bash deploy/clear-data.sh --keep-activity    # keeps the Activity page (what admins did, alerts)
#     bash deploy/clear-data.sh --reset-clock      # also restarts the monitor-mode clock (Readiness)
#     bash deploy/clear-data.sh --yes              # no question (scripts)
#
# Deleted (Firestore): records (every email the dashboard lists), stats (the daily counts), campaigns
# (campaign pauses and admins' campaign decisions), moveCounts (the brake's hourly counters), and events (the
# Activity page) unless --keep-activity.
# Kept: the watched mailboxes, which emails were already checked, your Settings switches, the brake's
# state, sender history and the phishing lists. Nothing in Gmail changes.
# Then Activity gets one entry saying who cleared it, and the dashboard restarts (each instance keeps
# a copy of the records, and a deletion doesn't reach it otherwise). It can't be undone.
set -euo pipefail
cd "$(dirname "$0")/.."
fail() { printf '\n\033[31mStopped:\033[0m %s\n' "$*" >&2; exit 1; }
SETTINGS=deploy/settings.env
[ -f "$SETTINGS" ] || fail "no $SETTINGS here: run this from the folder you installed or upgraded from."
get() { sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" "$SETTINGS" | tr -d '\r' | tail -1 | sed 's/[[:space:]]*$//'; }
PROJECT="$(get PROJECT)"; REGION="$(get REGION)"
[ -n "$PROJECT" ] && [ -n "$REGION" ] || fail "PROJECT and REGION must be set in $SETTINGS."

KEEP_ACTIVITY='' RESET_CLOCK='' YES='' EVEN_IF_HELD=''
for a in "$@"; do
    case "$a" in
        --keep-activity) KEEP_ACTIVITY=1 ;;
        --reset-clock) RESET_CLOCK=1 ;;
        --yes) YES=1 ;;
        --even-if-paused | --even-if-held) EVEN_IF_HELD=1 ;;   # (--even-if-held: its name before 0.3.7)
        *) fail "unknown option $a (see the top of deploy/clear-data.sh)." ;;
    esac
done
# The collections to delete: always named (bulk-delete without them would delete every collection).
COLLECTIONS=records,stats,campaigns,moveCounts
[ -n "$KEEP_ACTIVITY" ] || COLLECTIONS="$COLLECTIONS,events"

gcloud config set project "$PROJECT" --quiet >/dev/null
ACCOUNT="$(gcloud config get-value account 2>/dev/null || true)"
TOKEN="$(gcloud auth print-access-token)"
# (SPRUCE_FIRESTORE_URL: the Firestore emulator, for the tests)
FS="${SPRUCE_FIRESTORE_URL:-https://firestore.googleapis.com/v1}/projects/$PROJECT/databases/(default)/documents"
fs() { curl -sS --fail-with-body -H "Authorization: Bearer $TOKEN" -H "x-goog-user-project: $PROJECT" -H 'content-type: application/json' "$@"; }

# --- 1. Is moving paused now? --------------------------------------------------------------------
# Emails the brake or a campaign pause left in the Inbox are listed only in the records: cleared, they
# are no longer tracked (they stay in the Inbox, and resuming no longer moves them). An answer that
# isn't what was asked for reads as "couldn't check" (?), never as "nothing paused".
TMPB="$(mktemp)"; trap 'rm -f "$TMPB"' EXIT
code="$(curl -sS -o "$TMPB" -w '%{http_code}' -H "Authorization: Bearer $TOKEN" -H "x-goog-user-project: $PROJECT" "$FS/state/brake" 2>/dev/null || true)"
case "$code" in
    200) brake="$(python3 -c '
import json, sys
try:
    v = json.load(open(sys.argv[1])).get("fields", {}).get("value") or {}
    print("on" if v and "nullValue" not in v else "off")
except Exception:
    print("?")' "$TMPB" 2>/dev/null || echo '?')" ;;
    404) brake=off ;;        # never tripped
    *) brake='?' ;;
esac
held="$(fs -X POST "$FS:runQuery" -d '{"structuredQuery":{"from":[{"collectionId":"campaigns"}],"where":{"fieldFilter":{"field":{"fieldPath":"heldAt"},"op":"GREATER_THAN","value":{"integerValue":"0"}}},"limit":500}}' 2>/dev/null | python3 -c '
import json, sys
try:
    rows = json.load(sys.stdin)
    print(sum(1 for r in rows if "document" in r and not r["document"].get("fields", {}).get("decision", {}).get("stringValue")) if isinstance(rows, list) else "?")
except Exception:
    print("?")' 2>/dev/null || true)"
case "$held" in '' | *[!0-9]*) held='?' ;; esac

cat <<EOF

Clear the dashboard's data in $PROJECT:
  Deleted: every recorded email (Overview, every page under Email, Model health and Readiness),
           the daily counts, campaign pauses and decisions, the brake's hourly counters$( [ -n "$KEEP_ACTIVITY" ] || printf ',\n           and Status → Activity')
  Kept:    the watched mailboxes, the emails already checked (none is judged twice), your Settings
           switches, the brake's state, sender history, the phishing lists$( [ -z "$KEEP_ACTIVITY" ] || printf ', Status → Activity')
  $( [ -n "$RESET_CLOCK" ] && echo 'Also:    the monitor-mode clock restarts (Readiness counts days again; 14 days of learning senders)' || echo 'Not:     the monitor-mode clock (add --reset-clock to restart it)')
  Nothing in Gmail changes. This can't be undone.
EOF
if [ "$brake" != off ] || [ "$held" != 0 ]; then
    echo
    [ "$brake" != on ] || echo "  The brake is on: the emails it left in the Inbox would no longer be tracked, so resuming couldn't move them."
    [ "$held" = '?' ] || [ "$held" -eq 0 ] || echo "  Moving is paused for $held campaign(s), waiting for a decision: the copies left in the Inbox would no longer be tracked."
    if [ "$brake" = '?' ] || [ "$held" = '?' ]; then
        echo "  Couldn't check whether the brake or a campaign pause is on (Firestore didn't answer as expected)."
    fi
    echo "  Decide first on the dashboard (Overview: resume; Email → Campaigns: confirm, or dismiss as a false alarm)."
    [ -n "$EVEN_IF_HELD" ] || fail "moving is or may be paused. Check the dashboard's Overview first, then add --even-if-paused to clear anyway."
fi

if [ -z "$YES" ]; then
    [ -t 0 ] || fail "no terminal to ask in: add --yes to clear without the question."
    read -r -p "Type the project ID ($PROJECT) to clear its dashboard data: " ok
    [ "$ok" = "$PROJECT" ] || { echo "Nothing changed."; exit 0; }
fi

# --- 2. Delete -----------------------------------------------------------------------------------
echo
echo "== Deleting $COLLECTIONS (a minute or two)"
gcloud firestore bulk-delete --database='(default)' --collection-ids="$COLLECTIONS" --quiet
if [ -n "$RESET_CLOCK" ]; then
    echo "== Restarting the monitor-mode clock"
    fs -X DELETE "$FS/state/installedAt" >/dev/null || fail "couldn't delete state/installedAt (the rest is cleared)."
fi

# --- 3. Say so in Activity, and restart the dashboard ----------------------------------------------
TEXT="${ACCOUNT:-Someone in Cloud Shell} cleared the dashboard's data (deploy/clear-data.sh): the recorded emails, daily counts and campaign decisions$( [ -n "$KEEP_ACTIVITY" ] || printf ', and Activity before this')$( [ -z "$RESET_CLOCK" ] || printf '; the monitor-mode clock restarts'). Watched mailboxes and settings were kept."
BODY="$(python3 -c 'import json,sys; print(json.dumps({"fields": {"at": {"integerValue": sys.argv[1]}, "kind": {"stringValue": "clear"}, "text": {"stringValue": sys.argv[2]}}}))' "$(date +%s%3N)" "$TEXT")"
fs -X POST "$FS/events" -d "$BODY" >/dev/null || echo "  (Couldn't add the entry to Activity; everything else is done.)"
echo "== Restarting the dashboard (it keeps a copy of the records)"
gcloud run services update spruce-admin --region="$REGION" --update-env-vars="SPRUCE_RESTARTED=$(date +%s)" --quiet >/dev/null

cat <<EOF

Done. Reload the dashboard: it starts from zero, and new emails appear as they arrive.
EOF
