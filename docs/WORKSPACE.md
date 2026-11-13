# Google Workspace settings that work alongside the service

S.P.R.U.C.E Mail Protection Service checks mail after Gmail delivers it. Some protections are better done by
Gmail itself, before delivery or on mail your own people send. These are suggestions, set in the Google Admin
console by a Gmail settings administrator. Google moves and renames its menus from time to time: check the
names against your Admin console and Google's help pages linked below. Changes can take up to 24 hours to
apply.

## A staff account sending like a phisher: an outbound recipient limit

When an account is taken over, it is often used to send phishing to many people at once. The service doesn't
judge outgoing mail, and judging internal mail by how many people it goes to would catch every all-staff,
per-school, per-grade and student-body message (hundreds or thousands of recipients). A Gmail compliance rule
on mail going **outside** the organization catches the takeover without that.

What works well (the approach this project's own district uses): quarantine any message sent outside the
organization to more than about 50 recipients, with a short list of addresses allowed to exceed it (the
newsletter account, the superintendent's office, and the like). A quarantined message waits for an admin to
release or reject it.

1. **Make the quarantine** (super admin): Admin console → Apps → Google Workspace → Gmail → **Manage
   quarantines** → **Add quarantine**. Name it (for example "Many outside recipients"), choose a reviewers
   group, and set what happens when a message is denied (drop it, or send the default reject message).
   [Google's help: Set up email quarantine](https://support.google.com/a/answer/6104172)
2. **Make the rule:** Admin console → Apps → Google Workspace → Gmail → **Compliance** → **Content
   compliance** → **Configure** (or **Add another rule**), on the top organizational unit:
   - Email messages to affect: **Outbound** (mail to outside the organization).
   - Expression: **Advanced content match**, location **Recipients header**, match type **Matches regex**,
     an expression matching one address (an `@`), and a **minimum match count** of your limit plus one (51
     for a limit of 50).
   - Action: send the message to the quarantine you made (or **Reject message**, which Google's example
     uses: the sender gets a bounce).
   - Under **Show options**, use an **address list** to bypass the rule for the accounts allowed to send to
     more people.
   [Google's help: Set max recipients for outgoing messages](https://knowledge.workspace.google.com/admin/gmail/advanced/set-max-recipients-for-outgoing-gmail-messages),
   [Control message delivery based on content](https://support.google.com/a/answer/1346936)
3. Test it with a message to a few outside test addresses, temporarily with a low limit.

How recipients are counted (Bcc, groups) isn't spelled out by Google: test with your own lists.

## Gmail's own safety settings

Admin console → Apps → Google Workspace → Gmail → **Safety**. Each option has a choice of action (keep in the
Inbox with a warning, move to Spam, quarantine). Worth turning on:
- **Attachments:** protection against encrypted attachments from untrusted senders, attachments with scripts,
  and anomalous attachment types.
- **Links and external images:** identify links behind shortened URLs, scan linked images, show a warning
  for links to untrusted domains.
- **Spoofing and authentication:** protection against domain spoofing with similar domain names, spoofing of
  employee names, inbound email spoofing your own domain, and unauthenticated email.
- **Enhanced pre-delivery message scanning.**
- **Security sandbox** (some editions, such as Education Plus): opens attachments in a sandbox before
  delivery.

[Google's help: Advanced phishing and malware protection](https://support.google.com/a/answer/9157861)

## Your own domain

- **DMARC at `p=reject`** (or `p=quarantine`) on your domain, with SPF and DKIM set up, so mail forged with
  your address is refused by receivers, including Gmail. The service already treats a forged staff address
  as outside mail.
- **Register the obvious look-alikes yourself** (`yourdistrict-k12.org`, `yourdistrictschools.com`) if they
  are free, so nobody else can.

## Phishing-training services (KnowBe4, Wizer…)

Gmail must let your training service's emails through (its Google Workspace allow-listing guide: a content
compliance rule on its header, or its addresses in the inbound gateway or allowlist). The service checks them
like any email unless you also set **Settings → Phishing training** (0.5.44): the same header with its secret
token or sending addresses, and the vendor's link domains. Then they are let through unchecked, so the training
measures whether people spot phishing on their own.

## What the service adds on top

The service checks what Gmail delivered: links against security services and phishing lists, sender
look-alikes and colleagues' names, the platforms' notifications (Docs, DocuSign, Classroom), the AI model, and
more; and it moves or records what it finds (README). The two work together: Gmail's settings stop what is
clear before delivery; the service catches what got through and gives your admins the evidence.
