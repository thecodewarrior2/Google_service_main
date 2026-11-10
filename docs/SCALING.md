# Scaling: 10,000 mailboxes, 100,000 emails a day

What a district of that size asks of the service, what 0.4.0 changed for it, and the plan for the rest.
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

**At 100,000 emails a day** (estimates from the numbers above):
- **Processor time:** about 10,000–20,000 vCPU-seconds a day. One instance handles the busiest hour
  (about 15,000 emails); a campaign to every mailbox is checked within a few minutes, as Cloud Run adds
  instances (up to 30).
- **Gmail API:** about 67 units per email and 2 per notification, about 8 million a day: a tenth of the
  80 million below which there is no charge, and a tenth of the 1.2 million a minute in a campaign.
- **Cost:** Cloud Run about $14 a month (it was about $26), Firestore about $45–60 a month in us-east1
  (it was about $85). Pub/Sub, Scheduler and the Gmail API: next to nothing.

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

1. **Run the model natively (ONNX Runtime for Node).** The JavaScript pass is now about twice as fast,
   but still waits on one addition at a time; native matrix arithmetic is estimated 15–40× faster (not
   measured for this model: benchmark first). Export the same weights in float32 (answers equal to
   rounding), keep the JavaScript pass as the fallback and as the check. Then the explanation passes can
   run as one batch. Watch out: the package is 307 MB unpacked (keep only Linux x64's 48 MB), its
   installer downloads CUDA unless `ONNXRUNTIME_NODE_INSTALL=skip`, and `session.run` blocks the event
   loop while it runs (set `intraOpNumThreads: 1`, turn spinning off). License MIT.
   **Effect:** about 0.01–0.02 s per email; one instance for the whole district outside campaigns.
2. **Dashboard rollups instead of every record in memory.** Today the dashboard reads every record of the
   period when it starts (about 180,000 reads, perhaps 20–40 seconds, at 3,000 a day). Instead:
   - rollup documents (per day, per campaign, per user) updated in the same transaction as the record,
     sharded for campaign bursts, recounted nightly from the records by a job;
   - lists, search and review queues as Firestore queries with cursors (`startAfter`, never `offset`)
     and composite indexes; subject words as an `array-contains` token list (one word per query, the rest
     filtered); exact Message-ID, sender and recipient;
   - a 30-second cache shared by every admin's page; past days kept until midnight.

   **Effect:** correct numbers at any size, no read of everything, about $1–3 a month of reads. About a
   week's work; it adds indexes and a job (`installLevel` goes up). Until then, keeping one dashboard
   instance warm (`--min-instances=1`, about $13 a month) avoids the start-up read.
3. **Spread the watch renewal over the day.** A successful `users.watch` sends a notification at once,
   so renewing 5,800 mailboxes in 95 seconds sends 5,800 light notifications in that time (2 quota units
   and three Firestore operations each). An hourly job renewing a twenty-fourth of the mailboxes (by a
   hash of the address) evens it out; alert when any watch has less than 48 hours left.
4. **Firestore, smaller steps:**
   - the mailbox document updated with a precondition (`lastUpdateTime`) instead of a transaction: one
     read less per notification (about 200,000 a day);
   - `count()` for totals where a page only needs a number (one read per 1,000 index entries);
   - a new installation could use us-east4, about 45% cheaper than us-east1 in Standard edition (moving
     an existing database isn't worth it). Enterprise edition is cheaper per operation but means a new
     database.
5. **Large emails.** `messages.get` with `format=raw` brings attachments too: 8 at once of 25 MB on a
   1 GiB worker is a memory risk. Either fewer at once for large messages, or `format=full`, whose
   attachments come as ids (same 60 units), which the parser would have to take.
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
