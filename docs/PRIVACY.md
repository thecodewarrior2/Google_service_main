# Privacy: what the service reads, keeps and shows

Have your district's privacy officer and legal counsel review this before a pilot. It covers staff and
student email, which FERPA, state student-data law, and your Google Workspace for Education agreement
protect.

## What it reads

- **Every new message in the Inbox of each watched mailbox** (the pilot group or unit), through the Gmail API,
  within seconds of delivery.
  - The whole raw message is read **in memory only** while it is judged, then discarded.
  - Attachments are listed by name and type only; their contents are not read.
- **Also read, the same way:**
  - an email a user moves into their Inbox themselves that the service never checked (from Spam, within 7
    days of arrival). It is checked and recorded, never moved;
  - after a gap in a mailbox's history (the service was unreachable for a while), that Inbox's mail since
    the last notification, at most a week.
- **When an admin confirms a campaign and asks for a search:** each watched mailbox's Inbox of the last 7
  days is searched for mail from the campaign's senders. Only the From and Subject of the matching emails
  are read, to tell whether they are copies.
- **Not read:** sent mail, drafts, mail already in Spam, and mailboxes outside the pilot.
- **Who is in the pilot:**
  - read through the Admin SDK by an admin account with only read access (to groups, or to users for a
    unit);
  - only active accounts in the organization's own domains are watched, even if a group lists others.

- **The directory's full names** (the colleague-name check, when its permission is given): read through
  the Admin SDK every 12 hours, turned at once into one-way hashes (the extension's fingerprint: "Smith,
  John" and "John Smith" give the same one) and kept only in the service's memory, then compared with the
  names in an email's From, Reply-To, Cc and To lines, and in the subject and text of a share from outside
  (hashed the same way). Each person's primary address is read with their name, only to know their own
  name's hash (their own name in their own mail is not "a colleague named"); kept in memory with it. No
  name is stored; Firestore keeps only how many there are and when they were read (`state/colleagueNames`).
- **Shares from outside, counted:** for the mass-share sign and alert, one counter per outside account and
  hour (in `moveCounts`, deleted after 2 days), holding only one-way hashes of the recipients' addresses.
- **An email again, when an admin asks:** Re-scan, and **…show more** on an email's AI opinion, read that
  one email from Gmail again. "…show more" shows the admin what the AI model reads of it (addresses
  reduced to their domain, phone numbers and long numbers replaced), sentence by sentence, with each
  sentence that weighed most between the one before and after it; nothing of it is stored, and Activity
  notes who looked at which email.

## What it keeps (Firestore, in your own project and region)

For emails the policy moved, would have moved, or found suspicious, it keeps:
- the recipient, and the sender's name and address;
- the subject (`STORE_SUBJECTS`);
- the time;
- the checks' findings (the extension's short texts and weights);
- the flagged links;
- the AI score, and up to three short quotes (160 characters) the model weighed most (`STORE_AI_QUOTES`);
- Gmail's DMARC, SPF and DKIM results;
- attachment names, and what the attachment checks found in them (a QR code's or a link's site, a sign such
  as "asks for a password"; 0.5.34), never the files;
- its Message-ID (the header Google Workspace's Email log search uses), and Gmail's ID of the copy;
- the decision, and who moved it back or marked it (including "moved back by the user" when a user takes a
  moved email out of Spam themselves).

**Never kept:** email bodies or attachments. Attachments and pictures are read in the worker's memory while the
email is checked (QR codes, links, forms and scripts in them; 0.5.34) and dropped; nothing of them is sent
anywhere except the sites their links point to, which are looked up like the email's own links.

For every other email it keeps only a daily count (emails checked) and the message ID, so it doesn't
judge the same email twice. With **re-checking delivered mail** on (Settings → Policy, on by default; 0.5.35),
an email left in the Inbox also keeps, beside its message ID, up to 24 short **one-way hashes** (16 hex
characters each): of its link sites (each host and the domains above it, never your own domains or the big
brands' sites that lists never have), of the exact address of a link on shared hosting (a cloud-storage
page), and of its sender's address; and the time it arrived. They can't be turned back into the sites or
the address: they only let the service find the email again when a phishing list later adds one of them,
in every mailbox that got it. They are never shown. Turned off (`RECHECK=false`, or the dashboard), none are
kept; they are deleted with the message ID.

**Re-checked mail** (0.5.35): an email found to be phishing after it was delivered (a list added one of its
sites or its sender, or a second look an hour or a day after it arrived) is read again from Gmail and
checked in full, as on arrival, and gets a record like any flagged email, with when it was re-checked,
whether it was still in the Inbox, and whether it had been opened (Gmail's unread mark then). With
**Settings → Link clicks** on (off by default), the service also reads, for each re-checked email, Gmail's
own log events (Admin SDK Reports API, as the admin typed there) of its recipient for the time since it
arrived: opened (first time) and link clicked. Only the events naming that email are used; its record keeps
whether and when it was first opened and a link clicked, nothing else from the logs.

It also keeps, shared by every instance:
- **the look-alike watch** (0.5.36): the look-alikes of your domains that exist (name, when found, mail
  servers and website yes or no, registry age, an admin's mark and who made it), and how far the day's pass
  has got (`state/lookalikeWatch`);
- **the phishing lists:** gzipped in Firestore, replaced daily, with each list's last download (when, and the error if it failed: `state/feedHealth`);
- **registry dates of domains:** 30 days; an unknown one, a day.

And:
- **an update from the dashboard:** who asked for which version and when, and how it went
  (`state/updateRequest`, deleted when the build ends; `state/update`, the latest one);
- **sender history:** a hash of each sender address, to tell "first email from this sender";
- **mailbox state:** each watched mailbox's sync position;
- **a re-scan** (Review, Messages: Re-scan): the email's record takes what an admin's re-scan found (the
  scores, the AI opinion and model, the rule findings' descriptions), with when and by whom, and keeps its
  scores from arrival beside them. The email is read again from Gmail for it, like on arrival, and its
  body isn't kept;
- **the worker's AI engine:** the model, engine version and self-check of the newest worker instance
  (`state/engine-worker`), for Status. Nothing about any email.

**Conversations:** for an email whose subject says it is a reply and that names an earlier email, the service asks
Gmail how many emails its conversation (thread) holds in that mailbox (0.5.33: a fake reply chain). Only the
number; nothing of the other emails is read.

**Retention:** records and message IDs are deleted after `RETENTION_DAYS` (35 by
default, 14 to 365; also changed on the dashboard, Settings → Policy). Activity entries (alerts, admins'
actions, errors: mailbox addresses, sender domains and admins' addresses, never email text) are kept
`AUDIT_DAYS` (365 by default, 30 to 1,825; from 0.5.29), for audits; with `AUDIT_LOG=on` (off by default) a
copy of each also goes to Cloud Logging, in the project's own log bucket `spruce-audit`, kept
`AUDIT_LOG_DAYS`. Each is deleted on its own date,
that many days after its email arrived, by Firestore's TTL policies, so the oldest go first and the
rest stay; nothing is cleared all at once. Shortening it deletes the older ones within hours (the hourly
cleanup).
To delete what the dashboard shows sooner, all at once: `bash deploy/clear-data.sh` (docs/INSTALL.md,
"Clearing the dashboard's data").

## Who sees it

- **The dashboard:** only through Identity-Aware Proxy, and only for the addresses in `ADMIN_EMAILS` or
  the members of `ADMIN_GROUP` (accounts in your own domains).
  Every move back to the Inbox, mark and setting change records who did it.
- **The service's own accounts:** in your Cloud project, under IAM. Limit project access to the people
  who run the service.
- **The weekly summary** (off by default) goes into the Inbox of each dashboard admin. It has the week's
  counts, what waits for an admin, and the largest campaigns: each one's sender domain, and its subject
  if `STORE_SUBJECTS` keeps subjects. It names no recipient.
- **Check an email:** the pasted email is judged in memory and never stored. Its links and sender go to the
  same lookups as arriving mail. Activity notes who checked one, and the sender's domain.
- **Alert emails** go to `ALERT_EMAIL` (the admin group by default). They say what happened, with what
  the dashboard shows for it: a campaign's sender domain and subject, and for a user who took a flagged
  email into their Inbox, their address and the sender's.
- **The CSV export** (Email → Messages → Download CSV) holds what the Messages page shows: keep the file as you
  would the dashboard.
- **The retraining export** (Status → Model health → Download for retraining) is off until an admin allows it in
  Settings, and Activity notes who allowed it and every download.
  - It reads the emails admins marked from Gmail at the moment of the download: confirmed phishing, and
    false alarms only when asked.
  - The download holds what the AI model reads: the subject, the sender's name and domain, the DMARC
    result, up to 8 links, and the first 1,200 characters of the text.
  - The people are taken out first: the recipient becomes "your name"; the other people in the headers,
    and names after titles, greetings and sign-offs, become [NAME]; the sender of genuine or inside mail
    becomes [SENDER]; your domains become [OUR-DOMAIN]; addresses, phone numbers and long numbers are
    replaced.
  - Other words that may be names are marked for a person to decide. The removal can miss things, so
    the file is read by a person before it goes anywhere (`docs/RETRAINING.md`).
  - Nothing of these emails is stored by the service: the file is the only copy. Keep it on one computer
    and delete it when done.
  - The examples are used for training only in TinyPhishLLM_Private_Training's `training/data/extra/` (the
    model's private training repository), which is never committed. Whether they may go to an outside AI service to be reworded is your district's decision.

## What is sent elsewhere

Never the email itself, its text, its recipients or who received it. Only these, for the checks (each
can be turned off):

| Service | Sent | Kept there | Setting |
|---|---|---|---|
| **Cloudflare Security DNS** (`security.cloudflare-dns.com`, and `cloudflare-dns.com` to tell a block from a missing domain) | host names: the sites links point to, and the sender's domain. Never paths, addresses or anything else | Cloudflare's resolver privacy commitments (it doesn't sell or keep identifying query data) | `CLOUDFLARE_THREATS` |
| **Google Safe Browsing** (Lookup API v4). **Off by default:** nothing is sent until an admin saves an API key and turns it on (Settings → Safe Browsing; or `SAFE_BROWSING=true` with `SAFE_BROWSING_KEY`). The key is kept in Secret Manager only, never in Firestore, the logs or the dashboard's answers | link addresses, without the `#…` part, and for one-time links (password resets, sign-in, unsubscribe) without the query string, so tokens never leave | Google's API terms. The Lookup API is for non-commercial use, as a district's own protection is; otherwise use Google's Web Risk API | Settings → Safe Browsing (`SAFE_BROWSING`, `SAFE_BROWSING_KEY`) |
| **Phishing lists** (OpenPhish, HaGeZi, TweetFeed and Sefinek on GitHub, Phishing Army) | nothing about email: the lists are downloaded once a day and matched in the service | downloads only | `PHISHING_LISTS` |
| **Cloudflare's public resolver** (`cloudflare-dns.com`), for the look-alike watch (0.5.36) | look-alike names of your own domains, made by the service (about 80 an hour, a pass a day): nothing from any email | Cloudflare's resolver privacy commitments | `LOOKALIKE_WATCH` |
| **Domain registries** (RDAP, found through IANA's list) | domain names: up to 3 unfamiliar link domains per email and the sender's domain, each at most once a month for the whole district | public registration records | `SITE_AGE` |

**Not sent:**
- links to the organization's own domains;
- anything for allowlisted senders.

**Short links are not looked up** with any outside service.

**List licenses:**
- OpenPhish community feed: its terms of use.
- Phishing Army: CC BY-NC 4.0 (non-commercial, as a district's own protection is).
- HaGeZi Threat Intelligence Feeds: GPL-3.0 (the list is used by the service, not redistributed).
- TweetFeed: CC0 1.0.
- Sefinek: MIT.
- Not used: URLhaus (abuse.ch). Its downloads need an abuse.ch key since October 2026 (free for
  non-commercial use); keyless downloads answer "410 Gone".

**Settings → Update** reads the approved versions from GitHub (`api.github.com` and
`raw.githubusercontent.com`, the public `google_service_main` repository): the newest commit on main, and
that commit's `package.json`, `CHANGELOG.md` and `VENDOR.json`. The dashboard does, when the page is
opened (kept 10 minutes), and from 0.5.24 the worker once an hour (its hourly job), to alert the admins when an
approved version needs a manual install. It is read anonymously: no token, a plain User-Agent
(`spruce-mail-protection`), nothing about your installation, users or mail. An update's build downloads
the same repository from Cloud Build.

**The AI model** is downloaded when the image is built (install, `deploy/update.sh`, `deploy/upgrade.sh`,
Settings → Update; not while the service runs): its files come from `raw.githubusercontent.com`, the
public TinyPhishLLM repository, at the commit the version pins (`vendor/spruce/VENDOR.json`), and are
used only if each file's SHA-256 matches the pinned one (`tools/fetch-model.js`). The same anonymous
request: no token, nothing about your installation. TinyPhishLLM holds only the model and made-up
references; the training and its examples are in a private repository, and examples from your mail are
never committed anywhere.

The service's other network calls are to Google's own APIs (Gmail, Admin SDK, Firestore, Pub/Sub, IAM,
Cloud Scheduler, Cloud Build; with Settings → Link clicks on, the Admin SDK's Reports API for Gmail's logs).

## What users notice

- A moved email lands in Spam with the label `SPRUCE/Moved`. One an admin moves back returns to the Inbox
  with `SPRUCE/Moved back`. Nothing is withheld: every email reaches the mailbox, in the Inbox or in Spam.
- A user can always move a moved email back ("Not spam"). The service sees the Inbox label come back,
  never moves that email again, and shows admins that the user took it back.
- Monitor mode changes nothing in mailboxes (unless `MONITOR_LABEL` is set).
- Consider telling staff before the pilot that suspicious mail may be moved to Spam, and who to ask.

## The credential

Domain-wide delegation with `gmail.modify` can read and change every mailbox in the domain. The
deployment keeps it as narrow as Google allows:
- no key file exists (IAM signs for the service account, and only the Cloud Run identity may ask);
- only two scopes are granted;
- only the pilot group's (or unit's) mailboxes are watched.

Gmail API use by the service shows in the Workspace audit logs. Removing the delegation entry in the
Admin console switches all access off at once.
