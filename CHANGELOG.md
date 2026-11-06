# Changelog

## 0.2.5: Upgrade and rollback scripts

- **`deploy/upgrade.sh`:** run it from the new version's unzipped folder in Cloud Shell.
  - It finds the previous version's `deploy/settings.env` in your home folder (or takes the old folder
    as an argument) and copies it.
  - Settings new in this version are added empty, which means their defaults, never the example's
    values.
  - Before changing anything, it shows the installed version (read from the worker's image) and the
    new one, the `CHANGELOG.md` headings in between, and the delegation scopes this version uses. It
    asks before going on, and warns when going to an older version.
  - It then runs `install.sh` in upgrade mode, which doesn't stop at the delegation step.
- **`deploy/rollback.sh`:** sends all traffic on both services back to the previous ready Cloud Run
  revision, with the settings it had. Nothing is rebuilt. Run it again to go back further.
- **`install.sh`:**
  - moves traffic to the new build after each deploy (`update-traffic --to-latest`), so it also undoes
    a rollback;
  - in upgrade mode, keeps a service stopped by `deploy/stop.sh` stopped.
- **Docs:** `docs/INSTALL.md` has an "Upgrading to a new version" section.
- **Checked** against a stand-in `gcloud`:
  - an upgrade from a 0.2.3 folder (settings found and completed, no pause, traffic to the new build);
  - an upgrade of a stopped service (it stays stopped);
  - a rollback (it skips a revision that never became ready).

## 0.2.4: The dashboard's admins can be a group

- **`ADMIN_GROUP`:** the members of a group may use the dashboard, as well as (or instead of) the
  addresses in `ADMIN_EMAILS`. At least one of the two must be set.
  - Identity-Aware Proxy still lets them in first (granted to `group:…`). Then the service asks Google
    whether the signed-in address is in the group (`groups.hasMember`, which counts groups inside it).
    It asks as `DIRECTORY_ADMIN`, with the group-member read scope the pilot group already uses.
  - Answers are remembered for 5 minutes ("no" for 1 minute, so someone just added gets in soon).
  - Only accounts in `ORG_DOMAINS` can get in through the group.
  - If the check fails, nobody gets in through the group: the answer is 503 with the reason.
  - A group Google doesn't know is an error, not a silent "no".
- **`deploy/install.sh`:**
  - takes `ADMIN_GROUP` (the template now uses it, with `ADMIN_EMAILS` optional);
  - grants IAP to the group;
  - gives the dashboard `DIRECTORY_ADMIN`;
  - refuses to run when neither is set.
- **Docs:** `docs/INSTALL.md` creates a second security group for the dashboard; `DEPLOY.md`,
  `PRIVACY.md` and `README.md` updated.
- **Tests:**
  - listed addresses, group members, outside accounts, a failed check, and the remembered answers
    (added and removed members);
  - `hasMember`'s request, and an unknown address versus an unknown group;
  - the configuration needs `DIRECTORY_ADMIN` with a group.

## 0.2.3: Install for a test, limited to a security group

- **`PILOT_GROUP`: watch the members of a security group** (or several, separated by semicolons).
  - Groups inside it count (`includeDerivedMembership`).
  - Only active user accounts in `ORG_DOMAINS` are watched: suspended accounts, outside addresses and
    group entries are skipped.
  - Members are read daily by `renew-watches`, as `DIRECTORY_ADMIN`, with only the
    `admin.directory.group.member.readonly` scope. Removed members stop being watched.
  - `PILOT_OU` and `PILOT_USERS` still work, alone or together with a group.
- **A failed read of the pilot's members stops nothing.** Before, the error stopped the renewal
  silently; now the dashboard's Recent activity names what to check.
- **`deploy/install.sh`: one script, run from Cloud Shell, for the whole Google Cloud side.**
  - It covers APIs, Firestore, the three service accounts (no keys), Pub/Sub, a single built image for
    both services, the worker, the dashboard with Identity-Aware Proxy, the push subscription, the daily
    jobs, and the first run.
  - It pauses for the domain-wide delegation entry and prints the client ID and exact scopes.
  - Settings come from `deploy/settings.env`, read as data, never run as shell. Safe to run again: it
    updates what exists.
- **`deploy/stop.sh`** stops every watch and pauses the renewal; `install.sh` starts it again.
- **`docs/INSTALL.md`:** step by step for a test limited to a security group, with the Admin console
  steps (group, read-only directory admin, delegation), a test email, and troubleshooting.
- **The Settings page** shows the pilot group.
- **`tools/release.js`** builds the install zip.
- **Tests:**
  - group members are watched, removed members are stopped, and a failed read stops nothing and says so;
  - the members request covers nested groups, pages, the scope, and skips suspended and outside
    accounts.
- **Checked:**
  - the installer, against a stand-in `gcloud`;
  - the image, built and run in both roles: the worker refuses an unsigned push, the dashboard refuses
    anyone without Identity-Aware Proxy.

## 0.2.2: Emails a user moves back out of Spam are recorded

- **A user who takes a moved email back to the Inbox** ("Not spam", or dragging it out of Spam) is now
  seen. Before, the email stayed in the Inbox but the dashboard still showed it as in Spam.
  - The mailbox history is read for the Inbox label added back as well as for new messages
    (`historyTypes` messageAdded and labelAdded).
  - The record becomes "released", marked as by the user (`releasedByUser`), and counts as a false
    alarm unless an admin marks it phishing.
  - The service never moves that email again.
  - An alert says who moved it back. When the rules had flagged it (score 5+), it asks an admin to make
    sure it's safe, since the user may be about to click it.
- **An admin's own release** is noted on the record before Gmail is changed, so its Inbox label isn't
  counted as the user's. A message judged in the same batch as its Inbox label is not a rescue either.
- **Dashboard:**
  - The overview splits moved-back emails into by admins and by users, and has a "Moved back by users"
    figure.
  - Model health has a "By users" column per trigger.
  - Messages show "Moved back by user" and "Moved back to the Inbox by the user". When the checks had
    flagged it (score 5+) and no admin has reviewed it, the box is amber and asks for a look; the
    verdict line says it counts as a false alarm only because the user moved it back.
  - In monitor mode, the "Moved" figure also shows how many were moved back, by admins and by users.
- **Demo and mockup:** one staff member moved the fake storage notice back, with its alert.
- **Tests:** a user rescue is recorded once with its alert; an admin's release (even when its
  notification arrives mid-release) and a same-batch label are not rescues; the history request asks
  for both kinds as repeated parameters.

## 0.2.1: Cloudflare only for threat lookups (Google Safe Browsing off by default)

- **Google Safe Browsing is off unless `SAFE_BROWSING=true`,** at the maintainer's request, to be on the
  safe side about its quota and terms.
  - The code stays, and turning it on needs its API key (`SAFE_BROWSING_KEY`).
  - By default no link address leaves the district: threat lookups send only host names, to Cloudflare
    Security DNS.
  - The worker no longer needs a Safe Browsing key to start.
  - While off, links aren't sent for that lookup at all, so they don't count as "not checked".
- **Unchanged:** the phishing lists (downloaded, matched locally) and site age (domain names to their
  registries).
- **Demo mode and the mockup** now match a real deployment: no Safe Browsing findings. The fake
  storage notice is still moved, by its failed sender check, hidden filler and brand-new domain.
- **Tests:**
  - By default nothing is sent to Safe Browsing, even with a key set.
  - Cloudflare still flags links.
  - Turning Safe Browsing on without a key is refused.

## 0.2.0: network checks (Cloudflare, Safe Browsing, phishing lists, site age)

- **Cloudflare Security DNS** for link sites (where a link goes, and its own host) and the sender's
  domain (`src/intel/threats.js`):
  - Only host names are sent.
  - A 0.0.0.0 answer is a block. A name the filter says doesn't exist is asked again of Cloudflare's
    unfiltered resolver: if that one answers, it was a block; if not, the domain doesn't exist.
- **Google Safe Browsing** (Lookup API v4) for the links:
  - Up to 500 per request.
  - The `#…` part is never sent, and one-time links (the extension's `isSingleUseToken`) go without
    their query string.
  - Needs `SAFE_BROWSING_KEY` (from Secret Manager); the worker refuses to start without it unless
    `SAFE_BROWSING=false`.
- **The extension's phishing lists** (OpenPhish, Phishing Army, Sefinek scam senders;
  `src/intel/feeds.js`):
  - Downloaded once a day for the whole district by a new Cloud Scheduler task (`/tasks/sync-feeds`),
    and checked as the extension checks them.
  - Kept gzipped in Firestore (in chunks), shared by every instance, and matched locally.
- **Site age** from each domain's registry (RDAP, via IANA's list; `src/intel/rdap.js`):
  - Up to 3 unfamiliar link domains per email, plus the sender's domain.
  - Answers kept 30 days for everyone; 4 seconds at most per lookup.
- **What they change** (`src/engine/network.js`):
  - A link any check flags is dangerous, so the extension's dangerous-links weight counts it.
  - Sender's address on the scam-sender list: 5. Sender's domain blocked or listed: 5. Domain doesn't
    exist: 3.
  - Sender's domain under 30 days old: 2; a look-alike under 90 days old: 5.
  - Young link sites: the extension's `linkAgeSigns` (3 or 2).
  - A failed or slow lookup leaves things "not checked", never "safe".
  - Allowlisted senders and the organization's own sites are not looked up.
- **Not looked up:** short links (no unshorten.me or other outside unshortening service). A short link
  is judged by its own host and by what decodes offline.
- **Request limits** (`src/intel/http.js`, from the extension): a few requests at a time per service,
  and back-off after "too many requests" or repeated server errors. Answers are remembered so a
  campaign's copies cost one lookup.
- **Dashboard:**
  - Each email shows what was looked up.
  - Settings shows which checks are on, plus each phishing list's size and last update.
  - New top-reason groups: "Sender on a threat list", "Brand-new site or domain", "Made-up sender domain".
- **Demo mode** uses made-up answers for these checks (no network), so the demo shows what they add.
- **Tests:**
  - Cloudflare blocks, NXDOMAIN and failures.
  - What Safe Browsing is sent (no fragments or one-time tokens), batching, and no key.
  - List syncing once a day, sanitizing (never a protected brand's domain or a cloud-storage host),
    matching, and keeping the previous copy.
  - Registry dates, sharing, and slow registries.
  - Their effect on verdicts, including that a dead network never makes an email safer.
- **Checked once against the real services** from the development machine (not Safe Browsing: no key
  there):
  - Cloudflare blocked its own malware test domain.
  - The three lists downloaded in 1.6 s (144,400 phishing sites).
  - Three registry lookups took 0.7 s.

## 0.1.0: first testing version

- **Worker:**
  - takes Gmail notifications through Pub/Sub and reads new Inbox messages (raw) through domain-wide
    delegation, without a key file;
  - judges them with the S.P.R.U.C.E+ extension's checks and phish-tiny model (extension 5.94.6,
    model 0.4.0; `vendor/spruce/`);
  - moves to Spam when the rules flag a message, or when the AI scores 85% or more for an outside sender.
- **Safety:**
  - monitor mode by default;
  - the AI score alone never moves inside mail;
  - allowlists;
  - a brake (moves per hour) that pauses moving until an admin resumes;
  - releases recorded with who did them.
- **Dashboard** behind Identity-Aware Proxy for `ADMIN_EMAILS`:
  - overview, campaigns, users, messages with each decision;
  - Release, Mark false alarm, Confirm phishing;
  - model health and settings.
  - Plain HTML, CSS and JavaScript, light and dark, works on a phone.
- **Records** in Firestore with no email bodies, deleted after 60 days. Daily jobs renew watches and
  delete old records; a task stops every watch.
- **Two Cloud Run services from one image** (`ROLE=worker`, `ROLE=admin`).
- **Demo mode** with an invented district: every record is judged by the real engine; it refuses Cloud
  Run. `tools/build-mockup.js` makes a one-file clickable mockup of the dashboard.
- **Tests:** engine, HTML reading, policy, pipeline (fake Gmail), brake, release, watches, retention,
  authorization of every route, and the dashboard API on the demo data.
- **Known:** `npm audit` reports 6 moderate advisories in dependencies of the Firestore client library
  (`minimatch` and `rimraf` used for file-path matching, not reachable with email content);
  `npm audit fix` can't resolve them without breaking changes.
