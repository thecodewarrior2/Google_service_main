'use strict';
// Made-up answers for the network checks in demo mode (no network): which of the INVENTED demo
// domains Cloudflare "blocks", Safe Browsing "lists", the phishing lists "have", and how old each is.
// Same shapes as src/intel, so the demo shows what the real checks would add.
const DAYS = { 'micros0ft-support.example': 4, 'docs-review-center.example': 12, 'maple-schools-payroll.example': 6, 'harbor-supply-invoices.example': 20,
    'greenpath-mail.example': 9, 'pw-offers-mailer.example': 45, 'gadgetdeals-shop.example': 2900, 'brightpath-learning.example': 1600, 'cedar-library.example': 4200 };
const CF_BLOCKS = new Set(['docs-review-center.example', 'micros0ft-support.example']);
const SB_LISTS = [/storage\.googleapis\.com\/bucket-77\//];
const LIST_DOMAINS = { 'maple-schools-payroll.example': 'Phishing Army (extended)' };
const LIST_ADDRESSES = { 'lena__a81f22c4e9@freemail.example': 'Sefinek scam-sender list' };

const regOf = (h) => String(h || '').toLowerCase().split('.').slice(-2).join('.');
function createFakeIntel() {
    return {
        threats: {
            async checkHosts(hosts) { return new Map(hosts.map(h => [h, CF_BLOCKS.has(regOf(h)) ? { verdict: 'unsafe', by: 'Cloudflare Security', reason: 'Cloudflare Security blocks it as malware or phishing' } : { verdict: 'clean', by: 'Cloudflare Security' }])); },
            async checkUrls(links) { return new Map(links.map(l => [l.url, SB_LISTS.some(re => re.test(l.url)) ? { verdict: 'unsafe', by: 'Google Safe Browsing', reason: 'Google Safe Browsing lists it as phishing or a deceptive site' } : { verdict: 'clean', by: 'Google Safe Browsing' }])); }
        },
        feeds: {
            async urlHit(url) { try { return LIST_DOMAINS[regOf(new URL(url).hostname)] || null; } catch (e) { return null; } },
            async domainHit(host) { return LIST_DOMAINS[regOf(host)] || null; },
            async addressHit(a) { return LIST_ADDRESSES[String(a || '').toLowerCase()] || null; },
            async status() { return [{ id: 'openphish', name: 'OpenPhish community feed', kind: 'url', updated: Date.now() - 5 * 3600e3, count: 412 }, { id: 'phishingarmy', name: 'Phishing Army (extended)', kind: 'domain', updated: Date.now() - 5 * 3600e3, count: 141882 }, { id: 'sefinekemails', name: 'Sefinek scam-sender list', kind: 'address', updated: Date.now() - 5 * 3600e3, count: 23517 }]; },
            async sync() { return { feeds: [] }; }
        },
        rdap: { async ageDays(d) { const v = DAYS[regOf(d)]; return typeof v === 'number' ? v : 3000; } }
    };
}

module.exports = { createFakeIntel };
