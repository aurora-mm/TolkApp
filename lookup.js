// Term lookup, ported from the desktop app so both search identically.
//
// Mirrors interpreter_note_assistant/transliteration.py and term_lookup.py
// function for function. tools/parity-test.mjs runs the same queries through
// both implementations and fails on any difference, so change them together.

const CYRILLIC_TO_LATIN = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "yo", ж: "zh",
  з: "z", и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o",
  п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "kh", ц: "ts",
  ч: "ch", ш: "sh", щ: "shch", ы: "y", э: "e", ю: "yu", я: "ya",
  ь: "", ъ: "",
};

const LATIN_VARIANTS = [
  ["shch", "sch"],
  ["shtch", "sch"],
  ["šč", "sch"],
  ["jo", "yo"],
  ["je", "ye"],
  ["iy", "y"],
  ["ij", "y"],
  ["kh", "h"],
  ["ts", "c"],
];

const MIN_SCORE = 0.58;
const DEFAULT_LIMIT = 8;

// Python's str.casefold(). For Swedish and Russian it agrees with lower-casing
// except for ß, which casefold expands.
function casefold(value) {
  return value.toLowerCase().replaceAll("ß", "ss");
}

function compact(value) {
  return value.replace(/[^0-9a-zа-яёåäö]+/gu, "");
}

export function foldSwedish(value) {
  let folded = casefold(value.normalize("NFKC"));
  folded = folded.replaceAll("å", "a").replaceAll("ä", "a").replaceAll("ö", "o");
  return compact(folded);
}

export function hasCyrillic(value) {
  for (const char of value) {
    if (char >= "Ѐ" && char <= "ӿ") return true;
  }
  return false;
}

export function foldCyrillic(value) {
  return casefold(value.normalize("NFKC")).replace(/[^а-яё]+/gu, "");
}

export function normalizeLatinTransliteration(value) {
  let normalized = casefold(value.normalize("NFKC"));
  normalized = normalized.replaceAll("ё", "yo");
  normalized = compact(normalized);
  for (const [source, target] of LATIN_VARIANTS) {
    normalized = normalized.replaceAll(source, target);
  }
  return normalized;
}

export function transliterateRuToLatin(value) {
  let out = "";
  for (const char of casefold(value.normalize("NFKC"))) {
    out += Object.hasOwn(CYRILLIC_TO_LATIN, char) ? CYRILLIC_TO_LATIN[char] : char;
  }
  return normalizeLatinTransliteration(out);
}

// rapidfuzz's fuzz.ratio: normalised Indel similarity, where Indel distance is
// len(a) + len(b) - 2 * LCS(a, b). Computed in the same order rapidfuzz does so
// equal ratios compare equal across both implementations.
function longestCommonSubsequence(a, b) {
  if (a.length === 0 || b.length === 0) return 0;
  let previous = new Uint16Array(b.length + 1);
  let current = new Uint16Array(b.length + 1);
  for (let i = 1; i <= a.length; i += 1) {
    const ai = a[i - 1];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = ai === b[j - 1]
        ? previous[j - 1] + 1
        : Math.max(previous[j], current[j - 1]);
    }
    [previous, current] = [current, previous];
  }
  return previous[b.length];
}

function ratio(a, b) {
  const lensum = a.length + b.length;
  if (lensum === 0) return 1;
  const distance = lensum - 2 * longestCommonSubsequence(a, b);
  return ((1 - distance / lensum) * 100) / 100;
}

function score(query, candidate) {
  if (!query || !candidate) return 0;
  if (query === candidate) return 1;
  // Code-point arrays, so lengths match Python's len() for any input.
  const q = Array.from(query);
  const c = Array.from(candidate);
  if (candidate.includes(query)) {
    return Math.min(0.98, 0.72 + (q.length / Math.max(c.length, 1)) * 0.25);
  }
  if (query.includes(candidate)) return 0.9;
  // ratio can never exceed 2 * min / (len_a + len_b); skip pairs that cannot
  // reach the threshold. Purely a speed-up: it never changes a result.
  const ceiling = (2 * Math.min(q.length, c.length)) / (q.length + c.length);
  if (ceiling < MIN_SCORE - 1e-9) return 0;
  return ratio(q, c);
}

export class TermLookup {
  constructor(entries) {
    this.records = entries.map((entry) => ({
      entry,
      swedishKey: foldSwedish(entry.source_term),
      cyrillicKey: foldCyrillic(entry.source_term),
      russianLatinKey: transliterateRuToLatin(entry.source_term),
      sortKey: casefold(entry.source_term),
    }));
  }

  get size() {
    return this.records.length;
  }

  search(rawQuery, { limit = DEFAULT_LIMIT } = {}) {
    const query = rawQuery.trim();
    if (!query) return [];
    const querySv = foldSwedish(query);
    const queryCyrillic = foldCyrillic(query);
    const queryLatin = normalizeLatinTransliteration(query);
    const queryHasCyrillic = hasCyrillic(query);

    const scored = [];
    for (const record of this.records) {
      let value;
      if (record.entry.language === "sv") {
        value = score(querySv, record.swedishKey);
      } else if (queryHasCyrillic) {
        value = score(queryCyrillic, record.cyrillicKey);
      } else {
        value = score(queryLatin, record.russianLatinKey);
      }
      if (value >= MIN_SCORE) scored.push([value, record]);
    }

    // Python sorts by (-score, casefold(term)) comparing code points; plain
    // string comparison does the same for these alphabets.
    scored.sort((left, right) => {
      if (left[0] !== right[0]) return right[0] - left[0];
      if (left[1].sortKey < right[1].sortKey) return -1;
      if (left[1].sortKey > right[1].sortKey) return 1;
      return 0;
    });
    return scored.slice(0, limit).map(([, record]) => record.entry);
  }
}
