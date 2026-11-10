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

## What it keeps (Firestore, in your own project and region)

For emails the policy moved, would have moved, or found suspicious, it keeps:
- the recipient, and the sender's name and address;
- the subject (`STORE_SUBJECTS`);
- the time;
- the checks' findings (the extension's short texts and weights);
- the flagged links;
- the AI score, and up to three short quotes (160 characters) the model weighed most (`STORE_AI_QUOTES`);
- Gmail's DMARC, SPF and DKIM results;
- attachment names;
- its Message-ID (the header Google Workspace's Email log search uses), and Gmail's ID of the copy;
- the decision, and who released or marked it (including "moved back by the user" when a user takes a
  moved email out of Spam themselves).

**Never kept:** email bodies or attachments.

For every other email it keeps only a daily count (emails checked) and the message ID, so it doesn't
judge the same email twice.

It also keeps, shared by every instance:
- **the phishing lists:** gzipped in Firestore, replaced daily;
- **registry dates of domains:** 30 days; an unknown one, a day.

And:
- **sender history:** a hash of each sender address, to tell "first email from this sender";
- **mailbox state:** each watched mailbox's sync position.

**Retention:** records and message IDs are deleted after `RETENTION_DAYS` (60 by default) by a daily job.
To delete what the dashboard shows sooner, all at once: `bash deploy/clear-data.sh` (docs/INSTALL.md,
"Clearing the dashboard's data").

## Who sees it

- **The dashboard:** only through Identity-Aware Proxy, and only for the addresses in `ADMIN_EMAILS` or
  the members of `ADMIN_GROUP` (accounts in your own domains).
  Every release and mark records who did it.
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
- **The CSV export** (Messages → Download CSV) holds what the Messages page shows: keep the file as you
  would the dashboard.
- **The retraining export** (Model health → Download for retraining) is off until an admin allows it in
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
  - The examples are used for training only in the extension's `tools/ai/data/extra/`, which is never
    committed. Whether they may go to an outside AI service to be reworded is your district's decision.

## What is sent elsewhere

Never the email itself, its text, its recipients or who received it. Only these, for the checks (each
can be turned off):

| Service | Sent | Kept there | Setting |
|---|---|---|---|
| **Cloudflare Security DNS** (`security.cloudflare-dns.com`, and `cloudflare-dns.com` to tell a block from a missing domain) | host names: the sites links point to, and the sender's domain. Never paths, addresses or anything else | Cloudflare's resolver privacy commitments (it doesn't sell or keep identifying query data) | `CLOUDFLARE_THREATS` |
| **Google Safe Browsing** (Lookup API v4). **Off by default:** nothing is sent unless `SAFE_BROWSING=true` | link addresses, without the `#…` part, and for one-time links (password resets, sign-in, unsubscribe) without the query string, so tokens never leave | Google's API terms. The Lookup API is for non-commercial use, as a district's own protection is; otherwise use Google's Web Risk API | `SAFE_BROWSING`, `SAFE_BROWSING_KEY` |
| **Phishing lists** (OpenPhish, Phishing Army, Sefinek on GitHub) | nothing about email: the lists are downloaded once a day and matched in the service | downloads only | `PHISHING_LISTS` |
| **Domain registries** (RDAP, found through IANA's list) | domain names: up to 3 unfamiliar link domains per email and the sender's domain, each at most once a month for the whole district | public registration records | `SITE_AGE` |

**Not sent:**
- links to the organization's own domains;
- anything for allowlisted senders.

**Short links are not looked up** with any outside service.

**List licenses:**
- OpenPhish community feed: its terms of use.
- Phishing Army: CC BY-NC 4.0 (non-commercial, as a district's own protection is).
- Sefinek: MIT.

The service's other network calls are to Google's own APIs (Gmail, Admin SDK, Firestore, Pub/Sub, IAM).

## What users notice

- A moved email lands in Spam with the label `SPRUCE/Moved`. A released one returns to the Inbox with
  `SPRUCE/Released`.
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
