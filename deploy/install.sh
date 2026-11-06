#!/usr/bin/env bash
# S.P.R.U.C.E+ Mail Protection: install, or update, in your own Google Cloud project.
# Run it in Cloud Shell, from the folder you unzipped (docs/INSTALL.md):
#     bash deploy/install.sh
# Settings come from deploy/settings.env (copy deploy/settings.example.env). Safe to run again: it
# creates what is missing, updates the rest and deploys a fresh build. It never creates a key file.
set -euo pipefail
cd "$(dirname "$0")/.."

step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
fail() { printf '\n\033[31mStopped:\033[0m %s\n' "$*" >&2; exit 1; }
# New service accounts take a few seconds to be usable in IAM bindings.
retry() { local i; for i in 1 2 3 4 5 6; do if "$@"; then return 0; fi; echo "  (retrying in $((i * 5)) s)"; sleep $((i * 5)); done; return 1; }

# --- Settings (read line by line: values hold semicolons, so the file is not run as shell) ---------
SETTINGS=deploy/settings.env
[ -f "$SETTINGS" ] || fail "copy deploy/settings.example.env to $SETTINGS and fill it in first."
PROJECT= REGION= ORG_DOMAINS= PILOT_GROUP= DIRECTORY_ADMIN= ADMIN_EMAILS= MODE=monitor
AI_MOVE_THRESHOLD= ALLOW_DOMAINS= ALLOW_ADDRESSES= BRAKE_PER_HOUR=
while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    case "$line" in '' | \#*) continue ;; esac
    key="${line%%=*}"; val="${line#*=}"
    key="$(echo "$key" | tr -d '[:space:]')"; val="$(echo "$val" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
    case "$val" in *'"'* | *'\'* | *'$'* | *'`'*) fail "$key: quotes, backslashes and \$ are not allowed in settings." ;; esac
    case "$key" in
        PROJECT | REGION | ORG_DOMAINS | PILOT_GROUP | DIRECTORY_ADMIN | ADMIN_EMAILS | MODE | AI_MOVE_THRESHOLD | ALLOW_DOMAINS | ALLOW_ADDRESSES | BRAKE_PER_HOUR) printf -v "$key" '%s' "$val" ;;
        *) fail "unknown setting '$key' in $SETTINGS." ;;
    esac
done < "$SETTINGS"
for k in PROJECT REGION ORG_DOMAINS PILOT_GROUP DIRECTORY_ADMIN ADMIN_EMAILS; do [ -n "${!k}" ] || fail "$k is empty in $SETTINGS."; done
case "$MODE" in monitor | enforce) ;; *) fail "MODE must be monitor or enforce." ;; esac
if grep -v '^[[:space:]]*#' "$SETTINGS" | grep -q 'maple-schools.example\|my-spruce-project'; then fail "$SETTINGS still has the example values: put in your own."; fi
command -v gcloud >/dev/null || fail "gcloud is not installed (use Cloud Shell)."

VERSION="$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' package.json | head -1)"
SA_RUN="spruce-run@$PROJECT.iam.gserviceaccount.com"
SA_DELEGATE="spruce-delegate@$PROJECT.iam.gserviceaccount.com"
SA_INVOKER="spruce-invoker@$PROJECT.iam.gserviceaccount.com"
TOPIC=gmail-spruce
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

step "Project $PROJECT ($REGION), S.P.R.U.C.E+ Mail Protection $VERSION, mode $MODE"
gcloud config set project "$PROJECT" --quiet >/dev/null
NUMBER="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')" || fail "can't read project $PROJECT (does it exist, and are you an owner?)."

step "1/9 APIs"
gcloud services enable gmail.googleapis.com admin.googleapis.com pubsub.googleapis.com run.googleapis.com \
    firestore.googleapis.com iamcredentials.googleapis.com cloudscheduler.googleapis.com iap.googleapis.com \
    cloudbuild.googleapis.com artifactregistry.googleapis.com --quiet

step "2/9 Firestore (records, counters, state)"
if gcloud firestore databases describe --database='(default)' >/dev/null 2>&1; then echo "  exists"
else gcloud firestore databases create --location="$REGION" --quiet; fi

step "3/9 Service accounts (no keys)"
mk_sa() { gcloud iam service-accounts describe "$1@$PROJECT.iam.gserviceaccount.com" >/dev/null 2>&1 || gcloud iam service-accounts create "$1" --display-name="$2" --quiet; }
mk_sa spruce-run "SPRUCE Mail Protection (Cloud Run)"
mk_sa spruce-delegate "SPRUCE Mail Protection (Gmail delegation)"
mk_sa spruce-invoker "SPRUCE Mail Protection (Pub/Sub and Scheduler)"
retry gcloud iam service-accounts add-iam-policy-binding "$SA_DELEGATE" --member="serviceAccount:$SA_RUN" --role=roles/iam.serviceAccountTokenCreator --quiet >/dev/null
retry gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$SA_RUN" --role=roles/datastore.user --condition=None --quiet >/dev/null
# Pub/Sub signs its push requests as spruce-invoker (needed explicitly in older projects).
retry gcloud iam service-accounts add-iam-policy-binding "$SA_INVOKER" --member="serviceAccount:service-$NUMBER@gcp-sa-pubsub.iam.gserviceaccount.com" --role=roles/iam.serviceAccountTokenCreator --quiet >/dev/null
CLIENT_ID="$(gcloud iam service-accounts describe "$SA_DELEGATE" --format='value(oauth2ClientId)')"

step "4/9 Domain-wide delegation (Admin console; you do this part)"
cat <<EOF
  In admin.google.com: Security > Access and data control > API controls >
  Manage Domain Wide Delegation > Add new (or edit the existing entry):
      Client ID:  $CLIENT_ID
      Scopes:     https://www.googleapis.com/auth/gmail.modify,https://www.googleapis.com/auth/admin.directory.group.member.readonly
  Also check that $PILOT_GROUP exists and that $DIRECTORY_ADMIN has an admin
  role with Groups > Read (docs/INSTALL.md, step 2).
EOF
if [ -t 0 ]; then read -r -p "  Press Enter when that is done (it can take a few minutes to apply)... " _; fi

step "5/9 Pub/Sub topic Gmail notifies"
gcloud pubsub topics describe "$TOPIC" >/dev/null 2>&1 || gcloud pubsub topics create "$TOPIC" --quiet
gcloud pubsub topics add-iam-policy-binding "$TOPIC" --member=serviceAccount:gmail-api-push@system.gserviceaccount.com --role=roles/pubsub.publisher --quiet >/dev/null \
    || fail "Gmail couldn't be allowed to publish to $TOPIC. If an organization policy limits members to your domain (iam.allowedPolicyMemberDomains), allow an exception for this project: docs/INSTALL.md, Troubleshooting."

step "6/9 Build the image"
gcloud artifacts repositories describe spruce --location="$REGION" >/dev/null 2>&1 \
    || gcloud artifacts repositories create spruce --repository-format=docker --location="$REGION" --description="S.P.R.U.C.E+ Mail Protection" --quiet
IMAGE="$REGION-docker.pkg.dev/$PROJECT/spruce/mail-protection:$VERSION-$(date -u +%Y%m%d-%H%M%S)"
if command -v docker >/dev/null && docker info >/dev/null 2>&1; then
    gcloud auth configure-docker "$REGION-docker.pkg.dev" --quiet >/dev/null
    docker build -t "$IMAGE" . && docker push "$IMAGE"
else
    gcloud builds submit --tag "$IMAGE" --quiet .
fi
echo "  $IMAGE"

# Settings for both services, as YAML (no comma escaping).
env_file() {
    local f="$TMP/$1.yaml"; shift
    : > "$f"
    while [ $# -gt 1 ]; do [ -n "$2" ] && printf '%s: "%s"\n' "$1" "$2" >> "$f"; shift 2; done
    echo "$f"
}
WORKER_AUD="https://spruce-worker-$NUMBER.$REGION.run.app"
IAP_AUD="/projects/$NUMBER/locations/$REGION/services/spruce-admin"
COMMON=(MODE "$MODE" ORG_DOMAINS "$ORG_DOMAINS" DELEGATED_SA "$SA_DELEGATE" AI_MOVE_THRESHOLD "$AI_MOVE_THRESHOLD" ALLOW_DOMAINS "$ALLOW_DOMAINS" ALLOW_ADDRESSES "$ALLOW_ADDRESSES" BRAKE_PER_HOUR "$BRAKE_PER_HOUR")

step "7/9 Worker (reads the pilot mailboxes; only Pub/Sub and Scheduler may call it)"
WF="$(env_file worker ROLE worker "${COMMON[@]}" PILOT_GROUP "$PILOT_GROUP" DIRECTORY_ADMIN "$DIRECTORY_ADMIN" \
    PUBSUB_TOPIC "projects/$PROJECT/topics/$TOPIC" PUSH_SERVICE_ACCOUNT "$SA_INVOKER" PUSH_AUDIENCE "$WORKER_AUD")"
gcloud run deploy spruce-worker --image="$IMAGE" --region="$REGION" --service-account="$SA_RUN" --no-allow-unauthenticated \
    --concurrency=8 --timeout=120 --memory=1Gi --max-instances=10 --env-vars-file="$WF" --quiet
WORKER_URL="$(gcloud run services describe spruce-worker --region="$REGION" --format='value(status.url)')"
gcloud run services add-iam-policy-binding spruce-worker --region="$REGION" --member="serviceAccount:$SA_INVOKER" --role=roles/run.invoker --quiet >/dev/null

step "8/9 Dashboard (behind Identity-Aware Proxy, for ADMIN_EMAILS only)"
AF="$(env_file admin ROLE admin "${COMMON[@]}" IAP_AUDIENCE "$IAP_AUD" ADMIN_EMAILS "$ADMIN_EMAILS")"
gcloud run deploy spruce-admin --image="$IMAGE" --region="$REGION" --service-account="$SA_RUN" --no-allow-unauthenticated \
    --memory=512Mi --max-instances=3 --env-vars-file="$AF" --quiet
ADMIN_URL="$(gcloud run services describe spruce-admin --region="$REGION" --format='value(status.url)')"
iap_setup() {
    gcloud beta run services update spruce-admin --region="$REGION" --iap --quiet >/dev/null || return 1
    gcloud beta services identity create --service=iap.googleapis.com --project="$PROJECT" --quiet >/dev/null 2>&1 || true
    retry gcloud run services add-iam-policy-binding spruce-admin --region="$REGION" --member="serviceAccount:service-$NUMBER@gcp-sa-iap.iam.gserviceaccount.com" --role=roles/run.invoker --quiet >/dev/null || return 1
    local e
    for e in $(echo "$ADMIN_EMAILS" | tr ';,' '  '); do
        gcloud iap web add-iam-policy-binding --resource-type=cloud-run --service=spruce-admin --region="$REGION" \
            --member="user:$e" --role=roles/iap.httpsResourceAccessor --condition=None --quiet >/dev/null || return 1
    done
}
if ! iap_setup; then
    echo "  Identity-Aware Proxy could not be set up from here; the dashboard stays closed to everyone. Turn it on in the console: docs/INSTALL.md, Troubleshooting."
fi

step "9/9 Notifications and daily jobs"
if gcloud pubsub subscriptions describe gmail-spruce-push >/dev/null 2>&1; then
    gcloud pubsub subscriptions update gmail-spruce-push --push-endpoint="$WORKER_URL/pubsub/push" --push-auth-service-account="$SA_INVOKER" --push-auth-token-audience="$WORKER_AUD" --ack-deadline=120 --quiet >/dev/null
else
    gcloud pubsub subscriptions create gmail-spruce-push --topic="$TOPIC" --push-endpoint="$WORKER_URL/pubsub/push" --push-auth-service-account="$SA_INVOKER" --push-auth-token-audience="$WORKER_AUD" --ack-deadline=120 --quiet >/dev/null
fi
job() { # name, schedule, path, extra flags...
    local name="$1" schedule="$2" path="$3"; shift 3
    local verb=create; gcloud scheduler jobs describe "$name" --location="$REGION" >/dev/null 2>&1 && verb=update
    gcloud scheduler jobs "$verb" http "$name" --location="$REGION" --schedule="$schedule" --uri="$WORKER_URL$path" --http-method=POST \
        --oidc-service-account-email="$SA_INVOKER" --oidc-token-audience="$WORKER_AUD" "$@" --quiet >/dev/null
    echo "  $name ($schedule UTC)"
}
job spruce-renew-watches "17 3 * * *" /tasks/renew-watches
job spruce-purge "41 4 * * *" /tasks/purge
job spruce-sync-feeds "23 5 * * *" /tasks/sync-feeds --attempt-deadline=300s
gcloud scheduler jobs resume spruce-renew-watches --location="$REGION" --quiet >/dev/null 2>&1 || true
# Left by deploy/stop.sh: never kept around while the service is on.
gcloud scheduler jobs delete spruce-stop-watches --location="$REGION" --quiet >/dev/null 2>&1 || true
gcloud scheduler jobs run spruce-sync-feeds --location="$REGION" --quiet
gcloud scheduler jobs run spruce-renew-watches --location="$REGION" --quiet

step "Done"
cat <<EOF
  Dashboard:  $ADMIN_URL   (sign in as one of: $ADMIN_EMAILS)
  Mode:       $MODE$( [ "$MODE" = monitor ] && echo " (nothing is moved; would-be moves are recorded)")
  Watching:   members of $PILOT_GROUP. Settings in the dashboard shows how many mailboxes are watched.

  The watches start within a minute. To see the worker's log:
      gcloud run services logs read spruce-worker --region=$REGION --limit=50
  After you change the group's members, apply it now (otherwise it happens daily at 03:17 UTC):
      gcloud scheduler jobs run spruce-renew-watches --location=$REGION
EOF
