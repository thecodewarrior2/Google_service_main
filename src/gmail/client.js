'use strict';
// The few Gmail and Directory API calls the service makes, over plain HTTPS. Every Gmail call names the
// user it is for (quotaUser), so quota is counted per mailbox and not all against the service account.
const { SCOPES } = require('./auth');

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users';
const DIRECTORY = 'https://admin.googleapis.com/admin/directory/v1/users';

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
            if ((res.status === 429 || res.status >= 500) && i < tries - 1) { await new Promise(r => setTimeout(r, 1000 * 2 ** i + Math.random() * 500)); continue; }
            throw new GoogleApiError(res.status, text, `${method} ${path}`);
        }
    }
    profile(user) { return this.call(user, 'GET', '/profile'); }
    // Since a history id: new messages in the Inbox (ids), and messages that got the Inbox label back
    // (inboxed: the user moved them out of Spam, or "Not spam"). Throws GoogleApiError 404 when the id is
    // too old.
    async addedSince(user, startHistoryId) {
        const ids = new Set(), inboxed = new Set();
        let pageToken, lastHistoryId = startHistoryId;
        do {
            const r = await this.call(user, 'GET', '/history', { query: Object.assign({ startHistoryId, historyTypes: ['messageAdded', 'labelAdded'], labelId: 'INBOX', maxResults: '500' }, pageToken ? { pageToken } : {}) });
            for (const h of r.history || []) {
                for (const m of h.messagesAdded || []) if (m.message && m.message.id) ids.add(m.message.id);
                for (const l of h.labelsAdded || []) if (l.message && l.message.id && (l.labelIds || []).includes('INBOX')) inboxed.add(l.message.id);
            }
            if (r.historyId) lastHistoryId = r.historyId;
            pageToken = r.nextPageToken;
        } while (pageToken && ids.size + inboxed.size < 4000);
        return { ids: [...ids], inboxed: [...inboxed], historyId: lastHistoryId };
    }
    async raw(user, id) {
        const r = await this.call(user, 'GET', `/messages/${encodeURIComponent(id)}`, { query: { format: 'raw' } });
        return { id: r.id, threadId: r.threadId, labelIds: r.labelIds || [], internalDate: Number(r.internalDate) || null, raw: Buffer.from(String(r.raw || ''), 'base64url') };
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
}

module.exports = { GmailClient, GoogleApiError };
