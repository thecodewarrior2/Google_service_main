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
- The cost for a small pilot is usually a few dollars a month (Cloud Run, Firestore, Pub/Sub, Cloud
  Scheduler). Check the project's billing page after the first week.

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
2. Link a billing account to it.
3. Write down its **project ID**. It's shown under the name and is not always the same as the name.

## 4. Upload and configure (Cloud Shell)

1. In the Cloud console, select the project, then open **Cloud Shell** (the `>_` button, top right).
2. In Cloud Shell, click **⋮ → Upload** and upload `spruce-mail-protection-0.2.3.zip`.
3. Unzip it and go into its folder:

   ```bash
   unzip spruce-mail-protection-0.2.3.zip
   ```

   ```bash
   cd spruce-mail-protection-0.2.3
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
   | `ADMIN_EMAILS` | who may open the dashboard, separated by semicolons |
   | `MODE` | leave `monitor` |

## 5. Install

```bash
bash deploy/install.sh
```

It goes through nine steps and can be run again at any time. It builds the service from the files you
uploaded and deploys two Cloud Run services:
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

1. **Open the dashboard address** and sign in as one of the `ADMIN_EMAILS`. The first time,
   Identity-Aware Proxy can take a few minutes to let you in.
2. **Settings → Mailboxes watched** should show the number of people in the group. If it shows 0:
   - look at **Overview → Recent activity** for an error;
   - see "Troubleshooting" below;
   - delegation changes can take a few minutes to apply. Then rerun the job from step 7.
3. **Send a test email** from an account outside your domain (a personal Gmail) to a pilot member:
   - A normal email shows up only in **Emails checked**.
   - An email whose text includes the link `http://malware.testcategory.com/` should be recorded. That
     address is Cloudflare's own test site for its malware block. The email should show in
     **Messages** as *Would be moved*, or at least *Suspicious*. In monitor mode it stays in the Inbox.
   - If Gmail puts the test email in Spam on its own, the service never sees it. It only reads mail
     that reaches the Inbox.
4. **The worker's log:**

   ```bash
   gcloud run services logs read spruce-worker --region=REGION --limit=50
   ```

## 7. Running the test

- **Add or remove people** in the security group. It applies daily, or at once with:

  ```bash
  gcloud scheduler jobs run spruce-renew-watches --location=REGION
  ```

  Removed members stop being watched.
- **Monitor for two to three weeks.**
  - Open the *Would be moved* emails.
  - Use **Mark false alarm** or **Confirm phishing**.
  - Watch **Model health**.
- **To move mail for real:**
  1. Set `MODE=enforce` in `deploy/settings.env`.
  2. Run `bash deploy/install.sh` again.

  Moved mail goes to Spam with the label `SPRUCE/Moved`. A user can always move it back, and the
  dashboard records that.
- **A new version:**
  1. Upload and unzip the new zip.
  2. Copy your `deploy/settings.env` into its folder.
  3. Run `bash deploy/install.sh` there.

## Turning it off

| How | What it does |
|---|---|
| `MODE=monitor` in `deploy/settings.env`, then `bash deploy/install.sh` | Nothing is moved from then on. Emails are still checked and recorded |
| `bash deploy/stop.sh` | Stops watching every mailbox: no email is read from then on. Running `install.sh` starts it again |
| Remove the domain-wide delegation entry in the Admin console | All access to mail ends at once |
| Delete the Cloud project | Removes the service and every record |

## Troubleshooting

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
- **Recent activity: "Couldn't watch …'s mailbox".**
  - That account may have no Gmail (no license, or Gmail turned off for it).
  - Or the delegation entry lacks `gmail.modify`.
- **"Identity-Aware Proxy could not be set up from here" (step 8/9).** The dashboard stays closed to
  everyone until you finish it in the console:
  1. Open **Cloud Run → spruce-admin → Security** and tick **Identity-Aware Proxy (IAP)**.
  2. In **Security → Identity-Aware Proxy**, give each admin the **IAP-secured Web App User** role on
     `spruce-admin`.

  IAP needs the project to be inside your Google Cloud organization.
- **The dashboard says you are not an admin.** IAP let you in, but your address isn't in
  `ADMIN_EMAILS`. Fix the setting and run `install.sh` again.
- **Firestore: unsupported location.** Pick another `REGION` that Firestore supports (for example
  `us-east1` or `us-central1`), then run `install.sh` again.
- **Build errors outside Cloud Shell.** Cloud Shell has Docker. Elsewhere, the script builds with Cloud
  Build, whose service account may need the **Cloud Build Service Account** role in a new project.
