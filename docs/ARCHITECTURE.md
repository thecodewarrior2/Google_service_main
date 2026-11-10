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
                           ──▶ worker /tasks/purge (daily; RETENTION_DAYS)
                           ──▶ worker /tasks/sync-feeds (daily; the phishing lists, for everyone)

worker ──▶ security.cloudflare-dns.com    host names (blocked = 0.0.0.0)
       ··▶ safebrowsing.googleapis.com    OFF by default (SAFE_BROWSING=true): link addresses, no #part
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
- **The extension's own code.** `vendor/spruce/` is copied unchanged and run in a separate JavaScript
  context with a small stand-in for the browser, as the extension's own unit tests run it. Both judge
  an email the same way. A fix in the extension reaches the service with `tools/sync-engine.js`.
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
- **Alerts.** The service logs each alert as a structured line (`spruceAlert`, `message`) and adds it to
  Recent activity. Cloud Monitoring emails them, and any failed Cloud Scheduler job, to `ALERT_EMAIL`
  (log-based alert policies made by `deploy/install.sh`). The hourly `spruce-sync-feeds` job runs a
  health check: no notification from Gmail for `QUIET_HOURS`, or watches about to end.
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
  what the model read. It is then written in the extension's training format (`{ name, label, note, facts }`,
  as in `tools/ai/data/extra/`), with the people taken out:
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
    `TIME_ZONE`, `ALLOW_DOMAINS` and `ALLOW_ADDRESSES`, kept in Firestore as `state/policy-<key>`. The
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

## Throughput

The model takes 50–300 ms per email in plain JavaScript on one Cloud Run CPU, and the rest is Gmail API
time. With `--concurrency=8`, Cloud Run adds instances as notifications arrive. A district of a few
thousand mailboxes (about 100,000 emails a day, peaks of maybe 20 a second) fits a handful of
instances.

Gmail API quota is per user and per project. Every call names its user (`quotaUser`), so a busy
mailbox can't use up everyone's quota.
