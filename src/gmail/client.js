'use strict';
// The few Gmail and Directory API calls the service makes, over plain HTTPS. Every Gmail call names the
// user it is for (quotaUser), so quota is counted per mailbox and not all against the service account.
const { SCOPES } = require('./auth');

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users';
const DIRECTORY = 'https://admin.googleapis.com/admin/directory/v1/users';
const GROUPS = 'https://admin.googleapis.com/admin/directory/v1/groups';
const REPORTS = 'https://admin.googleapis.com/admin/reports/v1/activity/users';
const MAX_LISTED = 4000;   // messages listed from a mailbox's history at a time (the rest, next time)

class GoogleApiError extends Error {
    constructor(status, body, what) { super(`${what}: HTTP ${status} ${String(body).slice(0, 300)}`); this.status = status; }
}

class GmailClient {
    constructor(auth, opts = {}) { this.auth = auth; this.fetch = opts.fetch || fetch; this.labelIds = new Map(); }

    async call(user, method, path, { query = {}, body, scope = SCOPES.gmail, base = `${GMAIL}/${encodeURIComponent(user)}` } = {}, tries = 3) {
        // A value given as a list is sent as the parameter repeated (historyTypes=a&historyTypes=b).
        const q = new URLSearchParams();
        for (const [k, v] of Object.entries(Object.assign({ quotaUser: user }, query))) for (const x of [].concat(v)) q.append(k, x);
        for (let i = 0; ; i++) {
            const token = await this.auth.tokenFor(user, scope);
            const res = await this.fetch(`${base}${path}?${q}`, { method, headers: Object.assign({ authorization: `Bearer ${token}` }, body ? { 'content-type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined });
            if (res.ok) return res.status === 204 ? null : res.json();
            const text = await res.text();
            // Busy or rate-limited (Gmail answers 403 rateLimitExceeded / userRateLimitExceeded too): wait, try again.
            const busy = res.status === 429 || res.status >= 500 || (res.status === 403 && /rateLimitExceeded/i.test(text));
            if (busy && i < tries - 1) { await new Promise(r => setTimeout(r, 1000 * 2 ** i + Math.random() * 500)); continue; }
            throw new GoogleApiError(res.status, text, `${method} ${path}`);
        }
    }
    profile(user) { return this.call(user, 'GET', '/profile'); }
    // Since a history id: new messages in the Inbox (ids), and messages that got the Inbox label back
    // (inboxed: the user moved them out of Spam, or "Not spam"; inboxedAt: the history id of that
    // change). historyId: where the next call starts. Throws GoogleApiError 404 when the id is too old.
    // At most about MAX_LISTED messages at a time: past that, historyId is the last change read (not the
    // mailbox's newest), so the rest is read next time instead of skipped (more: true).
    async addedSince(user, startHistoryId) {
        const ids = new Set(), inboxed = new Set(), inboxedAt = {};
        let pageToken, lastHistoryId = startHistoryId, lastRead = null;
        do {
            const r = await this.call(user, 'GET', '/history', { query: Object.assign({ startHistoryId, historyTypes: ['messageAdded', 'labelAdded'], labelId: 'INBOX', maxResults: '500' }, pageToken ? { pageToken } : {}) });
            for (const h of r.history || []) {
                for (const m of h.messagesAdded || []) if (m.message && m.message.id) ids.add(m.message.id);
                for (const l of h.labelsAdded || []) if (l.message && l.message.id && (l.labelIds || []).includes('INBOX')) { inboxed.add(l.message.id); if (h.id) inboxedAt[l.message.id] = String(h.id); }
                if (h.id) lastRead = String(h.id);
            }
            if (r.historyId) lastHistoryId = r.historyId;
            pageToken = r.nextPageToken;
        } while (pageToken && ids.size + inboxed.size < MAX_LISTED);
        const more = !!pageToken;
        return Object.assign({ ids: [...ids], inboxed: [...inboxed], inboxedAt, historyId: more ? (lastRead || startHistoryId) : lastHistoryId }, more ? { more } : {});
    }
    async raw(user, id) {
        const r = await this.call(user, 'GET', `/messages/${encodeURIComponent(id)}`, { query: { format: 'raw' } });
        return { id: r.id, threadId: r.threadId, labelIds: r.labelIds || [], historyId: r.historyId ? String(r.historyId) : null, internalDate: Number(r.internalDate) || null, raw: Buffer.from(String(r.raw || ''), 'base64url') };
    }
    // A message's labels now (to check a held email is still in the Inbox before moving it).
    async labels(user, id) {
        const r = await this.call(user, 'GET', `/messages/${encodeURIComponent(id)}`, { query: { format: 'minimal' } });
        return r.labelIds || [];
    }
    // Message ids matching a Gmail search (q), a page at a time: { ids, next }.
    async search(user, q, { max = 100, pageToken = null } = {}) {
        const r = await this.call(user, 'GET', '/messages', { query: Object.assign({ q, maxResults: String(max) }, pageToken ? { pageToken } : {}) });
        return { ids: (r.messages || []).map(m => m.id), next: r.nextPageToken || null };
    }
    // From, Subject, Message-ID and labels of a message, without its body.
    async headers(user, id) {
        const r = await this.call(user, 'GET', `/messages/${encodeURIComponent(id)}`, { query: { format: 'metadata', metadataHeaders: ['From', 'Subject', 'Message-ID'] } });
        const get = (n) => ((r.payload && r.payload.headers) || []).find(x => String(x.name).toLowerCase() === n.toLowerCase());
        return { id: r.id, threadId: r.threadId, labelIds: r.labelIds || [], internalDate: Number(r.internalDate) || null, from: get('From') ? get('From').value : '', subject: get('Subject') ? get('Subject').value : '', messageId: get('Message-ID') ? get('Message-ID').value : '' };
    }
    // Puts a message straight into a mailbox (the weekly summary): no sending, nothing leaves Google.
    insert(user, raw, labelIds = ['INBOX', 'UNREAD']) {
        return this.call(user, 'POST', '/messages', { query: { internalDateSource: 'dateHeader' }, body: { raw: Buffer.from(raw).toString('base64url'), labelIds } });
    }
    // How many emails a conversation (thread) holds (0.5.33: a "RE:" answering nothing this mailbox has).
    async threadSize(user, threadId) {
        const r = await this.call(user, 'GET', `/threads/${encodeURIComponent(threadId)}`, { query: { format: 'minimal', fields: 'messages(id)' } });
        return (r.messages || []).length;
    }
    modify(user, id, add = [], remove = []) { return this.call(user, 'POST', `/messages/${encodeURIComponent(id)}/modify`, { body: { addLabelIds: add, removeLabelIds: remove } }); }
    // The id of a label of ours ("SPRUCE/Moved"), made if the mailbox doesn't have it yet.
    async labelId(user, name) {
        const key = `${user}|${name}`;
        if (this.labelIds.has(key)) return this.labelIds.get(key);
        const list = await this.call(user, 'GET', '/labels');
        let l = (list.labels || []).find(x => x.name === name);
        if (!l) l = await this.call(user, 'POST', '/labels', { body: { name, labelListVisibility: 'labelShow', messageListVisibility: 'show' } });
        this.labelIds.set(key, l.id);
        return l.id;
    }
    watch(user, topicName) { return this.call(user, 'POST', '/watch', { body: { topicName, labelIds: ['INBOX'], labelFilterBehavior: 'INCLUDE' } }); }
    stop(user) { return this.call(user, 'POST', '/stop'); }
    // Users of an organizational unit and its sub-units (acting as a Workspace admin).
    async usersInOu(admin, ouPath) {
        const out = [];
        let pageToken;
        do {
            const r = await this.call(admin, 'GET', '', { scope: SCOPES.directory, base: DIRECTORY,
                query: Object.assign({ customer: 'my_customer', query: `orgUnitPath='${ouPath.replace(/'/g, '')}'`, maxResults: '500', projection: 'basic' }, pageToken ? { pageToken } : {}) });
            for (const u of r.users || []) if (!u.suspended && u.primaryEmail) out.push(u.primaryEmail.toLowerCase());
            pageToken = r.nextPageToken;
        } while (pageToken);
        return out;
    }
    // The full names of the organization's users (acting as a Workspace admin: the Users → Read privilege and
    // the admin.directory.user.readonly scope), for the colleague-name check. Names only, never stored: the
    // service keeps a one-way hash of each (see Service.colleagueNames).
    async userNames(admin) {
        const out = [];
        let pageToken;
        do {
            const r = await this.call(admin, 'GET', '', { scope: SCOPES.directory, base: DIRECTORY,
                query: Object.assign({ customer: 'my_customer', maxResults: '500', projection: 'basic', fields: 'users(name/fullName,primaryEmail),nextPageToken' }, pageToken ? { pageToken } : {}) });
            // (the address only to know each person's own name: their own name in their mail is no "colleague named")
            for (const u of r.users || []) if (u.name && u.name.fullName) out.push({ name: String(u.name.fullName), email: String(u.primaryEmail || '').toLowerCase() });
            pageToken = r.nextPageToken;
        } while (pageToken);
        return out;
    }
    // Gmail's log events for one mailbox (the Admin SDK Reports API, acting as a Workspace admin with the
    // Reports privilege and the admin.reports.audit.readonly scope; 0.5.35, Settings → Link clicks):
    // eventName delivery, between two times (Google requires both, at most 30 days apart), with filters
    // such as event_info.mail_event_type==15. At most max events.
    async gmailEvents(admin, mailbox, { startTime, endTime, filters = '', max = 3000 } = {}) {
        const out = [];
        const start = Math.max(Number(startTime) || 0, Number(endTime) - 30 * 24 * 3600 * 1000 + 60000);
        let pageToken;
        do {
            const r = await this.call(admin, 'GET', `/${encodeURIComponent(mailbox)}/applications/gmail`, { scope: SCOPES.reports, base: REPORTS,
                query: Object.assign({ eventName: 'delivery', startTime: new Date(start).toISOString(), endTime: new Date(Number(endTime)).toISOString(), maxResults: '1000' }, filters ? { filters } : {}, pageToken ? { pageToken } : {}) });
            out.push(...(r.items || []));
            pageToken = r.nextPageToken;
        } while (pageToken && out.length < max);
        return out.slice(0, max);
    }
    // Whether an address is in a group, directly or through a group inside it (acting as a Workspace admin).
    async hasMember(admin, groupEmail, email) {
        try {
            const r = await this.call(admin, 'GET', `/${encodeURIComponent(groupEmail)}/hasMember/${encodeURIComponent(email)}`, { scope: SCOPES.groupMembers, base: GROUPS });
            return !!(r && r.isMember);
        } catch (e) {
            // An address Google doesn't know is not a member; a group it doesn't know is an error to show.
            if (e instanceof GoogleApiError && (e.status === 400 || e.status === 404) && !/groupKey/i.test(e.message)) return false;
            throw e;
        }
    }
    // Members of a group, with the members of groups inside it (acting as a Workspace admin). Only
    // active user accounts in the organization's own domains: a group can hold outside addresses and
    // suspended accounts, and their mail is not ours to read.
    // found (optional) is filled in with what the group listed and why entries were left out: entries,
    // inactive, outside (with outsideDomains), everyone ("all users in the organization" entries, which
    // aren't expanded), groups (groups inside it: their members are listed too).
    async groupMembers(admin, groupEmail, orgDomains = [], found = null) {
        const out = new Set();
        const f = found || {};
        Object.assign(f, { entries: 0, inactive: 0, outside: 0, outsideDomains: [], everyone: 0, groups: 0 });
        const outsideDomains = new Set();
        let pageToken;
        do {
            const r = await this.call(admin, 'GET', `/${encodeURIComponent(groupEmail)}/members`, { scope: SCOPES.groupMembers, base: GROUPS,
                query: Object.assign({ includeDerivedMembership: 'true', maxResults: '200' }, pageToken ? { pageToken } : {}) });
            for (const m of r.members || []) {
                f.entries++;
                const email = String(m.email || '').toLowerCase();
                if (m.type === 'GROUP') { f.groups++; continue; }
                if (m.type === 'CUSTOMER') { f.everyone++; continue; }
                if (m.type !== 'USER' || !email) continue;
                if (m.status && m.status !== 'ACTIVE') { f.inactive++; continue; }
                const domain = email.split('@')[1] || '';
                if (orgDomains.length && !orgDomains.includes(domain)) { f.outside++; outsideDomains.add(domain); continue; }
                out.add(email);
            }
            pageToken = r.nextPageToken;
        } while (pageToken);
        f.outsideDomains = [...outsideDomains].sort();
        return [...out];
    }
}

module.exports = { GmailClient, GoogleApiError };
