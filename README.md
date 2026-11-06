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
  - **A brake** stops moving after too many moves in an hour, until an admin resumes.
  - **Every move can be undone** from the dashboard.

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
| The AI scores **85%** or more (`AI_MOVE_THRESHOLD`), sender outside the organization | **Move to Spam** |
| Same, in monitor mode or while the brake is on | Recorded as "would move" |
| Amber, or a high AI score the policy doesn't act on (an inside sender) | Recorded as suspicious |
| Allowlisted sender | Nothing |

It also looks things up (`src/intel/`; `docs/PRIVACY.md` says exactly what is sent where):

| Check | What is sent | What it adds |
|---|---|---|
| **Cloudflare Security DNS** | host names of link sites and the sender's domain | a blocked link is dangerous; a blocked or nonexistent sender domain is a sign |
| **Google Safe Browsing** | link addresses (no `#…`; one-time links without their query) | a listed link is dangerous |
| **Phishing lists** (OpenPhish, Phishing Army, Sefinek) | nothing: downloaded once a day, matched in the service | listed links are dangerous; a listed sender address or domain is a sign |
| **Site age** (registries, RDAP) | domain names, to their own registry | brand-new link sites and sender domains are signs (stronger with sign-in or payment wording) |

A lookup that fails leaves an email "not checked", never "safe". Short links are **not** looked up:
there is no outside unshortening service. A short link is judged by its own host and by what decodes
offline.

## The dashboard

The dashboard has these pages:
- **Overview:** emails checked, moved and released; users affected; moves per day by trigger; top
  reasons; largest campaigns; alerts.
- **Campaigns** and **Users:** each opens the list of emails behind it.
- **Messages:** search and filters, opening each email's decision.
  - It shows the signs found with their weights, flagged links, the AI score with what weighed most,
    and the sender check.
  - Buttons: **Release to Inbox**, **Mark false alarm**, **Confirm phishing**.
- **Model health:** recorded emails by AI score, and how often each kind of move was undone. This is
  the number to tune the threshold with.
- **Settings:** the policy in force, read-only.

The dashboard's numbers come from `src/dashboard/aggregate.js`. The clickable mockup
(`tools/build-mockup.js`) uses that same file with made-up data.

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

See `docs/DEPLOY.md` (step by step) and `docs/PRIVACY.md` (what is read, kept and shown).
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
| `src/auth/verify.js` | OIDC for Pub/Sub and Scheduler; Identity-Aware Proxy and ADMIN_EMAILS for the dashboard |
| `src/server.js` | The HTTP service (`ROLE=worker` / `admin`) |
| `public/` | The dashboard (plain HTML, CSS and JavaScript; no build step) |
| `src/demo/seed.js` | Made-up demo data, judged by the real engine |
| `tools/` | `sync-engine.js` (copy the extension's engine), `build-mockup.js` |
| `vendor/spruce/` | The extension's checks and model (copied; `VENDOR.json` says from which commit) |
