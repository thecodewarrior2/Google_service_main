#!/usr/bin/env bash
# S.P.R.U.C.E Mail Protection Service: stop watching every mailbox (docs/INSTALL.md, "Turning it off").
# Run in Cloud Shell from the unzipped folder:  bash deploy/stop.sh
# Gmail stops sending notifications, so no email is read from then on. Records stay in Firestore.
# Running deploy/install.sh again starts watching again.
set -euo pipefail
cd "$(dirname "$0")/.."
SETTINGS=deploy/settings.env
[ -f "$SETTINGS" ] || { echo "No $SETTINGS: run this from the folder you installed from." >&2; exit 1; }
get() { sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" "$SETTINGS" | tr -d '\r' | tail -1 | sed 's/[[:space:]]*$//'; }
PROJECT="$(get PROJECT)"; REGION="$(get REGION)"
[ -n "$PROJECT" ] && [ -n "$REGION" ] || { echo "PROJECT and REGION must be set in $SETTINGS." >&2; exit 1; }
gcloud config set project "$PROJECT" --quiet >/dev/null
NUMBER="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"
SA_INVOKER="spruce-invoker@$PROJECT.iam.gserviceaccount.com"
WORKER_URL="$(gcloud run services describe spruce-worker --region="$REGION" --format='value(status.url)')"

echo "== Pausing the daily watch renewal"
gcloud scheduler jobs pause spruce-renew-watches --location="$REGION" --quiet

echo "== Stopping every watch"
verb=create; gcloud scheduler jobs describe spruce-stop-watches --location="$REGION" >/dev/null 2>&1 && verb=update
# A one-off job (Scheduler needs a schedule; it is paused right after this run).
gcloud scheduler jobs "$verb" http spruce-stop-watches --location="$REGION" --schedule="0 0 1 1 *" --uri="$WORKER_URL/tasks/stop-watches" --http-method=POST \
    --oidc-service-account-email="$SA_INVOKER" --oidc-token-audience="https://spruce-worker-$NUMBER.$REGION.run.app" --quiet >/dev/null
gcloud scheduler jobs resume spruce-stop-watches --location="$REGION" --quiet >/dev/null 2>&1 || true
gcloud scheduler jobs run spruce-stop-watches --location="$REGION" --quiet
echo "   (waiting for it to run)"; sleep "${SPRUCE_STOP_WAIT:-45}"   # (the tests make it shorter)
# Paused, so it never runs again by itself; deploy/install.sh deletes it.
gcloud scheduler jobs pause spruce-stop-watches --location="$REGION" --quiet >/dev/null

cat <<EOF
Done: Gmail stops notifying for the pilot mailboxes within a minute.
To switch all access off as well, remove the domain-wide delegation entry in the Admin console
(Security > Access and data control > API controls > Manage Domain Wide Delegation).
EOF
