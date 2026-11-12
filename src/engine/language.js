'use strict';
// Which language an email is written in, as far as the AI model is concerned: phish-tiny was trained on
// English only (its card says so), so on an email in another language its score means little. The rule
// checks don't depend on the language; the model's opinion does. Offline, no library: the letters'
// writing system (Cyrillic, Arabic, Chinese…), and for the Latin alphabet the share of each language's
// commonest short words. It says "not English" only when that is clear: an email with a real English part
// (a bilingual newsletter) counts as English, and a short one as unknown (the model reads both).
//
// detectLanguage(text) → { code: 'en' | 'es' | … | null, name: 'English' | 'Spanish' | …, english: bool, reason }
//   english: false only when the text is clearly in another language.

const SCRIPTS = [
    ['Cyrillic', 'ru', 'Russian or another language written in Cyrillic'],
    ['Greek', 'el', 'Greek'],
    ['Arabic', 'ar', 'Arabic, or another language written in Arabic script'],
    ['Hebrew', 'he', 'Hebrew'],
    ['Hangul', 'ko', 'Korean'],
    ['Hiragana', 'ja', 'Japanese'], ['Katakana', 'ja', 'Japanese'],
    ['Han', 'zh', 'Chinese'],
    ['Thai', 'th', 'Thai'], ['Lao', 'lo', 'Lao'], ['Khmer', 'km', 'Khmer'], ['Myanmar', 'my', 'Burmese'],
    ['Devanagari', 'hi', 'Hindi, or another language written in Devanagari'], ['Bengali', 'bn', 'Bengali'],
    ['Gurmukhi', 'pa', 'Punjabi'], ['Gujarati', 'gu', 'Gujarati'], ['Tamil', 'ta', 'Tamil'], ['Telugu', 'te', 'Telugu'],
    ['Armenian', 'hy', 'Armenian'], ['Georgian', 'ka', 'Georgian'], ['Ethiopic', 'am', 'Amharic, or another language written in Ge\'ez script']
].map(([script, code, name]) => ({ code, name, re: new RegExp(`\\p{Script=${script}}`, 'u') }));

// The commonest short words of each language, without words that are also common in English ("a", "in",
// "no", "is", "to"…): a hit is evidence for that language.
const WORDS = {
    en: 'the and to of you your for that this with are be on we will please have it our from not by an or at can if been has was would should here all any been they their there which what when who about into than then them these those',
    es: 'el la los las de del que y en por para con una un su sus se al lo como más pero este esta estos estas usted ustedes nuestro nuestra gracias hola estimado estimada favor cuenta correo aquí haga información también está están ser hay sobre cuando desde muy todos puede',
    pt: 'o os de do da dos das que e em para com um uma não por se mais seu sua você é está obrigado obrigada olá prezado prezada conta clique aqui também ao à pelo pela isso este esta são foi ser muito quando',
    fr: 'le la les des du de et est en un une que qui pour dans sur pas vous votre vos nous notre avec ce cette au aux merci bonjour compte cliquez ici sont être plus mais ou très tout tous elle il ils',
    de: 'der die das und ist nicht sie ich wir ihr ihre ihren mit für auf dem den ein eine einen zu von bitte sehr geehrte geehrter konto hier klicken werden wird sind auch oder aber im zum zur danke',
    it: 'il lo la gli le di del della che e è per con un una non sono alla nel nella si suo sua vostro gentile grazie ciao conto clicca qui anche più questo questa',
    nl: 'de het een en van niet voor met op te dat die zijn uw u wij ons onze je jouw bedankt alstublieft klik worden wordt ook maar aan bij',
    vi: 'của và các là cho được này với trong không có những một người bạn chúng tôi đã sẽ để khi từ theo vui lòng tài khoản xin cảm ơn',
    pl: 'w z na nie się jest do że jak ale od za po dla tak czy są pan pani konto proszę kliknij tutaj dziękujemy oraz',
    tr: 've bir bu için ile da de değil çok daha olarak olan gibi sizin hesabınız lütfen tıklayın teşekkürler merhaba ama veya mi ne',
    id: 'yang dan di ke dari untuk dengan ini itu tidak akan anda kami kita pada adalah atau juga sudah bisa akun silakan klik terima kasih harap',
    tl: 'ang ng sa mga na at ay ito ko mo ka po para hindi salamat kayo namin natin inyong',
    ht: 'ak nan pou li yo se ki ou mwen nou pa gen sa te kounye mèsi bonjou lekòl paran timoun',
    so: 'iyo waa ka ku oo la uu ay ee aad si ah waxaa waxay lacag fadlan mahadsanid'
};
const NAMES = { en: 'English', es: 'Spanish', pt: 'Portuguese', fr: 'French', de: 'German', it: 'Italian', nl: 'Dutch', vi: 'Vietnamese', pl: 'Polish',
                tr: 'Turkish', id: 'Indonesian or Malay', tl: 'Tagalog', ht: 'Haitian Creole', so: 'Somali' };
const SETS = Object.fromEntries(Object.entries(WORDS).map(([k, v]) => [k, new Set(v.split(' '))]));

const MIN_LETTERS = 20, MIN_WORDS = 12;

function detectLanguage(text) {
    const t = String(text || '').slice(0, 6000);
    // 1. The writing system: most letters outside the Latin alphabet name the language (or its script).
    let latin = 0, other = 0;
    const byScript = new Map();
    for (const ch of t) {
        if (!/\p{L}/u.test(ch)) continue;
        if (/\p{Script=Latin}/u.test(ch)) { latin++; continue; }
        other++;
        const s = SCRIPTS.find(x => x.re.test(ch));
        if (s) byScript.set(s, (byScript.get(s) || 0) + 1);
    }
    if (latin + other >= MIN_LETTERS && other / (latin + other) >= 0.5) {
        let best = null;
        for (const [s, n] of byScript) if (!best || n > best[1]) best = [s, n];
        // Japanese mixes kana with Chinese characters: any kana makes it Japanese.
        if (best && best[0].code === 'zh' && [...byScript.keys()].some(s => s.code === 'ja')) best = [SCRIPTS.find(s => s.code === 'ja'), best[1]];
        return best ? { code: best[0].code, name: best[0].name, english: false, reason: 'script' }
            : { code: null, name: 'a language not written in the Latin alphabet', english: false, reason: 'script' };
    }
    // 2. The Latin alphabet: the commonest short words of each language.
    const words = t.toLowerCase().match(/[\p{L}']+/gu) || [];
    if (words.length < MIN_WORDS) return { code: null, name: 'unknown', english: true, reason: 'short' };
    const hits = Object.fromEntries(Object.keys(SETS).map(k => [k, 0]));
    for (const w of words) for (const k in SETS) if (SETS[k].has(w)) hits[k]++;
    let best = null;
    for (const k in hits) if (k !== 'en' && (!best || hits[k] > hits[best])) best = k;
    const en = hits.en;
    if (best && hits[best] >= 5 && hits[best] >= 2.5 * Math.max(en, 1) && hits[best] / words.length >= 0.1) {
        return { code: best, name: NAMES[best], english: false, reason: 'words' };
    }
    return en / words.length >= 0.04 ? { code: 'en', name: 'English', english: true, reason: 'words' } : { code: null, name: 'unknown', english: true, reason: 'unclear' };
}

module.exports = { detectLanguage, NAMES };
