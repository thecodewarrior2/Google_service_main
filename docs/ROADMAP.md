# Roadmap

What the service doesn't do yet, roughly in the order it would help.

1. **Network checks the extension has.** Each sends domain names to a third party, so each needs a
   privacy review and the service's own rate limits (the extension's per-service limits and back-off).
   - DNS threat resolvers (Quad9, Cloudflare Security…).
   - Phishing lists.
   - Short-link expansion: unshorten.me's free tier is too small at this scale; it needs a paid or
     self-hosted lookup.
   - Registry dates of link domains, and brand ownership.
2. **Retraining from real mail.** False alarms marked in the dashboard, de-identified and reviewed,
   become training examples for phish-tiny (the extension's `tools/ai/data/extra/`).
3. **Campaign actions.** "Move every copy" and "release every copy" for a whole campaign, plus finding
   earlier copies already delivered before the first one was judged.
4. **Notifications.** Email or chat alerts to IT when the brake trips or a large campaign arrives, and an
   optional daily digest to users of what was moved for them.
5. **Composite Firestore indexes**, for districts big enough that the dashboard's bounded reads (the
   latest 20,000 records in the period) aren't enough.
6. **Real admin quarantine** (Design B): an inbound gateway that adds a verdict header and a Gmail
   content-compliance rule that sends matching mail to an admin quarantine. Only if moving after
   delivery proves not to be enough.
7. **Attachment scanning** (QR codes in images and PDFs, as the extension does), with strict size and
   time limits.
