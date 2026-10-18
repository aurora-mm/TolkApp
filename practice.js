// Flashcard practice: one card per term, served from a shuffle bag.
//
// Pure functions and a small class with no DOM access, so the behaviour can be
// tested in Node (tools/practice-test.mjs) independently of the page.

const casefold = (value) => value.toLowerCase().replaceAll("ß", "ss");

// The dictionary stores one entry per term-translation pair, and 705 terms have
// more than one translation: "КТ" is both "datortomograf CT" and
// "datortomografi CT". As separate cards, one would mark a valid answer wrong,
// so each term becomes a single card carrying every translation it has.
export function buildCards(entries) {
  const cards = new Map();
  for (const entry of entries) {
    const term = entry.source_term.trim();
    const translation = entry.translation.trim();
    if (!term || !translation) continue;
    const key = `${entry.language}\u0000${casefold(term)}`;
    let card = cards.get(key);
    if (!card) {
      card = { term, language: entry.language, translations: [], notes: [] };
      cards.set(key, card);
    }
    if (!card.translations.some((t) => casefold(t) === casefold(translation))) {
      card.translations.push(translation);
    }
    const note = (entry.notes ?? "").trim();
    if (note && !card.notes.includes(note)) card.notes.push(note);
  }
  return [...cards.values()];
}

// Random order without repeats: every card comes up once per round before any
// comes up again. Pure random draws would keep re-serving some terms while
// others never appear, which is the opposite of what practice needs.
export class ShuffleBag {
  constructor(items, random = Math.random) {
    if (items.length === 0) throw new Error("ShuffleBag needs at least one item");
    this.items = items;
    this.random = random;
    this.order = [];
    this.position = 0;
    this.round = 0;
    this.last = null;
  }

  get size() {
    return this.items.length;
  }

  // 1-based index of the current card within its round.
  get positionInRound() {
    return this.position;
  }

  next() {
    if (this.position >= this.order.length) this.reshuffle();
    const item = this.order[this.position];
    this.position += 1;
    this.last = item;
    return item;
  }

  reshuffle() {
    const order = [...this.items];
    for (let i = order.length - 1; i > 0; i -= 1) {
      const j = Math.floor(this.random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    // Do not open a new round with the card that just closed the last one.
    if (order.length > 1 && order[0] === this.last) {
      const swap = 1 + Math.floor(this.random() * (order.length - 1));
      [order[0], order[swap]] = [order[swap], order[0]];
    }
    this.order = order;
    this.position = 0;
    this.round += 1;
  }
}

export const DIRECTION_LABEL = {
  sv: "Svenska → ryska",
  ru: "Ryska → svenska",
};

// The language a card's answer is written in, for hyphenation and screen readers.
export const answerLanguage = (card) => (card.language === "sv" ? "ru" : "sv");
