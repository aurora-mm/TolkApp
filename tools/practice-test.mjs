#!/usr/bin/env node
// Tests for practice.js: card building and the shuffle bag.
//
//   node dictionary-web/tools/practice-test.mjs [path/to/dictionary.json]
//
// The last section runs against the real dictionary when it is available.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { ShuffleBag, answerLanguage, buildCards } from "../practice.js";

let failures = 0;
function check(name, condition, detail = "") {
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ""}`);
  }
}

// Deterministic generator so failures reproduce. mulberry32 rather than a
// plain LCG: an LCG's first output for consecutive seeds sits in a narrow band
// (0.24-0.31 for seeds 1-200), which starves the shuffle's first swap and made
// a correct shuffle look biased.
function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

const entry = (source_term, translation, language, notes = "") =>
  ({ source_term, translation, language, notes });

console.log("buildCards");
{
  const cards = buildCards([
    entry("КТ", "datortomograf CT", "ru"),
    entry("КТ", "datortomografi CT", "ru"),
    entry("kt", "should merge by casefold", "ru"),
    entry("КТ", "datortomograf CT", "ru"), // exact duplicate translation
    entry("datortomograf CT", "КТ", "sv"), // same text, other direction
  ]);
  const ru = cards.find((c) => c.language === "ru" && c.term === "КТ");
  check("terms with several translations become one card", cards.filter((c) => c.term === "КТ").length === 1);
  check(
    "every distinct translation is kept, in order, without duplicates",
    JSON.stringify(ru.translations) === JSON.stringify(["datortomograf CT", "datortomografi CT"]),
    JSON.stringify(ru.translations),
  );
  check("the two directions stay separate cards", cards.some((c) => c.language === "sv"));
  check("answer language is the opposite of the term's", answerLanguage(ru) === "sv");
}
{
  const cards = buildCards([entry("  ", "x", "sv"), entry("a", "  ", "sv"), entry("b", "c", "sv")]);
  check("blank terms and blank translations are dropped", cards.length === 1 && cards[0].term === "b");
}

console.log("ShuffleBag");
{
  const items = Array.from({ length: 50 }, (_, i) => i);
  const bag = new ShuffleBag(items, seeded(7));
  for (let round = 1; round <= 20; round += 1) {
    const seen = items.map(() => bag.next());
    const unique = new Set(seen);
    if (unique.size !== items.length) {
      check(`round ${round} serves every card exactly once`, false, `${unique.size} distinct of ${items.length}`);
    }
  }
  check("every round serves every card exactly once (20 rounds)", failures === 0);
}
{
  let boundaryRepeats = 0;
  for (let seed = 1; seed <= 2000; seed += 1) {
    const bag = new ShuffleBag([0, 1, 2], seeded(seed));
    let previous = null;
    for (let i = 0; i < 30; i += 1) {
      const current = bag.next();
      if (current === previous) boundaryRepeats += 1;
      previous = current;
    }
  }
  check("never the same card twice in a row, even across rounds", boundaryRepeats === 0, `${boundaryRepeats} repeats`);
}
{
  const bag = new ShuffleBag(["only"]);
  check("a one-card bag keeps returning its card", bag.next() === "only" && bag.next() === "only");
}
{
  const bag = new ShuffleBag([1, 2, 3, 4], seeded(3));
  bag.next();
  bag.next();
  check("position counts cards within the round", bag.positionInRound === 2);
  bag.next();
  bag.next();
  bag.next();
  check("position restarts with each new round", bag.positionInRound === 1 && bag.round === 2);
}
{
  let threw = false;
  try {
    new ShuffleBag([]);
  } catch {
    threw = true;
  }
  check("an empty bag is refused rather than looping forever", threw);
}
{
  // Every item should be equally likely at every position. This is what
  // catches the classic Fisher-Yates off-by-one (drawing from [0, i) instead
  // of [0, i]), which only ever produces cyclic permutations: no item could
  // stay in place, and the diagonal below would read zero.
  const n = 5;
  const trials = 20000;
  const counts = Array.from({ length: n }, () => new Array(n).fill(0));
  const random = seeded(42);
  for (let t = 0; t < trials; t += 1) {
    const bag = new ShuffleBag([0, 1, 2, 3, 4], random);
    for (let position = 0; position < n; position += 1) counts[bag.next()][position] += 1;
  }
  const expected = trials / n;
  const worst = Math.max(...counts.flat().map((c) => Math.abs(c - expected) / expected));
  check(
    "every card is equally likely at every position",
    worst < 0.1,
    `worst cell off by ${(worst * 100).toFixed(1)}%: ${JSON.stringify(counts)}`,
  );
}

const dictionaryPath = resolve(
  process.argv[2] ?? join(homedir(), "Library", "Application Support", "InterpreterAid", "dictionary.json"),
);
if (existsSync(dictionaryPath)) {
  console.log("real dictionary");
  const entries = JSON.parse(readFileSync(dictionaryPath, "utf8"));
  const cards = buildCards(entries);
  const translations = cards.reduce((sum, c) => sum + c.translations.length, 0);
  const multi = cards.filter((c) => c.translations.length > 1).length;
  console.log(`       ${entries.length} entries -> ${cards.length} cards, ${multi} with several translations`);
  check("no translation is lost by merging", translations <= entries.length && translations >= cards.length);
  const pairs = new Set(entries.map((e) => `${e.language}|${e.source_term.trim().toLowerCase()}|${e.translation.trim().toLowerCase()}`));
  const covered = new Set(cards.flatMap((c) => c.translations.map((t) => `${c.language}|${c.term.toLowerCase()}|${t.toLowerCase()}`)));
  const missing = [...pairs].filter((p) => !covered.has(p));
  check("every term-translation pair in the dictionary is on some card", missing.length === 0, missing.slice(0, 3).join("; "));
}

console.log(failures === 0 ? "\nall passed" : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
