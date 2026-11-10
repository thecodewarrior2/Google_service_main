# Roadmap

What the service doesn't do yet, roughly in the order it would help.

1. **More of the extension's network checks.** Cloudflare Security, Safe Browsing, the phishing lists and
   site age are in (0.2.0). Still out:
   - **Short-link expansion:** deliberately, with no outside service. A self-hosted resolver could follow
     short links from the district's own project, at the cost of "clicking" them.
   - **Other DNS threat resolvers** (Quad9, Control D).
   - **Brand ownership checks.**
   - **Safe Browsing's Update API:** local hash prefixes, so link addresses are not sent at all.
2. **Retraining from real mail.** In since 0.3.2: the retraining export (Model health) and
   `docs/RETRAINING.md`. Still to do: a first round of training with the district's examples, and a
   held-out set that grows with each round.
3. **Campaign actions** are in (0.3.0). Still out: a campaign search over more than the last 7 days.
4. **Notifications.** Email alerts to IT are in (0.3.0: brakes, paused campaigns, large campaigns, Gmail
   gone quiet, failed jobs). Still out: chat alerts, and an optional daily digest to users of what was
   moved for them.
5. **Beyond 10,000 mailboxes:** the model run natively, dashboard rollups instead of every record in
   memory, the watch renewal spread over the day, a load test on a spare project. The plan, measured and
   with sources: `docs/SCALING.md`.
6. **Real admin quarantine** (Design B): an inbound gateway that adds a verdict header and a Gmail
   content-compliance rule that sends matching mail to an admin quarantine. Only if moving after
   delivery proves not to be enough.
7. **Attachment scanning** (QR codes in images and PDFs, as the extension does), with strict size and
   time limits.
