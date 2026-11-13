# Architecture

```
Gmail (each watched mailbox)
   │  users.watch → "this mailbox changed" (historyId)
   ▼
Pub/Sub topic gmail-spruce ──push (OIDC: spruce-invoker)──▶ spruce-worker (Cloud Run, ROLE=worker)
                                                               │ history.list → new Inbox message ids,
                                                               │   and the Inbox label added back (user rescues)
                                                               │ messages.get (raw)          ┐ as the mailbox's user:
                                                               │ engine: MIME → facts →       │ domain-wide delegation,
                                                               │   extension checks + model  │ token signed by IAM for
                                                               │ policy → move / record      │ spruce-delegate (no key)
                                                               │ messages.modify (Spam)      ┘
                                                               ▼
                                                           Firestore (records, counters, state)
                                                               ▲
Admins ──Identity-Aware Proxy──▶ spruce-admin (Cloud Run, ROLE=admin): dashboard + /api/*
                                   move back → messages.modify (Inbox)

Cloud Scheduler ──(OIDC)──▶ worker /tasks/renew-watches (daily; a watch lasts 7 days)
                           ──▶ worker /tasks/sync-feeds (hourly: the health check, the phishing lists
                                once a day for everyone, the cleanup of what TTL doesn't delete)

worker ──▶ security.cloudflare-dns.com    host names (blocked = 0.0.0.0)
       ··▶ safebrowsing.googleapis.com    OFF by default (Settings → Safe Browsing): link addresses, no #part;
                                          its API key in Secret Manager (spruce-safe-browsing-key)
       ──▶ registries (RDAP, via IANA)    domain names, at most once a month each
       ◀── Firestore blobs/feed_*         the phishing lists, gzipped, shared by every instance
```

## Why these choices

- **After delivery (Gmail API), not in the mail path.** Nothing in mail routing changes, so the service
  can't delay or lose mail. The cost is a few seconds in which a new email is visible before it's moved.
  Real admin quarantine needs an inbound gateway; Google offers no API that puts messages there.
- **Two services, one image.** Pub/Sub and Scheduler can't sign in through Identity-Aware Proxy. So the
  worker is private (only `spruce-invoker` may call it) and has no dashboard, and the dashboard has no
  worker routes. The dashboard's "Update group membership now" doesn't call the worker either: it asks
  Cloud Scheduler to run the daily `spruce-renew-watches` job at once (`src/scheduler.js`), which calls
  the worker as every day.
- **Updates from the dashboard, without giving it the right to deploy.** Settings → Update only records
  the request (a version and its exact commit) and runs the `spruce-update` job, whose build install.sh
  fixed. The build runs as `spruce-updater`, takes its steps from `google_service_main`, and checks
  everything again before building: a recent request, a commit on the release repository's main branch
  with that version, newer than what runs, and no higher `installLevel` than the one installed. So a
  dashboard admin, or someone who took over a dashboard session, can at most install an approved
  version that is newer, never their own code. A version that changes the installation (roles, jobs,
  settings) still needs `install.sh`, run by someone who can change the project.
- **The checks and the model, run as written for the browser.** `vendor/spruce/` began as the
  S.P.R.U.C.E+ extension's code; since 0.4.0 it is this project's own (changed here, with tests). It
  runs in a separate JavaScript context with a small stand-in for the browser, as the extension's own
  unit tests ran it.
- **No key files.** `spruce-run` asks IAM to sign each delegation token for `spruce-delegate`
  (`iamcredentials.signJwt`). Tokens last an hour and are kept in memory.
- **Safe to repeat.** Pub/Sub delivers at least once, and Gmail often sends several notifications for
  one email.
  - **One instance at a time judges a message.** It claims the message ID in Firestore first, and marks
    it done afterwards. A claim left by an instance that stopped is taken over after 5 minutes.
  - **A failed check is tried again, 3 times in all.** Until every message in a mailbox's notification is
    done, the mailbox's sync position stays where it was. The worker answers Pub/Sub with 503, and Pub/Sub
    delivers the notification again 30 s to 10 min later. After the third failed try the message is
    left where it is, with an alert, and the mailbox moves on.
  - **A move whose record failed isn't lost.** The next try sees the service's own `SPRUCE/Moved`
    label and writes the record without moving the email again.
  - **The sync position only moves forward,** whichever notification finishes last. History is read
    4,000 messages at a time; a longer backlog is read in parts, never skipped.
- **Brakes for a whole district** (`brakes` in `src/pipeline.js`). A move first passes:
  - **an admin's decision on the campaign** (a false alarm: not moved; confirmed: moved);
  - **the campaign pause**, for weak evidence only (no outside confirmation): past `CAMPAIGN_HOLD_AFTER`
    copies of one campaign, moving the rest pauses. Strong evidence never pauses;
  - **the domain-wide brake**, a last resort: a slot is reserved in the hour's count before each move, in
    up to 32 Firestore shards whose limits add up to the limit exactly.

  Copies not moved meanwhile stay in the Inbox like any other email, recorded as "would move" (`held` on
  the record), and can be moved later: on **Resume, and move those to Spam**, or when the campaign is
  confirmed (`moveHeld`). A single recorded email an admin confirms as phishing on Review (or its own
  page) is moved the same way (`moveRecord`), in enforce mode only and only while it is still in the
  Inbox: the service's rules never move a suspicious email, an admin's decision can. Nothing is ever
  withheld from a mailbox. The counters are spread so one busy
  campaign doesn't make every move wait for one Firestore document; the daily stats are spread too.
- **Alerts.** An alert is a problem the admins are emailed about (0.5.28). The service logs each one as a
  structured line (`spruceAlert`, `message`) and adds it to Activity → Alerts; Cloud Monitoring emails them,
  and any failed Cloud Scheduler job, to `ALERT_EMAIL` (log-based alert policies made by `deploy/install.sh`).
  They are: a phishing list that missed its download; Cloudflare Security or Safe Browsing whose every
  lookup failed for 30 minutes, or Google refusing the Safe Browsing key; the AI model not working in the
  worker; Gmail refusing the service (domain-wide delegation removed), an email left unchecked after three
  tries, or 25 errors in an hour (0.5.29); an admin's account locked after five wrong project IDs (0.5.29); no notification from Gmail for `QUIET_HOURS`, or watches about to end; the directory not readable;
  the brake; a campaign whose moving paused, a large campaign, a mass share from one outside account; a
  user taking a flagged email out of Spam or into the Inbox; an update from the dashboard that failed or
  never finished; an approved version that needs a manual install. A problem that lasts is emailed at most
  once a day. An admin's own change (a policy change, an update started, a Safe Browsing key) is not an
  alert: it is noted in Activity → What admins did, and not emailed. With `PUBSUB_BACKLOG_ALERT=on` (off by
  default: Google charges for it), Cloud Monitoring also emails when Gmail's notifications wait in Pub/Sub over
  30 minutes.
- **Audit trail (0.5.29).** Activity is kept `AUDIT_DAYS` (a year by default), apart from the email records;
  admins' downloads of the email list or of Activity, and their first visit to the dashboard each day, are
  noted too. `GET /api/activity` takes any period kept, a kind and words to look for; `/api/activity.csv`
  downloads it (noted). With `AUDIT_LOG=on` (off by default) each entry is also a structured log line
  (`spruceAudit`), which a sink routes to the log bucket `spruce-audit`, kept `AUDIT_LOG_DAYS`. The hourly `spruce-sync-feeds` job runs a
  health check: no notification from Gmail for `QUIET_HOURS`, or watches about to end. It also downloads
  the phishing lists once a day, and a list whose download failed again 3 hours later
  (`state/feedHealth` keeps each list's last download); a list that newly fails, and once a day one that
  keeps failing, is an alert (`list-download`), on Overview until it downloads again, and on Settings →
  About, whose Re-check (`POST /api/lists/recheck`) downloads it at once.
- **Mail that skipped the checks.** An email the user moves into the Inbox that the service never
  checked (it went to Spam first) is checked when its Inbox label shows in the history, and never moved.
  After a gap in a mailbox's history, its Inbox since the last notification is checked in batches of 25
  with the next notifications.
- **The weekly summary** (`src/digest.js`; off until an admin turns it on in Settings → Weekly summary) is put straight into
  each admin's Inbox with the Gmail API's `messages.insert`, which the `gmail.modify` scope already allows.
  Nothing is sent, nothing leaves Google, and no mailbox or new permission is needed. The hourly job sends
  it on Monday from 7 AM in `TIME_ZONE`, once a week whichever instance runs. The service never judges its
  own summary: it is marked as seen, and has the `X-SPRUCE-Summary` header with no `Received:` header,
  which mail from outside always has.
- **The retraining export** (`src/training.js`; off until an admin allows it in Settings → Retraining). The emails an
  admin marked are read from Gmail when an admin downloads them: one per campaign, the newest copy still
  in a mailbox. Each is judged again as on arrival, with `analyze(..., { keepAiFacts: true })`, to get
  what the model read. It is then written in the model's training format (`{ name, label, note, facts }`,
  as in TinyPhishLLM_Private_Training's `training/data/extra/`), with the people taken out:
  - the headers' names (`mime.readMessage`'s `people`);
  - titles, greetings and sign-offs;
  - the organization's domains;
  - the model's own redaction (`redactForAi`, `maskRecipient` from `vendor/spruce/ai.js`).

  Other possible names are marked ⟦like this⟧: common names (`src/names.js`) and words the model's
  vocabulary doesn't have, when they start a sentence; most capitalized words in the middle of one.
  Nothing is stored or counted. `tools/check-training-file.js` refuses a file with leftovers, and
  `docs/RETRAINING.md` covers the rest.
- **The policy, changed on the dashboard** (Settings → Policy, Settings → Allowlist).
  - **Which settings:** `MODE`, `AI_MOVE_THRESHOLD`, `AI_SUSPICIOUS_THRESHOLD`, `BRAKE_PER_HOUR`,
    `TIME_ZONE`, `ALLOW_DOMAINS`, `ALLOW_ADDRESSES` and `RETENTION_DAYS`, kept in Firestore as
    `state/policy-<key>`. Each document's expiry date (`expireAt`) is computed from the retention in
    force when it is written. The
    suspicious line is checked against the move threshold both ways (`policyValue`).
  - **How they apply:** in `loadConfig` these four are live values; everything else is frozen.
    `Service.refreshPolicy` reads them at least every 30 s (on each notification, each job, each
    dashboard request). Every check reads them when it runs, so a change applies everywhere within
    30 s.
  - **Settings.env:** a change records the settings.env value it replaced. If settings.env later has
    another value, that one is newer and applies.
  - **The installer:** `deploy/dashboard-policy.sh` (used by `install.sh`) takes the dashboard's value
    where settings.env is silent and asks which to keep where they differ. It writes the answer into
    settings.env, removes the dashboard's copy once the new build is deployed, and notes it in
    Activity.
  - **The server** checks the project ID against `GOOGLE_CLOUD_PROJECT`, and the agreement for enforce
    mode.
- **The dashboard reads little.** It keeps a copy of the records (`src/dashboard/cache.js`). After one full
  read, it asks only for records changed since (each record has `updatedAt`), at most every 15 s, however
  many dashboards are open.
- **Lookups that never block mail.** Every lookup has its own time limit and limits on requests at once,
  and answers are remembered (6 hours to a day; registry dates 30 days, shared). One that fails or is
  slow leaves the email "not checked". The verdict can only get stronger from a lookup, never weaker.
- **The user has the last word.** When a user takes a moved email back to the Inbox ("Not spam", or
  dragging it out of Spam), the history shows the Inbox label added back.
  - The record becomes "moved back by the user" and counts as a false alarm until an admin marks it
    otherwise. The service never moves that email again.
  - Only a label added after the service read the email counts. The label an email arrived with can show
    in the same history, and the two are told apart by their history IDs.
  - An admin's own move back is noted on the record first, so it isn't counted as the user's.
- **Records only for what matters.** Clean mail is counted per day, not recorded, which keeps Firestore
  small and private.

## Platform notifications and outside shares

A share or notification that a platform sends for a person (Google Classroom, Drive, Docs, Forms, Calendar;
DocuSign; Dropbox; Adobe Acrobat Sign; SharePoint) carries the platform's address and passes the
platform's sender check, whoever the person is. `src/engine/notifications.js` recognizes one only when
Gmail's DMARC check passed for the platform's own domain and the sender is a notification mailbox, then
judges it by the person's own address: the Reply-To the platform set, or the "Name (address)" in its text
(none for Classroom: unknown). An outside share (such a notification for a person outside, or an outside
email linking a document, form or signature request) gets the colleague-name, sign-in and mass-share checks;
`pipeline.js` counts each outside account's reach per hour (`store.shareReach`) and alerts at 10.

## Throughput

The model doesn't read mail from inside the organization (your domains, DMARC passing) unless
`AI_SCANS_INSIDE` (Settings → Policy) is on, or `AI_MOVES_INSIDE` ("AI alone moves inside mail", which
needs it): the rules alone judge it (`src/engine/analyze.js`). The model reads English only: `src/engine/language.js` finds an email clearly in another language (its
writing system, or the commonest words of other languages), and then the model isn't run and the AI
gives no score, saying why (the rules run as always).

The model runs in ONNX Runtime (`src/engine/model.js`, from `models/phish-tiny/model.onnx`): about 6 ms
for a full-length pass on one Cloud Run CPU, one thread, at the "basic" graph optimization level (the
higher levels turn the 8-bit weights into 8-bit arithmetic, which changes the answers). An email's
explanation passes (its sentences) run as one batch. All of an email takes about 10 ms of processor time
on average; the rest is waiting for Gmail and Firestore. So each worker instance takes 32 requests at a
time (`--concurrency=32`) and checks at most 12 emails at once, 2 of them large (over 4 MB): about 28
emails a second per instance, measured with realistic delays. A district of 10,000 mailboxes (about
100,000 emails a day) needs one instance outside campaigns.

Gmail API quota is per user and per project. Every call names its user (`quotaUser`), so a busy
mailbox can't use up everyone's quota.
