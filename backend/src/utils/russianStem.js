/**
 * Simplified Russian Porter stemmer.
 * Handles common Russian suffixes to normalize words for BM25 scoring.
 */

const VOWEL = /[аеиоуыэюяё]/;

const PERFECTIVEGROUND = /((ив|ивши|ившись|ыв|ывши|ывшись)|((?<=[ая])(в|вши|вшись)))$/;
const REFLEXIVE = /(с[яь])$/;
const ADJECTIVE = /(ее|ие|ые|ое|ими|ыми|ей|ий|ый|ой|ем|им|ым|ом|его|ого|ему|ому|их|ых|ую|юю|ая|яя|ою|ею)$/;
const PARTICIPLE = /((ивш|ывш|ующ)|((?<=[ая])(ем|нн|вш|ющ|щ)))$/;
const VERB = /((ила|ыла|ена|ейте|уйте|ите|или|ыли|ей|уй|ил|ыл|им|ым|ен|ило|ыло|ено|ят|ует|уют|ит|ыт|ены|ить|ыть|ишь|ую|ю)|((?<=[ая])(ла|на|ете|йте|ли|й|л|ем|н|ло|но|ет|ют|ны|ть|ешь|нно)))$/;
const NOUN = /(а|ев|ов|ие|ье|е|иями|ями|ами|еи|ии|и|ией|ей|ой|ий|й|иям|ям|ием|ем|ам|ом|о|у|ах|иях|ях|ы|ь|ию|ью|ю|ия|ья|я)$/;
const DERIVATIONAL = /(ост|ость)$/;
const SUPERLATIVE = /(ейш|ейше)$/;

/**
 * Find the RV region (everything after the first vowel).
 */
function rvRegion(word) {
  const match = word.match(VOWEL);
  if (!match) return '';
  return word.slice(match.index + 1);
}

/**
 * Stem a Russian word (simplified Porter algorithm).
 *
 * @param {string} word
 * @returns {string} stemmed word
 */
function stem(word) {
  if (!word || word.length <= 2) return word;

  word = word.toLowerCase().replace(/ё/g, 'е');

  const rv = rvRegion(word);
  if (!rv) return word;

  const rvStart = word.length - rv.length;

  // Step 1: Try to strip suffixes in order of priority
  let result = word;

  // Try PERFECTIVEGROUND
  let stripped = rv.replace(PERFECTIVEGROUND, '');
  if (stripped !== rv) {
    result = word.slice(0, rvStart) + stripped;
  } else {
    // Try REFLEXIVE first
    stripped = rv.replace(REFLEXIVE, '');
    const afterReflexive = stripped !== rv ? stripped : rv;

    // Try ADJECTIVE
    let step1Done = false;
    const adjStripped = afterReflexive.replace(ADJECTIVE, '');
    if (adjStripped !== afterReflexive) {
      // Try PARTICIPLE after adjective
      const partStripped = adjStripped.replace(PARTICIPLE, '');
      result = word.slice(0, rvStart) + (partStripped !== adjStripped ? partStripped : adjStripped);
      step1Done = true;
    }

    if (!step1Done) {
      // Try VERB
      const verbStripped = afterReflexive.replace(VERB, '');
      if (verbStripped !== afterReflexive) {
        result = word.slice(0, rvStart) + verbStripped;
      } else {
        // Try NOUN
        const nounStripped = afterReflexive.replace(NOUN, '');
        if (nounStripped !== afterReflexive) {
          result = word.slice(0, rvStart) + nounStripped;
        } else {
          result = word.slice(0, rvStart) + afterReflexive;
        }
      }
    }
  }

  // Step 2: strip И if present at end of rv
  if (result.endsWith('и')) {
    result = result.slice(0, -1);
  }

  // Step 3: derivational suffix
  const rv2 = rvRegion(result);
  if (rv2) {
    const derStripped = rv2.replace(DERIVATIONAL, '');
    if (derStripped !== rv2) {
      result = result.slice(0, result.length - rv2.length) + derStripped;
    }
  }

  // Step 4: superlative + trailing НН → Н
  result = result.replace(SUPERLATIVE, '');
  if (result.endsWith('нн')) {
    result = result.slice(0, -1);
  }

  return result;
}

module.exports = { stem };
