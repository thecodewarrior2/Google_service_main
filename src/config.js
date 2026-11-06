'use strict';
// Settings, from environment variables (Cloud Run: --set-env-vars / Secret Manager). Every default is
// the cautious one: MONITOR mode (nothing is moved, only recorded), the AI alone never moves mail from
// inside the organization, and a brake stops moving if moves suddenly pile up.
// Lists: commas or semicolons (semicolons avoid gcloud's comma escaping in --set-env-vars).
const list = (v) => String(v || '').split(/[,;]/).map(s => s.trim().toLowerCase()).filter(Boolean);
const num = (v, d) => (v === undefined || v === '' || !Number.isFinite(Number(v)) ? d : Number(v));
const bool = (v, d) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(String(v)));

function loadConfig(env = process.env) {
    const demo = bool(env.DEMO, false);
    return Object.freeze({
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
        aiThreshold: num(env.AI_MOVE_THRESHOLD, 0.85),
        aiMovesInside: bool(env.AI_MOVES_INSIDE, false),
        // Never moved, whatever the checks say.
        allowDomains: list(env.ALLOW_DOMAINS),
        allowAddresses: list(env.ALLOW_ADDRESSES),
        // The brake: more moves than this in an hour stops moving (back to recording only) until an
        // admin resumes it in the dashboard.
        brakePerHour: num(env.BRAKE_PER_HOUR, 100),
        movedLabel: env.MOVED_LABEL || 'SPRUCE/Moved',
        releasedLabel: env.RELEASED_LABEL || 'SPRUCE/Released',
        monitorLabel: env.MONITOR_LABEL || '',            // '' = monitor mode leaves mailboxes untouched
        // Network checks (src/intel). Cloudflare Security only, for now: Google Safe Browsing is OFF unless
        // SAFE_BROWSING=true, and then needs its API key (Secret Manager → SAFE_BROWSING_KEY).
        cloudflareThreats: bool(env.CLOUDFLARE_THREATS, true),
        safeBrowsing: bool(env.SAFE_BROWSING, false),
        safeBrowsingKey: env.SAFE_BROWSING_KEY || '',
        phishingLists: bool(env.PHISHING_LISTS, true),
        siteAge: bool(env.SITE_AGE, true),
        // Records
        store: env.STORE || (demo ? 'memory' : 'firestore'),
        firestoreDatabase: env.FIRESTORE_DATABASE || '(default)',
        storeSubjects: bool(env.STORE_SUBJECTS, true),
        storeAiQuotes: bool(env.STORE_AI_QUOTES, true),
        retentionDays: num(env.RETENTION_DAYS, 60),
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
        adminEmails: list(env.ADMIN_EMAILS)
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
        if (c.safeBrowsing && !c.safeBrowsingKey) p.push('SAFE_BROWSING=true needs SAFE_BROWSING_KEY (an API key restricted to the Safe Browsing API, from Secret Manager).');
        if (!c.pilotGroups.length && !c.pilotOu && !c.pilotUsers.length) p.push('None of PILOT_GROUP, PILOT_OU or PILOT_USERS is set: no mailbox would be watched.');
        if (!c.pubsubTopic) p.push('PUBSUB_TOPIC is not set.');
        if (!c.pushAudience || !c.pushServiceAccount) p.push('PUSH_AUDIENCE and PUSH_SERVICE_ACCOUNT must be set, so only Pub/Sub and Cloud Scheduler can call the worker.');
        if ((c.pilotOu || c.pilotGroups.length) && !c.directoryAdmin) p.push('DIRECTORY_ADMIN is not set (an admin the service may act as to list the members of PILOT_GROUP or the users of PILOT_OU).');
    }
    if (admin) {
        if (!c.iapAudience) p.push('IAP_AUDIENCE is not set: the dashboard must sit behind Identity-Aware Proxy.');
        if (!c.adminEmails.length) p.push('ADMIN_EMAILS is not set: nobody could use the dashboard.');
    }
    if (!(c.aiThreshold > 0.5 && c.aiThreshold <= 1)) p.push('AI_MOVE_THRESHOLD must be between 0.5 and 1.');
    return p;
}

module.exports = { loadConfig, configProblems };
