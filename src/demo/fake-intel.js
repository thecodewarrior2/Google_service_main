'use strict';
// Made-up answers for the network checks in demo mode (no network): which of the INVENTED demo
// domains Cloudflare "blocks", Safe Browsing "lists", the phishing lists "have", and how old each is.
// Same shapes as src/intel, so the demo shows what the real checks would add.
const DAYS = { 'micros0ft-support.example': 4, 'docs-review-center.example': 12, 'maple-schools-payroll.example': 6, 'harbor-supply-invoices.example': 20,
    'greenpath-mail.example': 9, 'pw-offers-mailer.example': 45, 'gadgetdeals-shop.example': 2900, 'brightpath-learning.example': 1600, 'cedar-library.example': 4200,
    'staff-perks-portal.example': 25, 'summit-registration.example': 18 };
const CF_BLOCKS = new Set(['docs-review-center.example', 'micros0ft-support.example']);
const SB_LISTS = [/storage\.googleapis\.com\/bucket-77\//];
const LIST_DOMAINS = { 'maple-schools-payroll.example': 'Phishing Army (extended)', 'paystub-viewer.example': 'Phishing Army (extended)' };
const LIST_ADDRESSES = { 'lena__a81f22c4e9@freemail.example': 'Sefinek scam-sender list' };

const regOf = (h) => String(h || '').toLowerCase().split('.').slice(-2).join('.');
function createFakeIntel() {
    let demoListFailed = true;
    return {
        threats: {
            enabled: { cloudflare: true, safeBrowsing: false },        // as deployed: Cloudflare only
            async checkHosts(hosts) { return new Map(hosts.map(h => [h, CF_BLOCKS.has(regOf(h)) ? { verdict: 'unsafe', by: 'Cloudflare Security', reason: 'Cloudflare Security blocks it as malware or phishing' } : { verdict: 'clean', by: 'Cloudflare Security' }])); },
            async checkUrls(links) { return new Map(links.map(l => [l.url, SB_LISTS.some(re => re.test(l.url)) ? { verdict: 'unsafe', by: 'Google Safe Browsing', reason: 'Google Safe Browsing lists it as phishing or a deceptive site' } : { verdict: 'clean', by: 'Google Safe Browsing' }])); }
        },
        feeds: {
            async urlHit(url) { try { return LIST_DOMAINS[regOf(new URL(url).hostname)] || null; } catch (e) { return null; } },
            async domainHit(host) { return LIST_DOMAINS[regOf(host)] || null; },
            async addressHit(a) { return LIST_ADDRESSES[String(a || '').toLowerCase()] || null; },
            // Made-up numbers; HaGeZi's last download "failed" (0.5.22), until the About page's Re-check.
            async status() {
                const t = Date.now() - 5 * 3600e3;
                const ok = (id, name, kind, count, extra = {}) => Object.assign({ id, name, kind, confidence: 'list', updated: t, count, lastAttempt: t, error: null, failedSince: null, failures: 0, missed: null }, extra);
                return [ok('openphish', 'OpenPhish community feed', 'url', 412), ok('phishingarmy', 'Phishing Army (extended)', 'domain', 141882),
                    demoListFailed ? ok('hagezitif', 'HaGeZi Threat Intelligence Feeds', 'domain', 365120, { updated: Date.now() - 29 * 3600e3, lastAttempt: Date.now() - 2 * 3600e3, error: 'HTTP 503', failedSince: t, failures: 2, missed: 'failed' })
                        : ok('hagezitif', 'HaGeZi Threat Intelligence Feeds', 'domain', 366027, { updated: Date.now(), lastAttempt: Date.now() }),
                    ok('tweetfeed', 'TweetFeed (researchers\' reports)', 'domain', 2641, { confidence: 'report' }), ok('sefinekemails', 'Sefinek scam-sender list', 'address', 23517)];
            },
            async sync({ retryFailed = false } = {}) {
                if (!retryFailed || !demoListFailed) return { feeds: [], recovered: [] };
                demoListFailed = false;
                return { feeds: [{ id: 'hagezitif', name: 'HaGeZi Threat Intelligence Feeds', count: 366027 }], recovered: ['HaGeZi Threat Intelligence Feeds'] };
            }
        },
        rdap: { async ageDays(d) { const v = DAYS[regOf(d)]; return typeof v === 'number' ? v : 3000; } }
    };
}

module.exports = { createFakeIntel };
