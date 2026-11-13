# S.P.R.U.C.E Mail Protection Service for Google Workspace

**Two repositories.** `google_service_testing` is where it's developed and tested.
`google_service_main` holds only the versions the maintainer has tried and approved, each copied there
unchanged. Which one you're reading: the repository's name on GitHub, or `git remote get-url origin`.
The version is in `package.json` and `CHANGELOG.md`.

S.P.R.U.C.E Mail Protection Service checks every new email in your Google Workspace domain with the same
checks and AI model as the S.P.R.U.C.E+ browser extension. It moves suspicious ones to Spam, or in
monitor mode only records them. An admin dashboard shows what was moved, why, which campaigns came in
and who was affected, and lets IT move an email back to the Inbox. Nothing is ever withheld: every email
reaches the user's mailbox, and the service only moves the suspicious ones to Spam (or not, in monitor
mode).

- **Runs in your own Google Cloud project** (Cloud Run, Pub/Sub, Firestore). Email is read through the
  Gmail API with domain-wide delegation and is not sent to any other service.
- **Its own checks, and the shared AI model.** `vendor/spruce/` holds the checks (`shared.js`,
  `decoders.js`) and the code that runs the phish-tiny model (`ai.js`). They began as the S.P.R.U.C.E+
  browser extension's; since 0.4.0 they are this project's own code, changed here. The model comes from
  **TinyPhishLLM**, the model's own public repository, which the extension uses too: each version pins
  one commit and every file's SHA-256 (`VENDOR.json`, by `tools/sync-model.js`), and every build of the
  image (install, update, Settings → Update) downloads the model from there and checks it
  (`tools/fetch-model.js`); the model's files are not in this repository. Since 0.5.0 the model runs in ONNX Runtime (the
  native engine, `src/engine/model.js`): about 25 times faster than the JavaScript that ran it, with
  the same answers.
- **Careful by default:**
  - **Monitor mode** (records, moves nothing) until you switch to enforce mode.
  - **The AI doesn't read mail from inside the organization** (your domains, DMARC passing) unless
    you turn it on (Settings → Policy, "AI on inside mail"; `AI_SCANS_INSIDE`). The rule checks read it
    as any email (its links, its headers and the rest), and can move it, for example when a staff
    account is compromised and sends dangerous links. Even when the AI reads it, its score alone doesn't
    move inside mail unless you turn on **"AI alone moves inside mail"** (Settings → Policy, with a ticked
    agreement; `AI_MOVES_INSIDE`), off by default.
  - **Mail dressed up as inside is outside mail:** a staff address that fails Gmail's DMARC check is read
    by the AI and gets a sign of its own ("claims to come from inside your organization"), and so does an
    outside sender whose name shows one of your addresses ("it@your-district.org" <x@elsewhere>).
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
     that is only pictures;
   - its attachments and pictures (0.5.34): QR codes in pictures, PDFs and Office files, links in PDFs and
     Office files, web pages and SVG pictures sent as files (a sign-in form, a script that builds or
     redirects the page), double extensions, programs and disk images, archives or PDFs that need a password,
     documents with macros. The links found are checked like the email's own.
2. The checks add up their signs:
   - forged or spam headers;
   - a brand-name or look-alike sender, or one named after the recipient;
   - dangerous links;
   - claims to be safe, and requests for passwords, codes, money or remote access;
   - a new sender from outside the organization;
   - a fake reply chain ("RE:" answering nothing this mailbox has, 0.5.33);
   - a QR code, a sign-in page or script sent as a file, a risky attachment (0.5.34).

   A score of 3 is amber, 5 is flagged.
3. The phish-tiny model scores the email (0–100%).
4. The policy acts:

| Situation | Action |
|---|---|
| The rules flag it (score 5+), from any sender | **Move to Spam** (label `SPRUCE/Moved`) |
| The AI scores **90%** or more (`AI_MOVE_THRESHOLD`), sender outside the organization (or a staff address without DMARC passing): the AI score alone, no rule, link check or other sign needs to agree | **Move to Spam** |
| Same, in monitor mode, or while moving is paused (a campaign on weaker evidence, or the domain-wide brake) | Left in the Inbox, recorded as "would move" (a paused one can be moved later) |
| An admin dismissed the campaign as a false alarm | Recorded as suspicious, not moved |
| The user moved it into the Inbox themselves, and the service hadn't checked it | Checked and recorded, never moved (an alert if flagged) |
| Sender inside (your domains, DMARC passing), and the rules don't flag it | Nothing: the AI doesn't read it (with "AI on inside mail" on: a score of 90% or more is recorded as suspicious, not moved by the AI alone; with "AI alone moves inside mail" on: moved, as from outside) |
| A rules score of 3 or more, or an AI score of **65%** or more (`AI_SUSPICIOUS_THRESHOLD`), below what moves it | Recorded as suspicious, not moved |
| Allowlisted sender, DMARC passing | Nothing |

It also looks things up (`src/intel/`; `docs/PRIVACY.md` says exactly what is sent where):

| Check | What is sent | What it adds |
|---|---|---|
| **Cloudflare Security DNS** | host names of link sites and the sender's domain | a blocked link is dangerous; a blocked or nonexistent sender domain is a sign |
| **Google Safe Browsing**: optional, off by default. An admin adds the API key (kept in Secret Manager) and turns it on in Settings → Safe Browsing | link addresses (no `#…`; one-time links without their query) | a listed link is dangerous |
| **Phishing lists** (OpenPhish, Phishing Army, HaGeZi Threat Intelligence Feeds, TweetFeed, Sefinek) | nothing: downloaded once a day (a list that misses its download: tried again every 3 hours, a red banner on Overview, an alert to the admins, and Settings → About shows it with a Re-check button), matched in the service | listed links are dangerous; a listed sender address or domain is a sign. TweetFeed (domains researchers reported in the last 30 days) is a community report: a reported link is amber and a sign of 2, never dangerous on its own. Your own domains count only as exact listed links and addresses, never as a whole site or domain |
| **Site age** (registries, RDAP) | domain names, to their own registry | brand-new link sites and sender domains are signs (stronger with sign-in or payment wording) |
| **Spamhaus** (0.5.37): optional, off by default. An admin adds the district's free DQS key (Secret Manager) and turns it on in Settings → Spamhaus | the sender's domain and up to 5 link sites' names, by DNS, at most `SPAMHAUS_DAILY_MAX` (90,000) lookups a day | a link site on the Domain Blocklist for phishing, malware or botnet control is dangerous (the sender's domain: strong evidence); low reputation or an abused site: a sign; a domain first seen in the last 24 hours (ZRD): a sign |
| **abuse.ch** (0.5.37): optional, off by default. An admin adds the district's free Auth-Key (Secret Manager) and turns it on in Settings → abuse.ch | nothing: URLhaus and ThreatFox are downloaded once a day and matched in the service | links spreading malware, malware sites and control servers are dangerous, as the phishing lists' |
| **The look-alike watch** (0.5.36; `LOOKALIKE_WATCH`): a pass a day over look-alike names of your domains (a letter left out, swapped or replaced, other endings, `-k12`, `schools`…), Status → Look-alikes | those names only, to Cloudflare's public resolver | a newly registered look-alike is an alert; mail from it, replies to it and links to it are strong signs (one there before the watch: a small sign; one marked as yours: none) |

**Reputation check before a newsletter's link is called dangerous.** A link whose text shows a well-known
site but goes somewhere else is dangerous, except when it goes through the click tracker of the mail
service that sent the email, and the lookups vouch for that service. The sending service needs no list:
it is the third party whose DKIM signature Gmail verified on the email (link.mail.beehiiv.com in an email
signed by mail.beehiiv.com for a podcast's own domain; never the sender's own domain). The lookups:
Cloudflare and the phishing lists checked its domain and found nothing (nor did Safe Browsing, when on),
and its registry date isn't recent (180 days or more). (The engine's own click-tracker recognition, such
as Mailchimp's and SendGrid's, still applies.) Then it is a warning: the link is amber,
and the email gets 1 point, never enough to move it alone. Blocked, listed, recently registered, or not
checked (a lookup that didn't answer): dangerous, as before.

**Re-checking delivered mail** (0.5.35; Settings → Policy, on by default; `RECHECK`). Phishing sites are
often put on a list hours after their email arrived. Each email left in the Inbox keeps, with its "checked"
marker, short one-way hashes of its link sites and sender (never readable, never shown). When a phishing
list's daily download adds one, every email of the last 7 days (`RECHECK_DAYS`) that has it, in every
mailbox, is read again and checked in full, and the policy acts as on arrival: moved to Spam (enforce mode,
through the brakes) or recorded as "would move" (monitor mode). An email found suspicious on arrival is also
looked at again an hour and a day later (Safe Browsing or a list may know its site by then). Never moved by a
re-check: an email its reader already archived or deleted, or one an admin released or marked. Each is listed
on **Email → Re-checked**, a red banner on Overview and Messages says so, and the admins get an alert.

A lookup that fails leaves an email "not checked", never "safe". Short links are **not** looked up:
there is no outside unshortening service. A short link is judged by its own host and by what decodes
offline.

**The AI model reads English only** (it was trained on English mail). An email clearly in another
language (its writing system, or the commonest words of Spanish, French, Vietnamese, Haitian Creole and
others) gets no AI score: the dashboard says so, the rule checks run as for any email, and the
retraining export leaves it out. A bilingual email with a real English part is read.

**The colleague-name check:** the full names in your directory are read (by `DIRECTORY_ADMIN`, every 12
hours) and kept only as one-way hashes, in memory; an outside sender whose display name is one of them
("Jordan Whitfield" <jordan.whitfield.office@gmail.com>) gets a sign (3: amber; it moves mail only with
other signs, since staff sometimes write from a personal address), **when the email claims to be from inside**
(0.5.43): written from a personal email account, from an address imitating your domain or a brand-new domain,
with Gmail's sender check failing, with replies going elsewhere, with a title or your organization's name in
the sender's name ("Jordan Whitfield, Superintendent", also matched now), or asking what impersonators ask (a
favor, a phone number, gift cards, payment or payroll details, codes). People share names: a vendor's employee
with a colleague's name, writing a greeting from her company's own address, is shown but doesn't count. The same names are looked for in the
other address lines: **Reply-To** under a colleague's name going to an outside address (3: replies would
go to someone else), and a colleague **copied in** (Cc or To) at an outside address (1) or at an address
that imitates your domain (3: "I've copied our superintendent").

**Shares and notifications sent through a platform** (Google Classroom, Drive, Docs, Forms, Calendar;
DocuSign; Dropbox; Adobe Acrobat Sign; SharePoint): the sender's address, the sender check and your
routing rule's `[EXTERNAL]` tag are the platform's, for a colleague's share as much as for a stranger's.
Once Gmail's sender check proves the platform sent it, the email is judged by the **person's own address**:
the Reply-To the platform sets from their account (Drive shares, DocuSign), or the "Name (address)" it
writes in the text (Classroom gives neither: the person is then unknown, and their name counts for nothing
either way). A colleague's own share or Classroom post gets no mark. For a share from outside:
- **an account under a colleague's name**: at another organization 5 (flagged: moved in enforce mode), at a
  personal provider such as gmail.com 3;
- **a colleague named in its subject or text** ("Dana Morales asked me to share…", a signature in their
  name): 2. Not a greeting ("Hi Dana Morales"), not the reader's own name, not a quotation of the colleague's
  own email;
- **asking to sign in, verify an account or confirm details** (payroll, direct deposit) to see it: 1;
- **the same outside account reaching 10 or more of your people within the hour**: 2, and an alert (Status
  → Activity, emailed), once per account and hour.

**Google Classroom from a personal account** (gmail.com, outlook.com, yahoo.com and the other free
providers): 5, flagged (moved in enforce mode), whatever the name. A school's classes come from its own
domain; a class run from a personal account is the known way to send scams through Classroom's own
address. The account is known when the email shows it: the "Name (address)" next to the person's name, or,
for a class invitation, a personal address anywhere in its text. A Classroom email that shows no account
can't be told apart, and is judged by its links and the AI. To keep your people out of personal accounts'
classes altogether: Admin console → Apps → Google Workspace → Classroom → Class settings, "Which classes
can users in your domain join" (not "any").

With "outside" (1) and a first share from that person (1.5), the compromised-district campaign (a real
account elsewhere sharing a document "from" your colleague and asking to sign in) reaches 5.5: moved. A
partner you know sharing a document that mentions a colleague stays at 3: suspicious, not moved. An
outside email that links a document, form or signature request itself (not a notification) gets the same
three checks. The colleague-name checks need the **Users → Read**
privilege and one more delegation scope (docs/INSTALL.md, "The colleague-name check"); without them it is
off, and Status says how to turn it on. `COLLEAGUE_NAMES=off` (a setting of both services, docs/DEPLOY.md)
turns it off.

## The dashboard

The dashboard keeps itself up to date: the page you're on is fetched again every 30 seconds while
the tab is visible (not while you're typing in it, or using it otherwise). The bar under the tabs says
when it last updated, and **Pause updates** stops it.

The dashboard has four tabs: **Overview**, **Email**, **Status** and **Settings**. Email, Status and
Settings each have a menu on the left (a row of buttons above the page on a phone).

- **Overview:** emails checked, moved and moved back (by admins and by users); users affected; moves per
  day by trigger; top reasons; largest campaigns; alerts. The daily chart (0.5.45) shows every email checked
  behind the emails moved (or, in monitor mode, that would be moved), each colored by what triggered it: rules +
  AI, the AI score alone, the rules alone, an admin's confirmation; **Zoom in to the moved ones** fits the scale to
  them. In monitor mode the big number says how many would move by each trigger.
- **Email**, with the number of emails waiting for review on the tab:
  - **Review:** emails nobody has reviewed, one at a time, in two queues (the menu shows how many are
    left in the first). The copies of one email (a campaign: the same email to many people) are one item,
    decided together: who received it (and who sent it, when the copies came from several addresses) is
    listed, the first two shown, **…show more** for everyone:
    - **Moved or would move**, oldest first: **F** false alarm, **P** phishing, **N** next.
    - **Suspicious, not moved**, newest first: emails the checks found suspicious (a rules score of 3 or
      more, or an AI score from the suspicious line) but not enough to move, still in the Inbox. **F**
      not phishing, **P** phishing, **N** next. Marking them shows what the move rules miss, and gives
      the retraining export its best examples. Each says what made it suspicious: the rule checks'
      score, the AI's, or a link check.
    - **The AI opinion** says where its score stands against the lines in force; **…show more** shows
      what the model reads of the email, sentence by sentence, and each sentence that weighed most
      between the sentence of real text before and after it (blank lines, invisible padding and lone
      punctuation skipped). When the whole email reads as genuine (under 50%), nothing is marked.
    - **R re-scans** the email: it is read again from the mailbox and judged with today's checks and AI
      model (after a model update, say). Its scores, AI opinion, model and signs become the re-scan's,
      beside what they were on arrival; what happened to it (moved, flagged) stays. A re-scan never moves
      anything: you decide with F or P. Activity notes who re-scanned what.
    - **In enforce mode, P moves an email still in the Inbox to Spam** (the button then reads
      **Phishing: move to Spam**), with the service's `SPRUCE/Moved` label; Activity notes who. In monitor
      mode nothing is moved. An email no longer in the Inbox (archived, deleted) is left where it is.
  - **Campaigns:** each opens the list of emails behind it, with **Confirm phishing: move every copy**
    (optionally searching every watched mailbox for copies the service didn't record), **False alarm:
    move every copy back**, and **Find other copies**.
  - **Messages:** search and filters (also by Message-ID), opening each email's decision. **Download
    CSV** gives the same list. An email found to be phishing after it was delivered has a red mark and
    "found later".
  - **Re-checked** (0.5.35): emails already delivered and found later to be phishing or suspicious, one
    card per email (all its copies): why (which list added which site, or a second look), when it was first
    delivered and re-checked, and for each person who got it: when it arrived, whether they had opened it,
    whether they clicked a link in it (with **Settings → Link clicks** on; Gmail's logs), and what was done
    (moved to Spam and when; would move; it had already left the Inbox). **Mark all as seen** clears the red
    banner on Overview and Messages until something new is found.
    - Tick several to **move back to the Inbox**, **mark false alarm** or **confirm phishing** them at once
      (in enforce mode, confirming also moves those still in the Inbox to Spam).
    - Each email shows the signs found with their weights, flagged links, the AI score with what weighed
      most, the sender check, and how strong the evidence was. Buttons: **Re-scan**, **Move back to Inbox**, **Mark
      false alarm** (**Mark not phishing** for a suspicious email), **Confirm phishing** (**Confirm
      phishing: move to Spam** for one still in the Inbox, in enforce mode).
    - Each email also shows its **Message-ID** and Gmail ID, each with a **Copy** button. The Message-ID
      is what Google Workspace's Email log search and the security investigation tool look an email
      up by. **Copy for Vault** copies it as Google Vault's search writes it: `rfc822msgid:<Message-ID>`.
    - **Check an email:** paste a reported email's original (Gmail: Show original), or an `.eml` file, to
      see what the service would decide and why. Nothing is stored, moved or counted.
  - **Users:** everyone who had mail moved, would have had it moved, or got suspicious mail; each opens
    the list of their emails.
- **Status:**
  - **Service status:** whether the service works end to end, with what to do for each problem:
    - Identity-Aware Proxy off on the worker, and who may call it;
    - both services on the same build, and the jobs reaching the worker;
    - notifications arriving and watches renewed;
    - the AI model in the dashboard and in the worker: its version, the native engine (ONNX Runtime),
      whether it loaded and how fast, and a self-check that scores two made-up emails each time an
      instance starts (the worker notes its own in Firestore, `state/engine-worker`);
    - the phishing lists (each one that missed its download), alerts, errors, the brake.

    `deploy/doctor.sh` checks the rest from Cloud Shell.
  - **Model health:** recorded emails by AI score, and how often each kind of move was undone (and how
    often by users themselves). This is the number to tune the threshold with. **Rules and AI together**
    counts the emails from outside senders that score in between on both (a rules score of 3 to under 5, an
    AI score from the suspicious line to under the move threshold), so neither moves them, and what admins
    marked them: whether moving such emails would be worth trying. It only measures. It names the model in use,
    and, after an upgrade, which models scored the period's emails (each keeps the score it got on arrival).
    - Marking emails doesn't train the AI model. **Download for retraining** (allowed in Settings → Retraining, off by
      default) gives the emails admins marked, read from Gmail at that moment with the people taken
      out, as training examples in the extension's format. Nothing is stored. `docs/RETRAINING.md` says
      how to check the file and train the model with it.
  - **Look-alikes** (0.5.36): the look-alike watch's progress and each domain found that imitates yours
    (when, registered, mail servers, website, how it counts in mail), with **It's ours**, **Harmless**, **A
    threat** and **Watch as found** (each with the project ID, noted in Activity). A new one is a red banner
    on Overview and an alert.
  - **Readiness:** whether monitor mode has shown enough to switch to enforce mode, as checks:
    - time in monitor mode, emails reviewed, false alarms;
    - staff mail failing DMARC, and the busiest hour against the brake;
    - notifications arriving, and the group re-read reaching the service.
  - **Activity:** alerts (problems the admins are emailed about), what admins did (opening the dashboard and
    downloads included), errors and the watching of mailboxes. Kept a year (`AUDIT_DAYS`), apart from the email
    records; any period, a kind, words to look for, and a CSV download for audits. Optional (off by default,
    Google charges a little): a copy in a Cloud Logging bucket (`AUDIT_LOG`), and an alert when Gmail's
    notifications pile up in Pub/Sub (`PUBSUB_BACKLOG_ALERT`).
- **Settings:**
  - **Policy:** **Change** the mode, the AI move threshold, the AI suspicious line, the brake (automatic,
    or a fixed number of moves an hour) or the time zone, and how the rest decides (read-only). The
    suspicious line is never above the move threshold.
    - Each change needs the Google Cloud project ID; five wrong ones lock it for 10 minutes.
    - Switching to enforce mode also needs **I agree**, next to how many Readiness checks pass.
    - A change applies everywhere within 30 seconds and is noted in Activity (What admins did).
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
  - Each service's page (Safe Browsing, Spamhaus, abuse.ch, Link clicks; Status → Look-alikes) shows beside
    its title whether it is on: a green "Service is on", a red "Service is on, but not working", or a grey
    "Service is off" (0.5.40).
  - **Spamhaus** and **abuse.ch** (0.5.37; optional, off by default): what each adds, its key (tested, then
    kept in Secret Manager only; never shown again), on and off, and how its lookups or downloads go (Spamhaus:
    the day's lookups against its limit). Each change needs the project ID.
  - **Phishing training** (0.5.44; off until set): your training service's test emails (KnowBe4, Wizer…) let
    through unchecked, recognized by the vendor's header with a secret token or its sending addresses, or by all
    their links going to the vendor's own domains; with step-by-step instructions. Each change needs the project
    ID.
  - **Link clicks** (0.5.35; optional, off by default): for each email found to be phishing after it was
    delivered, Gmail's own logs (Admin SDK Reports API) tell when each person first opened it and whether
    they clicked a link in it; a click is an alert. It needs Gmail log events in your Workspace edition, the
    `admin.reports.audit.readonly` scope on the domain-wide delegation, and an admin with the Reports
    privilege (docs/INSTALL.md, "Link clicks"). **Test** says what Google answers; turning it on or off
    needs the project ID.
  - **Update:** the version installed, the newest approved one (from `google_service_main`), what's new
    since yours (its changelog), and the whole changelog. **Last checked** says when GitHub was asked (the answer
    is kept 10 minutes); **Check again** asks it now, at most once a minute for everyone and 10 times an hour per
    admin (0.5.38). **Update to …** works like
    `bash deploy/update.sh`:
    - it needs **I agree**, the Google Cloud project ID and the email address you are signed in with
      (five wrong answers lock it for 10 minutes);
    - both services are rebuilt from that version and redeployed with their settings as they are, by a
      Cloud Build the dashboard can only start (it can't deploy anything itself). It takes about
      10 minutes, and the page follows it: requested, building, done or failed;
    - its start is noted in Activity (What admins did); how it ended is in Activity and on the page, and a
      failure, or a build that never finished, is an alert: the admins are emailed.

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

`npm run demo` and `npm test` first download the AI model from TinyPhishLLM, at the commit
`vendor/spruce/VENDOR.json` pins, into `vendor/spruce/models/` (once; `tools/fetch-model.js` checks every
file's SHA-256). Offline, with a TinyPhishLLM checkout at that commit:
`node tools/fetch-model.js --from ../TinyPhishLLM`.

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
  `deploy/cloud-update.sh` in Cloud Build. The page links each AI model to its TinyPhishLLM repository
  (and the pinned commit) and the approved versions to `google_service_main`.
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
AI suspicious line, the brake, the time zone, how long records are kept and the allowlist can also be
changed on the dashboard (Settings → Policy, Settings → Allowlist). When the two differ,
`install.sh` asks which to keep, and writes the answer into settings.env.

See `docs/DEPLOY.md` (each piece, by hand) and `docs/PRIVACY.md` (what is read, kept and shown).
`docs/COSTS.md` is what it costs a month, by district size. `docs/SCALING.md` is what a district of
10,000 mailboxes and 100,000 emails a day asks of it, measured, and the plan beyond.
`docs/ARCHITECTURE.md` explains the pieces. `docs/ALERTS.md` says what each alert the admins can receive means
and what to do. `docs/WORKSPACE.md` lists Google Workspace settings that work alongside the service (an outbound
recipient limit for a staff account taken over, Gmail's own Safety settings, DMARC). `docs/RETRAINING.md` turns the emails admins marked into
training examples, and a better AI model.

## Layout

| Path | What |
|---|---|
| `src/engine/` | MIME and HTML reading, the checks and the model (`spruce.js` loads `vendor/spruce/`; `model.js` runs the model in ONNX Runtime); `network.js` applies the lookups; `notifications.js` judges the person behind a platform's notification, and outside shares |
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
| `src/dashboard/cache.js` | The dashboard's copy of the records: the last 32 days first, older ones when a page shows them, then only what changed |
| `src/server.js` | The HTTP service (`ROLE=worker` / `admin`) |
| `public/` | The dashboard (plain HTML, CSS and JavaScript; no build step) |
| `src/demo/seed.js` | Made-up demo data, judged by the real engine |
| `deploy/` | `install.sh`, `update.sh`, `upgrade.sh`, `rollback.sh`, `stop.sh`, `doctor.sh` and `clear-data.sh` (Cloud Shell), `dashboard-policy.sh` (theirs), `cloud-update.sh` (Settings → Update's Cloud Build), `settings.example.env` |
| `.github/` | Dependabot (`dependabot.yml`: security fixes as pull requests) and the tests on every pull request (`workflows/test.yml`) |
| `tools/` | `build-mockup.js`, `release.js` (the install zip); `sync-model.js` (pins a model of TinyPhishLLM), `fetch-model.js` (downloads it: the image build and `npm test` run it); for retraining: `check-training-file.js`, `split-examples.js`, `score-examples.js` |
| `vendor/spruce/` | The checks and the code that runs the model (this project's own since 0.4.0; they began as the extension's); `VENDOR.json` says from which commits, and pins the model (`modelSource`); `models/phish-tiny/` is where `fetch-model.js` puts the model (not committed) |
