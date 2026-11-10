# S.P.R.U.C.E+ Mail Protection for Google Workspace

**Two repositories.** `google_service_testing` is where it's developed and tested.
`google_service_main` holds only the versions the maintainer has tried and approved, each copied there
unchanged. Which one you're reading: the repository's name on GitHub, or `git remote get-url origin`.
The version is in `package.json` and `CHANGELOG.md`.

S.P.R.U.C.E+ Mail Protection checks every new email in your Google Workspace domain with the same
checks and AI model as the S.P.R.U.C.E+ browser extension. It moves suspicious ones to Spam, or in
monitor mode only records them. An admin dashboard shows what was moved, why, which campaigns came in
and who was affected, and lets IT move an email back to the Inbox. Nothing is ever withheld: every email
reaches the user's mailbox, and the service only moves the suspicious ones to Spam (or not, in monitor
mode).

- **Runs in your own Google Cloud project** (Cloud Run, Pub/Sub, Firestore). Email is read through the
  Gmail API with domain-wide delegation and is not sent to any other service.
- **Its own checks and AI model.** `vendor/spruce/` holds the checks (`shared.js`, `decoders.js`) and the
  phish-tiny model (`ai.js`, `models/`). They began as the S.P.R.U.C.E+ browser extension's; since 0.4.0
  they are this project's own code, changed here (the model runs about twice as fast, with the same
  answers).
- **Careful by default:**
  - **Monitor mode** (records, moves nothing) until you switch to enforce mode.
  - **The AI score alone never moves mail from inside the organization.** The rules still can, for
    example when a staff account is compromised.
  - **Allowlisted senders and domains** are never moved (Settings → Allowlist, or `ALLOW_DOMAINS` and
    `ALLOW_ADDRESSES`). Your own domains can't be allowlisted, so a staff account taken over can still be
    caught.
  - **Both need DMARC to pass.** The allowlist and "inside the organization" go by the From address,
    which anyone can write. They count only when Gmail's own DMARC check passed for its domain. A
    forged allowlisted or staff address is judged like any mail from outside, and the record says so.
  - **Brakes that still protect a whole district** (`src/pipeline.js`, `brakes`):
    - **Moving clear phishing is never paused.** "Strong evidence" means the rules flag it *and* something outside
      the email confirms it: a blocked or listed link, a listed or blocked sender, a brand-new look-alike
      domain, or DMARC failing. Every copy is moved, to every mailbox.
    - **On weaker evidence, moving pauses per campaign.** Once `CAMPAIGN_HOLD_AFTER` (25) copies of one
      campaign were moved without outside confirmation, the others are left in the Inbox, like any email
      not moved, and recorded, until an admin decides: **Confirm phishing** moves every copy to Spam,
      **False alarm** moves the moved ones back to the Inbox. Other mail keeps moving.
    - **A domain-wide brake as a last resort:** more than `BRAKE_PER_HOUR` moves in an hour (by default
      half the watched mailboxes, at least 100) stops moving everywhere. That is a misfire on many
      unrelated emails, not one campaign. Counted exactly. While it is on, emails are left in the Inbox;
      **Resume, and move those to Spam** moves them afterwards.
    - **Alerts by email** when a brake engages, moving a campaign pauses, a large campaign arrives, Gmail goes
      quiet, or a scheduled job fails (`ALERT_EMAIL`, Cloud Monitoring).
  - **Every move can be undone** from the dashboard, and by the user: an email the user moves back
    out of Spam stays in the Inbox. It is recorded as moved back by the user (a false alarm unless an
    admin marks it phishing), and an alert asks an admin to check when the checks had flagged it.

## How it decides

For each new Inbox message:

1. The raw message is read the way the extension reads an opened email:
   - the sender, and Gmail's own DMARC/SPF/DKIM results;
   - the links, unwrapped offline;
   - the text a person sees, plus how the email hides text: filler after a large blank gap, or a body
     that is only pictures.
2. The checks add up their signs:
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
| The AI scores **90%** or more (`AI_MOVE_THRESHOLD`), sender outside the organization (or a staff address without DMARC passing) | **Move to Spam** |
| Same, in monitor mode, or while moving is paused (a campaign on weaker evidence, or the domain-wide brake) | Left in the Inbox, recorded as "would move" (a paused one can be moved later) |
| An admin dismissed the campaign as a false alarm | Recorded as suspicious, not moved |
| The user moved it into the Inbox themselves, and the service hadn't checked it | Checked and recorded, never moved (an alert if flagged) |
| A rules score of 3 or more, or an AI score of **65%** or more (`AI_SUSPICIOUS_THRESHOLD`), below what moves it; or a high AI score the policy doesn't act on (an inside sender) | Recorded as suspicious, not moved |
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

The dashboard has four tabs: **Overview**, **Email**, **Status** and **Settings**. Email, Status and
Settings each have a menu on the left (a row of buttons above the page on a phone).

- **Overview:** emails checked, moved and moved back (by admins and by users); users affected; moves per
  day by trigger; top reasons; largest campaigns; alerts.
- **Email**, with the number of emails waiting for review on the tab:
  - **Review:** emails nobody has reviewed, one at a time, in two queues (the menu shows how many are
    left in the first):
    - **Moved or would move**, oldest first: **F** false alarm, **P** phishing, **N** next.
    - **Suspicious, not moved**, newest first: emails the checks found suspicious (a rules score of 3 or
      more, or an AI score from the suspicious line) but not enough to move, still in the Inbox. **F**
      not phishing, **P** phishing, **N** next. Marking them shows what the move rules miss, and gives
      the retraining export its best examples.
    - **In enforce mode, P moves an email still in the Inbox to Spam** (the button then reads
      **Phishing: move to Spam**), with the service's `SPRUCE/Moved` label; Activity notes who. In monitor
      mode nothing is moved. An email no longer in the Inbox (archived, deleted) is left where it is.
  - **Campaigns:** each opens the list of emails behind it, with **Confirm phishing: move every copy**
    (optionally searching every watched mailbox for copies the service didn't record), **False alarm:
    move every copy back**, and **Find other copies**.
  - **Messages:** search and filters (also by Message-ID), opening each email's decision. **Download
    CSV** gives the same list.
    - Tick several to **move back to the Inbox**, **mark false alarm** or **confirm phishing** them at once
      (in enforce mode, confirming also moves those still in the Inbox to Spam).
    - Each email shows the signs found with their weights, flagged links, the AI score with what weighed
      most, the sender check, and how strong the evidence was. Buttons: **Move back to Inbox**, **Mark
      false alarm** (**Mark not phishing** for a suspicious email), **Confirm phishing** (**Confirm
      phishing: move to Spam** for one still in the Inbox, in enforce mode).
    - Each email also shows its **Message-ID** and Gmail ID, each with a **Copy** button. The Message-ID
      is what Google Workspace's Email log search and the security investigation tool look an email
      up by.
    - **Check an email:** paste a reported email's original (Gmail: Show original), or an `.eml` file, to
      see what the service would decide and why. Nothing is stored, moved or counted.
  - **Users:** everyone who had mail moved, would have had it moved, or got suspicious mail; each opens
    the list of their emails.
- **Status:**
  - **Service status:** whether the service works end to end, with what to do for each problem:
    - Identity-Aware Proxy off on the worker, and who may call it;
    - both services on the same build, and the jobs reaching the worker;
    - notifications arriving and watches renewed;
    - the phishing lists, alerts, errors, the brake.

    `deploy/doctor.sh` checks the rest from Cloud Shell.
  - **Model health:** recorded emails by AI score, and how often each kind of move was undone (and how
    often by users themselves). This is the number to tune the threshold with.
    - Marking emails doesn't train the AI model. **Download for retraining** (allowed in Settings → Retraining, off by
      default) gives the emails admins marked, read from Gmail at that moment with the people taken
      out, as training examples in the extension's format. Nothing is stored. `docs/RETRAINING.md` says
      how to check the file and train the model with it.
  - **Readiness:** whether monitor mode has shown enough to switch to enforce mode, as checks:
    - time in monitor mode, emails reviewed, false alarms;
    - staff mail failing DMARC, and the busiest hour against the brake;
    - notifications arriving, and the group re-read reaching the service.
  - **Activity:** alerts, what admins did, errors and the watching of mailboxes, by kind.
- **Settings:**
  - **Policy:** **Change** the mode, the AI move threshold, the AI suspicious line, the brake (automatic,
    or a fixed number of moves an hour) or the time zone, and how the rest decides (read-only). The
    suspicious line is never above the move threshold.
    - Each change needs the Google Cloud project ID; five wrong ones lock it for 10 minutes.
    - Switching to enforce mode also needs **I agree**, next to how many Readiness checks pass.
    - A change applies everywhere within 30 seconds, is noted in Activity, and is emailed as an alert
      (a time zone change is only noted).
    - Each setting says where its value comes from: settings.env, or changed here, by whom and when.
  - **Allowlist:** the domains and addresses never moved (when Gmail's DMARC check passes for them),
    changed the same way, one per line. Your own domains can't be added; single addresses in them can.
  - **Mailboxes:** each watched mailbox with the last time Gmail notified the service about it, and
    **Update group membership now**, which re-reads the pilot group at once instead of waiting for the
    daily run, and says whether that reached the service.
  - **Weekly summary** (off by default): every Monday from 7 AM (`TIME_ZONE`), the week's numbers, what
    waits, and the largest campaigns go into each dashboard admin's Inbox. **Preview** and **Send one
    now** are next to it.
  - **Retraining** (off by default): allows **Download for retraining** on Status → Model health.
  - **Update:** the version installed, the newest approved one (from `google_service_main`), what's new
    since yours (its changelog), and the whole changelog. **Update to …** works like
    `bash deploy/update.sh`:
    - it needs **I agree**, the Google Cloud project ID and the email address you are signed in with
      (five wrong answers lock it for 10 minutes);
    - both services are rebuilt from that version and redeployed with their settings as they are, by a
      Cloud Build the dashboard can only start (it can't deploy anything itself). It takes about
      10 minutes, and the page follows it: requested, building, done or failed;
    - its start is noted in Activity and emailed as an alert; how it ended is in Activity (a failure as
      an alert) and on the page.

    A version that changes the installation itself (new permissions, jobs or settings) is installed
    from Cloud Shell, `bash deploy/update.sh`: the page says so instead of offering the button. So is
    the first version with this page (0.3.9), which sets it up.
  - **About:** the version, the AI model, what is kept, and the network checks.
- **The browser tab's title** counts what needs you: the brake, paused campaigns, users who took flagged
  mail back.

Each page keeps its own address (`#/review`, `#/health`…), so links to a page keep working.

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
  zip to upload. Each version brings its own AI model; the upgrade says when the model changes. Most
  versions can also be installed from the dashboard (Settings → Update), which runs
  `deploy/cloud-update.sh` in Cloud Build.
- **`deploy/upgrade.sh`** installs a version you unzipped over the installed one.
- **`deploy/rollback.sh`** goes back to the previous build.
- **`deploy/stop.sh`** stops it.
- **`deploy/doctor.sh`** checks the installation end to end and says what to run for each problem.
- **`deploy/dashboard-policy.sh`** (used by `install.sh` and `upgrade.sh`) compares the policy
  changed on the dashboard with settings.env.
- **`deploy/clear-data.sh`** clears what the dashboard shows (emails recorded, counts, campaign
  decisions, Activity) and keeps the watched mailboxes and settings, after you type the project ID.

Changing a setting is quick: edit `deploy/settings.env` and run `install.sh` again. It reuses the image
built from the same files, so it only redeploys, in about a minute. The mode, the AI move threshold, the
AI suspicious line, the brake, the time zone and the allowlist can also be changed on the dashboard
(Settings → Policy, Settings → Allowlist). When the two differ,
`install.sh` asks which to keep, and writes the answer into settings.env.

See `docs/DEPLOY.md` (each piece, by hand) and `docs/PRIVACY.md` (what is read, kept and shown).
`docs/SCALING.md` is what a district of 10,000 mailboxes and 100,000 emails a day asks of it, measured,
and the plan beyond.
`docs/ARCHITECTURE.md` explains the pieces. `docs/RETRAINING.md` turns the emails admins marked into
training examples, and a better AI model.

## Layout

| Path | What |
|---|---|
| `src/engine/` | MIME and HTML reading, the extension's checks and model (`spruce.js` loads `vendor/spruce/`); `network.js` applies the lookups |
| `src/intel/` | Cloudflare Security DNS, Google Safe Browsing, the phishing lists, registry dates; request limits |
| `src/policy.js` | What happens to an analyzed email |
| `src/pipeline.js` | Notifications → messages → decisions → actions → records; moving back, brake, watches, retention |
| `src/gmail/` | Keyless domain-wide delegation, Gmail and Directory API calls |
| `src/store/` | Firestore (production) and memory (demo, tests) |
| `src/auth/verify.js` | OIDC for Pub/Sub and Scheduler; Identity-Aware Proxy and ADMIN_EMAILS / ADMIN_GROUP for the dashboard |
| `src/scheduler.js` | Cloud Scheduler, for the dashboard's "Update group membership now" (runs the daily re-read job) and Settings → Update (runs the spruce-update job) |
| `src/releases.js`, `src/update.js` | Settings → Update: the newest approved version and its changelog (read from GitHub), and the request |
| `src/training.js`, `src/names.js` | The retraining export: an email → a training example, with the people taken out |
| `src/digest.js` | The weekly summary email (put in admins' Inboxes; never judged by the service) |
| `src/cloudrun.js` | Cloud Run, read-only, for the Status page |
| `src/dashboard/cache.js` | The dashboard's copy of the records: one full read, then only what changed |
| `src/server.js` | The HTTP service (`ROLE=worker` / `admin`) |
| `public/` | The dashboard (plain HTML, CSS and JavaScript; no build step) |
| `src/demo/seed.js` | Made-up demo data, judged by the real engine |
| `deploy/` | `install.sh`, `update.sh`, `upgrade.sh`, `rollback.sh`, `stop.sh`, `doctor.sh` and `clear-data.sh` (Cloud Shell), `dashboard-policy.sh` (theirs), `cloud-update.sh` (Settings → Update's Cloud Build), `settings.example.env` |
| `.github/` | Dependabot (`dependabot.yml`: security fixes as pull requests) and the tests on every pull request (`workflows/test.yml`) |
| `tools/` | `build-mockup.js`, `release.js` (the install zip); for retraining: `check-training-file.js`, `split-examples.js`, `score-examples.js` |
| `vendor/spruce/` | The checks and the AI model (this project's own code since 0.4.0; they began as the extension's, `VENDOR.json` says from which commit) |
