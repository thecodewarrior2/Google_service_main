#!/usr/bin/env bash
# S.P.R.U.C.E Mail Protection Service: check the installation end to end, and say what to run for each problem.
# In Cloud Shell, from the folder you installed from:   bash deploy/doctor.sh
# Read-only: it changes nothing. It checks what the dashboard's Status page can't see from inside the
# service: the Pub/Sub subscription, Gmail's permission to publish, the alert policies, recent errors.
set -uo pipefail
cd "$(dirname "$0")/.."
SETTINGS=deploy/settings.env
[ -f "$SETTINGS" ] || { echo "No $SETTINGS: run this from the folder you installed from." >&2; exit 1; }
get() { sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" "$SETTINGS" | tr -d '\r' | tail -1 | sed 's/[[:space:]]*$//'; }
PROJECT="$(get PROJECT)"; REGION="$(get REGION)"; ALERT_EMAIL="$(get ALERT_EMAIL)"
[ -n "$PROJECT" ] && [ -n "$REGION" ] || { echo "PROJECT and REGION must be set in $SETTINGS." >&2; exit 1; }
gcloud config set project "$PROJECT" --quiet >/dev/null 2>&1
NUMBER="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)' 2>/dev/null)"
SA_INVOKER="spruce-invoker@$PROJECT.iam.gserviceaccount.com"
WORKER_AUD="https://spruce-worker-$NUMBER.$REGION.run.app"
bad=0
ok() { printf '  \033[32mOK\033[0m   %s\n' "$1"; }
no() { printf '  \033[31mFIX\033[0m  %s\n       What to do: %s\n' "$1" "$2"; bad=$((bad + 1)); }
iap_on() { gcloud run services describe "$1" --region="$REGION" --format=json 2>/dev/null | grep -Eq '"run.googleapis.com/iap-enabled": "?true'; }

echo "S.P.R.U.C.E Mail Protection Service in $PROJECT ($REGION)"
[ "$(gcloud billing projects describe "$PROJECT" --format='value(billingEnabled)' 2>/dev/null)" = True ] && ok "A billing account is linked." \
    || no "No billing account is linked: Cloud Run stops." "link one in the Cloud console (Billing)."
WIMG="$(gcloud run services describe spruce-worker --region="$REGION" --format='value(spec.template.spec.containers[0].image)' 2>/dev/null)"
AIMG="$(gcloud run services describe spruce-admin --region="$REGION" --format='value(spec.template.spec.containers[0].image)' 2>/dev/null)"
if [ -z "$WIMG" ] || [ -z "$AIMG" ]; then no "spruce-worker or spruce-admin isn't deployed." "bash deploy/install.sh"
else
    WV="${WIMG##*:}"; WV="${WV%%-*}"; AV="${AIMG##*:}"; AV="${AV%%-*}"
    [ "$WV" = "$AV" ] && ok "Both services run $WV." || no "The worker runs $WV and the dashboard $AV." "bash deploy/install.sh (or upgrade.sh), so both run the same build."
fi
iap_on spruce-worker && no "Identity-Aware Proxy is ON for spruce-worker: Gmail's notifications and the jobs are refused (401)." "gcloud beta run services update spruce-worker --region=$REGION --no-iap" \
    || ok "Identity-Aware Proxy is off for spruce-worker."
iap_on spruce-admin && ok "Identity-Aware Proxy is on for the dashboard (spruce-admin)." \
    || no "Identity-Aware Proxy is off for the dashboard: nobody can open it." "docs/INSTALL.md, Troubleshooting, \"Identity-Aware Proxy could not be set up from here\"."
gcloud run services get-iam-policy spruce-worker --region="$REGION" --format=json 2>/dev/null | grep -q "serviceAccount:$SA_INVOKER" \
    && ok "spruce-invoker may call the worker." || no "spruce-invoker may not call the worker." "bash deploy/install.sh (it grants roles/run.invoker)."
WURL="$(gcloud run services describe spruce-worker --region="$REGION" --format='value(status.url)' 2>/dev/null)"
SUB="$(gcloud pubsub subscriptions describe gmail-spruce-push --format='value(pushConfig.pushEndpoint,pushConfig.oidcToken.serviceAccountEmail,pushConfig.oidcToken.audience)' 2>/dev/null | tr '\t' ' ')"
[ "$SUB" = "$WURL/pubsub/push $SA_INVOKER $WORKER_AUD" ] && ok "The Pub/Sub subscription pushes to the worker, signed as spruce-invoker." \
    || no "The Pub/Sub subscription doesn't match the worker (${SUB:-missing})." "bash deploy/install.sh (step 9 sets it)."
gcloud pubsub topics get-iam-policy gmail-spruce --format=json 2>/dev/null | grep -q 'gmail-api-push@system.gserviceaccount.com' \
    && ok "Gmail may publish to the gmail-spruce topic." || no "Gmail may not publish to the gmail-spruce topic: no notification comes." "bash deploy/install.sh (step 5), and docs/INSTALL.md, Troubleshooting, if it fails there."
for j in spruce-renew-watches spruce-sync-feeds; do
    st="$(gcloud scheduler jobs describe "$j" --location="$REGION" --format='value(state)' 2>/dev/null)"
    code="$(gcloud scheduler jobs describe "$j" --location="$REGION" --format='value(status.code)' 2>/dev/null)"
    if [ "$st" != ENABLED ]; then no "The job $j is ${st:-missing}." "$( [ "$st" = PAUSED ] && echo 'bash deploy/install.sh starts it again (deploy/stop.sh paused it).' || echo 'bash deploy/install.sh')"
    elif [ -n "$code" ] && [ "$code" != 0 ]; then no "The job $j's last run didn't reach the worker (status $code)." "gcloud logging read 'resource.type=\"cloud_scheduler_job\" AND resource.labels.job_id=\"$j\"' --freshness=1d --limit=3 shows why; docs/INSTALL.md, Troubleshooting."
    else ok "The job $j is on, and its last run reached the worker."; fi
done
if [ "$ALERT_EMAIL" = off ]; then ok "Alerts aren't emailed (ALERT_EMAIL=off): they show in the dashboard."
else
    # "SPRUCE Mail Protection" matches the policies' names before 0.5.9 and after ("… Service: …").
    n="$(gcloud monitoring policies list --filter='displayName:"SPRUCE Mail Protection"' --format='value(name)' 2>/dev/null | grep -c . || true)"
    [ "${n:-0}" -ge 2 ] && ok "The alert policies are there ($n)." || no "The alert policies are missing ($n of 2): alerts aren't emailed." "bash deploy/install.sh (step 9); it needs the Monitoring Editor role, or Owner."
fi
errs="$(gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="spruce-worker" AND severity>=ERROR' --freshness=1d --limit=100 --format='value(timestamp)' 2>/dev/null | grep -c . || true)"
[ "${errs:-0}" -eq 0 ] && ok "No errors in the worker's log in the last day." \
    || no "$errs errors in the worker's log in the last day." "gcloud run services logs read spruce-worker --region=$REGION --limit=50 (and the dashboard's Activity)."
echo
if [ "$bad" -eq 0 ]; then echo "Everything checked works."; else echo "$bad to fix (above)."; exit 1; fi
