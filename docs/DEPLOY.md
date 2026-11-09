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

```bash
gcloud iam service-accounts create spruce-run --display-name="SPRUCE Mail Protection (Cloud Run)"
```

```bash
gcloud iam service-accounts create spruce-delegate --display-name="SPRUCE Mail Protection (Gmail delegation)"
```

```bash
gcloud iam service-accounts create spruce-invoker --display-name="SPRUCE Mail Protection (Pub/Sub and Scheduler)"
```

```bash
gcloud iam service-accounts add-iam-policy-binding spruce-delegate@PROJECT.iam.gserviceaccount.com --member=serviceAccount:spruce-run@PROJECT.iam.gserviceaccount.com --role=roles/iam.serviceAccountTokenCreator
```

```bash
gcloud projects add-iam-policy-binding PROJECT --member=serviceAccount:spruce-run@PROJECT.iam.gserviceaccount.com --role=roles/datastore.user
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
gcloud run deploy spruce-worker --source . --region=REGION --service-account=spruce-run@PROJECT.iam.gserviceaccount.com --no-allow-unauthenticated --concurrency=8 --timeout=120 --memory=1Gi --set-env-vars=ROLE=worker,MODE=monitor,ORG_DOMAINS=ORG,PILOT_OU=/Staff/IT\ Pilot,DIRECTORY_ADMIN=spruce-directory@ORG,DELEGATED_SA=spruce-delegate@PROJECT.iam.gserviceaccount.com,PUBSUB_TOPIC=projects/PROJECT/topics/gmail-spruce,PUSH_SERVICE_ACCOUNT=spruce-invoker@PROJECT.iam.gserviceaccount.com,PUSH_AUDIENCE=WORKER_URL
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
gcloud run deploy spruce-admin --source . --region=REGION --service-account=spruce-run@PROJECT.iam.gserviceaccount.com --no-allow-unauthenticated --set-env-vars=ROLE=admin,MODE=monitor,ORG_DOMAINS=ORG,DELEGATED_SA=spruce-delegate@PROJECT.iam.gserviceaccount.com,IAP_AUDIENCE=AUDIENCE,ADMIN_EMAILS=it.director@ORG;it.helpdesk@ORG
```

`ADMIN_EMAILS` (like every list setting) takes commas or semicolons. Use semicolons in
`--set-env-vars`, where commas separate the variables.

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

## 6. Notifications and daily jobs

```bash
gcloud pubsub subscriptions create gmail-spruce-push --topic=gmail-spruce --push-endpoint=WORKER_URL/pubsub/push --push-auth-service-account=spruce-invoker@PROJECT.iam.gserviceaccount.com --push-auth-token-audience=WORKER_URL --ack-deadline=120 --min-retry-delay=30s --max-retry-delay=600s
```

```bash
gcloud scheduler jobs create http spruce-renew-watches --location=REGION --schedule="17 3 * * *" --uri=WORKER_URL/tasks/renew-watches --http-method=POST --oidc-service-account-email=spruce-invoker@PROJECT.iam.gserviceaccount.com --oidc-token-audience=WORKER_URL
```

```bash
gcloud scheduler jobs create http spruce-purge --location=REGION --schedule="41 4 * * *" --uri=WORKER_URL/tasks/purge --http-method=POST --oidc-service-account-email=spruce-invoker@PROJECT.iam.gserviceaccount.com --oidc-token-audience=WORKER_URL
```

```bash
gcloud scheduler jobs create http spruce-sync-feeds --location=REGION --schedule="23 5 * * *" --uri=WORKER_URL/tasks/sync-feeds --http-method=POST --oidc-service-account-email=spruce-invoker@PROJECT.iam.gserviceaccount.com --oidc-token-audience=WORKER_URL --attempt-deadline=300s
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

## 7. Pilot, measure, then enforce

1. **Monitor mode, at least 2–3 weeks.** Watch the dashboard's *Would be moved* list and *Model
   health*. Open the emails; mark false alarms and confirm phishing.
2. **Tune.** If AI-only moves get many false alarms, raise `AI_MOVE_THRESHOLD`, for example to `0.95`.
   Add allowlist entries (`ALLOW_DOMAINS`, `ALLOW_ADDRESSES`) for senders you trust.
3. **Enforce.** Deploy both services with `MODE=enforce`. Keep `BRAKE_PER_HOUR` at a value just above
   your largest normal campaign.
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
| `ADMIN_EMAILS`, `ADMIN_GROUP` | none | who may use the dashboard: addresses, and/or the members of a group (needs `DIRECTORY_ADMIN` on the dashboard too); at least one |
| `AI_MOVE_THRESHOLD` | `0.85` | AI score that moves (outside senders) |
| `MOVE_ON_RULES` | `true` | the extension's "flagged" verdict moves |
| `AI_MOVES_INSIDE` | `false` | let the AI score alone move mail from inside the organization |
| `ALLOW_DOMAINS`, `ALLOW_ADDRESSES` | none | never moved |
| `BRAKE_PER_HOUR` | `100` | more moves than this in an hour pauses moving |
| `MOVED_LABEL`, `RELEASED_LABEL` | `SPRUCE/Moved`, `SPRUCE/Released` | labels added to moved and released mail |
| `MONITOR_LABEL` | none | optionally label would-move mail in monitor mode (users see it) |
| `CLOUDFLARE_THREATS` | `true` | Cloudflare Security DNS for link sites and sender domains |
| `SAFE_BROWSING`, `SAFE_BROWSING_KEY` | `false`, none | Google Safe Browsing for links: off for now; `true` needs the key (Secret Manager) |
| `PHISHING_LISTS` | `true` | the phishing lists (daily `sync-feeds` job) |
| `SITE_AGE` | `true` | registry dates of link and sender domains |
| `RETENTION_DAYS` | `60` | records are deleted after this |
| `BUDGET_ALERT` (installer only) | `1` | budget alert amount for the project, in the billing account's currency; `off` for none |
| `STORE_SUBJECTS`, `STORE_AI_QUOTES` | `true` | keep subjects and the model's short quotes in records |
| `FIRST_SEEN_LEARNING_DAYS` | `14` | "first email from this sender" only counts after this |
