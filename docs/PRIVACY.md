# Privacy: what the service reads, keeps and shows

Have your district's privacy officer and legal counsel review this before a pilot. It covers staff and
student email, which FERPA, state student-data law, and your Google Workspace for Education agreement
protect.

## What it reads

- **Every new message in the Inbox of each watched mailbox** (the pilot unit), through the Gmail API,
  within seconds of delivery.
  - The whole raw message is read **in memory only** while it is judged, then discarded.
  - Attachments are listed by name and type only; their contents are not read.
- **Not read:** sent mail, drafts, mail already in Spam, and mailboxes outside the pilot.
- **Who is in the pilot unit,** read through the Admin SDK by an admin account with only read access to
  users.

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
- the decision, and who released or marked it.

**Never kept:** email bodies or attachments.

For every other email it keeps only a daily count (emails checked) and the message ID, so it doesn't
judge the same email twice.

It also keeps:
- **sender history:** a hash of each sender address, to tell "first email from this sender";
- **mailbox state:** each watched mailbox's sync position.

**Retention:** records and message IDs are deleted after `RETENTION_DAYS` (60 by default) by a daily job.

## Who sees it

- **The dashboard:** only through Identity-Aware Proxy, and only for the addresses in `ADMIN_EMAILS`.
  Every release and mark records who did it.
- **The service's own accounts:** in your Cloud project, under IAM. Limit project access to the people
  who run the service.

## What is sent elsewhere

**Nothing.**
- The engine works offline: link decoding, the checks and the AI model all run inside the service.
- The only network calls are to Google's own APIs (Gmail, Admin SDK, Firestore, Pub/Sub, IAM).
- `docs/ROADMAP.md` lists checks that would need outside services (DNS threat lookups, phishing lists,
  registry dates). Each would send only domain names and would get its own review first.

## What users notice

- A moved email lands in Spam with the label `SPRUCE/Moved`. A released one returns to the Inbox with
  `SPRUCE/Released`.
- Monitor mode changes nothing in mailboxes (unless `MONITOR_LABEL` is set).
- Consider telling staff before the pilot that suspicious mail may be moved to Spam, and who to ask.

## The credential

Domain-wide delegation with `gmail.modify` can read and change every mailbox in the domain. The
deployment keeps it as narrow as Google allows:
- no key file exists (IAM signs for the service account, and only the Cloud Run identity may ask);
- only two scopes are granted;
- only the pilot unit's mailboxes are watched.

Gmail API use by the service shows in the Workspace audit logs. Removing the delegation entry in the
Admin console switches all access off at once.
