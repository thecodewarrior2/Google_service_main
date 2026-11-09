# S.P.R.U.C.E+ Mail Protection for Google Workspace

**Status: testing.** This is the testing repository. The approved product lands in
`google_service_main` (see `CLAUDE.md`).

S.P.R.U.C.E+ Mail Protection checks every new email in your Google Workspace domain with the same
checks and AI model as the S.P.R.U.C.E+ browser extension. It moves suspicious ones to Spam, or in
monitor mode only records them. An admin dashboard shows what was moved, why, which campaigns came in
and who was affected, and lets IT release an email back to the Inbox.

- **Runs in your own Google Cloud project** (Cloud Run, Pub/Sub, Firestore). Email is read through the
  Gmail API with domain-wide delegation and is not sent to any other service.
- **Same verdicts as the extension.** `vendor/spruce/` holds the extension's own checks (`shared.js`,
  `decoders.js`) and its phish-tiny model (`ai.js`, `models/`), copied unchanged by
  `tools/sync-engine.js`.
- **Careful by default:**
  - **Monitor mode** (records, moves nothing) until you switch to enforce mode.
  - **The AI score alone never moves mail from inside the organization.** The rules still can, for
    example when a staff account is compromised.
  - **Allowlisted senders and domains** are never moved.
  - **Both need DMARC to pass.** The allowlist and "inside the organization" go by the From address,
    which anyone can write. They count only when Gmail's own DMARC check passed for its domain. A
    forged allowlisted or staff address is judged like any mail from outside, and the record says so.
  - **A brake** stops moving after too many moves in an hour, until an admin resumes (the count then
    starts again).
  - **Every move can be undone** from the dashboard, and by the user: an email the user moves back
    out of Spam stays in the Inbox. It is recorded as released by the user (a false alarm unless an
    admin marks it phishing), and an alert asks an admin to check when the checks had flagged it.

## How it decides

For each new Inbox message:

1. The raw message is read the way the extension reads an opened email:
   - the sender, and Gmail's own DMARC/SPF/DKIM results;
   - the links, unwrapped offline;
   - the text a person sees, plus how the email hides text: filler after a large blank gap, or a body
     that is only pictures.
2. The extension's checks add up their signs:
   - forged or spam headers;
   - a brand-name or look-alike sender, or one named after the recipient;
   - dangerous links;
   - claims to be safe, and requests for passwords, codes, money or remote access;
   - a new sender from outside the organization.

   A score of 3 is amber, 5 is flagged.
3. The phish-tiny model scores the email (0–100%).
4. The policy acts:

| Situation | Action |
|---|---|
| The rules flag it (score 5+) | **Move to Spam** (label `SPRUCE/Moved`) |
| The AI scores **85%** or more (`AI_MOVE_THRESHOLD`), sender outside the organization (or a staff address without DMARC passing) | **Move to Spam** |
| Same, in monitor mode or while the brake is on | Recorded as "would move" |
| Amber, or a high AI score the policy doesn't act on (an inside sender) | Recorded as suspicious |
| Allowlisted sender, DMARC passing | Nothing |

It also looks things up (`src/intel/`; `docs/PRIVACY.md` says exactly what is sent where):

| Check | What is sent | What it adds |
|---|---|---|
| **Cloudflare Security DNS** | host names of link sites and the sender's domain | a blocked link is dangerous; a blocked or nonexistent sender domain is a sign |
| **Google Safe Browsing**: off for now (`SAFE_BROWSING=true` and a key turn it on) | link addresses (no `#…`; one-time links without their query) | a listed link is dangerous |
| **Phishing lists** (OpenPhish, Phishing Army, Sefinek) | nothing: downloaded once a day, matched in the service | listed links are dangerous; a listed sender address or domain is a sign. Your own domains count only as exact listed links and addresses, never as a whole site or domain |
| **Site age** (registries, RDAP) | domain names, to their own registry | brand-new link sites and sender domains are signs (stronger with sign-in or payment wording) |

A lookup that fails leaves an email "not checked", never "safe". Short links are **not** looked up:
there is no outside unshortening service. A short link is judged by its own host and by what decodes
offline.

## The dashboard

The dashboard keeps itself up to date: the page you're on is fetched again every 30 seconds while
the tab is visible (not while you're typing in it, or using it otherwise). The bar under the tabs says
when it last updated, and **Pause updates** stops it.

The dashboard has these pages:
- **Overview:** emails checked, moved and moved back (by admins and by users); users affected; moves per day by trigger; top
  reasons; largest campaigns; alerts.
- **Campaigns** and **Users:** each opens the list of emails behind it.
- **Messages:** search and filters, opening each email's decision.
  - It shows the signs found with their weights, flagged links, the AI score with what weighed most,
    and the sender check.
  - Buttons: **Release to Inbox**, **Mark false alarm**, **Confirm phishing**.
- **Model health:** recorded emails by AI score, and how often each kind of move was undone (and how
  often by users themselves). This is
  the number to tune the threshold with.
- **Settings:** the policy in force, read-only, and each watched mailbox with the last time Gmail
  notified the service about it.
  - **Update group membership now** re-reads the pilot group at once, instead of waiting for the daily
    run.
  - It also says when the group was last read and whether that reached the service.

The dashboard's numbers come from `src/dashboard/aggregate.js`. The clickable mockup
(`tools/build-mockup.js`) uses that same file with made-up data.

## Dependency updates

Dependabot proposes updates as pull requests on this repository: a weekly one with every minor and
patch update, and one per major version. GitHub runs the tests and `npm audit` on each pull request
(`.github/workflows/test.yml`). An update reaches the product like any change: merged here, installed,
tried, then approved for `google_service_main`. Security fixes come as soon as an advisory appears once
**Settings → Code security → Dependabot security updates** is on for this repository.

## Try it

```bash
npm install
```

```bash
npm run demo
```

Then open http://localhost:8080. The demo uses made-up data from an invented district
(`maple-schools.example`), and every record in it is produced by the real engine. Demo mode has no
sign-in and refuses to run on Cloud Run.

```bash
npm test
```

```bash
node tools/build-mockup.js
```

The last command writes `build/mockup.html`, a single file to share the look and feel.

## Deploying

**To test in your own Workspace, limited to one security group:** `docs/INSTALL.md`. A script,
`deploy/install.sh`, sets everything up from Cloud Shell; `deploy/upgrade.sh` installs a new version over
it, `deploy/rollback.sh` goes back, and `deploy/stop.sh` stops it.

See `docs/DEPLOY.md` (each piece, by hand) and `docs/PRIVACY.md` (what is read, kept and shown).
`docs/ARCHITECTURE.md` explains the pieces.

## Layout

| Path | What |
|---|---|
| `src/engine/` | MIME and HTML reading, the extension's checks and model (`spruce.js` loads `vendor/spruce/`); `network.js` applies the lookups |
| `src/intel/` | Cloudflare Security DNS, Google Safe Browsing, the phishing lists, registry dates; request limits |
| `src/policy.js` | What happens to an analyzed email |
| `src/pipeline.js` | Notifications → messages → decisions → actions → records; release, brake, watches, retention |
| `src/gmail/` | Keyless domain-wide delegation, Gmail and Directory API calls |
| `src/store/` | Firestore (production) and memory (demo, tests) |
| `src/auth/verify.js` | OIDC for Pub/Sub and Scheduler; Identity-Aware Proxy and ADMIN_EMAILS / ADMIN_GROUP for the dashboard |
| `src/scheduler.js` | Cloud Scheduler, for the dashboard's "Update group membership now" (runs the daily re-read job) |
| `src/server.js` | The HTTP service (`ROLE=worker` / `admin`) |
| `public/` | The dashboard (plain HTML, CSS and JavaScript; no build step) |
| `src/demo/seed.js` | Made-up demo data, judged by the real engine |
| `deploy/` | `install.sh`, `upgrade.sh`, `rollback.sh` and `stop.sh` (Cloud Shell), `settings.example.env` |
| `.github/` | Dependabot (`dependabot.yml`: dependency updates as pull requests) and the tests on every pull request (`workflows/test.yml`) |
| `tools/` | `sync-engine.js` (copy the extension's engine), `build-mockup.js`, `release.js` (the install zip) |
| `vendor/spruce/` | The extension's checks and model (copied; `VENDOR.json` says from which commit) |
