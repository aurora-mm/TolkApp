// Flashcard practice: a deck per dictionary and chapter, drawn by colour.
//
// Pure functions and small classes with no DOM access, so the behaviour can be
// tested in Node (tools/practice-test.mjs) independently of the page.

// How often each colour is drawn, relative to the others. The teacher's green
// terms come up most, yellow less, red least.
export const STATUS_WEIGHT = { green: 6, yellow: 3, red: 1 };

// Unmarked terms - the 18 section headings that also carry a translation - are
// drawn with the yellow ones. As a colour of their own with yellow's weight,
// those 18 cards took 23 % of all draws and repeated constantly.
export const STRATUM_OF = { none: "yellow" };
const stratumOf = (status) => STRATUM_OF[status] ?? status;

export const DIRECTION_LABEL = {
  sv: "Svenska → ryska",
  ru: "Ryska → svenska",
};

// Two cards per term, one each way. A term with only tolerable Russian gets no
// Russian-to-Swedish card: a tolerable rendering is not something to prompt with.
export function buildDeck(terms) {
  const cards = [];
  for (const term of terms) {
    if (term.ru.length || term.tolerable.length) {
      cards.push({
        termKey: term.key,
        status: term.status,
        direction: "sv",
        prompt: [term.sv],
        answers: term.ru,
        tolerable: term.tolerable,
        promptLang: "sv",
        answerLang: "ru",
      });
    }
    if (term.ru.length) {
      cards.push({
        termKey: term.key,
        status: term.status,
        direction: "ru",
        prompt: term.ru,
        answers: [term.sv],
        tolerable: [],
        promptLang: "ru",
        answerLang: "sv",
      });
    }
  }
  return cards;
}

// Random order without repeats: every item comes up once per round before any
// comes up again. next(reject) skips an item the caller does not want right
// now by swapping in a later one from the same round, so nothing is lost.
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

  get positionInRound() {
    return this.position;
  }

  next(reject = null) {
    if (this.position >= this.order.length) this.reshuffle();
    if (reject && reject(this.order[this.position])) {
      let found = false;
      for (let k = this.position + 1; k < this.order.length; k += 1) {
        if (!reject(this.order[k])) {
          [this.order[this.position], this.order[k]] = [this.order[k], this.order[this.position]];
          found = true;
          break;
        }
      }
      // Only rejected items left in this round: start the next one early. The
      // leftovers are not lost - every round contains every item.
      if (!found && this.items.some((item) => !reject(item))) {
        this.reshuffle();
        return this.next(reject);
      }
    }
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

// Stratified draw: pick a colour by weight, then the next card of that colour
// from its own shuffle bag. Weighting whole colours rather than single cards is
// what makes red rare however many red terms a chapter has: Juridik has 351 red
// terms to 572 green, and per-card weights would still serve red a third of
// the time. Colours absent from the deck drop out and the rest share the odds.
export class StratifiedPicker {
  constructor(cards, { weights = STATUS_WEIGHT, random = Math.random } = {}) {
    if (cards.length === 0) throw new Error("StratifiedPicker needs at least one card");
    this.random = random;
    this.size = cards.length;
    this.shown = 0;
    this.last = null;
    this.strata = [];
    const byStatus = new Map();
    for (const card of cards) {
      const stratum = stratumOf(card.status);
      if (!byStatus.has(stratum)) byStatus.set(stratum, []);
      byStatus.get(stratum).push(card);
    }
    for (const [status, group] of byStatus) {
      const weight = weights[status] ?? 1;
      if (weight > 0) {
        const terms = new Set(group.map((card) => card.termKey));
        this.strata.push({ status, weight, terms, bag: new ShuffleBag(group, random) });
      }
    }
    if (this.strata.length === 0) throw new Error("every colour has weight 0");
    this.totalWeight = this.strata.reduce((sum, s) => sum + s.weight, 0);
  }

  // The share of draws each colour gets in this deck.
  get odds() {
    return Object.fromEntries(this.strata.map((s) => [s.status, s.weight / this.totalWeight]));
  }

  next() {
    // Never the same term twice in a row, in either direction: the reverse
    // card straight after the forward one would show its own answer. Only
    // colours that hold some other term are eligible, so this is guaranteed
    // whenever the deck has more than one term - retrying a random draw
    // still repeated in about one draw in 30 000.
    const lastTerm = this.last?.termKey;
    const sameTerm = (card) => card.termKey === lastTerm;
    let eligible = this.strata;
    if (lastTerm !== undefined) {
      const others = this.strata.filter((s) => s.terms.size > 1 || !s.terms.has(lastTerm));
      if (others.length) eligible = others;
    }
    const card = this.chooseStratum(eligible).bag.next(sameTerm);
    this.last = card;
    this.shown += 1;
    return card;
  }

  // Weighted choice among the given colours. Leaving one out for a single draw
  // shifts that draw's odds, never the long-run ones by more than that draw.
  chooseStratum(strata = this.strata) {
    const total = strata.reduce((sum, s) => sum + s.weight, 0);
    let roll = this.random() * total;
    for (const stratum of strata) {
      roll -= stratum.weight;
      if (roll < 0) return stratum;
    }
    return strata[strata.length - 1];
  }
}
