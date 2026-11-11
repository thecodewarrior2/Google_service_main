# Scaling: 10,000 mailboxes, 100,000 emails a day

What a district of that size asks of the service, what 0.4.0 and 0.5.0 changed for it, and the plan for
the rest.
Every number here was measured with the service's own code on made-up mail, or comes from Google's
documentation (sources at the end). Prices are list prices to check against the pricing pages.

## How it was measured

A simulation ran the real code: the MIME and HTML reading, the checks, the AI model, notification
handling, the claims and brakes, the watch renewal and the dashboard's pages. Only Gmail, Firestore and
the network lookups were stand-ins, which count every call (Gmail in quota units, Firestore in reads and
writes) and wait as long as the real ones roughly take (Gmail 60–150 ms, Firestore 8–25 ms). The mail
was a made-up district's: staff mail, newsletters, notices, attachments, and the demo's phishing and
suspicious campaigns (`maple-schools.example`). It ran on a 2.1 GHz Xeon, about one Cloud Run vCPU.

**Not measured, so assumed:** how many notifications one email causes (taken as three: it arrives, it
is read, it is archived), the busiest hour (15% of the day), Firestore under real contention, and Cloud
Run's processor speed. A load test on a spare project is what settles them (below).

## Before and after

| | 0.3.12 | 0.4.0 |
|---|---|---|
| Watch renewal, 10,000 mailboxes | one at a time: 26.6 minutes, cut off at 120 s, so about 700 renewed a day; the others stop being checked within 7 days | 10 at a time, within 95 s: about 5,800 a run, the oldest first, so each mailbox every two days or so |
| Processor time per email (the made-up mix) | 217 ms (95th percentile 391 ms) | 97 ms (199 ms) |
| A newsletter the model scores 50% or more | 1.10 s | 0.51 s |
| One model pass, 256 / 32 tokens | 289 / 30 ms | 146 / 17 ms, the same answers to the bit (3,230 passes compared) |
| Identical copies of a campaign | every copy computed | one pass per instance (answers remembered by a hash of the input, in memory) |
| One worker instance (8 at a time, realistic delays) | 2.8 emails/s, 0.84 s each | 4.8 emails/s, 0.51 s each |
| Firestore per email | 8.4 reads, 5.3 writes, 3 transactions | 4.6 reads, 4.3 writes in the simulation; about 3.5 and 3.3 on Firestore (estimated: claims and new senders are created without a read, the counters added up) |
| Firestore per notification without new mail | 3 reads, 2 writes | 2 reads, 1 write |
| A campaign to all 10,000 mailboxes | 5,000 writes to its one campaign document, 10,000 transactions on its sender's | 59 and 10; the day's counters written once per instance every 5 s |
| Dashboard, 3,000 recorded emails a day (180,000 records) | 30-day Overview counted 20,000 of 90,000; ~300 MB for 50,000 records | every record counted; 169 MB for all 180,000; pages 30–350 ms |
| Old documents (~100,000 a day) | a daily job with 120 s to delete them, borderline | Firestore deletes them itself (TTL policies); the job only takes older ones, within 90 s |
| Worker limit | 10 instances | 30 (`WORKER_MAX_INSTANCES`), gen2, startup CPU boost |

**0.5.0** (the native engine, 32 at a time; the same simulation, the same made-up mail):

| | 0.4.1 | 0.5.0 |
|---|---|---|
| One model pass, full length (256 tokens) | 146 ms (JavaScript) | about 6 ms (ONNX Runtime, one thread) |
| An email's explanation passes (26 sentences) | one by one | one batch: 23 ms instead of 46 ms |
| Processor time per email (the made-up mix) | 97 ms (95th percentile 199 ms) | 9.5 ms (23 ms) |
| One worker instance, realistic delays | 4.8 emails/s at 8 at a time | 7.7 emails/s at 8; 28 emails/s at 32 (the processor 40% busy; half the emails checked within 0.31 s, 95% within 0.52 s) |
| Emails downloaded and checked at once, per instance | up to 8 (the requests) | at most 12, and only 2 of them over 4 MB (the rest wait their turn), so large attachments can't fill the worker's 1 GiB |
| The answers | | the same: 400 made-up inputs, largest difference 8.8e-6 in the margin, none on the other side of 50%, 65% or 90% |
| The image | | ONNX Runtime for Linux x64 only: 47 MB (the package is 294 MB with the other systems') |
| The dashboard when it starts | reads the retention period's records (60 days by default) | reads the last 32 days; older ones when a page shows them (Last 90 days), forgotten again after an hour without |
| How long records are kept | 60 days, in settings.env | 35 days by default, also in Settings → Policy |

**At 100,000 emails a day** (estimates from the numbers above):
- **Processor time:** about 1,000 vCPU-seconds a day with 0.5.0 (10,000–20,000 with 0.4.0). One
  instance handles the busiest hour (about 15,000 emails, 4 a second, against 28 a second it can take);
  a campaign to every mailbox is checked within a minute or two, as Cloud Run adds instances (up to 30).
- **Gmail API:** about 67 units per email and 2 per notification, about 8 million a day: a tenth of the
  80 million below which there is no charge, and a tenth of the 1.2 million a minute in a campaign.
- **Cost:** below ("What it costs"). Pub/Sub, Scheduler and the Gmail API: next to nothing.

## What it costs (0.5.0)

Estimates, at about 10 emails a mailbox a day, three notifications an email, with Google's free
allowances (Firestore: 50,000 reads, 20,000 writes and 20,000 deletes a day; Cloud Run: 180,000
vCPU-seconds, 360,000 GiB-seconds and 2 million requests a month; Cloud Scheduler: 3 jobs):

| Mailboxes | Emails a day | Firestore, `us-central1` | Firestore, `us-east1` | Cloud Run, worker | Dashboard always on | About a month |
|---|---|---|---|---|---|---|
| 500 | 5,000 | $0 | $0 | $0 | no | **$0** |
| 2,000 | 20,000 | about $2 | about $4 | about $2 | no | **$4–6** |
| 5,000 | 50,000 | about $6 | about $12 | about $10 | no | **$16–22** |
| 10,000 | 100,000 | about $15 | about $30 | about $21 | about $13 | **$49–64** |

**Cloud Run, counted again.** Cloud Run bills an instance for all the time it has at least one request
open, waiting for Gmail and Firestore included, not only its processor time. The estimates before 0.5.0
counted processor time, and were too low: about $14 at 10,000 mailboxes for 0.4.0, where a simulation
of the billing (notifications arriving at random over a school day, 80% of them from 7 AM to 5 PM, an
instance billed while it has a request, in 100 ms steps) gives about $26 for 0.4.1 and $21 for 0.5.0
(about 0.9 million instance-seconds a month: one instance busy most of the school day). Checking 32 at
a time lowers the bill less than the processor time suggests, because outside campaigns one instance
was enough already, and it is billed while it waits. (At 5,000 mailboxes: $14 and $10; at 2,000: $4 and
$2.)

**The dashboard always on** (from 10,000 watched mailboxes): an idle minimum instance is billed at
$0.0000025 a vCPU-second and a GiB-second, about $13 a month for 1 vCPU and 1 GiB. It saves the start-up
read of the last 32 days of records (about 96,000 reads, $0.03 in `us-central1`, $0.06 in `us-east1`)
each time a dashboard that went idle is opened again, so a dashboard opened 5–10 times a day pays back
$4–9 of it in `us-central1` ($9–17 in `us-east1`), and its pages open at once.

**Per email** after 0.5.0: about 3 Firestore reads and 3 writes for the email's own notification, 1
read for each notification that brings nothing new (2 an email), about 1 delete when it expires;
about 10 ms of processor time; 67 Gmail quota units (free below 80 million a day).

**Prices checked on Google's pricing page** (Firestore Standard edition, per 100,000): `us-east1`
reads $0.06, writes $0.18, deletes $0.02; `us-central1`, `us-west1`, `us-east5`, `us-west8` $0.03,
$0.09, $0.01; the other US regions $0.033–0.036, $0.099–0.108, $0.011–0.012. `us-east1` is the only US
region at twice the price.

**What 0.4.1 changed for cost:**
- **The dashboard no longer reads every mailbox** for Status, Readiness and Settings (each refreshes
  every 30 s while open): a count and one read instead, kept a minute. At 10,000 mailboxes, a Status
  page left open all day read about 29 million documents (about $17 a day in `us-east1`); now about
  17,000 (the counts cost one read per 1,000 mailboxes).
- **The hourly health check** counts instead of reading every mailbox (240,000 reads a day at 10,000
  mailboxes).
- **A notification that brings nothing new writes nothing** for up to 30 minutes (two thirds of
  notifications; about 200,000 writes and 200,000 reads a day at 10,000 mailboxes).
- **Three scheduled jobs, not four:** the cleanup runs with the hourly job, so the installation keeps to
  Cloud Scheduler's 3 free jobs per billing account.
- **The example region is `us-central1`.**

**More to save, not done (each with a trade-off):**
- **Region:** an installation in `us-east1` halves Firestore by moving to a new project in another
  region (a new installation; Firestore can't move).
- **Dashboard rollups** (plan, item 2): no read of the last 32 days of records when an idle dashboard
  is opened again (about 96,000 reads at 10,000 mailboxes), and no always-on dashboard needed for it.
- (Done in 0.5.0: the worker 32 at a time with a limit on large emails, the model run natively, the
  dashboard reading 32 days at start, and records kept 35 days by default.)
- **One write per email instead of two** for its "checked" marker (claimed, then done): possible, but
  the claim is what keeps two instances from judging one email at once; not worth the risk for about
  $3–5 a month at 10,000 mailboxes.

## What 0.4.0 changed

- **Watch renewal** (`renewWatches`): 10 at a time, stopping after 95 s, the mailboxes renewed longest
  ago (and new members) first, one renewed in the last 12 hours left for the next run, the mailboxes'
  state read once instead of once each. The automatic brake counts every mailbox still watched.
- **The AI model** (`vendor/spruce/ai.js`, this project's own code now): the linear layers compute two
  tokens and four outputs per sweep, attention four positions at a time, GELU without a function call per
  value. Each sum is added up in the same order as before, so the answers are identical. Each instance
  remembers the answer of a pass by a SHA-256 hash of its input (the most recent 50,000): campaign copies
  and shared sentences (greetings, footers) cost one pass.
- **Firestore:**
  - a mailbox's document read once per notification, and its "last notification" time written with its
    sync position (one write);
  - a message's claim and a new sender's first-seen time created with `create()` (no read, no lock);
  - when the service was installed, and when each sender was first seen, remembered per instance;
  - a campaign's move counter stops at its alert (50 moves); the day's counters added up per instance and
    written every 5 seconds (and when the instance stops), in 30 shards;
  - domain ages remembered per instance for 6 hours;
  - a campaign's records queried by campaign, not looked for among the newest 20,000.
- **Retention:** `expireAt` on what expires, and Firestore TTL policies (`deploy/install.sh`) that delete
  them; the cleanup job is the fallback, within 90 s a run.
- **The dashboard:** every record of the period, as slim copies with shared strings; no copy of the
  records per page; past days' counters read once.
- **Tokens:** calls for the same mailbox's token at once share one request.
- **Cloud Run and Pub/Sub:** the worker up to 30 instances, gen2, startup CPU boost; the dashboard 1 GiB;
  Pub/Sub retries after 10 s instead of 30.

## The plan for the rest, most useful first

1. ~~**Run the model natively.**~~ Done in 0.5.0 (ONNX Runtime, measured above): about 10 ms of
   processor time per email, 28 emails a second per instance, one instance for the district outside
   campaigns. The JavaScript pass was removed; its answers stay in the tests
   (`test/fixtures/model-reference.json`), and `tools/export-onnx.py` computes a new model's on its own
   (numpy, from `model.bin`).
2. **Dashboard rollups instead of every record in memory.** Today the dashboard reads every record of the
   last 32 days when it starts (since 0.5.0; about 96,000 reads, perhaps 10–20 seconds, at 3,000 a
   day), older ones when a page shows them. Instead:
   - rollup documents (per day, per campaign, per user) updated in the same transaction as the record,
     sharded for campaign bursts, recounted nightly from the records by a job;
   - lists, search and review queues as Firestore queries with cursors (`startAfter`, never `offset`)
     and composite indexes; subject words as an `array-contains` token list (one word per query, the rest
     filtered); exact Message-ID, sender and recipient;
   - a 30-second cache shared by every admin's page; past days kept until midnight.

   **Effect:** correct numbers at any size, no read of everything, about $1–3 a month of reads. About a
   week's work; it adds indexes and a job (`installLevel` goes up). Until then, from 10,000 watched
   mailboxes one dashboard instance is kept running (0.5.0, `--min-instances=1`, about $13 a month),
   which avoids the start-up read.
3. **Spread the watch renewal over the day.** A successful `users.watch` sends a notification at once,
   so renewing 5,800 mailboxes in 95 seconds sends 5,800 light notifications in that time (2 quota units
   and three Firestore operations each). An hourly job renewing a twenty-fourth of the mailboxes (by a
   hash of the address) evens it out; alert when any watch has less than 48 hours left.
4. **Firestore, smaller steps:**
   - the mailbox document updated with a precondition (`lastUpdateTime`) instead of a transaction: one
     read less per notification (about 200,000 a day);
   - `count()` for totals where a page only needs a number (one read per 1,000 index entries);
   - a new installation in `us-central1` or `us-west1` pays half of `us-east1`'s Firestore prices
     (checked: below). Enterprise edition is cheaper per operation but means a new database.
5. **Large emails.** `messages.get` with `format=raw` brings attachments too. Since 0.5.0 at most 2
   emails over 4 MB are read and checked at once per instance (12 in all), so they can't fill the 1 GiB.
   Still to do: `format=full`, whose attachments come as ids (same 60 units), which the parser would
   have to take, so a large email isn't downloaded whole.
6. **The brake's size is the district's decision.** Its automatic limit is half the watched mailboxes an
   hour: a phishing email to all 10,000 has 5,000 copies moved, then moving stops until an admin resumes.
   `BRAKE_PER_HOUR` above the largest campaign expected lets a whole campaign through, and also lets a
   mistake move that many before it stops.
7. **A load test on a spare project** before a district this size: 10,000 test mailboxes are not needed;
   a few hundred with replayed made-up mail, scaled, show Firestore's real contention on the hot
   documents, the notifications per email (log the history types received), and Cloud Run's speed.
8. **The training scripts in this project.** The model is this project's own since 0.4.0, but training
   still uses the extension's scripts (`docs/RETRAINING.md`).

**Not recommended:**
- **BigQuery and Looker Studio as the dashboard:** Looker Studio is outside Identity-Aware Proxy, so
  senders and subjects would leave the admins-only dashboard (a safety default). The "Stream Firestore to
  BigQuery" extension is also deprecated (Firebase Extensions shut down on March 31, 2027).
- **Cloud Run worker pools pulling from Pub/Sub:** cheaper per vCPU-second and no 429s, but no
  autoscaling, so sized (and paid) for the peak all the time.
- **A shared store of access tokens:** it would keep credentials in a database; each instance keeps its
  own in memory, and the IAM quota (60,000 a minute) is far above what 10,000 mailboxes need.

## Sources

- Gmail API: [usage limits](https://developers.google.com/workspace/gmail/api/reference/quota),
  [push notifications](https://developers.google.com/workspace/gmail/api/guides/push),
  [users.watch](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users/watch),
  [batch requests](https://developers.google.com/workspace/gmail/api/guides/batch)
- Firestore: [quotas](https://docs.cloud.google.com/firestore/quotas),
  [best practices](https://firebase.google.com/docs/firestore/best-practices),
  [distributed counters](https://firebase.google.com/docs/firestore/solutions/counters),
  [aggregation on write](https://firebase.google.com/docs/firestore/solutions/aggregation),
  [TTL policies](https://docs.cloud.google.com/firestore/native/docs/ttl),
  [aggregation queries](https://docs.cloud.google.com/firestore/native/docs/query-data/aggregation-queries),
  [transactions and contention](https://docs.cloud.google.com/firestore/native/docs/transaction-data-contention),
  [pricing](https://cloud.google.com/firestore/pricing)
- Cloud Run and Pub/Sub: [pricing](https://cloud.google.com/run/pricing),
  [autoscaling](https://docs.cloud.google.com/run/docs/about-instance-autoscaling),
  [execution environments](https://docs.cloud.google.com/run/docs/configuring/execution-environments),
  [startup CPU boost](https://cloud.google.com/blog/products/serverless/announcing-startup-cpu-boost-for-cloud-run--cloud-functions),
  [worker pools](https://docs.cloud.google.com/run/docs/deploy-worker-pools),
  [push subscriptions](https://docs.cloud.google.com/pubsub/docs/push),
  [retry policy](https://docs.cloud.google.com/pubsub/docs/subscription-retry-policy),
  [Pub/Sub pricing](https://cloud.google.com/pubsub/pricing)
- IAM: [quotas](https://docs.cloud.google.com/iam/quotas),
  [token types](https://docs.cloud.google.com/docs/authentication/token-types)
- The model: [ONNX Runtime for Node](https://onnxruntime.ai/docs/get-started/with-javascript/node.html),
  [threading](https://onnxruntime.ai/docs/performance/tune-performance/threading.html),
  [quantization](https://onnxruntime.ai/docs/performance/model-optimizations/quantization.html),
  [the blocking issue](https://github.com/microsoft/onnxruntime/issues/19611)
- [Firebase Extensions deprecation](https://firebase.google.com/docs/extensions/faq-and-troubleshooting)
