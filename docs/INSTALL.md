# Installing for a test, limited to one security group

This sets up S.P.R.U.C.E+ Mail Protection in a Google Cloud project of your own. Only the mailboxes of
the members of **one security group** are watched. It starts in **monitor mode**, so nothing is moved:
the dashboard shows what *would* have been moved. Plan on 30 to 45 minutes.

One script, `deploy/install.sh`, does the Google Cloud part from Cloud Shell. Three steps happen in the
Admin console, because only a Workspace admin can do them. `docs/DEPLOY.md` explains each piece, if you
would rather do it by hand.

**Before you start:**
- Get your district's approval to read the pilot members' mail (see `docs/PRIVACY.md`).
- Tell the pilot members what is being tested.
- You need:
  - a **super admin** account in the Admin console;
  - permission to create a Google Cloud project with billing in your organization.
- **Cost: a pilot should cost nothing,** but Google requires a billing account on the project (see
  "Costs" below).

## 1. The pilot security group (Admin console)

1. In [admin.google.com](https://admin.google.com) go to **Directory → Groups → Create group**.
2. Fill it in:
   - **Name:** `SPRUCE Pilot`.
   - **Group email:** for example `spruce-pilot@yourdomain`.
   - **Labels:** tick **Security**. This makes it a security group. A label, once added, can't be
     removed.
3. Set the access settings:
   - **Who can join the group:** only invited users;
   - **Who can view members:** group managers;
   - **Allow members outside your organization:** off.
4. Add the members: start with yourself and two or three IT staff.
5. **For the dashboard**, create a second security group the same way, for example
   `spruce-admins@yourdomain`. Add the people who may open the dashboard. Keep it small: they see who
   received which suspicious email.

What counts as a member:
- **Groups inside the group count:** their members are watched too.
- **Only active accounts in your own domains are watched.** Suspended accounts and outside addresses
  are skipped.
- **Changes apply once a day** (03:17 UTC), or at once with the command in step 7.

## 2. The directory admin (Admin console)

The service needs to read who is in the group. It does that by acting as a dedicated admin account that
can only read groups. It never uses that account's password.

1. Create the role. Go to **Account → Admin roles → Create new role**:
   - name it `SPRUCE group reader`;
   - under **Admin API privileges**, tick only **Groups → Read**;
   - save it.
2. Create a user, for example `spruce-directory@yourdomain`:
   - give it a long random password, and 2-Step Verification if your policy requires it;
   - nobody signs in with it.
3. Assign it the new role: open the user, then **Admin roles and privileges → Assign roles**.

## 3. A Google Cloud project

1. In [console.cloud.google.com](https://console.cloud.google.com), create a **new project** in your
   organization, for example `spruce-mail-test`.
2. Link a billing account to it. Google requires one for Cloud Run even when nothing is charged; the
   installer stops if none is linked. See "Costs" below.
3. Write down its **project ID**. It's shown under the name and is not always the same as the name.

## 4. Upload and configure (Cloud Shell)

1. In the Cloud console, select the project, then open **Cloud Shell** (the `>_` button, top right).
2. In Cloud Shell, click **⋮ → Upload** and upload `spruce-mail-protection-0.3.4.zip`.
3. Unzip it and go into its folder:

   ```bash
   unzip spruce-mail-protection-0.3.4.zip
   ```

   ```bash
   cd spruce-mail-protection-0.3.4
   ```

4. Make your settings file:

   ```bash
   cp deploy/settings.example.env deploy/settings.env
   ```

   ```bash
   nano deploy/settings.env
   ```

5. Fill it in, then save (Ctrl+O, Enter) and close (Ctrl+X):

   | Setting | Put in |
   |---|---|
   | `PROJECT` | the project ID from step 3 |
   | `REGION` | a region near you, for example `us-east1` |
   | `ORG_DOMAINS` | your email domain(s), separated by semicolons |
   | `PILOT_GROUP` | the security group from step 1 |
   | `DIRECTORY_ADMIN` | the account from step 2 |
   | `ADMIN_GROUP` | the dashboard group from step 1 |
   | `ADMIN_EMAILS` | optional: more people who may open the dashboard, separated by semicolons |
   | `MODE` | leave `monitor` |
   | `BUDGET_ALERT` | leave `1`: an email at the first charge (see "Costs") |
   | `TIME_ZONE` | your time zone, for example `America/New_York`: the nightly jobs and the weekly summary use it (empty = UTC) |
   | `ALERT_EMAIL` | leave empty: alerts go to `ADMIN_GROUP`. That group must accept email from outside the domain (alerts come from Google Cloud); otherwise put a person's address. `off` for none |

## 5. Install

```bash
bash deploy/install.sh
```

It goes through nine steps and can be run again at any time. It builds the service from the files you
uploaded and deploys two Cloud Run services. (It builds with Docker in Cloud Shell. If Docker can't
upload the result, which sometimes happens in Cloud Shell, it says so and builds with Cloud Build
instead, which takes a few minutes.)
- **`spruce-worker`** reads the pilot mailboxes. Only Gmail's notifications and the daily jobs can
  reach it.
- **`spruce-admin`** is the dashboard, behind Identity-Aware Proxy.

At **step 4/9** it stops and shows a **Client ID**. Leave Cloud Shell open and do this in the Admin
console:

1. Go to **Security → Access and data control → API controls → Manage Domain Wide Delegation → Add
   new**.
2. Paste the Client ID.
3. Paste these two scopes, exactly, as one comma-separated line:

   ```
   https://www.googleapis.com/auth/gmail.modify,https://www.googleapis.com/auth/admin.directory.group.member.readonly
   ```

4. Click **Authorize**, then go back to Cloud Shell and press Enter.

When it finishes, it prints the **dashboard address**.

## 6. Check that it works

1. **Open the dashboard address** and sign in as a member of `ADMIN_GROUP`. The first time,
   Identity-Aware Proxy can take a few minutes to let you in.
2. **Settings → Mailboxes watched** should show the number of people in the group, and list each
   mailbox with the last time Gmail notified the service about it.
   - **Overview → Recent activity** has a "Watching … mailboxes" line after each re-read of the group.
     It says how many entries the group has, and why any were left out.
   - If it shows fewer than you expect, see "Troubleshooting" below.
   - Delegation changes can take a few minutes to apply. Then rerun the job from step 7.
3. **Send a test email** from an account outside your domain (a personal Gmail) to a pilot member:
   - A normal email shows up only in **Emails checked**.
   - Mail you send from a watched mailbox to itself isn't checked: it's your own sent mail.
   - An email whose text includes the link `http://malware.testcategory.com/` should be recorded. That
     address is Cloudflare's own test site for its malware block. The email should show in
     **Messages** as *Would be moved*, or at least *Suspicious*. In monitor mode it stays in the Inbox.
   - If Gmail puts the test email in Spam on its own, the service never sees it. It only reads mail
     that reaches the Inbox.
4. **The worker's log:**

   ```bash
   gcloud run services logs read spruce-worker --region=REGION --limit=50
   ```

   Each notification from Gmail adds a line such as `notification: 1 new in the Inbox, 1 checked`. Each
   re-read of the group adds `renew-watches: Watching …`. The log can lag a minute behind.

## 7. Running the test

- **Changing a setting:** edit `deploy/settings.env` and run `bash deploy/install.sh`. It doesn't rebuild
  when the files are the same as last time (about a minute). `FORCE_BUILD=1 bash deploy/install.sh`
  rebuilds anyway.
- **Add or remove people** in the security group. It applies daily, or at once with **Settings →
  Update group membership now** in the dashboard, or with:

  ```bash
  gcloud scheduler jobs run spruce-renew-watches --location=REGION
  ```

  Removed members stop being watched.
- **Monitor for two to three weeks.**
  - Open the *Would be moved* emails.
  - Use **Mark false alarm** or **Confirm phishing**.
  - Watch **Model health**.
  - **Readiness** turns these into checks; switch when they are all green.
- **To move mail for real:**
  1. Set `MODE=enforce` in `deploy/settings.env`.
  2. Run `bash deploy/install.sh` again.

  Moved mail goes to Spam with the label `SPRUCE/Moved`. A user can always move it back, and the
  dashboard records that.
- **In enforce mode, the brakes** (README, "Careful by default"):
  - **A campaign held for your decision** (an alert, and a banner on Overview). Many copies were moved on
    evidence nothing outside the email confirms, so the rest wait in the Inbox. Open it:
    - **Confirm phishing** moves every copy, optionally searching every watched mailbox for more;
    - **False alarm** releases the moved ones, and later copies aren't moved.
  - **The domain-wide brake** (an alert, and a red banner). Far more moves in an hour than a campaign
    makes: something may be wrong. Look at Messages, then:
    - **Resume and move held mail** moves what it held;
    - **Resume without moving** leaves it in the Inbox.
  - Clear phishing (rules plus outside confirmation) is never held.
- **A new version:** see "Upgrading to a new version" below.

## Upgrading to a new version

Your settings, records and the Admin console steps carry over.

**The quick way: from the approved releases.** In Cloud Shell, from the folder you installed or last
upgraded from:

```bash
bash deploy/update.sh
```

It downloads the newest approved version from `google_service_main`, unpacks it next to your folder, and
runs its `upgrade.sh` (below). That shows what changes, including the AI model's version, and asks first.
The AI model (phish-tiny) comes with each version, so a new model arrives only with an approved version.

**From a zip:**

1. In Cloud Shell, upload the new zip, then unzip it **next to the old folder** (both in your home
   folder):

   ```bash
   unzip spruce-mail-protection-NEW.zip
   ```

   ```bash
   cd spruce-mail-protection-NEW
   ```

2. Run the upgrade:

   ```bash
   bash deploy/upgrade.sh
   ```

What it does:
- **Settings:** it finds your `deploy/settings.env` in the old folder and copies it. Settings new in
  this version are added empty, which means their defaults. To name the old folder yourself:
  `bash deploy/upgrade.sh ../spruce-mail-protection-OLD`.
- **Before changing anything,** it shows the installed version and the new one, what's new (from
  `CHANGELOG.md`), and the delegation scopes this version uses. It asks before going on.
- **Then it runs `install.sh`** without stopping at the delegation step. Mode stays as set. If
  `deploy/stop.sh` had stopped the service, it stays stopped.

**Going back:** to return both services to the build that ran before, run:

```bash
bash deploy/rollback.sh
```

- It's quick: nothing is rebuilt, and the earlier build comes back with the settings it had.
- Run it again to go back one more. Only the newest 3 builds are kept, so you can go back 2.
- The next upgrade or install moves forward again.

## Turning it off

| How | What it does |
|---|---|
| `MODE=monitor` in `deploy/settings.env`, then `bash deploy/install.sh` | Nothing is moved from then on. Emails are still checked and recorded |
| `bash deploy/stop.sh` | Stops watching every mailbox: no email is read from then on. Running `install.sh` starts it again |
| Remove the domain-wide delegation entry in the Admin console | All access to mail ends at once |
| Delete the Cloud project | Removes the service and every record |

## Clearing the dashboard's data

To start counting again, for example after a trial and before going live, run this in Cloud Shell
from the folder you installed or last upgraded from:

```bash
bash deploy/clear-data.sh
```

It shows what it deletes and what it keeps, and asks you to type the project ID first.
- **Deleted:**
  - every recorded email (Overview, Messages, Campaigns, Users, Review, Model health, Readiness);
  - the daily counts;
  - campaign holds and admins' campaign decisions;
  - the Activity page.
- **Kept:**
  - the watched mailboxes;
  - which emails were already checked, so none is judged twice;
  - your Settings switches and the brake's state;
  - sender history and the phishing lists.
- **Gmail:** nothing in it changes.
- **Afterwards:** Activity starts with one entry saying who cleared it, and the dashboard restarts so
  it drops its copy of the records.

It can't be undone.

| Option | What it does |
|---|---|
| `--keep-activity` | Keeps the Activity page (what admins did, alerts) |
| `--reset-clock` | Also restarts the monitor-mode clock: Readiness counts days again, and senders are learned for 14 days again |
| `--even-if-held` | Clears even when the brake or a campaign hold is on. The emails they held stay in the Inbox and are no longer tracked, so decide on them on the dashboard first |
| `--yes` | No question (for scripts) |

It needs the same access as `install.sh`, and nobody can clear the data from the dashboard.

## Costs

Google requires a billing account on the project before it runs Cloud Run, Cloud Scheduler, Cloud
Build or Artifact Registry, even when nothing is charged. A pilot of a few dozen mailboxes should stay
within the free monthly allowances. The table shows about what a 50-mailbox pilot uses (Google's free
amounts change; check its pricing pages):

| Piece | Free each month | A 50-mailbox pilot uses about |
|---|---|---|
| Cloud Run | 2 million requests, 180,000 CPU-seconds | 60,000 requests, 30,000 CPU-seconds |
| Firestore | 50,000 reads and 20,000 writes a day, 1 GB | a few thousand writes a day |
| Pub/Sub | 10 GB | well under 1 GB |
| Cloud Scheduler | 3 jobs | 3 jobs (one runs hourly: the health check) |
| Cloud Monitoring alerts | log-based alerts read no metrics | 2 alert policies, expected free (the budget alert would say otherwise) |
| Cloud Build (only when Docker can't upload) | 2,500 build-minutes | a few minutes per install |
| Cloud Storage (only with Cloud Build) | 5 GB in `us-east1`, `us-central1` and `us-west1` | about 5 MB per install (the uploaded source) |
| Artifact Registry | 0.5 GB | 3 builds (the installer deletes older ones) |

The installer keeps it there:
- **A budget alert** (`BUDGET_ALERT`, 1 by default, in your billing account's currency). Google emails
  the billing account's admins as soon as this project is charged anything, then again at half and all
  of the amount. It warns, it doesn't stop the service.
  - Creating it needs the **Billing Account Administrator** or **Costs Manager** role on the billing
    account. Without that, the installer says so and carries on; ask the billing admin to add it in
    **Billing → Budgets & alerts**, scoped to this project.
- **Only the newest 3 builds are kept** in Artifact Registry. Google applies the cleanup about once a
  day.
- **Instance limits:** at most 10 workers and 3 dashboards running at once, so a burst of mail can't
  run up the bill.

To turn the alert off, set `BUDGET_ALERT=off`.

## Investigating an email in Google Workspace

Every recorded email shows its **Message-ID**, with a **Copy** button (Messages → open the email →
Details).
- In the Admin console, go to **Reporting → Email log search** and paste it into **Message ID**: you see
  every delivery of that email in the domain.
- Or use the **security investigation tool** (Gmail log events, Message ID), where your edition has it.
- For an email someone reported but the service didn't record: **Messages → Check an email**. Paste its
  original (in Gmail: ⋮ → Show original → Copy to clipboard). You see what the service would decide, and
  its Message-ID.

## Troubleshooting

- **Start with the Status page** in the dashboard. In Cloud Shell, `bash deploy/doctor.sh` checks the
  rest (the subscription, Gmail's permission to publish, the jobs, the alert policies, recent errors)
  and says what to run.

- **"Gmail couldn't be allowed to publish" (step 5/9).** An organization policy, *Domain restricted
  sharing* (`iam.allowedPolicyMemberDomains`), allows only your own domain's accounts. Gmail's
  notifications come from Google's own `gmail-api-push@system.gserviceaccount.com`.
  1. An organization admin opens **IAM & Admin → Organization policies → Domain restricted sharing**
     for this project only.
  2. They choose **Manage policy → Override parent's policy**, and allow all.
  3. Run `install.sh` again.

  The exception covers this project alone.
- **Recent activity: "Couldn't read who is in the pilot …".** Check, in this order:
  1. the group address in `PILOT_GROUP`;
  2. the `SPRUCE group reader` role (Admin API privileges → Groups → Read) and that it's assigned to
     `DIRECTORY_ADMIN`;
  3. the delegation entry's second scope.

  Then rerun the job from step 7.
- **Fewer mailboxes watched than people in the group.** Read the latest "Watching … mailboxes" line in
  Recent activity. It says what was left out:
  - **not active:** suspended or archived accounts are never watched;
  - **outside your domains:** the address's domain isn't in `ORG_DOMAINS` (it must match exactly). If
    it's one of yours, add it to `ORG_DOMAINS` in `deploy/settings.env` and run `install.sh` again;
  - **an "all users in the organization" entry:** it isn't expanded. Add the people, or a group of
    them, instead;
  - **couldn't be watched:** an error for that mailbox is listed too, usually an account without Gmail.

  No "Watching" line at all after you run the job means the job didn't reach the service: look for
  `tasks/renew-watches` in the worker's log.
- **A mailbox that gets mail shows "None yet" under Last notification** (Settings): Gmail isn't
  notifying the service about it. Run `install.sh` again: step 5 lets Gmail publish to the topic, and
  step 9 starts the watches again.
- **"Alerts couldn't be set up from here" (step 9/9).** The alerts still show on the dashboard (Overview,
  Activity). Setting them up needs the Monitoring Editor role, or Owner, on the project. Run `install.sh`
  again with it.
- **No alert emails arrive.** The address in `ALERT_EMAIL` (or the admin group) must accept email from
  outside the domain: alerts come from Google Cloud (`alerting-noreply@google.com`). For a group, allow
  external senders, or put a person's address in `ALERT_EMAIL`.
- **Recent activity: "A message couldn't be checked (try 1 of 3 …)".** A Gmail or Firestore error. It is
  tried again within a few minutes, up to 3 times; nothing needs doing unless the same message ends in
  "after 3 tries", which is then left where it is (the reason follows the colon).
- **Recent activity: "Couldn't watch …'s mailbox".**
  - That account may have no Gmail (no license, or Gmail turned off for it).
  - Or the delegation entry lacks `gmail.modify`.
- **"Identity-Aware Proxy could not be set up from here" (step 8/9).** The dashboard stays closed to
  everyone until you finish it in the console:
  1. Open **Cloud Run → spruce-admin → Security** and tick **Identity-Aware Proxy (IAP)**. Only on
     `spruce-admin`, **never on `spruce-worker`**: Gmail's notifications and the daily jobs can't sign
     in through IAP, so nothing would reach the worker (see "The jobs and notifications are refused").
  2. In **Security → Identity-Aware Proxy**, give the admin group (or each admin) the **IAP-secured Web
     App User** role on `spruce-admin`.

  IAP needs the project to be inside your Google Cloud organization.
- **The jobs and notifications are refused.** `install.sh` stops with "spruce-renew-watches couldn't
  reach the worker (UNAUTHENTICATED … 401)". Or Settings → Mailboxes watched says the group's last read
  "didn't reach the service", or shows a "Watch renews by" date that doesn't move after a re-read and an
  old "Last notification".
  - **Identity-Aware Proxy is on for `spruce-worker`.** This is the usual cause. `install.sh` turns it
    off there (from 0.2.11). By hand:

    ```bash
    gcloud beta run services update spruce-worker --region=REGION --no-iap
    ```

  - **Otherwise:** `gcloud run services get-iam-policy spruce-worker --region=REGION` must list
    `spruce-invoker` with `roles/run.invoker`. Run `install.sh` again to add it.

  Gmail's notifications refused meanwhile are delivered again by Pub/Sub (it keeps them 7 days), so the
  mail in between is checked once they get through.
- **The dashboard says you are not an admin.** IAP let you in, but you aren't in `ADMIN_GROUP` or
  `ADMIN_EMAILS`.
  - Someone just added to the group gets in within a minute.
  - Accounts outside your domain never get in through the group.
- **"Couldn't check the admin group".** Check:
  - the group address in `ADMIN_GROUP`;
  - the directory admin's **Groups → Read** role;
  - the delegation entry's second scope (the same ones the pilot group needs).
- **Firestore: unsupported location.** Pick another `REGION` that Firestore supports (for example
  `us-east1` or `us-central1`), then run `install.sh` again.
- **Step 6/9: "dial tcp …:443: connect: connection refused"** after `The push refers to repository`.
  Docker in Cloud Shell couldn't reach Artifact Registry. This is a Cloud Shell network problem, not
  your settings. The installer goes on with Cloud Build by itself. Versions before 0.2.7 stopped here.
- **Step 6/9: Cloud Build fails.** Its log is printed above the message.
  - **A permission error about `spruce-build`** right after it was created: new permissions take a
    minute or two to apply. Run `install.sh` again.
  - **A region error:** Cloud Build runs in `REGION`. Pick a region it supports, for example `us-east1`.
