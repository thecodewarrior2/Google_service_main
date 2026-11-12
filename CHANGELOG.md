# Changelog

## 0.5.9: The name is now S.P.R.U.C.E Mail Protection Service

Nothing in how emails are judged changes: only the name.

- **S.P.R.U.C.E Mail Protection Service** everywhere the service names itself: the dashboard's header and
  browser tab, the weekly summary's subject, the sender name on the notices it puts in mailboxes ("From:"),
  the install, update, upgrade and check scripts, and the documentation.
- **In Google Cloud,** new installations name the service accounts, the budget, the alert channel and the
  alert policies "SPRUCE Mail Protection Service …". `deploy/install.sh` finds an existing budget or alert
  policy under its old name too and renames it, so none is made twice; `deploy/doctor.sh` counts the alert
  policies under either name. Service accounts and the alert channel keep the name they were made with.
- Unchanged, so installations keep working: the services' and jobs' identifiers (`spruce-worker`,
  `spruce-admin`, `spruce-…`), the image (`mail-protection`), the install zip's name, the GitHub
  repositories, and Gmail's labels.
- `installLevel` is unchanged: nothing new to install.


## 0.5.8: The AI model comes from TinyPhishLLM, downloaded when the service is built

Nothing in how emails are judged changes: the model is still phish-tiny 0.13.0, byte for byte. It now
comes from **TinyPhishLLM**, the model's own public repository, which the S.P.R.U.C.E+ extension uses
too: one model, trained in one place. Its training (scripts, examples, check sets) is in a separate
private repository, TinyPhishLLM_Private_Training; TinyPhishLLM holds only the model and made-up
references.

- **The model's files are no longer in this repository.** `vendor/spruce/VENDOR.json` (`modelSource`)
  pins one TinyPhishLLM commit and each file's SHA-256, and **`tools/fetch-model.js`** downloads the files
  at that commit and stops if any differs. The Dockerfile runs it, so every build of the image takes the
  model from TinyPhishLLM: `deploy/install.sh`, `deploy/update.sh`, `deploy/upgrade.sh` (from a zip too)
  and **Settings → Update** (Cloud Build). `npm test` and `npm run demo` run it first;
  `--from <TinyPhishLLM folder>` works offline. Nothing is downloaded while the service runs, and the
  request carries no token and nothing about the installation.
- **Settings → Update** shows the AI model of the version installed and of the newest approved one, and
  where each comes from (TinyPhishLLM and the commit). `update.sh` and `upgrade.sh` say it too; the
  update's line in Activity names the model and its commit.
- **`tools/sync-model.js <TinyPhishLLM folder>`** pins a model: after TinyPhishLLM's own check
  (`tools/check.js`), a check that the commit is on TinyPhishLLM's main branch on GitHub, and a check that
  `vendor/spruce/ai.js` builds the model's input exactly as it was trained, it records the commit and
  hashes and copies the two references the tests use (`test/fixtures/model-reference.json`,
  `test/fixtures/model-input-format.jsonl`). Pinned to TinyPhishLLM `68f8dd6`. `model.bin` is no longer
  part of the service (only ONNX Runtime's `model.onnx` runs here).
- **The input-format reference is made up:** 72 made-up emails built to use every rule of the format,
  and 10 edge cases (TinyPhishLLM publishes nothing from its check sets). The service builds all 82 texts
  exactly.
- **Tests** (`test/model-source.test.js`): the pin is complete; the downloaded files match it; no model
  file is committed and the image build downloads them; `fetch-model.js` downloads, checks, keeps the
  right files without downloading them again, and never writes a file whose SHA-256 differs; the input
  format matches. `test/update.test.js`: the model's source on Settings → Update and in the update's
  Activity line.
- **`tools/export-onnx.py` moved** to the model's training repository, where `model.onnx` is made with the
  rest of the model.
- **Retraining** (`docs/RETRAINING.md`): steps 6 and 7 train in TinyPhishLLM_Private_Training, publish
  to TinyPhishLLM and pin it here. Also `README.md`, `CLAUDE.md` (never commit the model's files),
  `docs/INSTALL.md`, `docs/PRIVACY.md` (what the build downloads), `docs/ARCHITECTURE.md`, `docs/SCALING.md`.
- `installLevel` is unchanged: nothing new to install. The build needs to reach
  `raw.githubusercontent.com`, as updates already reach `github.com`.


## 0.5.7: Model health measures "rules and AI together"

Nothing in how emails are judged changes: this only counts.

- **Status → Model health → Rules and AI together (measured only).** It counts the emails from outside
  senders that score in between on both:
  - a rules score of 3 to under 5;
  - and an AI score from the suspicious line (65%) to under the move threshold (90%).

  Neither score alone moves them, so they are recorded as suspicious. The card shows how many there were in
  the period, how many admins marked as phishing and as false alarms, and how many aren't reviewed. It also
  says, once ten or more are marked, whether mostly phishing (moving such emails could be worth trying, in
  monitor mode first) or many genuine (it would make false alarms). The lines follow Settings → Policy.
- **Why measure first:** in the district's own examples, no email scored between 65% and 89% (0 of 71
  genuine, 0 of 26 phishing). The rules and the AI aren't independent either: the AI reads many of the
  rules' findings, so a total would count them twice.
- **Inside senders are left out,** since the AI never moves them. Each record now notes whether its sender
  counted as inside (your domains, DMARC passing). For records from before 0.5.7, any address in your
  domains counts as inside, which can only leave emails out of the count.
- **Install:** Settings → Update, once approved (`installLevel` 3, as 0.5.6).
- **Tests:** 124, with three more checks in existing tests: the zone and its marks, inside senders left out,
  and the zone following the settings.

## 0.5.6: Microsoft 365 links are no longer "look-alike domains"

- **Links to Microsoft 365 no longer get a false look-alike finding.** That covers
  `bookings.cloud.microsoft`, `forms.cloud.microsoft`, `teams.cloud.microsoft`, `outlook.cloud.microsoft`
  and every other name under `.microsoft`, which read as "one letter away from icloud.com". The finding
  marked the link dangerous (5 points), and the AI model reads it too. A made-up vendor reply with a
  Bookings link was flagged with a rules score of 6 and AI 100%, enough to move it to Spam in enforce
  mode. Now it is clean: rules score 1, AI 1%.
- **A brand's own top-level domain is never a look-alike.** Only the brand registers names under it. The
  list holds the 19 closed brand top-level domains whose operator IANA's root zone database names as the
  brand, checked November 2026:
  - Microsoft: `.microsoft`, `.azure`, `.bing`, `.office`, `.windows`, `.xbox`, `.skype`, `.hotmail`;
  - Google: `.google`, `.goog`, `.gmail`, `.youtube`, `.android`, `.chrome`;
  - `.apple`, `.amazon`, `.aws`, `.dell`, `.ibm`.

  Open top-level domains stay off the list, even ones a brand runs: `.live`, `.cloud`, `.play`, `.new`.
- **The ordinary word "cloud"** (`cloud.com`, say) isn't counted as a one-letter typo of iCloud. Real
  look-alikes are still found: look-alike characters (`icl0ud.com`), one letter off (`lcloud.com`,
  `iclouds.com`), the name with sign-in words (`icloud-login.com`), and the name in front of another domain
  (`icloud.com.verify-id.com`).
- **Re-scan** (Review) gives emails flagged this way their new scores.
- **Install:** Settings → Update, once approved (`installLevel` 3, as 0.5.5).
- **Tests:** 124 (from 123): the brand top-level domains and the word "cloud" aren't look-alikes, and nine
  real look-alikes still are.

## 0.5.5: Clearer wording on what moves an email

Nothing in how emails are judged changes. The words do, where they could be read as "the AI also needs
the rules".

- **Settings → Policy, the AI move threshold:**
  - an email from outside the organization that the AI scores at or above it is moved on the AI score
    alone, whatever the rules find;
  - from inside (your domains, DMARC passing), the AI score alone never moves it, and it is recorded as
    suspicious.

  It used to say "an email the AI scores this high or higher is moved (rules aside)".
- **Settings → Policy → How it decides,** row by row:
  - **Moved, sender outside:** either one is enough, the AI score at the threshold or the rules flagging
    it (a rules score of 5). The AI needs no rule, link check or other sign to agree.
  - **Moved, sender inside:** only by the rules; the AI score alone never moves it.
  - **Inside or outside:** your domains and DMARC passing make a sender inside; anything else is outside,
    a forged staff address too. DMARC decides only that (and whether an allowlisted sender counts), and an
    outside sender doesn't have to pass or fail it. A failed DMARC check is also one of the rules' signs (2
    or 3 points), never required.
  - **The rules:** what the rule checks add up, with 3 amber and 5 flagged; the AI score is separate.
- **README:** the same in its table of what happens to an email.
- **Install:** Settings → Update, once approved (`installLevel` 3, as 0.5.4).
- **Tests:** 123, as in 0.5.4.

## 0.5.4: A re-scan updates the email's scores and model

- **After a re-scan, the email's page shows the re-scan's results.** In 0.5.3 the AI opinion still named
  the model of the email's arrival scan (phish-tiny 0.11.0, say) and its score, with the re-scan only in
  the box under "What happened". Now these all become the re-scan's:
  - the AI score, the model and what weighed most;
  - the rules score and the signs found;
  - the flagged links and the lookups.
- **The arrival values stay beside them.** They are kept once, from the first re-scan on, and shown in the
  re-scan box and under the AI opinion ("On arrival: 99%, phish-tiny 0.11.0").
- **What happened doesn't change:** moved, would move or flagged, and why. Nothing is moved by a re-scan.
  An email stays in its review queue until you decide.
- **The sender counts as new on a re-scan if it was new on arrival.** In 0.5.3 a re-scan treated every
  sender as known, which lowered the rules score twice:
  - "first email from this sender" no longer counted;
  - neither did a brand-new link site, which counts only with a new or unverified sender.

  Now the same checks give the same rules score as on arrival (all 140 demo emails do). A re-scan differs
  from arrival only where the model or the checks changed.
- **Model health counts a re-scanned email under the model that re-scanned it.**
- **Demo mode uses its made-up district's domain** (`maple-schools.example`) when `ORG_DOMAINS` isn't set,
  as its emails were judged with. Re-scan and Check an email there now see "your organization" the way the
  records do.
- **An email re-scanned with 0.5.3** takes its arrival values from the scores it still has, the next time
  it is re-scanned.
- **Install:** Settings → Update, once approved (`installLevel` 3, as 0.5.3).
- **Tests:** 123 (from 122): after a re-scan, the email's model and scores are the new ones and the
  arrival values are kept, also over a second re-scan and for a record re-scanned by 0.5.3; a sender new on
  arrival keeps its rules score.

## 0.5.3: Re-scan an email; Status shows the AI engine; Model health names the model in use

- **Re-scan** (Email → Review, and each email's page):
  - **What it does:** the email is read again from its mailbox and judged with today's checks and AI
    model, the way "Check an email" does. Use it after a model update, for emails still in the queues.
  - **What you see:** the result beside what happened on arrival, which stays: the model, the AI score,
    the rules score (each with its on-arrival value), and what would happen now.
  - **Nothing is moved:** you decide with the usual buttons. In the Review queue the key is **R**, next to
    F, P and N.
  - **Noted in Activity**, with who re-scanned what. At most once every 5 seconds per email. An email
    deleted from its mailbox can't be re-scanned, and says so.
  - **The rules score can be lower than on arrival:** a re-scan doesn't count "first email from this
    sender", since by then the sender isn't new.
- **Status → Service status shows the AI engine,** in the dashboard and in the worker:
  - the phish-tiny version;
  - the native engine (ONNX Runtime and its version, basic optimization, one thread);
  - whether the model loaded, and in how long;
  - a self-check run each time an instance starts, which scores a made-up phishing email (it must be 50%
    or more) and a made-up genuine one (under 50%).

  The worker notes its own when it starts (`state/engine-worker`, one write per instance), with its version
  and revision. The page says when the worker's model failed to load, or differs from the dashboard's, and
  which model scored the newest email.
- **Status → Model health** said "Model: phish-tiny 0.11.0" after upgrading to 0.5.2, which runs 0.13.0.
  The line named the model that had scored the newest recorded email, and no flagged email had arrived
  since the upgrade. Now it says the model in use. When other models scored some of the period's emails,
  it also says which, and how many: emails keep the score they got on arrival, so the chart above mixes
  both until the old ones age out.
- **Install:** from 0.5.2, Settings → Update can install it once it is approved (`installLevel` 3, as
  0.5.2); otherwise from Cloud Shell with the zip.
- **Tests:** 122 (from 119): re-scan (judged again, the on-arrival result kept, nothing moved, noted, at
  most every 5 s, a deleted email); the AI engine's status (loaded, self-check, a model that fails to
  load); Status's engine checks (the worker not reported yet, on another model, failed). Model health's
  model in use, and the models that scored a period, are checked in existing tests.

## 0.5.2: The AI model trained with more of the district's phishing (phish-tiny 0.13.0)

phish-tiny 0.13.0 adds 6 more of the district's phishing emails to 0.5.1's examples. On emails it never
trained on, it beats 0.11.0 on both sides: fewer false alarms on the district's mail, and about half the
missed phishing. Use it instead of 0.5.1, which was not published. Everything in 0.5.0 is included;
install it the same way.

- **What it learned from:** 0.5.1's examples, plus 6 phishing and spam emails from a second batch of
  originals:
  - a "call this number" antivirus bill;
  - two retirement-outreach campaigns posing as the district's;
  - a fake wage-garnishment notice to payroll;
  - an estate-claim scam;
  - a motivational speaker's cold pitch to a principal.

  Each comes with two variants. That makes 48 genuine and 48 phishing training examples, the balance
  `docs/RETRAINING.md` asks for.
- **Made anonymous** like 0.5.1's examples, with one more kind of detail: a partial Social Security number
  of a named employee (in the fake garnishment notice) was replaced with a made-up one.
- **Left out of this batch:**
  - a SharePoint share notice, whose trick could only be in the shared file;
  - a Zoom webinar confirmation in Zoom's own template;
  - an ed-tech vendor's sales email from its real domain.

  Training on them would teach the model to distrust those services' genuine mail.
- **Measured with the service's own engine at the 90% line, on emails no model was trained on**
  (0.11.0 → 0.13.0):
  - the district's genuine mail called phishing: 15 → 7 of 23;
  - the district's phishing caught: 2 → 3 of 6;
  - published phishing missed: 20 → 11 of 603 (15 → 8 at the 50% line);
  - published genuine emails called phishing: 17 → 13 of 624;
  - genuine look-alikes called phishing: 3 → 3 of 24, and the hand-written emails all right, as before.

  0.12.0 (0.5.1) made fewer false alarms (5 of 23) but missed more phishing (21 of 603). The fake e-sign
  document it scored 3% scores 98% now.
- **`vendor/spruce/models/phish-tiny/MODEL_CARD.md`** has the details.
- **Install:** from Cloud Shell with the zip, as 0.5.0 (`installLevel` 3).
- **Tests:** 119, as in 0.5.0.

## 0.5.1: The AI model trained with the district's own mail (phish-tiny 0.12.0)

phish-tiny 0.12.0 is trained with 78 examples from a district's own mail, made anonymous first, and makes
far fewer false alarms on mail like the district's, while catching published phishing about as well as
0.11.0. Everything in 0.5.0 is included; install it the same way.

- **What it learned from:**
  - 48 genuine emails the district's admins marked as false alarms: staff notes, vendor threads, service
    notices.
  - 10 phishing and spam emails from the district: retirement and pension outreach posing as the
    district's, "AI data licensing" broker scams, a pay-on-results PR pitch, a fake invoice. Each comes
    with two variants that use other made-up names and domains.
  - A third of each kind was kept aside and never trained on: 23 genuine, 3 phishing.
- **How they were made anonymous** (`docs/RETRAINING.md`):
  - every person, the district, its schools and town, other districts, account and tracking identifiers,
    and bank details replaced with made-up ones or removed;
  - a list of students' names left out entirely, and a fake invoice whose trick was only in its
    attachment (which the model never sees);
  - every line read. The examples are in no repository.
- **Measured with the service's own engine, at the 90% line, on emails no model was trained on**
  (0.11.0 → 0.12.0):
  - the district's genuine mail called phishing: 15 → 5 of 23;
  - published genuine emails called phishing: 17 → 9 of 624;
  - published phishing missed: 20 → 21 of 603 (15 → 15 at the 50% line);
  - the district's held-out phishing caught: 1 → 1 of 3 (kinds it wasn't trained on);
  - hand-written emails: all right, as before.
- **The phishing it trained on** scores 100% where 0.11.0 gave it 0–6%, except the fake invoice (8%):
  invoices that look like real vendors' are still for the rule checks. This is a training score, not a
  test, but these campaigns come back in new copies.
- **`vendor/spruce/models/phish-tiny/MODEL_CARD.md`** has the details, including a run on the same data
  without the district's examples.
- **The engine's test** now holds ONNX Runtime to `tools/export-onnx.py`'s own computation of the new model
  (numpy, from `model.bin`), over the same 400 made-up inputs.
- **Install:** from Cloud Shell with the zip, as 0.5.0 (`installLevel` 3).
- **Tests:** 119, as in 0.5.0.

## 0.5.0: The native engine, records kept 35 days, the dashboard on when it's large

The AI model now runs in ONNX Runtime instead of JavaScript, each worker checks 32 emails at a time, how
long records are kept is a dashboard setting (35 days by default), and the dashboard reads less when it
starts. Measured on made-up mail: `docs/SCALING.md`.

- **The native engine.** The phish-tiny model runs in ONNX Runtime (`onnxruntime-node` 1.31.1, MIT)
  from `models/phish-tiny/model.onnx`, which `tools/export-onnx.py` makes from `model.bin`. A full-length
  pass takes about 6 ms instead of 146 ms, and an email's explanation passes (its sentences) run as one
  batch. All of an email now takes about 10 ms of processor time on average (97 ms in 0.4.1, 217 ms in
  0.3.12).
  - **The same answers:** on 400 made-up inputs the largest difference in the margin is 8.8e-6, and no
    email changes side of the 50%, 65% or 90% line. The test holds the engine to the JavaScript engine's
    answers, which stay in `test/fixtures/model-reference.json` with their token ids.
  - **It runs at the "basic" level of graph optimization.** The higher levels turn the 8-bit weights
    into 8-bit arithmetic, which changed answers by up to 0.36 in the margin. One thread and no spinning,
    so the instance's one vCPU is shared fairly.
  - **The JavaScript engine is removed** (`vendor/spruce/ai.js` keeps the tokenizer and the model's
    input text, as in training).
  - **A new model** gets new reference answers from `tools/export-onnx.py --reference`, which computes
    them from `model.bin` in numpy, without ONNX (it agrees with the JavaScript engine to 1.2e-6):
    `docs/RETRAINING.md`, step 7.
  - **The image** keeps ONNX Runtime for Linux x64 only: 47 MB of the package's 294 MB. Its installer's
    download is turned off (`.npmrc`).
- **32 at a time.** Each worker instance takes 32 requests at once (8 before) and checks at most 12
  emails at once, and only 2 of them over 4 MB, so large attachments can't fill its 1 GiB. Measured: 28
  emails a second per instance (4.8 in 0.4.1), half of them checked within 0.31 s.
- **Records kept 35 days by default** (60 before), and **changeable in Settings → Policy** (14 to 365
  days, with the project ID; noted in Activity and emailed as an alert), or with `RETENTION_DAYS` in
  `deploy/settings.env`. `install.sh` reconciles the two like the other policy settings.
  - **Each record goes on its own date**, that many days after its email arrived, oldest first. It is
    never a clear-out every 35 days.
  - **Shorter:** records older than the new value are deleted over the next hours, by the hourly
    cleanup.
  - **Longer:** applies to records saved from then on. Those already saved keep their date.
  - **After this upgrade,** records between 35 and 60 days old are deleted within hours, unless
    `RETENTION_DAYS` or the dashboard says otherwise.
- **The period buttons follow the setting:** with 35 days, Last 90 days becomes Last 35 days.
- **The dashboard reads the last 32 days when it starts**, not the whole retention period. Last 90 days
  (or the longest period kept) reads the older ones then; they are forgotten after an hour without such
  a page.
- **Always on from 10,000 watched mailboxes.** `install.sh` and Settings → Update keep one dashboard
  instance running (`--min-instances=1`, about $13 a month) when the last watch renewal counted 10,000
  or more watched mailboxes, so its pages open at once. Below that, it starts when opened, at no cost.
  When the count isn't known yet (a first install), the setting is left as it is.
- **Costs, counted again**, and **`docs/COSTS.md`**: what it costs a month by district size, where the
  money goes, the free allowances and what the estimates assume. Cloud Run bills an instance for all
  the time it has a request open, waiting included. The earlier estimates counted only processor time
  and were too low. At 10,000 mailboxes the worker costs about $21 a month with 0.5.0 (about $26 with
  0.4.1, which was estimated at $14). In all, about $50–65 a month at that size, $13 of it the
  always-on dashboard.
- **Install:** from Cloud Shell (`installLevel` 3: `install.sh` sets the dashboard's minimum instances
  and the new setting). Settings → Update can't install it.
- **Tests:** 119 (from 113). They cover:
  - the native engine against the reference answers, one at a time and in a batch, and the tokenizer
    against the stored ids;
  - at most 12 emails at once, 2 of them large;
  - retention from settings.env and the dashboard, the Activity texts, the cleanup after shortening,
    and Firestore's expiry dates following the setting;
  - the dashboard's copy (32 days first, older on demand, forgotten after an hour, trimmed when
    retention shrinks);
  - the installer (`RETENTION_DAYS` 14 to 365, reconciled with the dashboard; the dashboard always on
    from 10,000 mailboxes, at install and in Settings → Update).

## 0.4.1: Lower monthly costs

For school systems on small budgets: the same protection for less. Costs by district size, with the
prices checked on Google's pricing page: `docs/SCALING.md` ("What it costs") and `docs/INSTALL.md`
("Costs").

- **The dashboard no longer reads every mailbox.** Status, Readiness and every Settings page read each
  watched mailbox's document, and open pages refresh every 30 seconds: at 10,000 mailboxes, a Status page
  left open all day read about 29 million documents (about $17 a day in `us-east1`). Now they use a count
  of the watched mailboxes, the latest notification (one read) and a count of watches ending, kept a
  minute: about 17,000 reads a day. Only Settings → Mailboxes lists mailboxes, the first 500.
- **The hourly health check counts too** (it read every mailbox's document every hour).
- **A notification that brings nothing new writes nothing** (someone read or archived an email: two
  thirds of notifications). The mailbox's position waits up to 30 minutes; the next notification reads
  its history from there, for 2 Gmail quota units.
- **Three scheduled jobs, the free ones.** The cleanup of old documents runs with the hourly job (last,
  within 30 seconds), and `install.sh` removes the daily `spruce-purge` job: Cloud Scheduler gives 3 jobs
  per billing account for free, then $0.10 a job a month.
- **The example region is `us-central1`** (`deploy/settings.example.env`, `docs/INSTALL.md`). Firestore
  in `us-east1` costs twice as much as in any other US region ($0.06 per 100,000 reads and $0.18 per
  100,000 writes, against $0.03 and $0.09). The region can't be changed once installed.
- **Stopped mailboxes clear their watch's end**, so "watches ending within a day" counts only watched
  ones (those stopped before are cleared at the next renewal).
- **Install:** from Cloud Shell, as 0.4.0 (`installLevel` 2). From 0.4.0, Settings → Update would work
  too: the old cleanup job then keeps running until the next `install.sh`, harmlessly.
- **Tests:** 113 (from 109): a notification with nothing new writes nothing for 30 minutes, then writes;
  the mailboxes in numbers (memory and the Firestore emulator), stopped ones not "ending"; the Mailboxes
  list only on request; the hourly cleanup; three jobs, the old one removed.
- **Docs:** `docs/SCALING.md`, `docs/INSTALL.md`, `docs/DEPLOY.md`, `docs/ARCHITECTURE.md`.

## 0.4.0: Ready for a district (10,000 mailboxes, 100,000 emails a day); its own engine

Measured with the service's own code on a made-up district's mail; the numbers, and the plan for what
is left, are in `docs/SCALING.md`.

- **This project's own engine.** The checks and the AI model in `vendor/spruce/` began as the
  S.P.R.U.C.E+ browser extension's; they are now changed here, with tests. `tools/sync-engine.js` is
  gone. The dashboard says "The rule checks" (it said "The extension's checks").
- **The watches stay renewed at 10,000 mailboxes.** The daily renewal went through mailboxes one at a
  time and was cut off after 120 seconds: about 700 renewed a day, the others no longer checked after 7
  days. Now 10 at a time within 95 seconds, the oldest (and new members) first, the rest at the next run:
  about 5,800 a run, each mailbox every two days or so. Activity says how many are left for the next run.
- **The AI model twice as fast, with the same answers.** One pass at 256 tokens: 146 ms (it was 289);
  checked on 3,230 passes, identical to the bit. Each instance remembers a pass's answer by a hash of its
  input (in memory): a campaign's identical copies cost one pass. Per email: 97 ms of processor time (it
  was 217); one worker instance checks 4.8 emails a second (it was 2.8).
- **Far fewer Firestore operations, and no hot documents in a campaign burst:**
  - per notification without new mail: 2 reads and 1 write (it was 3 and 2), the "last notification"
    time written with the sync position;
  - per email: a message's claim and a new sender created without a transaction; when the service was
    installed, and senders' first-seen times, remembered per instance; the day's counters added up and
    written every 5 seconds (and when the instance stops), in 30 shards; domain ages remembered 6 hours;
  - a campaign's move counter stops once its alert is sent: a campaign to 10,000 mailboxes writes its
    campaign document 59 times (it was 5,000), and its sender's 10 (it was 10,000 transactions).
- **The dashboard counts every record.** It read at most 50,000 records and built pages from 20,000, so
  at a district's size the 30-day numbers were too low. Now every record of the period, kept slim (169 MB
  for 180,000 records; it was about 300 MB for 50,000), pages in 30–350 ms, past days' counters read once.
  A campaign's page and "Confirm phishing: move every copy" read that campaign's records only.
- **Old documents delete themselves.** What expires carries `expireAt`, and Firestore's TTL policies
  delete it (typically within a day). The daily cleanup job only takes older documents, within 90 seconds.
- **Scaling settings:** the worker up to `WORKER_MAX_INSTANCES` instances (new, 30 by default; it was
  10), gen2 with startup CPU boost; the dashboard 1 GiB (it was 512 MiB); Pub/Sub retries after 10 s.
- **Tokens:** calls for the same mailbox's access token at once share one request.
- **Install this version from Cloud Shell** (`bash deploy/update.sh`): it sets up the TTL policies and the
  new service settings (`installLevel` 2), so Settings → Update says so instead of offering the button.
  `upgrade.sh` adds `WORKER_MAX_INSTANCES=` (empty: 30).
- **Tests:** 109 (from 103): the renewal at scale (10 at a time, the oldest first, the rest next time),
  the counters added up, the same model answer remembered, shared token requests, the installer's TTL and
  scaling settings, and in the Firestore emulator: `expireAt` written and left out of reads, claims and
  senders created by one of 12 racing callers, the cleanup's time limit.
- **Docs:** `docs/SCALING.md` (new), `CLAUDE.md` (the engine is this project's own), `README.md`,
  `docs/DEPLOY.md`, `docs/ARCHITECTURE.md`, `docs/RETRAINING.md`, `docs/ROADMAP.md`.

## 0.3.12: Settings → Update loads while an update is under way

- **Fixed: "Couldn't load this page. internal error." on Settings → Update** as soon as **Update to …**
  was pressed, and from then on. The page's answer had a field named `status` (the update's progress),
  which the dashboard's server took as the HTTP status code. In 0.3.9 to 0.3.11 the page loaded only
  until the first update was asked for. The update itself was asked for, and the job run.
  - The progress is now `progress`, and the server takes a route's status as the HTTP status code only
    when it is one (a number from 100 to 599).
- **A second build for the same update changes nothing.** Pressing the button and also running the
  `spruce-update` job by hand started two builds for one request. A build that finds another one
  "building" (in the last 45 minutes) now leaves it to that one, and says so in its log.
- **Old progress isn't shown as current.** An update's progress about a version already installed or
  passed (installed from Cloud Shell since, say) no longer shows as "under way" or "didn't finish", and
  doesn't hold the button back.
- **Install this version from Cloud Shell** (`bash deploy/update.sh`, or `upgrade.sh` with the zip): the
  Update page of 0.3.9 to 0.3.11 can't load once an update was asked for. Nothing in the installation
  changes (`installLevel` stays 1), so later versions can come from the dashboard.
- **Tests:** 103: the page through the dashboard's server with an update requested, building, done or
  failed (it failed with HTTP 500 before); old progress left out; a second build standing aside, one
  stopped long ago not blocking, and the dashboard's "requested" as the usual start.
- **Docs:** `docs/DEPLOY.md`.

## 0.3.11: Review suspicious emails that weren't moved

- **Email → Review has two queues**, chosen at the top, each with how many are left:
  - **Moved or would move** (as before, oldest first);
  - **Suspicious, not moved** (new, newest first): emails the checks found suspicious (a rules score of 3
    or more, or an AI score from the suspicious line) but not enough to move, still in the Inbox, that
    nobody has reviewed. **F** not phishing, **P** phishing, **N** next.
- **In enforce mode, P moves an email still in the Inbox to Spam**, with the service's `SPRUCE/Moved`
  label. The button then reads **Phishing: move to Spam**, and only a button that says so moves
  anything (if another admin switches the mode meanwhile, it only marks). Activity notes who moved
  what; the email's page says "moved when … confirmed it as phishing"; **Move back to Inbox** undoes it.
  - **In monitor mode nothing is moved**, by the service or by an admin's decision, as before.
  - An email no longer in the Inbox (archived, deleted, moved by the user) is marked, and left where it is.
  - The service's own rules still never move a suspicious email: only an admin's decision does.
- **The same on an email's own page and for several at once:** **Confirm phishing: move to Spam** for an
  email still in the Inbox in enforce mode, and **Confirm phishing** on Messages moves those still in the
  Inbox (Activity says how many). **Mark not phishing** replaces "Mark false alarm" for a suspicious email.
- **Why it matters:** phishing among the suspicious emails is what the move rules miss, and marking them
  gives the retraining export its best examples (docs/RETRAINING.md). The export already takes every
  email an admin marked.
- **Fixed:** an email's Details showed "undefined" as the trigger of a copy found by an admin's search
  for a campaign. The note about pausing a campaign is no longer shown for emails the service didn't move.
- **Demo:** two made-up campaigns that are suspicious but not moved (a benefits survey, a webinar), so
  the new queue has emails to try. (The demo's earlier suspicious example now scores 100% with the AI
  model of 0.3.3, and is moved.)
- **Tests:** 103 (from 101): moving on P in enforce mode only, an email no longer in the Inbox, not
  phishing, monitor mode, an admin's earlier decision kept, several at once; and the queue through the
  dashboard (only suspicious emails still in the Inbox, newest first, both counts, out of the queue once
  marked).
- **Docs:** `README.md`, `docs/INSTALL.md`, `docs/RETRAINING.md`, `docs/ARCHITECTURE.md`.

## 0.3.10: Long links and addresses stay inside their cards

- **On an email's page** (Email → Review, and an email opened from Messages), text with no place to
  break now wraps inside its card instead of running out of it and making the page scroll sideways:
  - the AI's quotes ("What weighed most"), which are often a tracking link;
  - **Flagged links**, and the links named in **Signs found**;
  - the subject, the sender and recipient line, and **What happened**.
- **The same elsewhere:** alerts, Overview's recent alerts, Status → Activity, and the Status and
  Readiness checks, which can name a subject, an address or a link.
- **Signs found:** the score badge stays one line tall at the top of a sign that wraps over several
  lines.
- Nothing else changes: the AI's quotes and the links are shown in full, as before.
- **Tests:** 101 (from 100): the dashboard's styles let long words break wherever email text is shown.

## 0.3.9: Updating from the dashboard (Settings → Update)

- **Settings → Update**, its own page in the Settings menu:
  - the version installed, the newest approved one (from `google_service_main`), and the AI model it
    brings;
  - **what's new since your version**, and the whole changelog, read from the release repository;
  - **Update to …**, which works like `bash deploy/update.sh`. It needs **I agree**, the Google Cloud
    project ID and the email address you are signed in with. Five wrong answers lock it (and policy
    changes) for 10 minutes;
  - how the update goes: requested, building, done or failed (with the reason), and who started it.
- **The dashboard can't deploy anything itself.** It records the request (the version and its exact
  commit) and runs the new `spruce-update` job. That job starts a Cloud Build, fixed by `install.sh`,
  as the new `spruce-updater` service account. The build takes `deploy/cloud-update.sh` from
  `google_service_main` and checks again before building:
  - the request is from the last 30 minutes;
  - the commit is on `google_service_main`'s main branch, and has that version;
  - it is newer than the version running;
  - its `installLevel` isn't higher than the one installed.

  Then it builds that commit, deploys both services with it (their settings as they are), and notes in
  Activity how it ended (a failure as an alert). It takes about 10 minutes; mail keeps being checked.
  If the build can't read the request at all (permissions, say), it fails visibly in Cloud Build's
  history instead of doing nothing quietly.
- **No button when there's nothing to install:** the newest approved version is the one installed, or
  older than it (a version not yet approved, installed from a zip), and the page says which.
- **`installLevel`** (new in `package.json`, now 1) goes up with each version that changes the
  installation itself (roles, jobs, settings). Those versions aren't offered on the dashboard: the page
  says to run `bash deploy/update.sh` in Cloud Shell. Both services are labelled with the level
  installed (`spruce-install-level`).
- **`install.sh`** sets it up: the `spruce-updater` account (Cloud Build Editor, Logs Writer, Cloud
  Datastore User; Service Account User on itself and `spruce-run`; Artifact Registry Writer on the
  `spruce` repository; Cloud Run Developer on the two services), the `spruce-update` job (it runs by
  itself once a year, and then does nothing), and `UPDATE_JOB` and `RELEASES_REPO` on the dashboard.
  **Install 0.3.9 from Cloud Shell** (`update.sh` or `upgrade.sh`); later versions can come from the
  dashboard.
- **Privacy:** the dashboard reads the release repository from GitHub anonymously (no token, nothing
  about your installation), when the page is opened, kept 10 minutes.
- **Fixed:** the README still named the Messages button "Release to Inbox".
- **Tests:** 100 (from 93): reading the releases and the changelog; the button's checks and lock; the
  reasons no button is offered; the demo routes; the job, build and roles install.sh sets up;
  `cloud-update.sh` with a real git repository (nothing asked, Firestore refusing, the approved commit
  built and deployed,
  a commit not on main, too old, not newer, a higher installLevel, a deploy that fails); and its state
  and Activity line in the Firestore emulator.
- **Docs:** `README.md`, `docs/INSTALL.md`, `docs/DEPLOY.md`, `docs/ARCHITECTURE.md`, `docs/PRIVACY.md`,
  `CLAUDE.md` (raise `installLevel` when install.sh changes).

## 0.3.8: The AI suspicious line, a setting

- **Settings → Policy → AI suspicious line** (`AI_SUSPICIOUS_THRESHOLD`, 65% by default): the AI score
  from which an email that isn't moved is recorded as suspicious for review.
  - Lower records more emails for Email → Review, higher fewer. Nothing more or less is moved.
  - Below the line, and with a rules score under 3, an email isn't recorded at all.
- **Changed like the rest of the policy:** the project ID, noted in Activity, emailed as an alert,
  everywhere within 30 seconds.
- **It is never above the move threshold, and the threshold is never below it,** checked both ways:
  - on the dashboard: "To go higher, raise the move threshold first" / "To go lower, lower the
    suspicious line first";
  - in settings.env: the service doesn't start with them the wrong way round.
  - The move threshold is no longer held at 65% or more: its floor is the suspicious line.
- **The installer** carries it like the others: `install.sh` compares it with settings.env and asks when
  they differ. `upgrade.sh` adds `AI_SUSPICIOUS_THRESHOLD=` (empty: 65%).
- **Tests:** 93 (from 92): the line as a setting in the decision, both checks, the alert, the config
  check, and the installer taking it.
- **Docs:** `README.md`, `docs/INSTALL.md`, `docs/DEPLOY.md`, `docs/ARCHITECTURE.md`.

## 0.3.7: The allowlist and Settings in pages; the AI lines at 65% and 90%; clearer words

- **The AI's two lines:**
  - **Suspicious from 65%** (it was 50%). Below 65%, and with a rules score under 3, an email isn't
    recorded.
  - **Moved from 90% by default** (`AI_MOVE_THRESHOLD`, it was 85%). An install whose settings.env
    leaves it empty moves from 90% after upgrading; one that sets a value keeps it.
  - The threshold can't go below 65% (settings.env, or Settings → Policy).
  - The AI meter on an email's page turns red at the threshold in force, not at a fixed 85%.
- **Allowlist on Settings** (Settings → Allowlist): the domains and addresses never moved (when Gmail's
  DMARC check passes for them).
  - Changed like the policy: the project ID, noted in Activity, emailed as an alert naming what was
    added and removed, in force everywhere within 30 seconds.
  - **Your own domains (and their subdomains) can't be allowlisted**, or a staff account taken over would
    never be moved. Single addresses in them can.
  - One per line, or separated by commas; lower case, no repeats; at most 500 of each.
  - `install.sh` compares the lists with `ALLOW_DOMAINS` and `ALLOW_ADDRESSES` as sets (order and case
    aside), and asks when they differ, as for the policy.
- **Settings in pages,** with a menu on the left like Email and Status:
  - **Policy:** the four settings, and how the rest decides;
  - **Allowlist**;
  - **Mailboxes:** the watched mailboxes, and Update group membership now;
  - **Weekly summary**;
  - **Retraining**;
  - **About:** the version, the model, what is kept, and the network checks.
- **Words that don't suggest mail is withheld.** Every email reaches the user's mailbox; the service
  only moves some to Spam.
  - "Release" is now **move back to the Inbox**: **Move back to Inbox**, **False alarm: move every copy
    back**, "Moved back" in lists and filters.
  - "Held" is now **paused**, or **left in the Inbox**:
    - "Moving is paused for this campaign, waiting for your decision";
    - the brake's "Resume, and move those to Spam" and "Resume, and leave them in the Inbox";
    - Settings' "Campaign pause".
  - The same words in the alerts, Activity, the weekly summary, decision reasons, `clear-data.sh` and
    the docs. `--even-if-paused` replaces `--even-if-held` (which still works). The setting
    `CAMPAIGN_HOLD_AFTER` keeps its name.
  - The Gmail label on mail an admin moves back is now **`SPRUCE/Moved back`** (`RELEASED_LABEL`; it was
    `SPRUCE/Released`, which emails moved back before stay labelled with).
- **Review:** the "Open it with its other buttons" link is gone.
- **Tests:** 92 (from 90): the 65% and 90% lines, the allowlist (checks, the own-domain refusal, in
  force at once, the alert's text, the installer comparing lists, `&` in an address kept), and the
  clickable mockup building with scripts that parse (its allowlist stand-in had broken it).
- **Docs:** `README.md`, `docs/INSTALL.md`, `docs/DEPLOY.md`, `docs/PRIVACY.md`, `docs/ARCHITECTURE.md`,
  `docs/RETRAINING.md`, `docs/ROADMAP.md`.

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
