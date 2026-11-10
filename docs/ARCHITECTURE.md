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
                                   release → messages.modify (Inbox)

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
  - **an admin's decision on the campaign** (released: not moved; confirmed: moved);
  - **the campaign hold**, for weak evidence only (no outside confirmation): past `CAMPAIGN_HOLD_AFTER`
    copies of one campaign, the rest wait. Strong evidence is never held;
  - **the domain-wide brake**, a last resort: a slot is reserved in the hour's count before each move, in
    up to 32 Firestore shards whose limits add up to the limit exactly.

  Held copies stay in the Inbox, recorded as "would move", and can be moved later: on **Resume and move
  held mail**, or when the campaign is confirmed (`moveHeld`). The counters are spread so one busy
  campaign doesn't make every move wait for one Firestore document; the daily stats are spread too.
- **Alerts.** The service logs each alert as a structured line (`spruceAlert`, `message`) and adds it to
  Recent activity. Cloud Monitoring emails them, and any failed Cloud Scheduler job, to `ALERT_EMAIL`
  (log-based alert policies made by `deploy/install.sh`). The hourly `spruce-sync-feeds` job runs a
  health check: no notification from Gmail for `QUIET_HOURS`, or watches about to end.
- **Mail that skipped the checks.** An email the user moves into the Inbox that the service never
  checked (it went to Spam first) is checked when its Inbox label shows in the history, and never moved.
  After a gap in a mailbox's history, its Inbox since the last notification is checked in batches of 25
  with the next notifications.
- **The weekly summary** (`src/digest.js`; off until an admin turns it on in Settings) is put straight into
  each admin's Inbox with the Gmail API's `messages.insert`, which the `gmail.modify` scope already allows.
  Nothing is sent, nothing leaves Google, and no mailbox or new permission is needed. The hourly job sends
  it on Monday from 7 AM in `TIME_ZONE`, once a week whichever instance runs. The service never judges its
  own summary: it is marked as seen, and has the `X-SPRUCE-Summary` header with no `Received:` header,
  which mail from outside always has.
- **The dashboard reads little.** It keeps a copy of the records (`src/dashboard/cache.js`). After one full
  read, it asks only for records changed since (each record has `updatedAt`), at most every 15 s, however
  many dashboards are open.
- **Lookups that never block mail.** Every lookup has its own time limit and limits on requests at once,
  and answers are remembered (6 hours to a day; registry dates 30 days, shared). One that fails or is
  slow leaves the email "not checked". The verdict can only get stronger from a lookup, never weaker.
- **The user has the last word.** When a user takes a moved email back to the Inbox ("Not spam", or
  dragging it out of Spam), the history shows the Inbox label added back.
  - The record becomes "released by the user" and counts as a false alarm until an admin marks it
    otherwise. The service never moves that email again.
  - Only a label added after the service read the email counts. The label an email arrived with can show
    in the same history, and the two are told apart by their history IDs.
  - An admin's own release is noted on the record first, so it isn't counted as the user's.
- **Records only for what matters.** Clean mail is counted per day, not recorded, which keeps Firestore
  small and private.

## Throughput

The model takes 50–300 ms per email in plain JavaScript on one Cloud Run CPU, and the rest is Gmail API
time. With `--concurrency=8`, Cloud Run adds instances as notifications arrive. A district of a few
thousand mailboxes (about 100,000 emails a day, peaks of maybe 20 a second) fits a handful of
instances.

Gmail API quota is per user and per project. Every call names its user (`quotaUser`), so a busy
mailbox can't use up everyone's quota.
