# Deploying

**For a test limited to one security group, use `docs/INSTALL.md`:** `deploy/install.sh` does every step
below from Cloud Shell. This page explains the pieces, for doing it by hand or changing it.

Everything runs in **your own Google Cloud project**, ideally one created for this service, in your
Workspace organization. Commands use `gcloud`. Replace the placeholders in capitals:
- `PROJECT`: the project ID;
- `REGION`: for example `us-east1`;
- `ORG`: your email domain;
- `WORKER_URL`: the worker service's URL, shown after its deploy.

Google renames console pages and flags now and then. Where a step says "check", look it up in
Google's current documentation.

## 0. Before you start

- **Approval:** your district's approval (privacy and legal review, see `docs/PRIVACY.md`) for a
  service that reads staff and student mail.
- **Pilot:** who is watched. Choose one or more:
  - a **security group** (`PILOT_GROUP`; the easiest to grow and shrink, and groups inside it count);
  - an organizational unit, such as `/Staff/IT Pilot` (`PILOT_OU`);
  - a list of addresses (`PILOT_USERS`).

  Start with the IT team's own mailboxes.
- **Directory admin:** a dedicated admin account the service acts as to read who is in the pilot. Give
  it a custom admin role with only what it needs, under **Admin API privileges**:
  - **Groups → Read** for a group;
  - **Users → Read** for a unit.

## 1. Project and APIs

```bash
gcloud config set project PROJECT
```

```bash
gcloud services enable gmail.googleapis.com admin.googleapis.com pubsub.googleapis.com run.googleapis.com firestore.googleapis.com iamcredentials.googleapis.com cloudscheduler.googleapis.com iap.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com
```

```bash
gcloud firestore databases create --location=REGION
```

### Optional: Google Safe Browsing (off for now)

Threat lookups use Cloudflare Security only. To add Safe Browsing later:
1. Enable its APIs:

   ```bash
   gcloud services enable safebrowsing.googleapis.com secretmanager.googleapis.com apikeys.googleapis.com
   ```

2. Create a key and store it as described below.
3. Deploy the worker with `SAFE_BROWSING=true` added to `--set-env-vars` and
   `--set-secrets=SAFE_BROWSING_KEY=safe-browsing-key:latest`.

Create an API key restricted to the Safe Browsing API and keep it in Secret Manager:

```bash
gcloud services api-keys create --display-name="SPRUCE Safe Browsing" --api-target=service=safebrowsing.googleapis.com
```

The command prints the key string. Store it as a secret, pasting the key when asked:

```bash
gcloud secrets create safe-browsing-key --replication-policy=automatic --data-file=-
```

```bash
gcloud secrets add-iam-policy-binding safe-browsing-key --member=serviceAccount:spruce-run@PROJECT.iam.gserviceaccount.com --role=roles/secretmanager.secretAccessor
```

Safe Browsing's Lookup API is for non-commercial use. A district's own protection fits; check Google's
terms, or use the Web Risk API otherwise. Its daily quota shows in the Cloud console (APIs & Services →
Safe Browsing API → Quotas). The worker sends up to 500 links per request and remembers answers, and a
link the quota leaves unchecked is "not checked", never "safe".

## 2. Service accounts (no keys, ever)

The project uses three service accounts:
- `spruce-run`: what the Cloud Run services run as.
- `spruce-delegate`: the account with domain-wide delegation. Nothing runs as it: `spruce-run` asks
  IAM to sign for it, so **no key file exists**.
- `spruce-invoker`: what Pub/Sub and Cloud Scheduler use to call the worker.

`deploy/install.sh` adds a fourth, `spruce-build`, with the **Cloud Build Service Account** role
(`roles/cloudbuild.builds.builder`). Cloud Build runs as it when the installer builds the image there,
instead of the project's default build account, whose roles differ between projects. It never touches
mail. (`gcloud run deploy --source`, below, uses the default build account.)

It also adds a fifth, `spruce-updater`, for the dashboard's Settings → Update (see "Updating from the
dashboard" below). It never touches mail either.

```bash
gcloud iam service-accounts create spruce-run --display-name="SPRUCE Mail Protection Service (Cloud Run)"
```

```bash
gcloud iam service-accounts create spruce-delegate --display-name="SPRUCE Mail Protection Service (Gmail delegation)"
```

```bash
gcloud iam service-accounts create spruce-invoker --display-name="SPRUCE Mail Protection Service (Pub/Sub and Scheduler)"
```

```bash
gcloud iam service-accounts add-iam-policy-binding spruce-delegate@PROJECT.iam.gserviceaccount.com --member=serviceAccount:spruce-run@PROJECT.iam.gserviceaccount.com --role=roles/iam.serviceAccountTokenCreator
```

```bash
gcloud projects add-iam-policy-binding PROJECT --member=serviceAccount:spruce-run@PROJECT.iam.gserviceaccount.com --role=roles/datastore.user
```

For the dashboard's Status page: read the worker's Cloud Run settings (Identity-Aware Proxy, who may call
it, its build).

```bash
gcloud projects add-iam-policy-binding PROJECT --member=serviceAccount:spruce-run@PROJECT.iam.gserviceaccount.com --role=roles/run.viewer
```

For the dashboard's "Update group membership now": run the re-read job, and read when it last ran.

```bash
gcloud projects add-iam-policy-binding PROJECT --member=serviceAccount:spruce-run@PROJECT.iam.gserviceaccount.com --role=roles/cloudscheduler.jobRunner
```

```bash
gcloud projects add-iam-policy-binding PROJECT --member=serviceAccount:spruce-run@PROJECT.iam.gserviceaccount.com --role=roles/cloudscheduler.viewer
```

Consider an organization policy that forbids key creation for service accounts in this project
(`iam.disableServiceAccountKeyCreation`).

## 3. Domain-wide delegation (Workspace Admin console)

1. Get the delegate's client ID:

   ```bash
   gcloud iam service-accounts describe spruce-delegate@PROJECT.iam.gserviceaccount.com --format="value(oauth2ClientId)"
   ```

2. In the Admin console, go to **Security → Access and data control → API controls → Manage
   Domain Wide Delegation → Add new**. Enter that client ID with exactly these scopes:
   - `https://www.googleapis.com/auth/gmail.modify`: read messages, move to Spam, labels, watch;
   - `https://www.googleapis.com/auth/admin.directory.group.member.readonly`: read the pilot group's
     members (with `PILOT_GROUP`);
   - `https://www.googleapis.com/auth/admin.directory.user.readonly`: list the pilot unit's users (with
     `PILOT_OU`).

   Grant only the directory scope you use.

`gmail.modify` can read and change every mailbox in the domain. That is why the service account has no
key, only `spruce-run` may sign for it, and the role can be removed at any time to switch everything off.

## 4. Pub/Sub

```bash
gcloud pubsub topics create gmail-spruce
```

```bash
gcloud pubsub topics add-iam-policy-binding gmail-spruce --member=serviceAccount:gmail-api-push@system.gserviceaccount.com --role=roles/pubsub.publisher
```

The push subscription is created after the worker exists (step 6).

## 5. Deploy the two services (one image)

**The worker** answers only Pub/Sub and Scheduler (`ROLE=worker`). It is not public: only
`spruce-invoker` may call it.

```bash
gcloud run deploy spruce-worker --source . --region=REGION --service-account=spruce-run@PROJECT.iam.gserviceaccount.com --no-allow-unauthenticated --concurrency=32 --timeout=120 --memory=1Gi --max-instances=30 --execution-environment=gen2 --cpu-boost --set-env-vars=ROLE=worker,MODE=monitor,ORG_DOMAINS=ORG,PILOT_OU=/Staff/IT\ Pilot,DIRECTORY_ADMIN=spruce-directory@ORG,DELEGATED_SA=spruce-delegate@PROJECT.iam.gserviceaccount.com,PUBSUB_TOPIC=projects/PROJECT/topics/gmail-spruce,PUSH_SERVICE_ACCOUNT=spruce-invoker@PROJECT.iam.gserviceaccount.com,PUSH_AUDIENCE=WORKER_URL
```

The first deploy prints `WORKER_URL`. Deploy again with `PUSH_AUDIENCE` set to it, then allow the
invoker:

```bash
gcloud run services add-iam-policy-binding spruce-worker --region=REGION --member=serviceAccount:spruce-invoker@PROJECT.iam.gserviceaccount.com --role=roles/run.invoker
```

(`deploy/install.sh` sets `PILOT_GROUP=…` instead of `PILOT_OU`, deploys from one built image with
`--image`, and passes the settings as a file, `--env-vars-file`.)

**The dashboard** (`ROLE=admin`) runs behind Identity-Aware Proxy.
- Enable IAP on the Cloud Run service directly (check Google's current "IAP for Cloud Run" steps). Grant
  **IAP-secured Web App User** only to your admin group.
- **Never on `spruce-worker`.** Pub/Sub and Cloud Scheduler can't sign in through IAP, so every
  notification and job would be refused (401) before reaching the service. `deploy/install.sh` turns it
  off there if it finds it on.
- Set `IAP_AUDIENCE` to the audience the IAP settings show for the service. For IAP on Cloud Run it has
  the form `/projects/PROJECT_NUMBER/locations/REGION/services/spruce-admin`.

```bash
gcloud run deploy spruce-admin --source . --region=REGION --service-account=spruce-run@PROJECT.iam.gserviceaccount.com --no-allow-unauthenticated --memory=1Gi --cpu-boost --set-env-vars=ROLE=admin,MODE=monitor,ORG_DOMAINS=ORG,DELEGATED_SA=spruce-delegate@PROJECT.iam.gserviceaccount.com,IAP_AUDIENCE=AUDIENCE,ADMIN_EMAILS=it.director@ORG;it.helpdesk@ORG
```

`ADMIN_EMAILS` (like every list setting) takes commas or semicolons. Use semicolons in
`--set-env-vars`, where commas separate the variables.

**From 10,000 watched mailboxes, keep one dashboard instance running** (`--min-instances=1`, about $13 a
month): its copy of the records stays in memory, so pages open at once instead of first reading the
last 32 days of records (about 96,000 reads at 3,000 recorded emails a day, each time it starts).
`deploy/install.sh` and Settings → Update set it from the count of watched mailboxes (`state/watchedCount`,
written by each watch renewal): 1 from 10,000, 0 below. When the count can't be read yet (a first
install), they leave it as it is.

**A group of admins instead:** set `ADMIN_GROUP=spruce-admins@ORG` (and `DIRECTORY_ADMIN`) on the
dashboard service, and grant IAP to `group:spruce-admins@ORG`.
- The service asks Google whether each signed-in address is in the group (groups inside it count). It
  remembers the answer for 5 minutes ("no" for 1 minute).
- Only accounts in `ORG_DOMAINS` can get in through the group.
- If the check fails, nobody gets in through the group.
- `ADMIN_EMAILS` and `ADMIN_GROUP` can be used together.

Even someone IAP lets through is refused unless their address is in `ADMIN_EMAILS` or they are in
`ADMIN_GROUP`.

Keep `MODE` the same on both services. The admin service shows the mode; the worker acts on it.

### Old documents (Firestore TTL)

The service writes `expireAt` (a Timestamp) on what expires: records and checked-message markers after
`RETENTION_DAYS`, Activity entries after the same, the brake's counters after 2 days, campaign states
after `RETENTION_DAYS` of quiet, remembered registry dates when they run out. Firestore deletes them by
itself, typically within a day (billed as deletes). `deploy/install.sh` sets the policies; by hand:

```bash
for g in seen records events moveCounts campaigns cache; do gcloud firestore fields ttls update expireAt --collection-group=$g --enable-ttl --async; gcloud firestore indexes fields update expireAt --collection-group=$g --disable-indexes --async; done
```

The hourly `spruce-sync-feeds` job also deletes what has no `expireAt` (written before 0.4.0), for up
to 30 seconds a run (since 0.4.1; before, a daily `spruce-purge` job did, which `install.sh` now
removes, keeping the installation to Cloud Scheduler's 3 free jobs).

## 6. Notifications and daily jobs

```bash
gcloud pubsub subscriptions create gmail-spruce-push --topic=gmail-spruce --push-endpoint=WORKER_URL/pubsub/push --push-auth-service-account=spruce-invoker@PROJECT.iam.gserviceaccount.com --push-auth-token-audience=WORKER_URL --ack-deadline=120 --min-retry-delay=10s --max-retry-delay=600s
```

```bash
gcloud scheduler jobs create http spruce-renew-watches --location=REGION --schedule="17 3 * * *" --uri=WORKER_URL/tasks/renew-watches --http-method=POST --oidc-service-account-email=spruce-invoker@PROJECT.iam.gserviceaccount.com --oidc-token-audience=WORKER_URL
```

```bash
gcloud scheduler jobs create http spruce-sync-feeds --location=REGION --schedule="23 * * * *" --uri=WORKER_URL/tasks/sync-feeds --http-method=POST --oidc-service-account-email=spruce-invoker@PROJECT.iam.gserviceaccount.com --oidc-token-audience=WORKER_URL --attempt-deadline=300s
```

Run the list and renew jobs once by hand to start:

```bash
gcloud scheduler jobs run spruce-sync-feeds --location=REGION
```

```bash
gcloud scheduler jobs run spruce-renew-watches --location=REGION
```

(Projects created before April 2021: the Pub/Sub service agent also needs **Service Account Token
Creator** on `spruce-invoker`. Check Google's push-authentication docs.)

## Updating from the dashboard (Settings → Update)

`deploy/install.sh` sets this up; doing it by hand is possible but not needed. The pieces:

- **The dashboard** reads the newest commit on `google_service_main`'s main branch from GitHub,
  anonymously (`RELEASES_REPO`), with that commit's `package.json`, `CHANGELOG.md` and
  `vendor/spruce/VENDOR.json`. When an admin clicks **Update to …** (with I agree, the project ID and
  their own email address), it writes `state/updateRequest` (the version, the exact commit, who, when)
  and runs the `spruce-update` job (`UPDATE_JOB`). It needs no new role: `spruce-run` already has
  **Cloud Scheduler Job Runner** for "Update group membership now". It can't change the job.
- **The `spruce-update` job** (Cloud Scheduler, HTTP) calls the Cloud Build API with a fixed build,
  signed as `spruce-updater`. Its schedule is once a year (it then does nothing): it is there to be run.
- **The build** runs as `spruce-updater` and logs to Cloud Logging (tag `spruce-update`). Its steps
  download `google_service_main` and run `deploy/cloud-update.sh` from it:
  1. **check:** there is a request from the last 30 minutes, for a version newer than the worker's
     `spruce-version` label; the commit is 40 hex characters; no other build is on it (the job run
     twice: a build that finds another one "building" in the last 45 minutes changes nothing);
  2. **pick:** the commit is on main (`git merge-base --is-ancestor`), its `package.json` has that
     version, and its `installLevel` isn't higher than the worker's `spruce-install-level` label;
  3. **image:** that commit's files built and pushed to Artifact Registry
     (`mail-protection:VERSION-cCOMMIT`);
  4. **deploy:** both services deployed with that image only (their settings, service account and
     environment as they are), labelled, all traffic to it;
  5. **finish:** `state/update` set to done or failed, the request deleted, and a line in Activity
     (failures are alerts).
- **`spruce-updater`'s roles:** Cloud Build Editor, Logs Writer and Cloud Datastore User on the project;
  Service Account User on itself and on `spruce-run` (Cloud Run needs it to deploy a service that runs
  as `spruce-run`); Artifact Registry Writer on the `spruce` repository; Cloud Run Developer on the two
  services. It can't change permissions, jobs, Pub/Sub or the delegation, which is why a version that
  needs those has a higher `installLevel` and is installed from Cloud Shell.

`installLevel` (in `package.json`) goes up with every version whose `install.sh` sets up something new
(a role, a job, a setting the services need). install.sh labels both services with the level it set up;
the dashboard offers only versions at that level or lower.

## 7. Pilot, measure, then enforce

1. **Monitor mode, at least 2–3 weeks.** Watch the dashboard's *Would be moved* list and *Model
   health*. Open the emails; mark false alarms and confirm phishing.
2. **Tune.** If AI-only moves get many false alarms, raise `AI_MOVE_THRESHOLD`, for example to `0.95`
   (or on the dashboard: Settings → Policy).
   Add allowlist entries (`ALLOW_DOMAINS`, `ALLOW_ADDRESSES`) for senders you trust. They apply only to
   mail whose DMARC check passed: a sender without DMARC can't be allowlisted.
3. **Enforce.** Deploy both services with `MODE=enforce`, or switch on the dashboard (Settings → Policy,
   with the project ID and **I agree**). Keep `BRAKE_PER_HOUR` at a value just above your largest
   normal campaign.
4. **Widen.** Add people to the pilot group, or grow `PILOT_OU` one unit at a time.

## Switching it off

- **Fast:** deploy the worker with `MODE=monitor`. Nothing is moved from then on.
- **Stop watching:** `bash deploy/stop.sh` does the next two steps.
- **Fully:**
  1. Pause the `spruce-renew-watches` job.
  2. Call `POST WORKER_URL/tasks/stop-watches` (with the invoker's token; for example, create a one-off
     Scheduler job for it).
  3. Remove the domain-wide delegation entry in the Admin console.
- **Records** are in Firestore. Delete the collections, or the project.

## Settings (environment variables)

`MODE`, `AI_MOVE_THRESHOLD`, `AI_SUSPICIOUS_THRESHOLD`, `BRAKE_PER_HOUR`, `TIME_ZONE`, `ALLOW_DOMAINS`,
`ALLOW_ADDRESSES` and `RETENTION_DAYS` can also be changed on the dashboard (Settings → Policy, Settings → Allowlist,
with the project ID, which the dashboard checks against `GOOGLE_CLOUD_PROJECT`).
Those changes are kept in Firestore (`state/policy-<key>`) and read by both services at least every
30 seconds. A change stays in force until settings.env has another value for the same setting:
`deploy/install.sh` asks which to keep, then writes it into settings.env (docs/INSTALL.md).

| Variable | Default | What |
|---|---|---|
| `ROLE` | `all` | `worker` or `admin` on Cloud Run |
| `MODE` | `monitor` | `enforce` moves to Spam |
| `ORG_DOMAINS` | none | your own domains, comma-separated |
| `PILOT_GROUP` | none | which mailboxes are watched: the members of this group (or groups, separated by semicolons), with the groups inside it; only active accounts in `ORG_DOMAINS` |
| `PILOT_OU` / `PILOT_USERS` | none | also watched: a unit with its sub-units, and/or addresses |
| `DIRECTORY_ADMIN` | none | admin the service acts as to read `PILOT_GROUP` or `PILOT_OU` |
| `DELEGATED_SA` | none | the delegation service account |
| `PUBSUB_TOPIC` | none | `projects/PROJECT/topics/gmail-spruce` |
| `PUSH_AUDIENCE`, `PUSH_SERVICE_ACCOUNT` | none | the OIDC tokens the worker accepts (Pub/Sub and Scheduler) |
| `IAP_AUDIENCE` | none | the dashboard's Identity-Aware Proxy audience |
| `RENEW_JOB` (dashboard) | none | the job "Update group membership now" runs: `projects/PROJECT/locations/REGION/jobs/spruce-renew-watches`. Without it the button isn't shown |
| `UPDATE_JOB` (dashboard) | none | the job Settings → Update runs: `projects/PROJECT/locations/REGION/jobs/spruce-update`. Without it the page says to run `deploy/update.sh` once |
| `RELEASES_REPO` (dashboard) | `thecodewarrior2/Google_service_main` | where Settings → Update reads the approved versions and their changelog (GitHub, anonymously). install.sh takes it from `SPRUCE_RELEASES` |
| `ADMIN_EMAILS`, `ADMIN_GROUP` | none | who may use the dashboard: addresses, and/or the members of a group (needs `DIRECTORY_ADMIN` on the dashboard too); at least one |
| `AI_MOVE_THRESHOLD` | `0.9` | AI score that moves (outside senders); from `AI_SUSPICIOUS_THRESHOLD` to `1` |
| `AI_SUSPICIOUS_THRESHOLD` | `0.65` | AI score from which an email not moved is recorded as suspicious (for review); from `0.5` to `AI_MOVE_THRESHOLD` |
| `MOVE_ON_RULES` | `true` | the extension's "flagged" verdict moves |
| `AI_SCANS_INSIDE` | `false` | the AI model also reads mail from inside the organization (your domains, DMARC passing); off, the rule checks alone read it (links, headers, the rest). Also on the dashboard: Settings → Policy, "AI on inside mail" |
| `AI_MOVES_INSIDE` | `false` | let the AI score alone move mail from inside the organization (only mail from your domains with DMARC passing counts as inside); it needs the AI to read inside mail, so it turns `AI_SCANS_INSIDE` on too |
| `ALLOW_DOMAINS`, `ALLOW_ADDRESSES` | none | never moved, when Gmail's DMARC check passed for the sender's domain (also on the dashboard: Settings → Allowlist). Your own domains can't be allowlisted |
| `BRAKE_PER_HOUR` | half the watched mailboxes, at least 100 | the domain-wide brake: more moves than this in an hour stops moving everywhere |
| `CAMPAIGN_HOLD_AFTER` | `25` | copies of one campaign moved on weaker evidence (nothing outside the email confirms it) before moving the rest pauses for an admin's decision (they stay in the Inbox meanwhile); strong evidence never pauses |
| `CAMPAIGN_ALERT_AFTER` | `50` | a campaign moved this many times sends an alert |
| `TIME_ZONE` | `UTC` | the time zone (IANA name) of the scheduled jobs (`--time-zone`) and of the weekly summary (Monday from 7 AM) |
| `DASHBOARD_URL` | none | the dashboard's address, in the weekly summary (install.sh: `https://spruce-admin-NUMBER.REGION.run.app`) |
| `GOOGLE_CLOUD_PROJECT`, `CLOUD_RUN_REGION` | none | where the services run, for the dashboard's Status page |
| `QUIET_HOURS` | `12` | no notification from Gmail for this long sends an alert (the hourly health check) |
| `ALERT_EMAIL` (installer; shown on the dashboard) | the `ADMIN_GROUP` | where Cloud Monitoring emails alerts; `off` for none |
| `MOVED_LABEL`, `RELEASED_LABEL` | `SPRUCE/Moved`, `SPRUCE/Moved back` | labels added to mail moved to Spam, and to mail an admin moved back to the Inbox (`SPRUCE/Released` before 0.3.7) |
| `MONITOR_LABEL` | none | optionally label would-move mail in monitor mode (users see it) |
| `CLOUDFLARE_THREATS` | `true` | Cloudflare Security DNS for link sites and sender domains |
| `SAFE_BROWSING`, `SAFE_BROWSING_KEY` | `false`, none | Google Safe Browsing for links: off for now; `true` needs the key (Secret Manager) |
| `PHISHING_LISTS` | `true` | the phishing lists (daily `sync-feeds` job) |
| `SITE_AGE` | `true` | registry dates of link and sender domains |
| `RETENTION_DAYS` | `35` | days each email's record (and its checked-message marker, and Activity entries) is kept, 14 to 365; also on the dashboard (Settings → Policy). Each document gets its `expireAt` when written, from the value in force then, and Firestore's TTL policies delete it on that date: the oldest go first, never all at once. A lower value also reaches documents already written: the hourly cleanup deletes what is older (within 30 s a run). A higher one applies to documents written from then on |
| `WORKER_MAX_INSTANCES` (installer) | `30` | the most worker instances at once (1 to 100); they cost only while they work |
| `BUDGET_ALERT` (installer only) | `1` | budget alert amount for the project, in the billing account's currency; `off` for none |
| `STORE_SUBJECTS`, `STORE_AI_QUOTES` | `true` | keep subjects and the model's short quotes in records |
| `COLLEAGUE_NAMES` | `true` | the colleague-name check: the directory's names (one-way hashes, in memory) against outside senders' names; needs `DIRECTORY_ADMIN` with Users → Read and the `admin.directory.user.readonly` scope (off, and said on Status, without them) |
| `FIRST_SEEN_LEARNING_DAYS` | `14` | "first email from this sender" only counts after this |
