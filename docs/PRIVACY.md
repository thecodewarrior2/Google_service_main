# Privacy: what the service reads, keeps and shows

Have your district's privacy officer and legal counsel review this before a pilot. It covers staff and
student email, which FERPA, state student-data law, and your Google Workspace for Education agreement
protect.

## What it reads

- **Every new message in the Inbox of each watched mailbox** (the pilot group or unit), through the Gmail API,
  within seconds of delivery.
  - The whole raw message is read **in memory only** while it is judged, then discarded.
  - Attachments are listed by name and type only; their contents are not read.
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

## Who sees it

- **The dashboard:** only through Identity-Aware Proxy, and only for the addresses in `ADMIN_EMAILS` or
  the members of `ADMIN_GROUP` (accounts in your own domains).
  Every release and mark records who did it.
- **The service's own accounts:** in your Cloud project, under IAM. Limit project access to the people
  who run the service.

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
