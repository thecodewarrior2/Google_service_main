# S.P.R.U.C.E+ Mail Protection for Google Workspace

**Two repositories.** `google_service_testing` is where it's developed and tested.
`google_service_main` holds only the versions the maintainer has tried and approved, each copied there
unchanged. Which one you're reading: the repository's name on GitHub, or `git remote get-url origin`.
The version is in `package.json` and `CHANGELOG.md`.

S.P.R.U.C.E+ Mail Protection checks every new email in your Google Workspace domain with the same
checks and AI model as the S.P.R.U.C.E+ browser extension. It moves suspicious ones to Spam, or in
monitor mode only records them. An admin dashboard shows what was moved, why, which campaigns came in
and who was affected, and lets IT release an email back to the Inbox.

- **Runs in your own Google Cloud project** (Cloud Run, Pub/Sub, Firestore). Email is read through the
  Gmail API with domain-wide delegation and is not sent to any other service.
- **Same verdicts as the extension.** `vendor/spruce/` holds the extension's own checks (`shared.js`,
  `decoders.js`) and its phish-tiny model (`ai.js`, `models/`), copied unchanged by
  `tools/sync-engine.js`.
- **Careful by default:**
  - **Monitor mode** (records, moves nothing) until you switch to enforce mode.
  - **The AI score alone never moves mail from inside the organization.** The rules still can, for
    example when a staff account is compromised.
  - **Allowlisted senders and domains** are never moved.
  - **Both need DMARC to pass.** The allowlist and "inside the organization" go by the From address,
    which anyone can write. They count only when Gmail's own DMARC check passed for its domain. A
    forged allowlisted or staff address is judged like any mail from outside, and the record says so.
  - **Brakes that still protect a whole district** (`src/pipeline.js`, `brakes`):
    - **Clear phishing is never held.** "Strong evidence" means the rules flag it *and* something outside
      the email confirms it: a blocked or listed link, a listed or blocked sender, a brand-new look-alike
      domain, or DMARC failing. Every copy is moved, to every mailbox.
    - **Weaker evidence is held per campaign.** Once `CAMPAIGN_HOLD_AFTER` (25) copies of one campaign
      were moved without outside confirmation, the rest wait (in the Inbox, recorded) for an admin:
      **Confirm phishing** moves every copy, **False alarm** releases them. Other mail keeps moving.
    - **A domain-wide brake as a last resort:** more than `BRAKE_PER_HOUR` moves in an hour (by default
      half the watched mailboxes, at least 100) stops moving everywhere. That is a misfire on many
      unrelated emails, not one campaign. Counted exactly. **Resume and move held mail** moves what it
      held.
    - **Alerts by email** when a brake engages, a campaign is held, a large campaign arrives, Gmail goes
      quiet, or a scheduled job fails (`ALERT_EMAIL`, Cloud Monitoring).
  - **Every move can be undone** from the dashboard, and by the user: an email the user moves back
    out of Spam stays in the Inbox. It is recorded as released by the user (a false alarm unless an
    admin marks it phishing), and an alert asks an admin to check when the checks had flagged it.

## How it decides

For each new Inbox message:

1. The raw message is read the way the extension reads an opened email:
   - the sender, and Gmail's own DMARC/SPF/DKIM results;
   - the links, unwrapped offline;
   - the text a person sees, plus how the email hides text: filler after a large blank gap, or a body
     that is only pictures.
2. The extension's checks add up their signs:
   - forged or spam headers;
   - a brand-name or look-alike sender, or one named after the recipient;
   - dangerous links;
   - claims to be safe, and requests for passwords, codes, money or remote access;
   - a new sender from outside the organization.

   A score of 3 is amber, 5 is flagged.
3. The phish-tiny model scores the email (0–100%).
4. The policy acts:

| Situation | Action |
|---|---|
| The rules flag it (score 5+) | **Move to Spam** (label `SPRUCE/Moved`) |
| The AI scores **85%** or more (`AI_MOVE_THRESHOLD`), sender outside the organization (or a staff address without DMARC passing) | **Move to Spam** |
| Same, in monitor mode, or held by a brake (a campaign on weaker evidence, or the domain-wide brake) | Recorded as "would move" (a held one can be moved later) |
| An admin released the campaign (a false alarm) | Recorded as suspicious, not moved |
| The user moved it into the Inbox themselves, and the service hadn't checked it | Checked and recorded, never moved (an alert if flagged) |
| Amber, or a high AI score the policy doesn't act on (an inside sender) | Recorded as suspicious |
| Allowlisted sender, DMARC passing | Nothing |

It also looks things up (`src/intel/`; `docs/PRIVACY.md` says exactly what is sent where):

| Check | What is sent | What it adds |
|---|---|---|
| **Cloudflare Security DNS** | host names of link sites and the sender's domain | a blocked link is dangerous; a blocked or nonexistent sender domain is a sign |
| **Google Safe Browsing**: off for now (`SAFE_BROWSING=true` and a key turn it on) | link addresses (no `#…`; one-time links without their query) | a listed link is dangerous |
| **Phishing lists** (OpenPhish, Phishing Army, Sefinek) | nothing: downloaded once a day, matched in the service | listed links are dangerous; a listed sender address or domain is a sign. Your own domains count only as exact listed links and addresses, never as a whole site or domain |
| **Site age** (registries, RDAP) | domain names, to their own registry | brand-new link sites and sender domains are signs (stronger with sign-in or payment wording) |

A lookup that fails leaves an email "not checked", never "safe". Short links are **not** looked up:
there is no outside unshortening service. A short link is judged by its own host and by what decodes
offline.

## The dashboard

The dashboard keeps itself up to date: the page you're on is fetched again every 30 seconds while
the tab is visible (not while you're typing in it, or using it otherwise). The bar under the tabs says
when it last updated, and **Pause updates** stops it.

The dashboard has these pages:
- **Review:** the moved or "would move" emails nobody has reviewed, one at a time, oldest first: **F** false
  alarm, **P** phishing, **N** next. The tab shows how many are left.
- **Overview:** emails checked, moved and moved back (by admins and by users); users affected; moves per day by trigger; top
  reasons; largest campaigns; alerts.
- **Campaigns** and **Users:** each opens the list of emails behind it.
  - For a campaign: **Confirm phishing: move every copy** (optionally searching every watched mailbox for
    copies the service didn't record), **False alarm: release every copy**, and **Find other copies**.
- **Messages:** search and filters (also by Message-ID), opening each email's decision. **Download CSV**
  gives the same list.
  - Tick several to **release**, **mark false alarm** or **confirm phishing** them at once.
  - Each email shows how strong the evidence was, and its **Message-ID** and Gmail ID, each with a
    **Copy** button. The Message-ID is what Google Workspace's Email log search and the security
    investigation tool look an email up by.
  - **Check an email:** paste a reported email's original (Gmail: Show original), or an `.eml` file, to see
    what the service would decide and why. Nothing is stored, moved or counted.
  - It shows the signs found with their weights, flagged links, the AI score with what weighed most,
    and the sender check.
  - Buttons: **Release to Inbox**, **Mark false alarm**, **Confirm phishing**.
- **Model health:** recorded emails by AI score, and how often each kind of move was undone (and how
  often by users themselves). This is
  the number to tune the threshold with.
  - Marking emails doesn't train the AI model. **Download for retraining** (allowed in Settings, off by
    default) gives the emails admins marked, read from Gmail at that moment with the people taken out,
    as training examples in the extension's format. Nothing is stored. `docs/RETRAINING.md` says how to
    check the file and train the model with it.
- **Readiness:** whether monitor mode has shown enough to switch to enforce mode, as checks: time,
  emails reviewed, false alarms, staff mail failing DMARC, the busiest hour against the brake,
  notifications arriving, the group re-read reaching the service.
- **Activity:** alerts, what admins did, errors and the watching of mailboxes, by kind.
- **Status:** whether the service works end to end, with what to do for each problem: Identity-Aware
  Proxy off on the worker, who may call it, both services on the same build, the jobs reaching it,
  notifications arriving, watches renewed, the phishing lists, alerts, errors, the brake.
  `deploy/doctor.sh` checks the rest from Cloud Shell.
- **Settings:** the policy in force, read-only, and each watched mailbox with the last time Gmail
  notified the service about it.
  - **Update group membership now** re-reads the pilot group at once, instead of waiting for the daily
    run.
  - It also says when the group was last read and whether that reached the service.
  - **Retraining export** (off by default): allows **Download for retraining** on Model health.
  - **Weekly summary email** (off by default; changed here, like the retraining export): every Monday from 7 AM
    (`TIME_ZONE`), the week's numbers, what waits, and the largest campaigns go into each dashboard admin's
    Inbox. **Preview** and **Send one now** are next to it.
- **The browser tab's title** counts what needs you: the brake, held campaigns, users who took flagged
  mail back.

The dashboard's numbers come from `src/dashboard/aggregate.js`. The clickable mockup
(`tools/build-mockup.js`) uses that same file with made-up data.

## Dependency updates

Dependabot proposes **security fixes** for the npm packages as pull requests on
`google_service_testing`. GitHub runs the tests and `npm audit` on each one (`.github/workflows/test.yml`).
A fix reaches the product like any change: merged in `google_service_testing`, installed, tried, then
approved for `google_service_main`.

- **Turn on** Settings → Code security → **Dependabot security updates** in `google_service_testing`.
- **Leave it off** in `google_service_main`. Nothing changes there except approved releases.
- **Routine version updates are off** (`.github/dependabot.yml`). The file is copied unchanged into
  `google_service_main` with each release, so they would open pull requests there too.

## Try it

```bash
npm install
```

```bash
npm run demo
```

Then open http://localhost:8080. The demo uses made-up data from an invented district
(`maple-schools.example`), and every record in it is produced by the real engine. Demo mode has no
sign-in and refuses to run on Cloud Run.

```bash
npm test
```

The tests include the deploy scripts against stand-ins for `gcloud` and `docker` (`test/install.test.js`).
The Firestore store's tests (`test/firestore.test.js`) run against Google's Firestore emulator when
`FIRESTORE_EMULATOR_HOST` is set, as in CI:

```bash
gcloud emulators firestore start --host-port=127.0.0.1:8786
```

```bash
FIRESTORE_EMULATOR_HOST=127.0.0.1:8786 npm test
```

```bash
node tools/build-mockup.js
```

The last command writes `build/mockup.html`, a single file to share the look and feel.

## Deploying

**To test in your own Workspace, limited to one security group:** `docs/INSTALL.md`. A script,
`deploy/install.sh`, sets everything up from Cloud Shell, and the others look after it:
- **`deploy/update.sh`** upgrades to the newest approved version (from `google_service_main`), with no
  zip to upload. Each version brings its own AI model; the upgrade says when the model changes.
- **`deploy/upgrade.sh`** installs a version you unzipped over the installed one.
- **`deploy/rollback.sh`** goes back to the previous build.
- **`deploy/stop.sh`** stops it.
- **`deploy/doctor.sh`** checks the installation end to end and says what to run for each problem.
- **`deploy/clear-data.sh`** clears what the dashboard shows (emails recorded, counts, campaign
  decisions, Activity) and keeps the watched mailboxes and settings, after you type the project ID.

Changing a setting is quick: edit `deploy/settings.env` and run `install.sh` again. It reuses the image
built from the same files, so it only redeploys, in about a minute.

See `docs/DEPLOY.md` (each piece, by hand) and `docs/PRIVACY.md` (what is read, kept and shown).
`docs/ARCHITECTURE.md` explains the pieces. `docs/RETRAINING.md` turns the emails admins marked into
training examples, and a better AI model.

## Layout

| Path | What |
|---|---|
| `src/engine/` | MIME and HTML reading, the extension's checks and model (`spruce.js` loads `vendor/spruce/`); `network.js` applies the lookups |
| `src/intel/` | Cloudflare Security DNS, Google Safe Browsing, the phishing lists, registry dates; request limits |
| `src/policy.js` | What happens to an analyzed email |
| `src/pipeline.js` | Notifications → messages → decisions → actions → records; release, brake, watches, retention |
| `src/gmail/` | Keyless domain-wide delegation, Gmail and Directory API calls |
| `src/store/` | Firestore (production) and memory (demo, tests) |
| `src/auth/verify.js` | OIDC for Pub/Sub and Scheduler; Identity-Aware Proxy and ADMIN_EMAILS / ADMIN_GROUP for the dashboard |
| `src/scheduler.js` | Cloud Scheduler, for the dashboard's "Update group membership now" (runs the daily re-read job) |
| `src/training.js`, `src/names.js` | The retraining export: an email → a training example, with the people taken out |
| `src/digest.js` | The weekly summary email (put in admins' Inboxes; never judged by the service) |
| `src/cloudrun.js` | Cloud Run, read-only, for the Status page |
| `src/dashboard/cache.js` | The dashboard's copy of the records: one full read, then only what changed |
| `src/server.js` | The HTTP service (`ROLE=worker` / `admin`) |
| `public/` | The dashboard (plain HTML, CSS and JavaScript; no build step) |
| `src/demo/seed.js` | Made-up demo data, judged by the real engine |
| `deploy/` | `install.sh`, `update.sh`, `upgrade.sh`, `rollback.sh`, `stop.sh`, `doctor.sh` and `clear-data.sh` (Cloud Shell), `settings.example.env` |
| `.github/` | Dependabot (`dependabot.yml`: security fixes as pull requests) and the tests on every pull request (`workflows/test.yml`) |
| `tools/` | `sync-engine.js` (copy the extension's engine), `build-mockup.js`, `release.js` (the install zip); for retraining: `check-training-file.js`, `split-examples.js`, `score-examples.js` |
| `vendor/spruce/` | The extension's checks and model (copied; `VENDOR.json` says from which commit) |
