# What it costs

What S.P.R.U.C.E Mail Protection Service (0.5.0) costs to run in your own Google Cloud project, by district
size. These are estimates at Google's list prices as checked in November 2026 (US dollars, before tax).
Check them against Google's pricing pages before you budget. How the numbers were measured is in
`docs/SCALING.md`.

## In short

| Mailboxes | Emails a day | A month in `us-central1` | A month in `us-east1` | Per mailbox per year |
|---|---|---|---|---|
| A pilot (a few dozen) | a few hundred | $0 | $0 | $0 |
| 500 | 5,000 | $0 | $0 | $0 |
| 2,000 | 20,000 | about $4 | about $6 | 2–4 cents |
| 5,000 | 50,000 | about $16 | about $22 | 4–5 cents |
| 10,000 | 100,000 | about $50 | about $65 | 6–8 cents |

Up to about 500 mailboxes it stays within Google's free monthly allowances. Google still requires a
billing account on the project, even when nothing is charged. The installer sets a budget alert
(`BUDGET_ALERT`, 1 by default) that emails the billing admins as soon as anything is charged.

## Where the money goes

A month, at each size (`us-central1` / `us-east1` where the region matters):

| Mailboxes | Firestore reads, writes and deletes | Firestore storage | Cloud Run: the worker | Cloud Run: the dashboard always on | Everything else | Total |
|---|---|---|---|---|---|---|
| 500 | $0 | $0 | $0 | no | $0 | **$0** |
| 2,000 | about $2 / $4 | $0 | about $2 | no | $0 | **about $4 / $6** |
| 5,000 | about $6 / $12 | under $0.25 | about $10 | no | $0 | **about $16 / $22** |
| 10,000 | about $15 / $30 | about $0.45 / $0.55 | about $21 | about $13 | about $0.35 | **about $50 / $65** |

- **Firestore reads, writes and deletes.** Per email: about 3 reads and 3 writes for the notification
  that brings it, 1 read for each of the two later notifications that bring nothing new (it was read,
  then archived), and about 1 delete when its marker expires. At 10,000 mailboxes that is about 500,000
  reads, 300,000 writes and 100,000 deletes a day.
- **Firestore storage.** The records of flagged emails, and a small marker for every email checked, kept
  for the retention period (35 days by default), with their indexes: about 4 GiB at 10,000 mailboxes
  (estimated from Firestore's storage-size rules, not measured). The first GiB is free.
- **Cloud Run: the worker.** It checks the mail. Cloud Run bills an instance for all the time it has a
  request open, and most of that time is spent waiting for Gmail and Firestore, not computing: about 0.9
  million instance-seconds a month at 10,000 mailboxes, one instance busy most of the school day. It
  costs the same in every US region.
- **Cloud Run: the dashboard always on.** From 10,000 watched mailboxes, one dashboard instance is kept
  running (`--min-instances=1`): about $13 a month for 1 vCPU and 1 GiB while idle. Its pages open at once,
  and it doesn't read the last 32 days of records again (about 96,000 reads) each time it is opened after
  going idle. A dashboard opened 5–10 times a day would spend $4–9 a month on those reads in `us-central1`
  ($9–17 in `us-east1`), so the always-on instance pays for part of itself. Below 10,000 mailboxes, the
  dashboard starts when opened and stops after, at no cost.
- **Everything else**, at 10,000 mailboxes: Pub/Sub about $0.30 (Gmail's notifications, above the free
  10 GiB a month), image storage and network a few cents. Cloud Logging, Cloud Scheduler, Cloud Build and
  the Gmail API stay within their free amounts (the Gmail API has no charge, only quotas).

## What changes the bill

- **The region.** Firestore in `us-east1` costs twice what it does in `us-central1` or `us-west1`, the
  only US region that does. The region is chosen at install and can't be changed later: a district
  moving out of `us-east1` installs again in a new project.
- **The dashboard always on** (from 10,000 watched mailboxes): about $13 a month. Without it, a
  10,000-mailbox district pays about $37 / $52.
- **How long records are kept** (Settings → Policy, or `RETENTION_DAYS`). At 10,000 mailboxes, roughly:
  35 days, about 4 GiB stored ($0.45 / $0.55 a month); 90 days, about 10 GiB ($1.40 / $1.60); a year,
  about 40 GiB ($6 / $7). Most of that is the markers of checked emails, not the records.
- **Campaigns.** A phishing email to every mailbox is checked within a minute or two by extra worker
  instances, at most 30 (`WORKER_MAX_INSTANCES`, which caps what a burst can cost): cents, not dollars.
- **Dashboard pages left open** refresh every 30 seconds. They read little (counts and the dashboard's
  own copy of the records), but close them when you're done.

## Free allowances it relies on

| Service | Free | Notes |
|---|---|---|
| Firestore | 50,000 reads, 20,000 writes and 20,000 deletes a day; 1 GiB stored | the deletes Firestore makes itself when documents expire (TTL) have no free amount ($0.01 / $0.02 per 100,000) |
| Cloud Run (request-based billing) | 180,000 vCPU-seconds, 360,000 GiB-seconds and 2 million requests a month | per billing account: other projects on it share them |
| Cloud Scheduler | 3 jobs | per billing account; the service uses 3, so other projects' jobs would be $0.10 a month each |
| Pub/Sub | 10 GiB a month | |
| Cloud Logging | 50 GiB a month | |
| Artifact Registry | 0.5 GB | the installer keeps only the newest 3 builds |
| Cloud Build | 2,500 build-minutes a month | used by Settings → Update, and by the installer when Docker can't upload |

## Prices used

- **Firestore** (Standard edition): `us-central1` $0.03 per 100,000 reads, $0.09 per 100,000 writes,
  $0.01 per 100,000 deletes, $0.15 per GiB a month; `us-east1` $0.06, $0.18, $0.02 and $0.18. The other
  US regions: `docs/SCALING.md`.
- **Cloud Run** (request-based billing, the same in every US region): $0.000024 per vCPU-second and
  $0.0000025 per GiB-second while an instance has a request; an idle minimum instance $0.0000025 per
  vCPU-second and per GiB-second; $0.40 per million requests.
- **Cloud Scheduler:** $0.10 per job a month after the free 3.

## What the estimates assume

- About 10 emails a mailbox a day, every day, and three Gmail notifications per email (it arrives, it is
  read, it is archived); 80% of the day's mail from 7 AM to 5 PM; about 3 in 100 emails recorded (flagged
  or suspicious).
- Records kept 35 days (the default).
- The service's own code ran on made-up mail in a simulation, with Gmail and Firestore as stand-ins that
  wait as long as the real ones roughly take. It was not a load test on Google Cloud. Real mail volumes,
  how often staff open and archive mail, and Cloud Run's processor speed can move the numbers either way.
- Not included: Google Workspace licenses, and the time of the people who run it.

Estimates before 0.5.0 counted only Cloud Run's processor time, not the time instances wait for Gmail,
and were too low (about $14 a month for Cloud Run at 10,000 mailboxes, where it is about $21–26).

## Checking the real bill

- **Billing → Reports** in the Google Cloud console, filtered to the project, grouped by service (or by
  SKU for the detail).
- **The budget alert** emails the billing admins at the first charge, then at half and all of
  `BUDGET_ALERT`. It warns; it doesn't stop the service.
