'use strict';
// What happens to an analyzed email.
//
//   move        to Spam (and the "SPRUCE/Moved" label): the extension's verdict is "flagged" (as the
//               extension moves flagged email), or the AI model's score is at or above the threshold
//               (90% by default) for a sender outside the organization.
//   would-move  the same, in monitor mode or while the brake is on: recorded, nothing moved.
//   flag        suspicious but not moved (amber verdict, an AI score of cfg.aiSuspicious or more below the
//               threshold, or a high one the policy doesn't act on, such as an inside sender): recorded.
//   (The suspicious line is never above the move threshold: config.js and pipeline.js policyValue.)
//   none        nothing to record.
//
// Never moved, whatever the checks say: allowlisted senders and domains ("trusted"). Mail from inside
// the organization is moved only by the rules (a compromised staff account trips them too), not by the
// AI score alone, unless AI_MOVES_INSIDE is set. Both rely on the From address, so both need Gmail's
// DMARC check to have passed for it (engine/analyze.js senderVerified): a forged allowlisted or staff
// address is judged like any other mail from outside.
// From this AI score an email counts as suspicious (recorded, not moved, below the move threshold): the
// default of AI_SUSPICIOUS_THRESHOLD (cfg.aiSuspicious; Settings → Policy).
const AI_SUSPICIOUS = 0.65;

function isAllowed(cfg, address) {
    const a = String(address || '').toLowerCase();
    const d = a.split('@')[1] || '';
    return cfg.allowAddresses.includes(a) || cfg.allowDomains.some(x => d === x || d.endsWith('.' + x));
}

// What made an email suspicious (and not moved), said plainly: the rule checks' score (or a link check's
// verdict), the AI's score, or both. Also used by the dashboard for records from before 0.5.12, which only
// said "suspicious, below the move rules" (server.js withPlainWhy).
function suspiciousWhy(result, cfg) {
    const p = result.ai && typeof result.ai.probability === 'number' ? result.ai.probability : null;
    const line = typeof cfg.aiSuspicious === 'number' ? cfg.aiSuspicious : AI_SUSPICIOUS;
    const pct = (x) => `${Math.round(x * 100)}%`;
    const parts = [];
    if (result.status === 'caution' || result.status === 'flagged') {
        const off = result.status === 'flagged' && !cfg.moveOnRules ? '; moving on the rules is off (MOVE_ON_RULES)' : '';
        parts.push(result.score >= 3 ? `the rule checks scored it ${result.score} (suspicious from 3, moved from 5)${off}`
            : `a link check found ${result.status === 'flagged' ? 'a dangerous' : 'a suspicious'} link${off}`);
    }
    if (p !== null && p >= cfg.aiThreshold && result.inside && !cfg.aiMovesInside) {
        parts.push(`the AI scored it ${pct(p)}, but the sender is inside the organization and "AI alone moves inside mail" is off, so the AI score alone doesn't move it`);
    } else if (p !== null && p >= line) {
        parts.push(`the AI scored it ${pct(p)} (suspicious from ${pct(line)}, moved from ${pct(cfg.aiThreshold)})`);
    }
    return parts.join(', and ') || 'suspicious';
}

function decide(result, cfg, state = {}) {
    if (result.status === 'trusted') return { action: 'none', trigger: null, why: 'allowlisted sender' };
    const p = result.ai && typeof result.ai.probability === 'number' ? result.ai.probability : null;
    const ruleMove = cfg.moveOnRules && result.status === 'flagged';
    const aiHigh = p !== null && p >= cfg.aiThreshold;
    const aiMove = aiHigh && (!result.inside || cfg.aiMovesInside);
    // Why an allowlisted or staff address didn't count as one (said on the record).
    const notes = [result.allowlistedUnverified ? 'allowlisted sender, but DMARC didn\'t pass, so it was judged like any other' : '',
                   result.ownAddress && !result.inside ? 'the address is the organization\'s, but DMARC didn\'t pass, so it isn\'t treated as inside' : ''].filter(Boolean);
    const noted = (s) => [s, ...notes].filter(Boolean).join('; ');
    if (!ruleMove && !aiMove) {
        const line = typeof cfg.aiSuspicious === 'number' ? cfg.aiSuspicious : AI_SUSPICIOUS;
        const byRules = result.status === 'caution' || result.status === 'flagged';
        const byAi = p !== null && p >= line;
        const suspicious = byRules || aiHigh || byAi;
        return { action: suspicious ? 'flag' : 'none', trigger: null, why: noted(suspicious ? suspiciousWhy(result, cfg) : '') };
    }
    const trigger = ruleMove && aiMove ? 'rules+ai' : ruleMove ? 'rules' : 'ai';
    const why = noted([ruleMove ? `rules flagged it (score ${result.score})` : '',
                       aiMove ? `AI ${Math.round(p * 100)}% ≥ ${Math.round(cfg.aiThreshold * 100)}%${result.inside ? ' (the sender is inside the organization; "AI alone moves inside mail" is on)' : ''}` : ''].filter(Boolean).join(' and '));
    if (cfg.mode !== 'enforce') return { action: 'would-move', trigger, why: `${why} (monitor mode: not moved)` };
    if (state.brake) return { action: 'would-move', trigger, why: `${why} (brake on: not moved)`, braked: true };
    return { action: 'move', trigger, why };
}

module.exports = { decide, isAllowed, suspiciousWhy, AI_SUSPICIOUS };
