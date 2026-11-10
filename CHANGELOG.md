# Changelog

## 0.3.6: The policy, changed on the dashboard

- **Settings → Policy:** a **Change** button for each of:
  - **the mode** (monitor or enforce);
  - **the AI move threshold** (51–100%);
  - **the brake** (automatic, or a fixed number of moves an hour, 10–100,000);
  - **the time zone** (a list of time zone names).

  Each row says where its value comes from: settings.env, or changed here, by whom and when.
- **The project ID is required for every change.** The dashboard checks it against
  `GOOGLE_CLOUD_PROJECT` (install.sh sets it), case and spaces aside. Five wrong ones lock changes for
  10 minutes.
- **Enforce mode also needs "I agree".** The form warns what enforce mode does and shows how many
  Readiness checks pass. Back to monitor needs only the project ID.
- **A change applies everywhere within 30 seconds.** It is kept in Firestore (`state/policy-<key>`), and
  both services read it on each notification, each job and each dashboard request.
- **Every change is noted in Activity and emailed as an alert**, except the time zone, which is only
  noted.
- **The header's mode badge** follows a switch made by any admin.
- **install.sh, upgrade.sh and update.sh** compare the dashboard with settings.env
  (`deploy/dashboard-policy.sh`, new):
  - settings.env doesn't set a setting the dashboard changed: the dashboard's is used;
  - settings.env sets it and the dashboard didn't change it: settings.env's is used;
  - the two differ: you're asked which to keep. The default is the dashboard's, since it is in force.
    Without a terminal to ask in, the dashboard's is kept; `SPRUCE_SETTINGS=file` uses settings.env's.
  - The choice is written into settings.env. Once the new build is deployed, the dashboard's copy is
    removed (until then it stays in force), and Activity notes what was chosen.
  - `upgrade.sh` says beforehand what will be taken or asked about, and `Mode now: …` when the
    dashboard switched it.
  - The nightly jobs follow the time zone chosen.
- **The services agree with settings.env changed later:** when settings.env has another value than the
  one a dashboard change replaced, settings.env's is newer and applies.
- **Tests:** 90 (from 85).
  - `test/policy.test.js` (new): values checked; a change at once here and after the refresh
    elsewhere; enforce really moves; alerts and notes; settings.env changed later wins; the project
    ID, the lock and the agreement through the dashboard's route.
  - `test/install.test.js`: the reconciliation (taken, kept, settings.env's chosen, a removal refused,
    the same on both sides), the env each service is deployed with, the jobs' time zone, the order (the
    removal after both deploys).
  - `test/firestore.test.js`: the helper against the Firestore emulator, reading what the service
    stores, removing it and noting it.
- **Docs:** `README.md`, `docs/INSTALL.md` (changing a setting, moving mail for real), `docs/DEPLOY.md`,
  `docs/ARCHITECTURE.md`.

## 0.3.5: The dashboard in four tabs

- **Four tabs instead of ten:** **Overview**, **Email**, **Status**, **Settings**.
- **Email** has a menu on the left: **Review**, **Campaigns**, **Messages**, **Users**, in that order.
  - The Email tab opens on Review.
  - The number of emails waiting for review is on the Email tab, and next to Review in the menu.
  - An email's page and **Check an email** belong to Messages.
- **Status** has the same kind of menu: **Service status** (the end-to-end checks that were the Status
  tab), **Model health**, **Readiness**, **Activity**.
- **On a phone** the menu is a row of buttons above the page, which scrolls sideways when it doesn't
  fit.
- **Every page keeps its address** (`#/review`, `#/health`, `#/activity`…), so links to a page keep
  working: bookmarks, and the Overview's links to held campaigns.
- **Where to go, in the texts:** the alert emails, the Status checks, the weekly summary, the
  Settings cards, `deploy/clear-data.sh` and the docs now say "Email → Campaigns", "Status → Model
  health" and so on.
- **Docs:** `README.md` (the dashboard, by tab), `docs/INSTALL.md`, `docs/RETRAINING.md`,
  `docs/PRIVACY.md`.

## 0.3.4: Clearing the dashboard's data

- **`deploy/clear-data.sh`** (Cloud Shell, from the install folder) clears what the dashboard shows, to
  start counting again (after a trial, before going live).
  - **Deleted** (Firestore): `records`, `stats`, `campaigns`, `moveCounts`, and `events` (Activity)
    unless `--keep-activity`.
  - **Kept:** the watched mailboxes (`users`), the emails already checked (`seen`), the Settings switches
    and the brake's state (`state`), sender history, the phishing lists. Nothing in Gmail changes.
  - **Before:** it shows all this and asks you to type the project ID (`--yes` for scripts; without a
    terminal it stops unless given `--yes`).
  - **When something is held, it stops:** the brake is on, a campaign waits for a decision, or Firestore
    didn't answer the check. The held emails stay in the Inbox and are no longer tracked once cleared.
    `--even-if-held` clears anyway.
  - **After:** Activity gets one entry saying who cleared it, and the dashboard restarts (each instance
    keeps a copy of the records, and a deletion doesn't reach it otherwise).
  - **`--reset-clock`** also restarts the monitor-mode clock (Readiness, and the senders' learning
    period).
  - Every collection is named: `gcloud firestore bulk-delete` without `--collection-ids` would delete
    every collection, and a test checks that no deploy script calls it that way.
- **Tests:** 85 (from 83).
  - `test/install.test.js`, with stand-ins for `gcloud` and `curl`: what is deleted and kept, the
    options, the order (the Activity entry after the deletion), refusing when something is held or
    can't be checked.
  - `test/firestore.test.js`, against the Firestore emulator with the real `curl`: the brake and held
    campaigns read as the service stores them, the Activity entry as the dashboard reads it, the clock
    reset, and a refused token stopping it before anything is deleted.
- **Docs:** `docs/INSTALL.md` ("Clearing the dashboard's data"), `README.md`, `docs/PRIVACY.md`.

## 0.3.3: The AI model phish-tiny 0.11.0

- **phish-tiny 0.11.0** replaces 0.4.0, copied unchanged from the S.P.R.U.C.E+ extension (5.94.13,
  `llm_testing` 9292388) with `tools/sync-engine.js`. Only the model changed: the extension's checks
  (`shared.js`, `decoders.js`, `ai.js`) are the same files as before.
- **Trained on twice as much** (17,024 emails, 3 runs averaged). The extra emails are published phishing
  and scams, including spear phishing and business email compromise, and published genuine emails that
  look like scams.
- **Scored on emails neither model was trained on**, at the service's move threshold (0.85):

  | | 0.4.0 | 0.11.0 |
  |---|---|---|
  | Published genuine emails called phishing | 276 of 624 (44%) | 17 of 624 (2.7%) |
  | Published phishing missed | 48 of 603 (8%) | 20 of 603 (3.3%) |
  | Hand-written genuine look-alikes called phishing | 9 of 24 | 3 of 24 |
  | Hand-written emails (both kinds) wrong | 0 of 33 | 0 of 33 |

  0.4.0 had never seen published genuine emails; 0.11.0 was trained on two thirds of them, and the third
  above is the one held out. The model card is `vendor/spruce/models/phish-tiny/MODEL_CARD.md`.
- **What it means here:** fewer emails moved on the AI score alone, and more phishing reaching it. The
  rules, the brakes and `AI_MOVE_THRESHOLD` are unchanged, and by default (`AI_MOVES_INSIDE`) the AI
  score alone still never moves mail from inside the organization.
- **Upgrading shows it:** `upgrade.sh` prints `AI model (phish-tiny): 0.4.0 -> 0.11.0`. In monitor mode,
  watch Model health and Readiness for a week: the undo rate of "AI score" moves should fall.
- **Tests:** the `update.sh` test now takes the installed model from `vendor/spruce/VENDOR.json` instead
  of assuming 0.4.0.

## 0.3.2: The retraining export, and how to retrain the AI model

Marking an email doesn't train the AI model: phish-tiny is a fixed file that comes with each version.
This version makes the marks usable for training.

- **Download for retraining** (Model health; **off until an admin allows it** in Settings → Retraining
  export; Activity notes who allowed it and every download):
  - The emails an admin confirmed as phishing, and with a tick the false alarms, from the chosen period.
  - One per campaign: the newest copy still in a mailbox. A campaign marked both ways is left out.
  - At most 100, newest first.
  - Each is read from Gmail at the moment of the download and judged again as on arrival, for what the
    model read. Nothing is stored or counted: the file is the only copy.
  - The file is JSON Lines in the extension's own training format (`tools/ai/data/extra/*.jsonl`:
    `name`, `label`, `note`, `facts`).
- **The people are taken out** (`src/training.js`), on top of the model's own redaction:
  - the recipient becomes "your name", as the model sees them;
  - the other people in To, Cc and Reply-To, and names after Mr./Ms./Dr., greetings and sign-offs,
    become [NAME];
  - the sender of genuine or inside mail becomes [SENDER];
  - your domains become [OUR-DOMAIN];
  - the text is cut to what the model reads.

  Other words that may be names are marked ⟦like this⟧ for a person to decide: common names
  (`src/names.js`), unusual words, and capitalized words in the middle of a sentence.
- **`docs/RETRAINING.md`:** how to read the file and train the model with it. In order: review every
  example, replace the placeholders with made-up names (by hand, or with claude.ai if your district
  allows it), keep a third aside, train in the extension, compare, release.
- **Tools** (Node only, no install):
  - `tools/check-training-file.js` refuses leftovers (marks, addresses, phone and long numbers, a `text`
    field), and with `--final`, placeholders;
  - `tools/split-examples.js` keeps every third email of each kind aside, with its variants;
  - `tools/score-examples.js` scores a file with the model the service runs, at its move threshold.
- **Engine:** `analyze()` can return what the model read (`keepAiFacts`, for the export only), and
  `readMessage()` the headers' names (`people`). Neither is stored.
- **Tests:** 83 (from 77). `test/training.test.js` covers:
  - the removal, and that everyday words in the demo's emails aren't marked;
  - the check, the split and the scorer;
  - the export: off by default, phishing only unless asked, one per campaign, a deleted copy replaced,
    nothing stored;
  - the dashboard's routes.
- **Docs:** `docs/RETRAINING.md` (new), `README.md`, `docs/PRIVACY.md`, `docs/ARCHITECTURE.md`,
  `docs/ROADMAP.md`.

## 0.3.1: Quality of life: review, bulk actions, Status, Check an email, the weekly summary

- **Review** (a new tab): the moved or "would move" emails nobody has reviewed, one at a time, oldest
  first. **F** marks a false alarm, **P** phishing, **N** goes to the next. The tab says how many are left;
  that's the Readiness check that asks for 80% reviewed.
- **Several at once** on Messages: tick emails (or all on the page), then **Release to Inbox**, **Mark
  false alarm** or **Confirm phishing**. Live updates wait while some are ticked.
- **The browser tab's title counts what needs you:** the brake, campaigns held for a decision, users who
  took a flagged email back.
- **Check an email** (Messages): paste a reported email's original (Gmail: Show original), or choose an
  `.eml` file. You see what the service would decide and why, judged as on arrival with the same lookups.
  Nothing is stored, moved or counted; Activity notes who checked one.
- **Message-ID on every email**, with a **Copy** button, for Google Workspace's Email log search and the
  security investigation tool. Messages can be searched by it, and the CSV has it. The Gmail ID of each
  copy is shown and copyable too. Emails recorded before 0.3.1 have no Message-ID.
- **Status** (a new tab) checks the service end to end, from the dashboard, and says what to do for each
  problem:
  - Identity-Aware Proxy off on the worker, and who may call it;
  - both services on the same build;
  - the re-read and hourly jobs reaching the worker;
  - Gmail's notifications arriving, and watches renewed;
  - the phishing lists, alerts, errors in the last day, and the brake.

  It needs the Cloud Run Viewer role (install.sh).
- **`deploy/doctor.sh`** checks the rest from Cloud Shell and says what to run for each problem:
  - billing;
  - Identity-Aware Proxy on both services;
  - the subscription's endpoint, sign-in and audience;
  - Gmail's permission to publish;
  - the jobs;
  - the alert policies;
  - errors in the worker's log.

  It is read-only.
- **A settings change doesn't rebuild.** The image is named after its files. `install.sh` with the same
  files reuses it and only redeploys, in about a minute. `FORCE_BUILD=1` builds anyway.
- **`TIME_ZONE`** (for example `America/New_York`): the scheduled jobs run in it (`--time-zone`), the
  installer shows times in it, and the weekly summary goes out Monday from 7 AM there. Empty means UTC,
  as before.
- **`deploy/update.sh`: upgrades without a zip.** It downloads the newest approved version from
  `google_service_main` (public), unpacks it next to your folder, and runs its `upgrade.sh`.
  - The upgrade shows the AI model's version change. Each service is now labelled with its version and
    model's (`spruce-version`, `spruce-model`).
  - The AI model comes with each version, so a new one arrives only with an approved version.
- **Weekly summary email** (Settings; **off by default**, the only setting changed from the dashboard;
  Activity says who turned it on or off):
  - every Monday from 7 AM, put straight into each dashboard admin's Inbox: `ADMIN_EMAILS`, and the
    members of `ADMIN_GROUP` in your domains;
  - the week's numbers, what waits for you, the largest campaigns, and (in monitor mode) the Readiness
    checks;
  - **Preview** and **Send one now** are next to the switch;
  - it uses the Gmail API's `messages.insert`, which the existing `gmail.modify` scope allows: nothing is
    sent and no new permission is needed;
  - the service never judges its own summary.
- **The dashboard reads far less from Firestore.** Since 0.2.12 every open dashboard re-read up to 20,000
  records every 30 s. It now keeps a copy and asks only for records changed since (records carry
  `updatedAt`; changes are read from a minute before the newest one seen, so none is missed).
- **Fixed:** the summary's campaign lines counted the copies wrongly ("0 copies"), found by its test
  before release.
- **Tests:** 77 (from 67). `test/qol.test.js` covers the summary, bulk, review, pending, Status and the
  cache. More in `test/install.test.js` (build reuse, `TIME_ZONE`, labels, `doctor.sh`, `update.sh`),
  `test/firestore.test.js` (change tracking, held campaigns) and `test/server.test.js` (Check an email,
  Message-ID).
- **Docs:** `README.md`, `docs/INSTALL.md` (upgrading with `update.sh`, investigating an email in Google
  Workspace, changing a setting, Troubleshooting starts at Status and `doctor.sh`), `docs/DEPLOY.md`,
  `docs/ARCHITECTURE.md`, `docs/PRIVACY.md`.

## 0.3.0: Brakes that protect a whole district, alerts, campaign decisions

With 7,000 mailboxes, the brake (100 moves an hour, for everyone) would have stopped protecting people
early in a real phishing campaign. The brakes now tell a clear phishing campaign from a possible
misfire.

- **Strong evidence is never held.** The rules flag the email *and* something outside it confirms it:
  - a link Cloudflare blocks or a phishing list has;
  - a sender on a list or blocked;
  - a brand-new look-alike domain;
  - Gmail's DMARC check failing.

  Every copy is moved, to every mailbox. Each record says how strong its evidence was.
- **Weaker evidence is held per campaign.** Past `CAMPAIGN_HOLD_AFTER` (25) copies of one campaign moved
  without outside confirmation, the rest wait in the Inbox, recorded as "would move". Other mail keeps
  moving. An alert and a banner on Overview ask an admin to decide.
- **The domain-wide brake is a last resort.** `BRAKE_PER_HOUR` now defaults to half the watched
  mailboxes, at least 100 (3,500 for 7,000).
  - Its count is exact: a slot is reserved before each move. Before, it was counted after the move, so
    moves happening at the same moment could pass the limit.
  - Tripping it is one atomic step (one alert).
- **Held mail is recoverable.** **Resume and move held mail** moves what the domain-wide brake held, if
  still in the Inbox. **Resume without moving** leaves it.
- **Campaign decisions** (Messages, filtered to a campaign):
  - **Confirm phishing: move every copy** moves held and recorded copies and marks them all phishing,
    and later copies aren't held. It can also search every watched mailbox's Inbox of the last 7 days
    for copies the service didn't record (same sender domain and subject), reading only From and
    Subject.
  - **False alarm: release every copy** releases the moved ones; later copies aren't moved.
  - **Find other copies** runs that search again.
  - In monitor mode nothing is moved.
- **Alerts by email** (`ALERT_EMAIL`, default the `ADMIN_GROUP`; `off` for none). The service logs each
  alert, and Cloud Monitoring emails it through two log-based alert policies that `install.sh` makes
  (expected free). The alerts:
  - the domain-wide brake engaged;
  - a campaign held;
  - a large campaign (`CAMPAIGN_ALERT_AFTER`, 50 moves);
  - no notification from Gmail for `QUIET_HOURS` (12), or watches about to end, from an hourly health
    check;
  - a user taking a flagged email into their Inbox;
  - the group re-read failing;
  - any failed scheduled job (as with Identity-Aware Proxy on the worker).
- **Mail that skipped the checks:**
  - **An email the user moves into the Inbox that was never checked** (it went to Spam first, within 7
    days of arrival) is checked and recorded, never moved, with an alert when the checks flag it.
  - **After a gap in a mailbox's history,** its Inbox since the last notification (at most a week) is
    checked, 25 at a time with each later notification. Before, it was skipped.
- **Dashboard:**
  - **Readiness**: whether monitor mode has shown enough for enforce mode, as checks;
  - **Activity**: alerts, admin actions, errors, watching, by kind;
  - **Download CSV** on Messages (cells a spreadsheet would run as formulas are written as text);
  - the strength of the evidence on each email;
  - the brake and campaign hold in Settings.
- **Scale**, found by the new Firestore tests: counters that every move or checked email updated were
  single Firestore documents, which take about one write a second.
  - The brake's hourly count is split in up to 32 shards, whose limits add up to the limit exactly.
  - The campaign hold only reads once a campaign is held. Campaign move counts use an increment.
  - The daily stats are split in 10 shards, summed when read (older days' single documents count too).
- **`install.sh`:**
  - Cloud Monitoring API, the email channel and the alert policies;
  - `spruce-sync-feeds` runs hourly for the health check (still 3 jobs; the lists are downloaded once a
    day, and a failed download is tried again the next day);
  - `CAMPAIGN_HOLD_AFTER` and `ALERT_EMAIL` settings, which `upgrade.sh` adds empty.
- **Tests:** 67 (from 47).
  - `test/brakes.test.js`: the brakes, held mail, campaign decisions, the two gaps, health.
  - `test/install.test.js`: the deploy scripts against stand-ins for `gcloud` and `docker`, which were
    checked by hand before.
  - `test/firestore.test.js`: the Firestore store against Google's emulator, run in CI by a new job.
  - New dashboard routes in `test/server.test.js`.
- **Docs:** `README.md`, `docs/INSTALL.md` (settings, the brakes in enforce mode, Troubleshooting, Costs),
  `docs/DEPLOY.md` (settings), `docs/ARCHITECTURE.md`, `docs/PRIVACY.md` (what the new checks read, alert
  emails, the CSV), `docs/ROADMAP.md`.

## 0.2.14: The files that are in both repositories read right in both

Each release copies `google_service_testing` unchanged to `google_service_main`. So `CLAUDE.md`, `README.md`
and `.github/dependabot.yml` are in both, but they were written for the testing repository alone. The
service itself is the same as 0.2.13.

- **`CLAUDE.md`** says it is in both repositories, and how to tell which one you're in
  (`git remote get-url origin`).
  - The rules for each are in their own section. The release repository: nothing is developed or
    edited there. The testing repository: tests, safety defaults, made-up data, the vendored engine,
    version bumps.
  - The approval rule for `google_service_main` is unchanged. A release now only moves
    `google_service_main` forward (the two share their history since 0.2.13).
- **`README.md`** opens with the two repositories instead of "This is the testing repository".
- **Dependabot:** only security fixes now, switched on per repository (on in `google_service_testing`,
  off in `google_service_main`). Routine version updates are off: from the copy of the file in
  `google_service_main`, they opened pull requests there too.

## 0.2.13: "Update group membership now" in Settings

- **Settings → Mailboxes watched** has a button, **Update group membership now**. It re-reads the
  pilot group at once: people added are watched, people removed are no longer watched.
  - It asks Cloud Scheduler to run the daily `spruce-renew-watches` job now. The dashboard never calls
    the worker itself, which stays reachable only by Pub/Sub and Cloud Scheduler.
  - At most once a minute. Recent activity says who asked, then "Watching N mailboxes" once the job
    has run. The page updates by itself.
- **When the group was last read** shows next to the button, with whether that reached the service.
  When it didn't (as with Identity-Aware Proxy on the worker), it says so in red and points to
  Troubleshooting. Before, that showed only in Cloud Scheduler's log.
- **`install.sh`:** gives `spruce-run` the Cloud Scheduler Job Runner and Viewer roles, and tells the
  dashboard which job to run (`RENEW_JOB`). Without `RENEW_JOB`, as in a hand-made deployment that
  doesn't set it, the button isn't shown.
- **Docs:** `README.md`, `docs/INSTALL.md` (step 7, Troubleshooting), `docs/DEPLOY.md` (the two roles,
  `RENEW_JOB`), `docs/ARCHITECTURE.md`.
- **Checked:**
  - tests for the Cloud Scheduler client (run, last run, a refusal) and for the dashboard action (needs
    the dashboard header, once a minute, recorded, a refused run says why);
  - the installer against a stand-in `gcloud` (roles granted, `RENEW_JOB` in the dashboard's
    settings);
  - in demo mode with a browser: the button, its message, the second press refused, and Recent activity.

## 0.2.12: DMARC must pass to be trusted; the dashboard updates itself; Dependabot

- **The allowlist and "inside the organization" need DMARC to pass.** Both go by the From address,
  which anyone can write. Now they count only when Gmail's own DMARC check passed for that address's
  domain (`header.from` the same domain).
  - **A forged allowlisted address** is judged like any other mail. The record says "allowlisted
    sender, but DMARC didn't pass, so it was judged like any other".
  - **A forged staff address** is treated as mail from outside, so the AI score can move it. The record
    says "the address is the organization's, but DMARC didn't pass, so it isn't treated as inside".
  - Genuine staff mail is unchanged: the AI alone never moves it. Before switching to enforce, check
    in monitor mode that your own staff's mail isn't being recorded with that note. A domain with no
    DMARC record, or one whose mail fails it, would lose the "inside" exemption.
  - The AI model's input is unchanged (as the extension gives it), so AI scores stay the same.
- **The dashboard updates itself.** The page you're on is fetched again every 30 seconds while the tab
  is visible, keeping your scroll position.
  - It waits while you're using the page: typing in a field, focus on a control, a tooltip open, text
    selected, or an action under way.
  - The bar under the tabs says "Live · updated …". **Pause updates** stops it, remembered in that
    browser only. If an update fails, the page stays as it was and the bar says so.
- **Dependabot** (`.github/dependabot.yml`):
  - npm updates weekly (minor and patch together, majors one by one);
  - GitHub Actions monthly;
  - every pull request runs the tests and `npm audit --omit=dev` (`.github/workflows/test.yml`).

  Turn on **Dependabot security updates** in the repository's settings for security fixes as soon as
  they're published.
- **Docs:** `README.md` (both exemptions need DMARC, live updates, dependency updates), `docs/DEPLOY.md`
  (`ALLOW_DOMAINS`, `ALLOW_ADDRESSES`, `AI_MOVES_INSIDE`).
- **Checked:**
  - a new test: allowlisted and staff addresses with and without DMARC passing, and DMARC for another
    domain than From; it fails on 0.2.11;
  - live updates in demo mode, with a browser: a release elsewhere shows within the interval, the
    scroll position is kept, half-typed search text holds the update, and Pause and Resume work;
  - light, dark and phone width; the clickable mockup (no live updates there).

## 0.2.11: The installer keeps Identity-Aware Proxy off the worker, and checks the jobs get through

In a pilot, Identity-Aware Proxy got turned on for `spruce-worker` (it belongs on the dashboard,
`spruce-admin`, only). Pub/Sub and Cloud Scheduler can't sign in through it, so from then on every
Gmail notification and every group re-read was refused with 401 before reaching the service. That leaves
nothing in the worker's log. The dashboard showed one mailbox watched and one email checked, the state
before IAP went on.

- **Step 7/9:** if IAP is on for `spruce-worker`, `install.sh` says so and turns it off there (the
  dashboard keeps it). It also removes the IAP service agent's permission to call the worker, which only
  the dashboard needs.
- **Step 9/9:** after starting the group re-read, `install.sh` waits up to a minute for the job to reach
  the worker. If the job was refused, it stops with the reason from Cloud Scheduler's log ("UNAUTHENTICATED
  … 401") and where to look. Before, it reported success whatever happened.
- **Docs:** `docs/INSTALL.md` (Troubleshooting: "The jobs and notifications are refused", and the IAP
  steps now say "never on `spruce-worker`"), `docs/DEPLOY.md` (the same).
- **Checked** against a stand-in `gcloud`: IAP on (turned off, install goes on), job refused (stops with
  the 401), job not run yet (says so, goes on). The real `gcloud` accepts the commands' options.

## 0.2.10: No known vulnerabilities in the dependencies

The build printed "6 moderate severity vulnerabilities". `npm audit --omit=dev` now finds none.

- **Why `npm audit fix` alone didn't fix them:** they came from `glob` and `minimatch`, through `rimraf`,
  in the older Google libraries that `@google-cloud/firestore` 9.4.0 (the newest) still requires
  (`@google-cloud/firestore-api` 0.2 → `google-gax` 5 → `rimraf` 5). No release in those ranges uses
  fixed versions.
- **The fix:** `package.json` overrides `rimraf` to `^6.1.4`, which brings `glob` 14.0.4 and
  `minimatch` 11.0.5. 21 packages fewer are installed.
- **Why the override is safe:** nothing in the service loads `rimraf`, `glob` or `minimatch`. They are
  listed by those libraries but never used. The flaws they had needed an attacker's file patterns,
  which the service never passes them.
- **Still printed:** a deprecation notice for `node-domexception`, from Google's libraries. It is not a
  vulnerability, and there is no newer version to move to yet.
- **Checked:** a clean `npm ci --omit=dev` (as in the Dockerfile) on Node 22, the Firestore client
  loading, and the 44 tests.

## 0.2.9: The dashboard says which mailboxes it watches, and why

A pilot showed "Mailboxes watched: 1" and "Emails checked: 1", with nothing on the dashboard to say
why. Nothing about how mail is judged changes.

- **Recent activity: "Watching N mailboxes."** after each re-read of the pilot group (daily, after
  `install.sh`, or the `spruce-renew-watches` job). For each group it says how many entries the group
  lists, how many people are watched, and what was left out:
  - accounts that aren't active;
  - addresses outside `ORG_DOMAINS`, with their domains;
  - "all users in the organization" entries (not expanded);
  - groups inside it, whose members are listed too.

  It also says how many mailboxes couldn't be watched, and how many were stopped. Before, only errors
  were shown, so people left out for these reasons were never mentioned.
- **Settings → Mailboxes watched:** each watched mailbox, with the last time Gmail notified the service
  about it and when its watch renews. A mailbox that gets mail but shows "None yet" isn't being
  notified.
- **Worker log:** a line for each notification (`notification: 1 new in the Inbox, 1 checked`) and for
  each re-read (`renew-watches: Watching …`), without email addresses.
- **Demo:** the made-up mailboxes have notification times, and Recent activity has a "Watching" line.
- **Docs:** `docs/INSTALL.md` (what step 6 should show; mail sent to yourself isn't checked;
  Troubleshooting for fewer mailboxes than people, and for "None yet"), `README.md` (Settings).
- **Tests:** what the group re-read says (people left out and why, mailboxes that couldn't be watched or
  were stopped), what the Directory API listing counts, and the Settings list.

## 0.2.8: Fixes from a code review

None of these could move mail in monitor mode, the default. They matter before enforce mode.

- **Your own domains and the phishing lists:** a list that names your organization's whole domain or
  website (a hacked school site, say) no longer flags staff mail, or links to your own sites. Your
  domains count only as exact listed links and addresses, as in the extension, and as the Cloudflare
  check already did. Before, one such listing scored every internal email with a link to your site as
  dangerous; in enforce mode they would have been moved until the brake stopped it.
- **A failed check is tried again.** Before, a message was marked as seen before it was judged, and
  the mailbox's place moved on even when its check failed. So a phish whose move Gmail refused once
  stayed in the Inbox with no record.
  - Now a message is marked done only after it is judged and recorded.
  - Until every message in a notification is done, the mailbox's place stays, and the worker asks
    Pub/Sub to deliver the notification again (503). `install.sh` gives the subscription a retry delay
    of 30 s to 10 min.
  - After 3 failed tries the message is left where it is, with an alert, and the mailbox moves on.
  - A move whose record then failed: the next try sees the `SPRUCE/Moved` label and writes the record
    without moving the email again. Before, such an email sat in Spam with no record, and couldn't be
    released from the dashboard.
  - Gmail's "slow down" answers (403 `rateLimitExceeded`, `userRateLimitExceeded`) are tried again like
    429. A message deleted before it was read is skipped without an error.
- **Two notifications at once:** one instance at a time judges a message (a claim in Firestore; one
  left by an instance that stopped is taken over after 5 minutes). Before, both judged it, counted it
  twice, and the mailbox's place could go back. The place now only moves forward.
- **A user's rescue when history is read again:** told from the label an email arrived with by their
  history IDs (records keep the message's history ID when read). Before, a rescue in a stretch of
  history read a second time was ignored.
- **The brake:** after an admin resumes, the count starts again. Before, the moves that tripped it
  still counted, so the next move tripped it again, for up to an hour.
- **A backlog over 4,000 messages** in one mailbox is read in parts. Before, the rest was skipped with
  no alert.
- **Not changed:** the allowlist and the "inside the organization" exemption still trust the From
  address without DMARC. That is a policy decision, left for the maintainer.
- **Tests:** 44 (10 new), each failing on 0.2.7.
- **Docs:** `README.md` (lists, brake), `docs/ARCHITECTURE.md` ("Safe to repeat", the user's rescue),
  `docs/DEPLOY.md` (the subscription's retry delay), `docs/INSTALL.md` (Troubleshooting).

## 0.2.7: The install goes on when Docker can't upload

In Cloud Shell, `docker push` to Artifact Registry can fail with `dial tcp …:443: connect: connection
refused` (a Cloud Shell network problem). `install.sh` stopped there, at step 6/9.

- **Cloud Build instead:** when Docker built the image but can't upload it, `install.sh` says so and
  builds it with Cloud Build, inside Google Cloud. Without Docker, it uses Cloud Build as before.
- **`spruce-build`:** a new service account with the Cloud Build Service Account role, created in step
  3/9. Cloud Build runs as it, not as the project's default build account, whose roles differ between
  projects (in newer organizations it may have none, and builds then fail).
  - The uploaded source and the build logs go to buckets in this project's `REGION`. In `us-east1`,
    `us-central1` and `us-west1` they are within Cloud Storage's free 5 GB.
- **A failed Docker build stops the install.** Before, a failed `docker build` was missed and the
  install went on to deploy an image that didn't exist.
- **Settings files with spaces:** `stop.sh`, `rollback.sh` and `upgrade.sh` read `PROJECT = x` and
  values with trailing spaces the way `install.sh` does. Before, `stop.sh` refused such a file.
- **Docs:** `docs/INSTALL.md` (Troubleshooting for this error and for Cloud Build; the Costs table),
  `docs/DEPLOY.md` (the fourth service account).
- **Checked** against a stand-in `gcloud` and `docker`: push refused (Cloud Build used, deploy goes
  on), push works (no Cloud Build), no Docker, `docker build` failing (stops), Cloud Build failing
  (stops with what to do). The real `gcloud` accepts the new build flags.

## 0.2.6: The installer keeps the bill at zero

Google requires a billing account for Cloud Run, Cloud Scheduler, Cloud Build and Artifact Registry,
even when nothing is charged. A pilot should stay within the free tier; the installer now makes sure
someone hears about it if it doesn't.

- **Billing check first:** `install.sh` stops at once, with what to do, when no billing account is
  linked. Before, it failed later, partway through.
- **Budget alert** (`BUDGET_ALERT`, 1 by default, in the billing account's currency; `off` for none).
  - A budget for this project only, emailing the billing account's admins at 1%, 50% and 100% of the
    amount: in practice, at the first charge.
  - It's created once and updated on later runs.
  - It needs the Billing Account Administrator or Costs Manager role. Without it, the installer explains
    and carries on.
- **Image cleanup:** Artifact Registry keeps only the newest 3 builds, within the free 0.5 GB.
  `deploy/rollback.sh` can still go back 2 builds.
- **Docs:** `docs/INSTALL.md` has a "Costs" section with the free allowances against a 50-mailbox
  pilot; `DEPLOY.md` lists `BUDGET_ALERT`.
- **Upgrades** add `BUDGET_ALERT=` (the default, 1) to older settings files.
- **Checked** against a stand-in `gcloud`: a new budget, an existing one updated, billing missing
  (stops), `off`, a bad value (stops), and a valid cleanup policy.

## 0.2.5: Upgrade and rollback scripts

- **`deploy/upgrade.sh`:** run it from the new version's unzipped folder in Cloud Shell.
  - It finds the previous version's `deploy/settings.env` in your home folder (or takes the old folder
    as an argument) and copies it.
  - Settings new in this version are added empty, which means their defaults, never the example's
    values.
  - Before changing anything, it shows the installed version (read from the worker's image) and the
    new one, the `CHANGELOG.md` headings in between, and the delegation scopes this version uses. It
    asks before going on, and warns when going to an older version.
  - It then runs `install.sh` in upgrade mode, which doesn't stop at the delegation step.
- **`deploy/rollback.sh`:** sends all traffic on both services back to the previous ready Cloud Run
  revision, with the settings it had. Nothing is rebuilt. Run it again to go back further.
- **`install.sh`:**
  - moves traffic to the new build after each deploy (`update-traffic --to-latest`), so it also undoes
    a rollback;
  - in upgrade mode, keeps a service stopped by `deploy/stop.sh` stopped.
- **Docs:** `docs/INSTALL.md` has an "Upgrading to a new version" section.
- **Checked** against a stand-in `gcloud`:
  - an upgrade from a 0.2.3 folder (settings found and completed, no pause, traffic to the new build);
  - an upgrade of a stopped service (it stays stopped);
  - a rollback (it skips a revision that never became ready).

## 0.2.4: The dashboard's admins can be a group

- **`ADMIN_GROUP`:** the members of a group may use the dashboard, as well as (or instead of) the
  addresses in `ADMIN_EMAILS`. At least one of the two must be set.
  - Identity-Aware Proxy still lets them in first (granted to `group:…`). Then the service asks Google
    whether the signed-in address is in the group (`groups.hasMember`, which counts groups inside it).
    It asks as `DIRECTORY_ADMIN`, with the group-member read scope the pilot group already uses.
  - Answers are remembered for 5 minutes ("no" for 1 minute, so someone just added gets in soon).
  - Only accounts in `ORG_DOMAINS` can get in through the group.
  - If the check fails, nobody gets in through the group: the answer is 503 with the reason.
  - A group Google doesn't know is an error, not a silent "no".
- **`deploy/install.sh`:**
  - takes `ADMIN_GROUP` (the template now uses it, with `ADMIN_EMAILS` optional);
  - grants IAP to the group;
  - gives the dashboard `DIRECTORY_ADMIN`;
  - refuses to run when neither is set.
- **Docs:** `docs/INSTALL.md` creates a second security group for the dashboard; `DEPLOY.md`,
  `PRIVACY.md` and `README.md` updated.
- **Tests:**
  - listed addresses, group members, outside accounts, a failed check, and the remembered answers
    (added and removed members);
  - `hasMember`'s request, and an unknown address versus an unknown group;
  - the configuration needs `DIRECTORY_ADMIN` with a group.

## 0.2.3: Install for a test, limited to a security group

- **`PILOT_GROUP`: watch the members of a security group** (or several, separated by semicolons).
  - Groups inside it count (`includeDerivedMembership`).
  - Only active user accounts in `ORG_DOMAINS` are watched: suspended accounts, outside addresses and
    group entries are skipped.
  - Members are read daily by `renew-watches`, as `DIRECTORY_ADMIN`, with only the
    `admin.directory.group.member.readonly` scope. Removed members stop being watched.
  - `PILOT_OU` and `PILOT_USERS` still work, alone or together with a group.
- **A failed read of the pilot's members stops nothing.** Before, the error stopped the renewal
  silently; now the dashboard's Recent activity names what to check.
- **`deploy/install.sh`: one script, run from Cloud Shell, for the whole Google Cloud side.**
  - It covers APIs, Firestore, the three service accounts (no keys), Pub/Sub, a single built image for
    both services, the worker, the dashboard with Identity-Aware Proxy, the push subscription, the daily
    jobs, and the first run.
  - It pauses for the domain-wide delegation entry and prints the client ID and exact scopes.
  - Settings come from `deploy/settings.env`, read as data, never run as shell. Safe to run again: it
    updates what exists.
- **`deploy/stop.sh`** stops every watch and pauses the renewal; `install.sh` starts it again.
- **`docs/INSTALL.md`:** step by step for a test limited to a security group, with the Admin console
  steps (group, read-only directory admin, delegation), a test email, and troubleshooting.
- **The Settings page** shows the pilot group.
- **`tools/release.js`** builds the install zip.
- **Tests:**
  - group members are watched, removed members are stopped, and a failed read stops nothing and says so;
  - the members request covers nested groups, pages, the scope, and skips suspended and outside
    accounts.
- **Checked:**
  - the installer, against a stand-in `gcloud`;
  - the image, built and run in both roles: the worker refuses an unsigned push, the dashboard refuses
    anyone without Identity-Aware Proxy.

## 0.2.2: Emails a user moves back out of Spam are recorded

- **A user who takes a moved email back to the Inbox** ("Not spam", or dragging it out of Spam) is now
  seen. Before, the email stayed in the Inbox but the dashboard still showed it as in Spam.
  - The mailbox history is read for the Inbox label added back as well as for new messages
    (`historyTypes` messageAdded and labelAdded).
  - The record becomes "released", marked as by the user (`releasedByUser`), and counts as a false
    alarm unless an admin marks it phishing.
  - The service never moves that email again.
  - An alert says who moved it back. When the rules had flagged it (score 5+), it asks an admin to make
    sure it's safe, since the user may be about to click it.
- **An admin's own release** is noted on the record before Gmail is changed, so its Inbox label isn't
  counted as the user's. A message judged in the same batch as its Inbox label is not a rescue either.
- **Dashboard:**
  - The overview splits moved-back emails into by admins and by users, and has a "Moved back by users"
    figure.
  - Model health has a "By users" column per trigger.
  - Messages show "Moved back by user" and "Moved back to the Inbox by the user". When the checks had
    flagged it (score 5+) and no admin has reviewed it, the box is amber and asks for a look; the
    verdict line says it counts as a false alarm only because the user moved it back.
  - In monitor mode, the "Moved" figure also shows how many were moved back, by admins and by users.
- **Demo and mockup:** one staff member moved the fake storage notice back, with its alert.
- **Tests:** a user rescue is recorded once with its alert; an admin's release (even when its
  notification arrives mid-release) and a same-batch label are not rescues; the history request asks
  for both kinds as repeated parameters.

## 0.2.1: Cloudflare only for threat lookups (Google Safe Browsing off by default)

- **Google Safe Browsing is off unless `SAFE_BROWSING=true`,** at the maintainer's request, to be on the
  safe side about its quota and terms.
  - The code stays, and turning it on needs its API key (`SAFE_BROWSING_KEY`).
  - By default no link address leaves the district: threat lookups send only host names, to Cloudflare
    Security DNS.
  - The worker no longer needs a Safe Browsing key to start.
  - While off, links aren't sent for that lookup at all, so they don't count as "not checked".
- **Unchanged:** the phishing lists (downloaded, matched locally) and site age (domain names to their
  registries).
- **Demo mode and the mockup** now match a real deployment: no Safe Browsing findings. The fake
  storage notice is still moved, by its failed sender check, hidden filler and brand-new domain.
- **Tests:**
  - By default nothing is sent to Safe Browsing, even with a key set.
  - Cloudflare still flags links.
  - Turning Safe Browsing on without a key is refused.

## 0.2.0: network checks (Cloudflare, Safe Browsing, phishing lists, site age)

- **Cloudflare Security DNS** for link sites (where a link goes, and its own host) and the sender's
  domain (`src/intel/threats.js`):
  - Only host names are sent.
  - A 0.0.0.0 answer is a block. A name the filter says doesn't exist is asked again of Cloudflare's
    unfiltered resolver: if that one answers, it was a block; if not, the domain doesn't exist.
- **Google Safe Browsing** (Lookup API v4) for the links:
  - Up to 500 per request.
  - The `#…` part is never sent, and one-time links (the extension's `isSingleUseToken`) go without
    their query string.
  - Needs `SAFE_BROWSING_KEY` (from Secret Manager); the worker refuses to start without it unless
    `SAFE_BROWSING=false`.
- **The extension's phishing lists** (OpenPhish, Phishing Army, Sefinek scam senders;
  `src/intel/feeds.js`):
  - Downloaded once a day for the whole district by a new Cloud Scheduler task (`/tasks/sync-feeds`),
    and checked as the extension checks them.
  - Kept gzipped in Firestore (in chunks), shared by every instance, and matched locally.
- **Site age** from each domain's registry (RDAP, via IANA's list; `src/intel/rdap.js`):
  - Up to 3 unfamiliar link domains per email, plus the sender's domain.
  - Answers kept 30 days for everyone; 4 seconds at most per lookup.
- **What they change** (`src/engine/network.js`):
  - A link any check flags is dangerous, so the extension's dangerous-links weight counts it.
  - Sender's address on the scam-sender list: 5. Sender's domain blocked or listed: 5. Domain doesn't
    exist: 3.
  - Sender's domain under 30 days old: 2; a look-alike under 90 days old: 5.
  - Young link sites: the extension's `linkAgeSigns` (3 or 2).
  - A failed or slow lookup leaves things "not checked", never "safe".
  - Allowlisted senders and the organization's own sites are not looked up.
- **Not looked up:** short links (no unshorten.me or other outside unshortening service). A short link
  is judged by its own host and by what decodes offline.
- **Request limits** (`src/intel/http.js`, from the extension): a few requests at a time per service,
  and back-off after "too many requests" or repeated server errors. Answers are remembered so a
  campaign's copies cost one lookup.
- **Dashboard:**
  - Each email shows what was looked up.
  - Settings shows which checks are on, plus each phishing list's size and last update.
  - New top-reason groups: "Sender on a threat list", "Brand-new site or domain", "Made-up sender domain".
- **Demo mode** uses made-up answers for these checks (no network), so the demo shows what they add.
- **Tests:**
  - Cloudflare blocks, NXDOMAIN and failures.
  - What Safe Browsing is sent (no fragments or one-time tokens), batching, and no key.
  - List syncing once a day, sanitizing (never a protected brand's domain or a cloud-storage host),
    matching, and keeping the previous copy.
  - Registry dates, sharing, and slow registries.
  - Their effect on verdicts, including that a dead network never makes an email safer.
- **Checked once against the real services** from the development machine (not Safe Browsing: no key
  there):
  - Cloudflare blocked its own malware test domain.
  - The three lists downloaded in 1.6 s (144,400 phishing sites).
  - Three registry lookups took 0.7 s.

## 0.1.0: first testing version

- **Worker:**
  - takes Gmail notifications through Pub/Sub and reads new Inbox messages (raw) through domain-wide
    delegation, without a key file;
  - judges them with the S.P.R.U.C.E+ extension's checks and phish-tiny model (extension 5.94.6,
    model 0.4.0; `vendor/spruce/`);
  - moves to Spam when the rules flag a message, or when the AI scores 85% or more for an outside sender.
- **Safety:**
  - monitor mode by default;
  - the AI score alone never moves inside mail;
  - allowlists;
  - a brake (moves per hour) that pauses moving until an admin resumes;
  - releases recorded with who did them.
- **Dashboard** behind Identity-Aware Proxy for `ADMIN_EMAILS`:
  - overview, campaigns, users, messages with each decision;
  - Release, Mark false alarm, Confirm phishing;
  - model health and settings.
  - Plain HTML, CSS and JavaScript, light and dark, works on a phone.
- **Records** in Firestore with no email bodies, deleted after 60 days. Daily jobs renew watches and
  delete old records; a task stops every watch.
- **Two Cloud Run services from one image** (`ROLE=worker`, `ROLE=admin`).
- **Demo mode** with an invented district: every record is judged by the real engine; it refuses Cloud
  Run. `tools/build-mockup.js` makes a one-file clickable mockup of the dashboard.
- **Tests:** engine, HTML reading, policy, pipeline (fake Gmail), brake, release, watches, retention,
  authorization of every route, and the dashboard API on the demo data.
- **Known:** `npm audit` reports 6 moderate advisories in dependencies of the Firestore client library
  (`minimatch` and `rimraf` used for file-path matching, not reachable with email content);
  `npm audit fix` can't resolve them without breaking changes.
