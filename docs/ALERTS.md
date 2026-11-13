# Alerts: what each one means and what to do

An **alert** is a problem the admins are emailed about. Cloud Monitoring sends it to `ALERT_EMAIL` (the admin
group by default) with the subject **"SPRUCE Mail Protection Service: an alert from the service"**. The
email shows which alert it is (`alert`) and its message (`message`), which says what happened, what it
means for mail, and what to do. Each alert is also listed in the dashboard, **Status → Activity → Alerts**,
marked "alert, emailed to the admins".

- A problem that lasts is emailed **at most once a day**, not every time it happens. Activity lists every
  occurrence.
- An admin's own action (a policy change, an update started, a Safe Browsing key saved) is **not** an alert.
  It is noted in Activity → What admins did, and not emailed.
- `ALERT_EMAIL=off` emails nothing; the alerts still show in Activity. Google charges about $0.70 a month
  for the two alert policies that send the emails (docs/INSTALL.md, Costs).

The alerts are grouped below by what they are about. The name in brackets is the `alert` value in the email.

## Mail protection stopped or fell behind

These matter most: while one lasts, some mail isn't checked.

### Gmail refused the service (`gmail-access`)
- **When:** Gmail refuses the service's access to a mailbox (an error 401 or 403, a token refused).
- **What it means for mail:** new mail in the mailboxes affected isn't checked, often in **every** mailbox
  at once. Gmail's notifications keep coming, so the "No notification from Gmail" alert doesn't fire.
- **Usually:** the domain-wide delegation was removed, or its scopes changed, in the Admin console.
- **What to do:**
  1. Admin console → Security → Access and data control → API controls → Manage Domain Wide Delegation: is
     the service's client ID there, with every scope from docs/INSTALL.md, step 3?
  2. In Cloud Shell: `bash deploy/doctor.sh`.
  3. Once fixed, checking resumes by itself. Mail that arrived meanwhile is caught up the same way as after
     "The service fell behind".

### No notification from Gmail (`quiet`)
- **When:** no notification from Gmail for any watched mailbox for `QUIET_HOURS` (12 by default).
- **What it means for mail:** probably none is being checked. Gmail's notifications may be refused before
  they reach the service.
- **What to do:** docs/INSTALL.md, Troubleshooting, "The jobs and notifications are refused", or
  `bash deploy/doctor.sh`. Over a weekend or holiday with little mail, it can be a false alarm: send a test
  email to a watched mailbox.

### Watches ending (`watch-expiring`)
- **When:** some mailboxes' watches end within a day and weren't renewed.
- **What it means for mail:** once a watch ends, Gmail stops notifying the service about that mailbox, and
  its new mail isn't checked.
- **What to do:** Settings → Mailboxes → **Update group membership now**. If it keeps happening, the daily
  renewal job (`spruce-renew-watches`) is failing: Status → Service status, or `bash deploy/doctor.sh`.

### The service fell behind (`gaps`)
- **When:** the service fell behind on 10 or more mailboxes within 24 hours (`GAPS_ALERT_DAY`).
- **What happened:** Gmail keeps a list of what changed in each mailbox for about a week. When the service
  reads a mailbox after that list has run out, it can't see which emails arrived in between. It then starts
  again from that moment, and checks the mail still in the Inbox from the time it last looked, a batch at a
  time ("Caught up on …" in Activity when done).
- **What it means for mail:** new mail reached those Inboxes **before** it was checked. Mail still in the
  Inbox is checked now, and moved if it is phishing (in enforce mode; recorded in monitor mode). Mail the user already deleted or moved out of the Inbox
  meanwhile isn't checked.
- **Why:** once in a while is normal, after an outage. Ten in a day usually means Gmail's notifications
  weren't being processed for days (the worker stopped or kept failing, Pub/Sub backed up), or a bug.
- **What to do:**
  1. Status → Service status: are the worker, the jobs and the notifications all right now?
  2. Status → Activity → Errors and gaps: since when?
  3. In Cloud Shell: `bash deploy/doctor.sh`.
  4. If you know why (an outage, a long upgrade), nothing more is needed: the service catches up by itself.

### The service fell behind on one mailbox (`gaps-mailbox`)
- **When:** the service fell behind on the same mailbox 3 or more times within 7 days
  (`GAPS_ALERT_MAILBOX`). The alert names the mailbox; each mailbox has its own.
- **What it means for mail:** as above, for that mailbox only. Other mailboxes aren't affected unless they
  have their own alert.
- **Why:** this often for one mailbox usually means Gmail stops notifying the service about it, a problem
  with that account, or a bug.
- **What to do:**
  1. Settings → Mailboxes: when did Gmail last notify the service about it?
  2. Settings → Mailboxes → **Update group membership now** (it renews every watch).
  3. Admin console → Users: is the account active and licensed, with Gmail on?
  4. If it goes on, it may be a bug: note the mailbox and the times (Status → Activity, search for the
     mailbox) and report it.

### An email left unchecked (`unchecked-mail`)
- **When:** an email couldn't be checked after 3 tries, and was left in the mailbox unchecked.
- **What it means for mail:** that email (and any others listed under Activity → Errors and gaps that day)
  wasn't checked or moved.
- **What to do:** the message says why. A Gmail error points to "Gmail refused the service"; a one-off
  usually needs nothing. If it comes back every day, look at Activity → Errors and gaps for a pattern.

### Many errors (`errors`)
- **When:** 25 or more errors within an hour.
- **What it means for mail:** something stopped working (Gmail, Firestore, the model…). Some mail may be
  waiting to be checked; it is retried.
- **What to do:** Status → Activity → Errors and gaps says what failed; Status → Service status and
  `bash deploy/doctor.sh` check the rest.

### The AI model doesn't work (`ai-model`)
- **When:** the worker couldn't load the AI model, or the model's self-check failed, when an instance
  started.
- **What it means for mail:** emails are judged by the rule checks alone meanwhile (they still move clear
  phishing; the AI's score is missing).
- **What to do:** install the version again (`bash deploy/update.sh`, or `upgrade.sh` from the folder).
  Status → Service status shows the model's state.

### Who is in the pilot couldn't be read (`error`)
- **When:** the daily re-read of the pilot group or organizational unit failed.
- **What it means for mail:** the mailboxes already watched still are; people added or removed since aren't
  picked up.
- **What to do:** check `DIRECTORY_ADMIN`'s admin role and the domain-wide delegation scopes (docs/INSTALL.md,
  step 3).

### Gmail's notifications are waiting (optional, `PUBSUB_BACKLOG_ALERT=on`)
- **When:** Gmail's notifications have waited in Pub/Sub over 30 minutes (off by default; Google charges
  about $0.40 a month for it). Its email has its own subject: "SPRUCE Mail Protection Service: Gmail's
  notifications are waiting".
- **What it means for mail:** the worker isn't taking the notifications, so new mail isn't checked.
- **What to do:** Status → Service status and Activity → Errors; `bash deploy/doctor.sh`.

### A scheduled job failed (Cloud Monitoring)
- **When:** one of the service's scheduled jobs (`spruce-renew-watches`, `spruce-sync-feeds`,
  `spruce-update`) couldn't reach the worker. Its own subject: "SPRUCE Mail Protection Service: a scheduled
  job failed".
- **What to do:** if it says 401 or 403, docs/INSTALL.md, Troubleshooting, "The jobs and notifications are
  refused".

## Checks weaker for a while

Mail is still checked; one source of evidence is missing until it comes back.

### A phishing list missed its download (`list-download`)
- **When:** a phishing list couldn't be downloaded. Emailed when it first fails, then once a day while it
  keeps failing.
- **What it means for mail:** the checks use that list's previous copy. A banner on Overview says so.
- **What to do:** Settings → About shows what went wrong, and has **Re-check the lists now**. It is tried
  again every 3 hours. A day's outage at the list's host is common; days of it usually mean the list moved.

### A lookup service is down (`cloudflare-down`, `safeBrowsing-down`)
- **When:** every Cloudflare Security (or Google Safe Browsing) lookup has failed for 30 minutes.
- **What it means for mail:** links are "not checked" with that service (never "safe"); the other checks
  still run.
- **What to do:** usually nothing: it comes back by itself. Status → Service status shows how it is going.

### Google refuses the Safe Browsing key (`safe-browsing-key`)
- **When:** Google refuses the saved API key (revoked, restricted, quota).
- **What it means for mail:** links aren't looked up with Google until it works again.
- **What to do:** Settings → Safe Browsing shows what Google said, and lets you save a new key.

### Gmail's logs couldn't be read (`click-logs`)
- **When:** Settings → Link clicks is on (off by default), and Google refused the service's request for
  Gmail's logs about re-checked mail.
- **What it means for mail:** nothing for the checks. Email → Re-checked can't say who clicked a link in
  mail found to be phishing after delivery; it still says who got it and whether it was opened.
- **Usually:** the scope `https://www.googleapis.com/auth/admin.reports.audit.readonly` isn't on the
  service's domain-wide delegation entry, the admin typed on Settings → Link clicks lost the Reports
  privilege, or the Workspace edition has no Gmail logs in the Reports API.
- **What to do:** Settings → Link clicks → Test says what Google answered. docs/INSTALL.md, "Link clicks".
  Emailed at most once a day.

### Spamhaus refused the key or the lookups (`spamhaus-key`)
- **When:** Settings → Spamhaus is on (off by default) and Spamhaus answers the service's lookups with an
  error: the key disabled, the key used in a way its terms don't allow, or a mistyped zone. Emailed at most
  once a day.
- **What it means for mail:** domains aren't looked up with Spamhaus meanwhile (they are "not checked",
  never "clean"); every other check still runs.
- **What to do:** Settings → Spamhaus shows Spamhaus's answer. Check the key in Spamhaus's portal (a free
  account must stay within its fair use: non-commercial, under 100,000 lookups a day), or save a new one.
  abuse.ch refusing its key shows as a list that missed its download (`list-download`, above): URLhaus or
  ThreatFox, with "the key was refused"; Settings → abuse.ch.

## Phishing that needs a decision

### Moving is paused: the brake (`brake`)
- **When:** far more emails were moved within an hour than the limit (`BRAKE_PER_HOUR`, or automatic).
- **What it means for mail:** nothing is moved in any mailbox until an admin resumes; emails that would be
  moved stay in the Inbox.
- **What to do:** look at Email → Messages, then on Overview **Resume**, moving the held emails to Spam or
  leaving them (docs/INSTALL.md, "In enforce mode, the brakes").

### Moving a campaign is paused (`campaign-held`)
- **When:** many copies of one campaign were moved on evidence nothing outside the email confirms.
- **What to do:** Email → Campaigns → open it → **Confirm phishing** (every copy to Spam) or **False alarm**
  (the moved ones back to the Inbox).

### A large campaign (`campaign`)
- **When:** many copies of one campaign were moved to Spam.
- **What to do:** nothing needed. Email → Campaigns lists who received it, if you want to warn them.

### One outside account shared with many of your people (`mass-share`)
- **When:** the same outside account sent a document share or signature request to 10 or more of your
  people within an hour (the usual sign of an account taken over elsewhere).
- **What to do:** if it's phishing, Email → Campaigns → open it → **Confirm phishing** moves every copy.

### Re-checked mail (`recheck`)
- **When:** an email already delivered to an Inbox is found to be phishing on a re-check: a phishing list
  added one of its link sites or its sender after it arrived, or a second look an hour or a day after it
  arrived found more (a site Safe Browsing or a list has by then). One alert per hourly run, for every email
  found in it.
- **What it means for mail:** people had the email in their Inbox for a while. The re-check did what a
  check on arrival would have: moved each copy still in an Inbox to Spam (enforce mode, through the
  brakes), or recorded it as "would move" (monitor mode). A copy its reader had already archived or
  deleted is left where it is.
- **What to do:** dashboard, **Email → Re-checked**: every copy, who got it, when it was delivered,
  whether it had been opened, and (Settings → Link clicks on) whether a link in it was clicked. Warn the
  people who opened it; for anyone who may have typed a password, see "A link was clicked" below. "Mark all
  as seen" there clears the banner on Overview and Messages.

### A link was clicked (`recheck-click`)
- **When:** Settings → Link clicks is on, and Gmail's logs show that someone clicked a link (in the email,
  or in its attachment's preview) in an email found to be phishing after it was delivered.
- **What it means:** that person may have given their password, or downloaded something, on the
  phishing site.
- **What to do:** in the Admin console, for that user: reset the password, sign them out of every session
  (Users → the user → Security), check their recent sign-ins and any mail-forwarding rule or app access
  added since (Security → Investigation tool, or Reporting → Audit and investigation). Talk to them: what
  did they type in? Email → Re-checked shows when they clicked.

### A look-alike of your domain (`lookalike`)
- **When:** the look-alike watch (0.5.36) finds a newly registered domain that imitates yours: a letter left
  out, doubled, swapped or replaced (`maple-schoo1s.org`), another ending, or a district's usual forms
  (`hardee-k12.org`, `hardeeschools.com`). One alert per hourly run, for every one found in it. Not for those
  that existed before the watch's first pass (listed, no alert), unless registered in the last 30 days.
- **What it means:** someone may be preparing payroll, vendor or "the superintendent asks" fraud. From now
  on, mail from it, replies sent to it and links to it are strong signs of phishing (they move mail with the
  rules).
- **What to do:** dashboard, **Status → Look-alikes**: whether it has mail servers or a website, and when it
  was registered. If your district registered it (a defensive registration), mark it **It's ours**. Otherwise
  warn the business office and payroll; consider reporting it to the registrar, and blocking it in Gmail
  (Admin console → Apps → Gmail → Spam, phishing and malware → Blocked senders).

### A user moved a flagged email to the Inbox (`user-inbox`, `user-release`)
- **When:** a user took an email the checks flag into their Inbox, or back out of Spam.
- **What to do:** make sure it's safe, or confirm it as phishing and warn them.

## The service and its updates

### An update failed, or never finished (`update-failed`)
- **When:** an update started from Settings → Update failed, or didn't finish within 45 minutes.
- **What it means for mail:** nothing changed, unless the deploy stopped half-way; mail is checked by the
  version that was running.
- **What to do:** Cloud Build's history (tag `spruce-update`) has the log. If a deploy stopped half-way,
  `bash deploy/rollback.sh` goes back.

### An approved version needs a manual install (`update-manual`)
- **When:** the newest approved version changes the installation itself.
- **What to do:** in Cloud Shell, from the folder you installed or last upgraded from, `bash deploy/update.sh`.
  Until then, Settings → Update installs nothing.

### An admin's account was locked (`lockout`)
- **When:** an account typed a wrong project ID or email address 5 times within 10 minutes.
- **What to do:** ask the admin. If it wasn't them, someone may be using their signed-in session: sign them
  out of Google (Admin console → Users → Sign out). Activity → What admins did lists each try.
