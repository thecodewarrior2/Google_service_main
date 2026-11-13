'use strict';
// Settings, from environment variables (Cloud Run: --set-env-vars / Secret Manager). Every default is
// the cautious one: MONITOR mode (nothing is moved, only recorded), the AI alone never moves mail from
// inside the organization, and a brake stops moving if moves suddenly pile up.
// Lists: commas or semicolons (semicolons avoid gcloud's comma escaping in --set-env-vars).
const list = (v) => String(v || '').split(/[,;]/).map(s => s.trim().toLowerCase()).filter(Boolean);
const num = (v, d) => (v === undefined || v === '' || !Number.isFinite(Number(v)) ? d : Number(v));
const bool = (v, d) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(String(v)));

// The settings an admin can also change on the dashboard (Settings → Policy, Settings → Allowlist). They read from a live
// copy that only setPolicyValues changes (src/pipeline.js: refreshPolicy, setPolicy); envPolicy keeps what
// the environment (deploy/settings.env) says. The rest of the configuration is frozen.
const POLICY_KEYS = ['mode', 'aiThreshold', 'aiSuspicious', 'aiScansInside', 'aiMovesInside', 'safeBrowsing', 'brakePerHour', 'timeZone', 'allowDomains', 'allowAddresses', 'retentionDays'];
function withLivePolicy(c) {
    const envPolicy = Object.freeze(Object.fromEntries(POLICY_KEYS.map(k => [k, c[k]])));
    const live = Object.assign({}, envPolicy);
    for (const k of POLICY_KEYS) Object.defineProperty(c, k, { get: () => live[k], enumerable: true });
    c.envPolicy = envPolicy;
    Object.defineProperty(c, 'setPolicyValues', { value: (values) => { for (const k of POLICY_KEYS) live[k] = Object.prototype.hasOwnProperty.call(values, k) ? values[k] : envPolicy[k]; } });
    return Object.freeze(c);
}

function loadConfig(env = process.env) {
    const demo = bool(env.DEMO, false);
    return withLivePolicy({
        demo,
        onCloudRun: !!env.K_SERVICE,                   // Cloud Run sets K_SERVICE
        // Two Cloud Run services from one image (docs/DEPLOY.md): 'worker' answers only Pub/Sub and
        // Cloud Scheduler (no dashboard); 'admin' is only the dashboard, behind Identity-Aware Proxy.
        // 'all' (both) is for demo mode and a computer of your own.
        role: ['worker', 'admin'].includes(env.ROLE) ? env.ROLE : 'all',
        port: num(env.PORT, 8080),
        // 'monitor': record what would be moved, move nothing. 'enforce': move to Spam.
        mode: env.MODE === 'enforce' ? 'enforce' : 'monitor',
        orgDomains: list(env.ORG_DOMAINS),
        // Which mailboxes are watched: the members of a group (a security group is best; groups inside it
        // count too), an organizational unit (with its sub-units), and/or a list of addresses.
        pilotGroups: list(env.PILOT_GROUP),
        pilotOu: env.PILOT_OU || '',
        pilotUsers: list(env.PILOT_USERS),
        // What moves an email: the extension's own verdict "flagged" (score 5 or more), and/or the AI
        // model's score at or above the threshold.
        moveOnRules: bool(env.MOVE_ON_RULES, true),
        aiThreshold: num(env.AI_MOVE_THRESHOLD, 0.9),
        // From this AI score an email is recorded as suspicious (when it isn't moved): at most the threshold.
        aiSuspicious: num(env.AI_SUSPICIOUS_THRESHOLD, 0.65),
        // Whether the AI score alone can move mail from inside the organization (as it moves outside mail at
        // the threshold): off by default, and then only the rules move inside mail (a staff account taken
        // over trips them). Settings → Policy too ("AI alone moves inside mail", with an agreement).
        aiMovesInside: bool(env.AI_MOVES_INSIDE, false),
        // Whether the AI model reads mail from inside the organization (your domains, Gmail's DMARC check
        // passing): off by default; the rule checks (links, headers, the rest) read it either way, and a
        // forged inside address (DMARC not passing) is outside mail, read by the AI. Settings → Policy too.
        // AI_MOVES_INSIDE needs the AI to read it, so it turns this on as well.
        aiScansInside: bool(env.AI_SCANS_INSIDE, false),
        // Never moved, whatever the checks say.
        allowDomains: list(env.ALLOW_DOMAINS),
        allowAddresses: list(env.ALLOW_ADDRESSES),
        // The brakes (pipeline.js). The domain-wide one: more moves than this in an hour stops moving
        // until an admin resumes; 0 or unset = half the watched mailboxes, at least 100 (a misfire on
        // many unrelated emails, not one large campaign). The campaign one: copies of one campaign moved
        // on weaker evidence (no outside confirmation) beyond this are held until an admin confirms or
        // releases the campaign; strong evidence is never held.
        brakePerHour: num(env.BRAKE_PER_HOUR, 0),
        campaignHoldAfter: num(env.CAMPAIGN_HOLD_AFTER, 25),
        // Alerts (logged for Cloud Monitoring to email; deploy/install.sh): a campaign moved this many
        // times, and no notification from Gmail for this many hours.
        campaignAlertAfter: num(env.CAMPAIGN_ALERT_AFTER, 50),
        quietHours: num(env.QUIET_HOURS, 12),
        alertEmail: env.ALERT_EMAIL || '',                // shown in Settings (deploy/install.sh sets up the alerts)
        // The district's time zone (an IANA name, e.g. America/New_York): the scheduled jobs and the weekly
        // summary (Monday from 7 AM) use it. UTC when unset.
        timeZone: env.TIME_ZONE || 'UTC',
        // The dashboard's address (in the weekly summary), and where the services run (the Status page).
        dashboardUrl: env.DASHBOARD_URL || '',
        project: env.GOOGLE_CLOUD_PROJECT || '',
        region: env.CLOUD_RUN_REGION || '',
        movedLabel: env.MOVED_LABEL || 'SPRUCE/Moved',
        releasedLabel: env.RELEASED_LABEL || 'SPRUCE/Moved back',   // (SPRUCE/Released before 0.3.7)
        monitorLabel: env.MONITOR_LABEL || '',            // '' = monitor mode leaves mailboxes untouched
        // Network checks (src/intel). Google Safe Browsing is OFF by default: an admin adds its API key and
        // turns it on in Settings → Safe Browsing (0.5.23: the key in Secret Manager, SAFE_BROWSING_SECRET,
        // which install.sh sets up; safeBrowsing is a policy setting). SAFE_BROWSING=true with SAFE_BROWSING_KEY
        // still works where the secret isn't set up.
        cloudflareThreats: bool(env.CLOUDFLARE_THREATS, true),
        safeBrowsing: bool(env.SAFE_BROWSING, false),
        safeBrowsingKey: env.SAFE_BROWSING_KEY || '',
        safeBrowsingSecret: env.SAFE_BROWSING_SECRET || '',
        // Status → Activity (what admins did, alerts, errors) is kept this many days (0.5.29; the email records
        // RETENTION_DAYS). 30 to 1,825. It holds no email text: mailbox addresses, sender domains, admins.
        auditDays: Math.min(1825, Math.max(30, Math.round(num(env.AUDIT_DAYS, 365)))),
        // A copy of Activity in Cloud Logging, kept a year in its own log bucket (0.5.29): OFF by default (Google
        // charges for it, a little). install.sh sets AUDIT_LOG=true with the bucket.
        auditLog: bool(env.AUDIT_LOG, false),
        phishingLists: bool(env.PHISHING_LISTS, true),
        siteAge: bool(env.SITE_AGE, true),
        // Records
        store: env.STORE || (demo ? 'memory' : 'firestore'),
        firestoreDatabase: env.FIRESTORE_DATABASE || '(default)',
        storeSubjects: bool(env.STORE_SUBJECTS, true),
        storeAiQuotes: bool(env.STORE_AI_QUOTES, true),
        // The colleague-name check: the directory's names (as one-way hashes, in memory) against outside
        // senders' names. Needs DIRECTORY_ADMIN with Users → Read and the admin.directory.user.readonly scope.
        colleagueNames: bool(env.COLLEAGUE_NAMES, true),
        // How long records are kept (days, 14 to 365; also on the dashboard, Settings → Policy). Each one
        // is deleted on its own date, the oldest first: never all at once.
        retentionDays: num(env.RETENTION_DAYS, 35),
        firstSeenLearningDays: num(env.FIRST_SEEN_LEARNING_DAYS, 14),
        // Google: the service account that acts for each mailbox (domain-wide delegation), the admin it
        // acts as to list the pilot users, and the Pub/Sub topic Gmail notifies.
        delegatedServiceAccount: env.DELEGATED_SA || '',
        directoryAdmin: env.DIRECTORY_ADMIN || '',
        pubsubTopic: env.PUBSUB_TOPIC || '',
        // Who may call what: Pub/Sub push and Cloud Scheduler sign their requests (OIDC); the dashboard
        // sits behind Identity-Aware Proxy and only these admins may use it.
        pushAudience: env.PUSH_AUDIENCE || '',
        pushServiceAccount: (env.PUSH_SERVICE_ACCOUNT || '').toLowerCase(),
        taskServiceAccount: (env.TASK_SERVICE_ACCOUNT || env.PUSH_SERVICE_ACCOUNT || '').toLowerCase(),
        iapAudience: env.IAP_AUDIENCE || '',
        adminEmails: list(env.ADMIN_EMAILS),
        // A group whose members may use the dashboard too (read as DIRECTORY_ADMIN; groups inside it count).
        adminGroups: list(env.ADMIN_GROUP),
        // The Cloud Scheduler job the dashboard's "Update group membership now" runs
        // (projects/PROJECT/locations/REGION/jobs/spruce-renew-watches; deploy/install.sh sets it).
        renewJob: env.RENEW_JOB || '',
        // The job Settings → Update runs (projects/PROJECT/locations/REGION/jobs/spruce-update; install.sh
        // makes it), and where the approved versions are (src/releases.js).
        updateJob: env.UPDATE_JOB || '',
        releasesRepo: env.RELEASES_REPO || 'thecodewarrior2/Google_service_main'
    });
}

// What is wrong with a configuration for real use (the server refuses to start with any of these).
function configProblems(c) {
    // Demo mode lets anyone into the dashboard (made-up data): never on Cloud Run.
    if (c.demo) return c.onCloudRun ? ['DEMO mode is for a computer of your own; it refuses to run on Cloud Run (it has no sign-in).'] : [];
    const p = [];
    const worker = c.role !== 'admin', admin = c.role !== 'worker';
    if (!c.orgDomains.length) p.push('ORG_DOMAINS is not set (your organization\'s own domains).');
    if (!c.delegatedServiceAccount) p.push('DELEGATED_SA is not set (the service account with domain-wide delegation).');
    if (worker) {
        if (c.safeBrowsing && !c.safeBrowsingKey && !c.safeBrowsingSecret) p.push('SAFE_BROWSING=true needs SAFE_BROWSING_KEY (an API key restricted to the Safe Browsing API, from Secret Manager).');
        if (!c.pilotGroups.length && !c.pilotOu && !c.pilotUsers.length) p.push('None of PILOT_GROUP, PILOT_OU or PILOT_USERS is set: no mailbox would be watched.');
        if (!c.pubsubTopic) p.push('PUBSUB_TOPIC is not set.');
        if (!c.pushAudience || !c.pushServiceAccount) p.push('PUSH_AUDIENCE and PUSH_SERVICE_ACCOUNT must be set, so only Pub/Sub and Cloud Scheduler can call the worker.');
        if ((c.pilotOu || c.pilotGroups.length) && !c.directoryAdmin) p.push('DIRECTORY_ADMIN is not set (an admin the service may act as to list the members of PILOT_GROUP or the users of PILOT_OU).');
    }
    if (admin) {
        if (!c.iapAudience) p.push('IAP_AUDIENCE is not set: the dashboard must sit behind Identity-Aware Proxy.');
        if (!c.adminEmails.length && !c.adminGroups.length) p.push('Neither ADMIN_EMAILS nor ADMIN_GROUP is set: nobody could use the dashboard.');
        if (c.adminGroups.length && !c.directoryAdmin) p.push('ADMIN_GROUP needs DIRECTORY_ADMIN (an admin the service may act as to check who is in the group).');
    }
    if (!(Number.isInteger(c.retentionDays) && c.retentionDays >= 14 && c.retentionDays <= 365)) p.push('RETENTION_DAYS must be a whole number of days from 14 to 365.');
    if (!(c.aiSuspicious >= 0.5 && c.aiSuspicious <= 1)) p.push('AI_SUSPICIOUS_THRESHOLD must be between 0.5 and 1.');
    if (!(c.aiThreshold > 0.5 && c.aiThreshold <= 1 && c.aiThreshold >= c.aiSuspicious)) p.push('AI_MOVE_THRESHOLD must be between AI_SUSPICIOUS_THRESHOLD (where an email counts as suspicious) and 1.');
    return p;
}

module.exports = { loadConfig, configProblems };
