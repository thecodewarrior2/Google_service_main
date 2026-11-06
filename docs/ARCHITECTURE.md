# Architecture

```
Gmail (each watched mailbox)
   │  users.watch → "this mailbox changed" (historyId)
   ▼
Pub/Sub topic gmail-spruce ──push (OIDC: spruce-invoker)──▶ spruce-worker (Cloud Run, ROLE=worker)
                                                               │ history.list → new Inbox message ids
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
```

## Why these choices

- **After delivery (Gmail API), not in the mail path.** Nothing in mail routing changes, so the service
  can't delay or lose mail. The cost is a few seconds in which a new email is visible before it's moved.
  Real admin quarantine needs an inbound gateway; Google offers no API that puts messages there.
- **Two services, one image.** Pub/Sub and Scheduler can't sign in through Identity-Aware Proxy. So the
  worker is private (only `spruce-invoker` may call it) and has no dashboard, and the dashboard has no
  worker routes.
- **The extension's own code.** `vendor/spruce/` is copied unchanged and run in a separate JavaScript
  context with a small stand-in for the browser, as the extension's own unit tests run it. Both judge
  an email the same way. A fix in the extension reaches the service with `tools/sync-engine.js`.
- **No key files.** `spruce-run` asks IAM to sign each delegation token for `spruce-delegate`
  (`iamcredentials.signJwt`). Tokens last an hour and are kept in memory.
- **Safe to repeat.** Pub/Sub delivers at least once. Each message ID is marked as seen before it's
  judged, and a mailbox's sync position only moves forward.
- **Records only for what matters.** Clean mail is counted per day, not recorded, which keeps Firestore
  small and private.

## Throughput

The model takes 50–300 ms per email in plain JavaScript on one Cloud Run CPU, and the rest is Gmail API
time. With `--concurrency=8`, Cloud Run adds instances as notifications arrive. A district of a few
thousand mailboxes (about 100,000 emails a day, peaks of maybe 20 a second) fits a handful of
instances.

Gmail API quota is per user and per project. Every call names its user (`quotaUser`), so a busy
mailbox can't use up everyone's quota.
