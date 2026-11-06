# Changelog

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
