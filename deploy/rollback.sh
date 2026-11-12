#!/usr/bin/env bash
# S.P.R.U.C.E Mail Protection Service: go back to the build that ran before the current one.
# In Cloud Shell, from the folder with your deploy/settings.env:   bash deploy/rollback.sh
# Cloud Run keeps every earlier build (a "revision", with the settings it had). This sends all traffic,
# on both services, back to the one before the build serving now. Firestore records are kept. Run it
# again to go back one more. The next install or upgrade moves traffic to its new build.
set -euo pipefail
cd "$(dirname "$0")/.."
SETTINGS=deploy/settings.env
[ -f "$SETTINGS" ] || { echo "No $SETTINGS: run this from the folder you installed or upgraded from." >&2; exit 1; }
get() { sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" "$SETTINGS" | tr -d '\r' | tail -1 | sed 's/[[:space:]]*$//'; }
PROJECT="$(get PROJECT)"; REGION="$(get REGION)"
[ -n "$PROJECT" ] && [ -n "$REGION" ] || { echo "PROJECT and REGION must be set in $SETTINGS." >&2; exit 1; }
gcloud config set project "$PROJECT" --quiet >/dev/null

declare -A TARGET
for s in spruce-worker spruce-admin; do
    # The revision taking the traffic now, then the newest ready revision older than it.
    cur="$(gcloud run services describe "$s" --region="$REGION" --format='value(status.traffic[0].revisionName)')"
    [ -n "$cur" ] || { echo "Can't read $s's current build." >&2; exit 1; }
    prev="$(gcloud run revisions list --service="$s" --region="$REGION" --sort-by='~metadata.creationTimestamp' \
              --format='value(metadata.name,status.conditions[0].status)' | awk -v cur="$cur" 'found && $2=="True" { print $1; exit } $1==cur { found=1 }')"
    [ -n "$prev" ] || { echo "$s has no earlier build to go back to." >&2; exit 1; }
    img="$(gcloud run revisions describe "$prev" --region="$REGION" --format='value(spec.containers[0].image)')"
    echo "$s: $cur -> $prev (${img##*:})"
    TARGET[$s]="$prev"
done
if [ -t 0 ]; then
    read -r -p "Go back to these builds? [y/N] " ok
    case "$ok" in y | Y | yes | YES) ;; *) echo "Nothing changed."; exit 0 ;; esac
fi
for s in spruce-worker spruce-admin; do
    gcloud run services update-traffic "$s" --region="$REGION" --to-revisions="${TARGET[$s]}=100" --quiet >/dev/null
done
echo "Done. Both services run the earlier builds. To move forward again: bash deploy/upgrade.sh (or install.sh)."
