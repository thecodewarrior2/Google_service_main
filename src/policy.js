'use strict';
// What happens to an analyzed email.
//
//   move        to Spam (and the "SPRUCE/Moved" label): the extension's verdict is "flagged" (as the
//               extension moves flagged email), or the AI model's score is at or above the threshold
//               (85% by default) for a sender outside the organization.
//   would-move  the same, in monitor mode or while the brake is on: recorded, nothing moved.
//   flag        suspicious but not moved (amber verdict, or a high AI score the policy doesn't act on,
//               such as an inside sender): recorded for the dashboard.
//   none        nothing to record.
//
// Never moved, whatever the checks say: allowlisted senders and domains ("trusted"). Mail from inside
// the organization is moved only by the rules (a compromised staff account trips them too), not by the
// AI score alone, unless AI_MOVES_INSIDE is set.
function isAllowed(cfg, address) {
    const a = String(address || '').toLowerCase();
    const d = a.split('@')[1] || '';
    return cfg.allowAddresses.includes(a) || cfg.allowDomains.some(x => d === x || d.endsWith('.' + x));
}

function decide(result, cfg, state = {}) {
    if (result.status === 'trusted') return { action: 'none', trigger: null, why: 'allowlisted sender' };
    const p = result.ai && typeof result.ai.probability === 'number' ? result.ai.probability : null;
    const ruleMove = cfg.moveOnRules && result.status === 'flagged';
    const aiHigh = p !== null && p >= cfg.aiThreshold;
    const aiMove = aiHigh && (!result.inside || cfg.aiMovesInside);
    if (!ruleMove && !aiMove) {
        const suspicious = result.status === 'caution' || result.status === 'flagged' || aiHigh || (p !== null && p >= 0.5);
        return { action: suspicious ? 'flag' : 'none', trigger: null,
                 why: aiHigh && result.inside ? `AI ${Math.round(p * 100)}%, but the sender is inside the organization (the AI alone doesn't move those)` : (suspicious ? 'suspicious, below the move rules' : '') };
    }
    const trigger = ruleMove && aiMove ? 'rules+ai' : ruleMove ? 'rules' : 'ai';
    const why = [ruleMove ? `rules flagged it (score ${result.score})` : '', aiMove ? `AI ${Math.round(p * 100)}% ≥ ${Math.round(cfg.aiThreshold * 100)}%` : ''].filter(Boolean).join(' and ');
    if (cfg.mode !== 'enforce') return { action: 'would-move', trigger, why: `${why} (monitor mode: not moved)` };
    if (state.brake) return { action: 'would-move', trigger, why: `${why} (brake on: not moved)`, braked: true };
    return { action: 'move', trigger, why };
}

module.exports = { decide, isAllowed };
