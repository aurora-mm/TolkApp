// The decrypted glossary: four dictionaries, each split into chapters.
//
// Pure functions with no DOM access, so the page and the Node tests share them.

export const STATUS = { g: "green", y: "yellow", r: "red", "": "none" };

const casefold = (value) => value.toLowerCase().replaceAll("ß", "ss");

// Expand the compact payload ([sv, status, [correct], [tolerable]]) into
// objects the rest of the page can read.
export function decodeGlossary(content) {
  if (content?.v !== 2 || !Array.isArray(content.dictionaries)) {
    throw new Error("okänt ordlisteformat");
  }
  return content.dictionaries.map((dictionary) => ({
    id: dictionary.id,
    name: dictionary.name,
    chapters: dictionary.chapters.map((chapter) => ({
      id: String(chapter.id),
      number: chapter.number,
      title: chapter.title,
      terms: chapter.terms.map(([sv, status, ru, tolerable]) => ({
        sv,
        status: STATUS[status] ?? "none",
        ru,
        tolerable,
      })),
    })),
  }));
}

export function termCount(dictionary) {
  return dictionary.chapters.reduce((sum, chapter) => sum + chapter.terms.length, 0);
}

// Terms for practice: one chapter, or every chapter when chapterId is "all".
// The same Swedish term can appear in several chapters of one dictionary;
// across chapters those become one term carrying every translation.
export function termsInScope(dictionary, chapterId = "all") {
  const chapters =
    chapterId === "all" ? dictionary.chapters : dictionary.chapters.filter((c) => c.id === chapterId);
  const merged = new Map();
  for (const chapter of chapters) {
    for (const term of chapter.terms) {
      const key = casefold(term.sv);
      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, { ...term, key, ru: [...term.ru], tolerable: [...term.tolerable] });
        continue;
      }
      for (const text of term.ru) {
        if (!existing.ru.some((t) => casefold(t) === casefold(text))) existing.ru.push(text);
      }
      for (const text of term.tolerable) {
        const known = [...existing.ru, ...existing.tolerable].some((t) => casefold(t) === casefold(text));
        if (!known) existing.tolerable.push(text);
      }
    }
  }
  // A translation tolerable in one chapter but correct in another is correct.
  for (const term of merged.values()) {
    term.tolerable = term.tolerable.filter((t) => !term.ru.some((r) => casefold(r) === casefold(t)));
  }
  return [...merged.values()];
}

// Entries in the shape the desktop app's lookup works on: one per
// term-translation pair, in both directions, so Swedish, Russian and Latin
// transliteration all find a term exactly as they do in the app.
export function lookupEntries(dictionary) {
  const entries = [];
  const seen = new Map();
  const add = (source_term, translation, language, status, tolerable) => {
    const key = `${language}\u0000${casefold(source_term)}\u0000${casefold(translation)}`;
    const existing = seen.get(key);
    if (existing) {
      // Tolerable in one chapter but correct in another: it is correct.
      if (!tolerable) existing.tolerable = false;
      return;
    }
    const entry = { source_term, translation, language, notes: "", status, tolerable };
    seen.set(key, entry);
    entries.push(entry);
  };
  for (const chapter of dictionary.chapters) {
    for (const term of chapter.terms) {
      for (const ru of term.ru) {
        add(term.sv, ru, "sv", term.status, false);
        add(ru, term.sv, "ru", term.status, false);
      }
      for (const ru of term.tolerable) {
        add(term.sv, ru, "sv", term.status, true);
        add(ru, term.sv, "ru", term.status, true);
      }
    }
  }
  return entries;
}
