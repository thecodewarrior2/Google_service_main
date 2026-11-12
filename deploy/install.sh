#!/usr/bin/env bash
# S.P.R.U.C.E Mail Protection Service: install, or update, in your own Google Cloud project.
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
PROJECT= REGION= ORG_DOMAINS= PILOT_GROUP= DIRECTORY_ADMIN= ADMIN_EMAILS= ADMIN_GROUP= MODE=monitor
AI_MOVE_THRESHOLD= AI_SUSPICIOUS_THRESHOLD= ALLOW_DOMAINS= ALLOW_ADDRESSES= BRAKE_PER_HOUR= BUDGET_ALERT= ALERT_EMAIL= CAMPAIGN_HOLD_AFTER= TIME_ZONE= WORKER_MAX_INSTANCES= RETENTION_DAYS=
while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    case "$line" in '' | \#*) continue ;; esac
    key="${line%%=*}"; val="${line#*=}"
    key="$(echo "$key" | tr -d '[:space:]')"; val="$(echo "$val" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
    case "$val" in *'"'* | *'\'* | *'$'* | *'`'*) fail "$key: quotes, backslashes and \$ are not allowed in settings." ;; esac
    case "$key" in
        PROJECT | REGION | ORG_DOMAINS | PILOT_GROUP | DIRECTORY_ADMIN | ADMIN_EMAILS | ADMIN_GROUP | MODE | AI_MOVE_THRESHOLD | AI_SUSPICIOUS_THRESHOLD | ALLOW_DOMAINS | ALLOW_ADDRESSES | BRAKE_PER_HOUR | BUDGET_ALERT | ALERT_EMAIL | CAMPAIGN_HOLD_AFTER | TIME_ZONE | WORKER_MAX_INSTANCES | RETENTION_DAYS) printf -v "$key" '%s' "$val" ;;
        *) fail "unknown setting '$key' in $SETTINGS." ;;
    esac
done < "$SETTINGS"
for k in PROJECT REGION ORG_DOMAINS PILOT_GROUP DIRECTORY_ADMIN; do [ -n "${!k}" ] || fail "$k is empty in $SETTINGS."; done
[ -n "$ADMIN_EMAILS$ADMIN_GROUP" ] || fail "set ADMIN_GROUP or ADMIN_EMAILS in $SETTINGS (who may open the dashboard)."
WHO="$(echo "$ADMIN_GROUP;$ADMIN_EMAILS" | tr ',' ';' | sed 's/;;*/;/g; s/^;//; s/;$//')"   # for messages
case "$MODE" in monitor | enforce) ;; *) fail "MODE must be monitor or enforce." ;; esac
BUDGET_ALERT="${BUDGET_ALERT:-1}"
# Where alerts are emailed: ALERT_EMAIL, else the dashboard's group, else its first address; off = none.
ALERT_TO="${ALERT_EMAIL:-$(echo "$ADMIN_GROUP;$ADMIN_EMAILS" | tr ',;' '  ' | awk '{print $1}')}"
[ "$ALERT_EMAIL" != off ] || ALERT_TO=
case "$ALERT_TO" in '' | *@*.*) ;; *) fail "ALERT_EMAIL must be an email address, or off." ;; esac
# The scheduled jobs (and the weekly summary) run in the district's time zone: an IANA name.
TZ_NAME="${TIME_ZONE:-UTC}"
[[ "$TZ_NAME" =~ ^(UTC|[A-Za-z_]+(/[A-Za-z0-9_+-]+)+)$ ]] || fail "TIME_ZONE must be a time zone name, like America/New_York (or empty for UTC)."
[[ "$BUDGET_ALERT" =~ ^(off|[0-9]+(\.[0-9]{1,2})?)$ ]] || fail "BUDGET_ALERT must be an amount (like 1 or 5) or off."
WORKER_MAX="${WORKER_MAX_INSTANCES:-30}"
[[ "$WORKER_MAX" =~ ^[0-9]+$ ]] && [ "$WORKER_MAX" -ge 1 ] && [ "$WORKER_MAX" -le 100 ] || fail "WORKER_MAX_INSTANCES must be a number from 1 to 100 (or empty for 30)."
# How long records are kept (also on the dashboard, Settings → Policy). Empty = 35.
keep_days_ok() { [ -z "$RETENTION_DAYS" ] || { [[ "$RETENTION_DAYS" =~ ^[0-9]+$ ]] && [ "$RETENTION_DAYS" -ge 14 ] && [ "$RETENTION_DAYS" -le 365 ]; } || fail "RETENTION_DAYS must be a number of days from 14 to 365 (or empty for 35)."; }
keep_days_ok
KEEP_BUILDS=3   # images kept in Artifact Registry (the free tier is 0.5 GB; deploy/rollback.sh can go back 2)
if grep -v '^[[:space:]]*#' "$SETTINGS" | grep -q 'maple-schools.example\|my-spruce-project'; then fail "$SETTINGS still has the example values: put in your own."; fi
command -v gcloud >/dev/null || fail "gcloud is not installed (use Cloud Shell)."

VERSION="$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' package.json | head -1)"
SA_RUN="spruce-run@$PROJECT.iam.gserviceaccount.com"
SA_DELEGATE="spruce-delegate@$PROJECT.iam.gserviceaccount.com"
SA_INVOKER="spruce-invoker@$PROJECT.iam.gserviceaccount.com"
SA_BUILD="spruce-build@$PROJECT.iam.gserviceaccount.com"
SA_UPDATER="spruce-updater@$PROJECT.iam.gserviceaccount.com"
# Where the approved versions are: Settings → Update reads them, and its job installs from there.
RELEASES="${SPRUCE_RELEASES:-https://github.com/thecodewarrior2/Google_service_main.git}"
INSTALL_LEVEL="$(sed -n 's/^ *"installLevel": *\([0-9]*\).*/\1/p' package.json | head -1)"; INSTALL_LEVEL="${INSTALL_LEVEL:-0}"
TOPIC=gmail-spruce
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

step "Project $PROJECT ($REGION), S.P.R.U.C.E Mail Protection Service $VERSION, mode $MODE"
gcloud config set project "$PROJECT" --quiet >/dev/null
# The policy settings changed on the dashboard (Settings → Policy): taken where settings.env doesn't set
# them, asked about where the two differ, and written into settings.env (deploy/dashboard-policy.sh).
. deploy/dashboard-policy.sh
dashboard_policy_read "$PROJECT" "$MODE" "$AI_MOVE_THRESHOLD" "$BRAKE_PER_HOUR" "$TIME_ZONE" "$ALLOW_DOMAINS" "$ALLOW_ADDRESSES" "$AI_SUSPICIOUS_THRESHOLD" "$RETENTION_DAYS"
dashboard_policy_reconcile "$SETTINGS"
case "$MODE" in monitor | enforce) ;; *) fail "MODE must be monitor or enforce." ;; esac
keep_days_ok
TZ_NAME="${TIME_ZONE:-UTC}"
NUMBER="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')" || fail "can't read project $PROJECT (does it exist, and are you an owner?)."
# Google requires a billing account on the project for Cloud Run, Scheduler, Build and Artifact
# Registry, even when the use stays within the free tier (docs/INSTALL.md, "Costs").
[ "$(gcloud billing projects describe "$PROJECT" --format='value(billingEnabled)' 2>/dev/null)" = True ] \
    || fail "no billing account is linked to $PROJECT. Google requires one for Cloud Run, even at no cost: link it in the Cloud console (Billing), then run this again. A pilot should stay within the free tier, and a budget alert is set up below."
BILLING_ACCOUNT="$(gcloud billing projects describe "$PROJECT" --format='value(billingAccountName)')"; BILLING_ACCOUNT="${BILLING_ACCOUNT#billingAccounts/}"

step "1/9 APIs and the budget alert"
gcloud services enable gmail.googleapis.com admin.googleapis.com pubsub.googleapis.com run.googleapis.com \
    firestore.googleapis.com iamcredentials.googleapis.com cloudscheduler.googleapis.com iap.googleapis.com \
    cloudbuild.googleapis.com artifactregistry.googleapis.com billingbudgets.googleapis.com monitoring.googleapis.com --quiet

# A budget alert: Google emails the billing account's admins as soon as this project is charged at all
# (1% of the amount), and again at half and all of it. It warns; it doesn't stop the service.
budget() {
    # (Named "SPRUCE Mail Protection (…)" before 0.5.9: found under either name, and renamed.)
    local name="SPRUCE Mail Protection Service ($PROJECT)" old="SPRUCE Mail Protection ($PROJECT)" cur id
    cur="$(gcloud billing accounts describe "$BILLING_ACCOUNT" --format='value(currencyCode)' 2>/dev/null || true)"; cur="${cur:-USD}"
    id="$(gcloud billing budgets list --billing-account="$BILLING_ACCOUNT" --filter="displayName=\"$name\" OR displayName=\"$old\"" --format='value(name)' 2>/dev/null | head -1)" || return 1
    if [ -n "$id" ]; then
        gcloud billing budgets update "$id" --billing-account="$BILLING_ACCOUNT" --display-name="$name" --budget-amount="$BUDGET_ALERT$cur" --clear-threshold-rules \
            --add-threshold-rule=percent=0.01 --add-threshold-rule=percent=0.5 --add-threshold-rule=percent=1.0 --quiet >/dev/null || return 1
    else
        gcloud billing budgets create --billing-account="$BILLING_ACCOUNT" --display-name="$name" --budget-amount="$BUDGET_ALERT$cur" \
            --filter-projects="projects/$PROJECT" --threshold-rule=percent=0.01 --threshold-rule=percent=0.5 --threshold-rule=percent=1.0 --quiet >/dev/null || return 1
    fi
    echo "  Budget alert: $BUDGET_ALERT $cur for this project; the billing account's admins are emailed at the first charge."
}
if [ "$BUDGET_ALERT" = off ]; then echo "  Budget alert: off (BUDGET_ALERT=off)."
elif ! budget; then
    echo "  The budget alert couldn't be set: it needs the Billing Account Administrator or Costs Manager role on"
    echo "  billing account $BILLING_ACCOUNT. Ask its admin to add one in Billing > Budgets & alerts (docs/INSTALL.md, Costs)."
fi

step "2/9 Firestore (records, counters, state)"
if gcloud firestore databases describe --database='(default)' >/dev/null 2>&1; then echo "  exists"
else gcloud firestore databases create --location="$REGION" --quiet; fi
# Old documents are deleted by Firestore itself (TTL policies on expireAt, which the service writes on what
# expires: records and checked messages after RETENTION_DAYS, the brake's counters after 2 days…), typically
# within a day; the daily cleanup job only takes what has no expireAt. expireAt is never queried: not indexed.
TTL_FAILED=
for g in seen records events moveCounts campaigns cache; do
    gcloud firestore fields ttls update expireAt --collection-group="$g" --enable-ttl --async --quiet >/dev/null 2>&1 || TTL_FAILED=1
    gcloud firestore indexes fields update expireAt --collection-group="$g" --disable-indexes --async --quiet >/dev/null 2>&1 || true
done
if [ -n "$TTL_FAILED" ]; then echo "  (Old documents couldn't be set to expire by themselves; the daily cleanup job still deletes them.)"
else echo "  Old documents expire by themselves (Firestore TTL policies)."; fi

step "3/9 Service accounts (no keys)"
mk_sa() { gcloud iam service-accounts describe "$1@$PROJECT.iam.gserviceaccount.com" >/dev/null 2>&1 || gcloud iam service-accounts create "$1" --display-name="$2" --quiet; }
mk_sa spruce-run "SPRUCE Mail Protection Service (Cloud Run)"
mk_sa spruce-delegate "SPRUCE Mail Protection Service (Gmail delegation)"
mk_sa spruce-invoker "SPRUCE Mail Protection Service (Pub/Sub and Scheduler)"
mk_sa spruce-build "SPRUCE Mail Protection Service (Cloud Build)"
mk_sa spruce-updater "SPRUCE Mail Protection Service (updates from the dashboard)"
retry gcloud iam service-accounts add-iam-policy-binding "$SA_DELEGATE" --member="serviceAccount:$SA_RUN" --role=roles/iam.serviceAccountTokenCreator --quiet >/dev/null
retry gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$SA_RUN" --role=roles/datastore.user --condition=None --quiet >/dev/null
# Pub/Sub signs its push requests as spruce-invoker (needed explicitly in older projects).
retry gcloud iam service-accounts add-iam-policy-binding "$SA_INVOKER" --member="serviceAccount:service-$NUMBER@gcp-sa-pubsub.iam.gserviceaccount.com" --role=roles/iam.serviceAccountTokenCreator --quiet >/dev/null
# The dashboard's "Update group membership now" runs the spruce-renew-watches job, and shows its last run.
retry gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$SA_RUN" --role=roles/cloudscheduler.jobRunner --condition=None --quiet >/dev/null
retry gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$SA_RUN" --role=roles/cloudscheduler.viewer --condition=None --quiet >/dev/null
# The dashboard's Status page reads the worker's Cloud Run settings (Identity-Aware Proxy, who may call it).
retry gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$SA_RUN" --role=roles/run.viewer --condition=None --quiet >/dev/null
# What Cloud Build runs as when it builds the image (step 6), instead of a default account whose roles
# differ from project to project.
retry gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$SA_BUILD" --role=roles/cloudbuild.builds.builder --condition=None --quiet >/dev/null
# Settings → Update: the spruce-update job starts a Cloud Build as spruce-updater (deploy/cloud-update.sh).
# It may start builds that run as itself, log them, read and write the update's state in Firestore,
# store images (step 6) and deploy new builds of the two services, running as spruce-run (step 8). It
# can't change permissions, jobs or anything else. The dashboard itself only runs the job.
retry gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$SA_UPDATER" --role=roles/cloudbuild.builds.editor --condition=None --quiet >/dev/null
retry gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$SA_UPDATER" --role=roles/logging.logWriter --condition=None --quiet >/dev/null
retry gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$SA_UPDATER" --role=roles/datastore.user --condition=None --quiet >/dev/null
retry gcloud iam service-accounts add-iam-policy-binding "$SA_UPDATER" --member="serviceAccount:$SA_UPDATER" --role=roles/iam.serviceAccountUser --quiet >/dev/null
retry gcloud iam service-accounts add-iam-policy-binding "$SA_RUN" --member="serviceAccount:$SA_UPDATER" --role=roles/iam.serviceAccountUser --quiet >/dev/null
# (Cloud Scheduler signs the job's call to Cloud Build as spruce-updater: needed explicitly in older projects.)
retry gcloud iam service-accounts add-iam-policy-binding "$SA_UPDATER" --member="serviceAccount:service-$NUMBER@gcp-sa-cloudscheduler.iam.gserviceaccount.com" --role=roles/iam.serviceAccountTokenCreator --quiet >/dev/null
CLIENT_ID="$(gcloud iam service-accounts describe "$SA_DELEGATE" --format='value(oauth2ClientId)')"

step "4/9 Domain-wide delegation (Admin console; you do this part)"
cat <<EOF
  In admin.google.com: Security > Access and data control > API controls >
  Manage Domain Wide Delegation > Add new (or edit the existing entry):
      Client ID:  $CLIENT_ID
      Scopes:     https://www.googleapis.com/auth/gmail.modify,https://www.googleapis.com/auth/admin.directory.group.member.readonly
  Also check that these groups exist: $(echo "$PILOT_GROUP;$ADMIN_GROUP" | tr ',' ';' | sed 's/;;*/;/g; s/;$//; s/;/, /g')
  and that $DIRECTORY_ADMIN has an admin role with Groups > Read (docs/INSTALL.md, step 2).
EOF
if [ -n "${SPRUCE_UPGRADE:-}" ]; then echo "  (upgrade: not waiting; the entry is already there unless this version's notes say a scope was added)"
elif [ -t 0 ]; then read -r -p "  Press Enter when that is done (it can take a few minutes to apply)... " _; fi

step "5/9 Pub/Sub topic Gmail notifies"
gcloud pubsub topics describe "$TOPIC" >/dev/null 2>&1 || gcloud pubsub topics create "$TOPIC" --quiet
gcloud pubsub topics add-iam-policy-binding "$TOPIC" --member=serviceAccount:gmail-api-push@system.gserviceaccount.com --role=roles/pubsub.publisher --quiet >/dev/null \
    || fail "Gmail couldn't be allowed to publish to $TOPIC. If an organization policy limits members to your domain (iam.allowedPolicyMemberDomains), allow an exception for this project: docs/INSTALL.md, Troubleshooting."

step "6/9 Build the image"
gcloud artifacts repositories describe spruce --location="$REGION" >/dev/null 2>&1 \
    || gcloud artifacts repositories create spruce --repository-format=docker --location="$REGION" --description="S.P.R.U.C.E Mail Protection Service" --quiet
# (Settings → Update stores its builds here too, as spruce-updater.)
retry gcloud artifacts repositories add-iam-policy-binding spruce --location="$REGION" --member="serviceAccount:$SA_UPDATER" --role=roles/artifactregistry.writer --quiet >/dev/null
# Keep only the newest builds, so stored images stay within the free 0.5 GB (Google applies it about daily).
printf '%s\n' '[' \
  "  { \"name\": \"keep-newest\", \"action\": { \"type\": \"Keep\" }, \"mostRecentVersions\": { \"packageNamePrefixes\": [\"mail-protection\"], \"keepCount\": $KEEP_BUILDS } }," \
  '  { "name": "delete-older", "action": { "type": "Delete" }, "condition": { "tagState": "any", "olderThan": "1d" } }' \
  ']' > "$TMP/cleanup.json"
if gcloud artifacts repositories set-cleanup-policies spruce --location="$REGION" --policy="$TMP/cleanup.json" --no-dry-run --quiet >/dev/null; then
    echo "  Keeping the newest $KEEP_BUILDS builds."
else
    echo "  (Couldn't set the image cleanup policy; old builds stay until deleted.)"
fi
# The image is named after its source: a run with the same files (a change of settings only) uses the
# image already built and just redeploys, in a minute or so. FORCE_BUILD=1 builds again anyway. The AI
# model's files aren't counted (they may or may not have been downloaded here): VENDOR.json, which pins
# them, is.
SRC="$( { find src public vendor package.json package-lock.json Dockerfile tools/fetch-model.js -path vendor/spruce/models -prune -o -type f -print0 2>/dev/null || true; } | LC_ALL=C sort -z | xargs -0 -r sha256sum | sha256sum | cut -c1-12)"
IMAGE="$REGION-docker.pkg.dev/$PROJECT/spruce/mail-protection:$VERSION-src$SRC"
MODEL="$(sed -n 's/.*"model": *"\([^"]*\)".*/\1/p' vendor/spruce/VENDOR.json 2>/dev/null | head -1 || true)"
# The build downloads the AI model from TinyPhishLLM at the commit VENDOR.json pins (Dockerfile).
MODEL_COMMIT="$(sed -n 's/.*"commit": *"\([0-9a-f]\{40\}\)".*/\1/p' vendor/spruce/VENDOR.json 2>/dev/null | head -1 || true)"
echo "  The AI model, phish-tiny ${MODEL:-unknown}, is downloaded from TinyPhishLLM (github.com/thecodewarrior2/TinyPhishLLM, commit ${MODEL_COMMIT:0:7}) during the build, and used only if every file's SHA-256 matches."
# Cloud Build builds and stores the image inside Google Cloud, so it works where Docker can't upload.
# It runs as spruce-build; its source and logs go to buckets in this project and region.
cloud_build() {
    gcloud builds submit --tag "$IMAGE" --region="$REGION" --service-account="projects/$PROJECT/serviceAccounts/$SA_BUILD" \
        --default-buckets-behavior=regional-user-owned-bucket --quiet . \
        || fail "Cloud Build couldn't build the image (its log is above). If it says spruce-build lacks a permission, wait a minute (new permissions take a moment to apply) and run this again. If it couldn't download the AI model, check that the build can reach raw.githubusercontent.com."
}
if [ -z "${FORCE_BUILD:-}" ] && gcloud artifacts docker images describe "$IMAGE" >/dev/null 2>&1; then
    echo "  These files were built before: using that image, not building again (FORCE_BUILD=1 builds anyway)."
elif command -v docker >/dev/null && docker info >/dev/null 2>&1; then
    gcloud auth configure-docker "$REGION-docker.pkg.dev" --quiet >/dev/null
    docker build -t "$IMAGE" . || fail "the image didn't build (the error is above; the build downloads the AI model from raw.githubusercontent.com)."
    if ! docker push "$IMAGE"; then
        echo "  Docker couldn't upload the image from here (Cloud Shell can't always reach Artifact Registry)."
        echo "  Building it with Cloud Build instead (a few minutes)."
        cloud_build
    fi
else
    cloud_build
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
COMMON=(MODE "$MODE" ORG_DOMAINS "$ORG_DOMAINS" DELEGATED_SA "$SA_DELEGATE" AI_MOVE_THRESHOLD "$AI_MOVE_THRESHOLD" AI_SUSPICIOUS_THRESHOLD "$AI_SUSPICIOUS_THRESHOLD" ALLOW_DOMAINS "$ALLOW_DOMAINS" ALLOW_ADDRESSES "$ALLOW_ADDRESSES" BRAKE_PER_HOUR "$BRAKE_PER_HOUR" CAMPAIGN_HOLD_AFTER "$CAMPAIGN_HOLD_AFTER"
    RETENTION_DAYS "$RETENTION_DAYS" TIME_ZONE "$TZ_NAME" GOOGLE_CLOUD_PROJECT "$PROJECT" CLOUD_RUN_REGION "$REGION" DASHBOARD_URL "https://spruce-admin-$NUMBER.$REGION.run.app")
# Each service is labelled with its version and AI model's (deploy/upgrade.sh shows what changes).
LABELS="spruce-version=$(echo "$VERSION" | tr '.' '-'),spruce-model=$(echo "${MODEL:-unknown}" | tr '.' '-'),spruce-install-level=$INSTALL_LEVEL"

step "7/9 Worker (reads the pilot mailboxes; only Pub/Sub and Scheduler may call it)"
# Never behind Identity-Aware Proxy: Pub/Sub and Cloud Scheduler can't sign in through it, so every
# notification and job would be refused (401) before reaching the service. (Easy to tick by mistake in the
# console's Security tab; the dashboard, spruce-admin, keeps it.)
if gcloud run services describe spruce-worker --region="$REGION" --format=json 2>/dev/null | grep -Eq '"run.googleapis.com/iap-enabled": "?true'; then
    echo "  Identity-Aware Proxy was on for spruce-worker: Gmail's notifications and the daily jobs can't pass it."
    echo "  Turning it off there (the dashboard keeps it)."
    gcloud beta run services update spruce-worker --region="$REGION" --no-iap --quiet >/dev/null
fi
gcloud run services remove-iam-policy-binding spruce-worker --region="$REGION" --member="serviceAccount:service-$NUMBER@gcp-sa-iap.iam.gserviceaccount.com" \
    --role=roles/run.invoker --quiet >/dev/null 2>&1 || true
WF="$(env_file worker ROLE worker "${COMMON[@]}" PILOT_GROUP "$PILOT_GROUP" DIRECTORY_ADMIN "$DIRECTORY_ADMIN" \
    PUBSUB_TOPIC "projects/$PROJECT/topics/$TOPIC" PUSH_SERVICE_ACCOUNT "$SA_INVOKER" PUSH_AUDIENCE "$WORKER_AUD" ADMIN_EMAILS "$ADMIN_EMAILS" ADMIN_GROUP "$ADMIN_GROUP")"
gcloud run deploy spruce-worker --image="$IMAGE" --region="$REGION" --service-account="$SA_RUN" --no-allow-unauthenticated \
    --concurrency=32 --timeout=120 --memory=1Gi --max-instances="$WORKER_MAX" --execution-environment=gen2 --cpu-boost \
    --env-vars-file="$WF" --update-labels="$LABELS" --quiet
# All traffic to this build, even after deploy/rollback.sh pinned an older one.
gcloud run services update-traffic spruce-worker --region="$REGION" --to-latest --quiet >/dev/null
WORKER_URL="$(gcloud run services describe spruce-worker --region="$REGION" --format='value(status.url)')"
gcloud run services add-iam-policy-binding spruce-worker --region="$REGION" --member="serviceAccount:$SA_INVOKER" --role=roles/run.invoker --quiet >/dev/null

step "8/9 Dashboard (behind Identity-Aware Proxy, for ADMIN_GROUP and ADMIN_EMAILS only)"
AF="$(env_file admin ROLE admin "${COMMON[@]}" IAP_AUDIENCE "$IAP_AUD" ADMIN_EMAILS "$ADMIN_EMAILS" ADMIN_GROUP "$ADMIN_GROUP" DIRECTORY_ADMIN "$DIRECTORY_ADMIN" \
    RENEW_JOB "projects/$PROJECT/locations/$REGION/jobs/spruce-renew-watches" ALERT_EMAIL "$ALERT_TO" \
    UPDATE_JOB "projects/$PROJECT/locations/$REGION/jobs/spruce-update" RELEASES_REPO "$(printf '%s' "$RELEASES" | sed -n 's|^https://github.com/\([^/]*/[^/]*\)$|\1|p' | sed 's/\.git$//')")"
# Always on from 10,000 watched mailboxes (deploy/dashboard-policy.sh); not known yet (a first install,
# before the first watch renewal): left as it is, and the next install or Settings → Update decides.
WATCHED="$(dashboard_watched_count "$PROJECT")"
ADMIN_MIN=()
if [[ "$WATCHED" =~ ^[0-9]+$ ]]; then
    if [ "$WATCHED" -ge "$DASHBOARD_ALWAYS_ON_AT" ]; then ADMIN_MIN=(--min-instances=1); echo "  $WATCHED mailboxes watched: the dashboard stays on (one instance always running, about \$13 a month), so its pages open at once."
    else ADMIN_MIN=(--min-instances=0); echo "  $WATCHED mailboxes watched: the dashboard starts when opened (always on from $DASHBOARD_ALWAYS_ON_AT)."; fi
fi
gcloud run deploy spruce-admin --image="$IMAGE" --region="$REGION" --service-account="$SA_RUN" --no-allow-unauthenticated \
    --memory=1Gi --max-instances=3 "${ADMIN_MIN[@]}" --cpu-boost --env-vars-file="$AF" --update-labels="$LABELS" --quiet
gcloud run services update-traffic spruce-admin --region="$REGION" --to-latest --quiet >/dev/null
# Settings → Update deploys new builds of both services (deploy/cloud-update.sh), as spruce-updater.
for s in spruce-worker spruce-admin; do
    retry gcloud run services add-iam-policy-binding "$s" --region="$REGION" --member="serviceAccount:$SA_UPDATER" --role=roles/run.developer --quiet >/dev/null
done
ADMIN_URL="$(gcloud run services describe spruce-admin --region="$REGION" --format='value(status.url)')"
iap_setup() {
    gcloud beta run services update spruce-admin --region="$REGION" --iap --quiet >/dev/null || return 1
    gcloud beta services identity create --service=iap.googleapis.com --project="$PROJECT" --quiet >/dev/null 2>&1 || true
    retry gcloud run services add-iam-policy-binding spruce-admin --region="$REGION" --member="serviceAccount:service-$NUMBER@gcp-sa-iap.iam.gserviceaccount.com" --role=roles/run.invoker --quiet >/dev/null || return 1
    local e members=()
    for e in $(echo "$ADMIN_GROUP" | tr ';,' '  '); do members+=("group:$e"); done
    for e in $(echo "$ADMIN_EMAILS" | tr ';,' '  '); do members+=("user:$e"); done
    for e in "${members[@]}"; do
        gcloud iap web add-iam-policy-binding --resource-type=cloud-run --service=spruce-admin --region="$REGION" \
            --member="$e" --role=roles/iap.httpsResourceAccessor --condition=None --quiet >/dev/null || return 1
    done
}
if ! iap_setup; then
    echo "  Identity-Aware Proxy could not be set up from here; the dashboard stays closed to everyone. Turn it on in the console: docs/INSTALL.md, Troubleshooting."
fi

step "9/9 Notifications and daily jobs"
if gcloud pubsub subscriptions describe gmail-spruce-push >/dev/null 2>&1; then
    gcloud pubsub subscriptions update gmail-spruce-push --push-endpoint="$WORKER_URL/pubsub/push" --push-auth-service-account="$SA_INVOKER" --push-auth-token-audience="$WORKER_AUD" --ack-deadline=120 --min-retry-delay=10s --max-retry-delay=600s --quiet >/dev/null
else
    gcloud pubsub subscriptions create gmail-spruce-push --topic="$TOPIC" --push-endpoint="$WORKER_URL/pubsub/push" --push-auth-service-account="$SA_INVOKER" --push-auth-token-audience="$WORKER_AUD" --ack-deadline=120 --min-retry-delay=10s --max-retry-delay=600s --quiet >/dev/null
fi
# An upgrade keeps a stopped service stopped (deploy/stop.sh paused the renewal); a plain install starts it.
STOPPED=
if [ -n "${SPRUCE_UPGRADE:-}" ] && [ "$(gcloud scheduler jobs describe spruce-renew-watches --location="$REGION" --format='value(state)' 2>/dev/null)" = PAUSED ]; then STOPPED=1; fi
job() { # name, schedule, path, extra flags...
    local name="$1" schedule="$2" path="$3"; shift 3
    local verb=create; gcloud scheduler jobs describe "$name" --location="$REGION" >/dev/null 2>&1 && verb=update
    gcloud scheduler jobs "$verb" http "$name" --location="$REGION" --schedule="$schedule" --uri="$WORKER_URL$path" --http-method=POST \
        --oidc-service-account-email="$SA_INVOKER" --oidc-token-audience="$WORKER_AUD" --time-zone="$TZ_NAME" "$@" --quiet >/dev/null
    echo "  $name ($schedule, $TZ_NAME)"
}
# Whether the job's run since $2 (UTC) reached the worker: waits up to a minute, then stops with the reason.
job_reached_worker() {
    local name="$1" since="$2" i t code why
    for i in $(seq 1 12); do
        sleep "${SPRUCE_WAIT_STEP:-5}"   # (the tests make it shorter)
        t="$(gcloud scheduler jobs describe "$name" --location="$REGION" --format='value(lastAttemptTime)' 2>/dev/null || true)"
        code="$(gcloud scheduler jobs describe "$name" --location="$REGION" --format='value(status.code)' 2>/dev/null || true)"
        if [[ "$t" > "$since" ]] && { [ -z "$code" ] || [ "$code" = 0 ]; }; then echo "  $name reached the service."; return 0; fi
    done
    [[ "$t" > "$since" ]] || { echo "  ($name hasn't run yet; check it later: docs/INSTALL.md, Troubleshooting.)"; return 0; }
    why="$(gcloud logging read "resource.type=\"cloud_scheduler_job\" AND resource.labels.job_id=\"$name\" AND severity>=ERROR" --freshness=10m --limit=1 --format='value[separator=": "](jsonPayload.status,jsonPayload.debugInfo)' 2>/dev/null || true)"
    fail "$name couldn't reach the worker (${why:-status code $code}). Gmail's notifications can't either, so no mail is checked. A 401 or 403 means a sign-in problem in front of the service: docs/INSTALL.md, Troubleshooting, \"The jobs and notifications are refused\"."
}
job spruce-renew-watches "17 3 * * *" /tasks/renew-watches
# (0.4.1: the cleanup runs with the hourly job, so the installation keeps to Cloud Scheduler's 3 free jobs.)
gcloud scheduler jobs delete spruce-purge --location="$REGION" --quiet >/dev/null 2>&1 || true
# Hourly: the health check (alerts when Gmail has gone quiet), the phishing lists once a day, and the
# cleanup of what Firestore's TTL policies don't delete.
job spruce-sync-feeds "23 * * * *" /tasks/sync-feeds --attempt-deadline=300s
# Settings → Update runs this job; it starts a Cloud Build as spruce-updater with these steps, fixed
# here: download google_service_main, then deploy/cloud-update.sh from it. It also runs by itself once a
# year, and then does nothing unless an admin asked for an update in the last 30 minutes.
cat > "$TMP/update-build.json" <<EOF
{
  "serviceAccount": "projects/$PROJECT/serviceAccounts/$SA_UPDATER",
  "options": { "logging": "CLOUD_LOGGING_ONLY" },
  "timeout": "2700s",
  "tags": ["spruce-update"],
  "steps": [
    { "id": "download", "name": "gcr.io/cloud-builders/git", "args": ["clone", "-q", "$RELEASES", "/workspace/release"] },
    { "id": "check", "name": "gcr.io/cloud-builders/gcloud", "entrypoint": "bash", "args": ["/workspace/release/deploy/cloud-update.sh", "check"], "env": ["PROJECT=$PROJECT", "REGION=$REGION", "BUILD=\$BUILD_ID"] },
    { "id": "pick", "name": "gcr.io/cloud-builders/git", "entrypoint": "bash", "args": ["/workspace/release/deploy/cloud-update.sh", "pick"], "env": ["PROJECT=$PROJECT", "REGION=$REGION"] },
    { "id": "image", "name": "gcr.io/cloud-builders/docker", "entrypoint": "bash", "args": ["/workspace/release/deploy/cloud-update.sh", "image"], "env": ["PROJECT=$PROJECT", "REGION=$REGION"] },
    { "id": "deploy", "name": "gcr.io/cloud-builders/gcloud", "entrypoint": "bash", "args": ["/workspace/release/deploy/cloud-update.sh", "deploy"], "env": ["PROJECT=$PROJECT", "REGION=$REGION"] },
    { "id": "finish", "name": "gcr.io/cloud-builders/gcloud", "entrypoint": "bash", "args": ["/workspace/release/deploy/cloud-update.sh", "finish"], "env": ["PROJECT=$PROJECT", "REGION=$REGION", "BUILD=\$BUILD_ID"] }
  ]
}
EOF
gcloud scheduler jobs delete spruce-update --location="$REGION" --quiet >/dev/null 2>&1 || true
gcloud scheduler jobs create http spruce-update --location="$REGION" --schedule="7 5 1 1 *" --time-zone="$TZ_NAME" \
    --uri="https://cloudbuild.googleapis.com/v1/projects/$PROJECT/locations/$REGION/builds" --http-method=POST \
    --headers=Content-Type=application/json --message-body-from-file="$TMP/update-build.json" \
    --oauth-service-account-email="$SA_UPDATER" --oauth-token-scope=https://www.googleapis.com/auth/cloud-platform --quiet >/dev/null
echo "  spruce-update (when an admin presses Update in the dashboard's Settings → Update)"

# Alerts by email (Cloud Monitoring), from log lines: what the service reports (the brake, a held
# campaign, Gmail gone quiet, a user taking flagged mail into the Inbox) and any failed scheduled job.
# Log-based alerts read no metrics, so no charge is expected; the budget alert would say otherwise.
policy() { # display name, log filter (JSON-escaped), label extractors (JSON), what to do, channel
    local f="$TMP/policy.json" id
    printf '%s\n' '{' \
        "  \"displayName\": \"$1\"," \
        "  \"documentation\": { \"content\": \"$4\", \"mimeType\": \"text/markdown\" }," \
        '  "combiner": "OR",' \
        "  \"conditions\": [ { \"displayName\": \"$1\", \"conditionMatchedLog\": { \"filter\": \"$2\", \"labelExtractors\": $3 } } ]," \
        '  "alertStrategy": { "notificationRateLimit": { "period": "300s" }, "autoClose": "1800s" },' \
        "  \"notificationChannels\": [ \"$5\" ]" \
        '}' > "$f"
    # (Named "SPRUCE Mail Protection: …" before 0.5.9: found under either name; the update renames it.)
    local old="${1/SPRUCE Mail Protection Service/SPRUCE Mail Protection}"
    id="$(gcloud monitoring policies list --filter="displayName=\"$1\" OR displayName=\"$old\"" --format='value(name)' 2>/dev/null | head -1)"
    if [ -n "$id" ]; then gcloud monitoring policies update "$id" --policy-from-file="$f" --quiet >/dev/null
    else gcloud monitoring policies create --policy-from-file="$f" --quiet >/dev/null; fi
}
alerts() {
    local channel
    channel="$(gcloud beta monitoring channels list --filter="type=\"email\" AND labels.email_address=\"$ALERT_TO\"" --format='value(name)' 2>/dev/null | head -1)"
    [ -n "$channel" ] || channel="$(gcloud beta monitoring channels create --display-name="SPRUCE Mail Protection Service alerts" --type=email --channel-labels=email_address="$ALERT_TO" --format='value(name)' --quiet)" || return 1
    [ -n "$channel" ] || return 1
    policy "SPRUCE Mail Protection Service: an alert from the service" 'resource.type=\"cloud_run_revision\" AND jsonPayload.spruceAlert:*' \
        '{ "alert": "EXTRACT(jsonPayload.spruceAlert)", "message": "EXTRACT(jsonPayload.message)" }' \
        "The service reported something to look at: the message says what. Open the dashboard (Overview, Activity)." "$channel" || return 1
    policy "SPRUCE Mail Protection Service: a scheduled job failed" 'resource.type=\"cloud_scheduler_job\" AND severity>=ERROR AND resource.labels.job_id:\"spruce-\"' \
        '{ "job": "EXTRACT(resource.labels.job_id)", "why": "EXTRACT(jsonPayload.debugInfo)" }' \
        "A scheduled job couldn't reach the worker. If it says 401 or 403, see docs/INSTALL.md, Troubleshooting, The jobs and notifications are refused." "$channel" || return 1
}
if [ -z "$ALERT_TO" ]; then echo "  Alerts: not emailed (ALERT_EMAIL=off); they show in the dashboard's Recent activity."
elif alerts; then echo "  Alerts: emailed to $ALERT_TO (the brake, held campaigns, Gmail gone quiet, failed jobs)."
else echo "  (Alerts couldn't be set up from here; they still show in the dashboard's Recent activity. docs/INSTALL.md, Troubleshooting.)"; fi
gcloud scheduler jobs run spruce-sync-feeds --location="$REGION" --quiet
if [ -n "$STOPPED" ]; then
    gcloud scheduler jobs pause spruce-renew-watches --location="$REGION" --quiet >/dev/null 2>&1 || true
    echo "  Watching stays stopped (deploy/stop.sh was run). To start it: bash deploy/install.sh"
else
    gcloud scheduler jobs resume spruce-renew-watches --location="$REGION" --quiet >/dev/null 2>&1 || true
    # Left by deploy/stop.sh: never kept around while the service is on.
    gcloud scheduler jobs delete spruce-stop-watches --location="$REGION" --quiet >/dev/null 2>&1 || true
    # Checked: the job must reach the worker (a refused job means Gmail's notifications are refused too).
    STARTED="$(date -u -d '5 seconds ago' +%Y-%m-%dT%H:%M:%S)"
    gcloud scheduler jobs run spruce-renew-watches --location="$REGION" --quiet
    job_reached_worker spruce-renew-watches "$STARTED"
fi

# Deployed with the policy now in settings.env: the dashboard's copies go, and Activity notes it.
dashboard_policy_finish "$PROJECT" "$VERSION"

step "Done"
cat <<EOF
  Dashboard:  $ADMIN_URL   (for: $WHO)
  Mode:       $MODE$( [ "$MODE" = monitor ] && echo " (nothing is moved; would-be moves are recorded)")
  Watching:   members of $PILOT_GROUP. Settings in the dashboard shows how many mailboxes are watched.
  Alerts:     $( [ -n "$ALERT_TO" ] && echo "emailed to $ALERT_TO" || echo "off (Recent activity only)")

  The watches start within a minute. To see the worker's log:
      gcloud run services logs read spruce-worker --region=$REGION --limit=50
  After you change the group's members, apply it now (otherwise daily at 3:17 AM, $TZ_NAME), or press
  Settings → Mailboxes → Update group membership now in the dashboard:
      gcloud scheduler jobs run spruce-renew-watches --location=$REGION
EOF
