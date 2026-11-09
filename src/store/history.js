'use strict';
// Gmail history ids are increasing 64-bit numbers, sent as strings. -1, 0 or 1 as a is before, the same
// as or after b; null when either is missing or not a number (the order isn't known).
function compareHistoryIds(a, b) {
    if (a === null || a === undefined || b === null || b === undefined || a === '' || b === '') return null;
    let x, y;
    try { x = BigInt(String(a)); y = BigInt(String(b)); } catch (e) { return null; }
    return x < y ? -1 : x > y ? 1 : 0;
}
// Whether `next` may replace the stored position `cur`: only ever forward. Where the order isn't known
// (not numbers), any other value replaces it, as before this check existed.
function movesForward(next, cur) {
    if (!cur) return true;
    const c = compareHistoryIds(next, cur);
    return c === null ? String(next) !== String(cur) : c > 0;
}

module.exports = { compareHistoryIds, movesForward };
