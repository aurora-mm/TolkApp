#!/usr/bin/env node
// Tests for glossary.js and practice.js.
//
//   node dictionary-web/tools/practice-test.mjs
//
// The last section runs against the real parsed glossary when it is available
// (dictionary-web/build/glossary.json, produced by tools/parse_facit.py).

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { decodeGlossary, lookupEntries, termCount, termsInScope } from "../glossary.js";
import { STATUS_WEIGHT, ShuffleBag, StratifiedPicker, buildDeck } from "../practice.js";

let failures = 0;
function check(name, condition, detail = "") {
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ""}`);
  }
}

// mulberry32 rather than a plain LCG: an LCG's first output for consecutive
// seeds sits in a narrow band, which starves a shuffle's first swap and made a
// correct shuffle look biased.
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

const fixture = decodeGlossary({
  v: 2,
  dictionaries: [
    {
      id: "test",
      name: "Test",
      chapters: [
        { id: "1", number: 1, title: "Ett", terms: [
          ["Statsskick", "g", ["государственный строй"], ["форма правления"]],
          ["Fordran", "r", ["требование", "претензия"], []],
          ["Rubrik", "", ["заголовок"], ["титул"]],
        ] },
        { id: "2", number: 2, title: "Två", terms: [
          ["statsskick", "y", ["форма правления", "политический строй"], []],
          ["Lag", "y", ["закон"], []],
        ] },
      ],
    },
  ],
})[0];

console.log("glossary");
{
  check("statuses decode to colour names", fixture.chapters[0].terms.map((t) => t.status).join() === "green,red,none");
  check("term count spans all chapters", termCount(fixture) === 5);
  const chapterOne = termsInScope(fixture, "1");
  check("one chapter's scope holds only that chapter", chapterOne.length === 3);
  const all = termsInScope(fixture, "all");
  const merged = all.find((t) => t.key === "statsskick");
  check("the same term across chapters becomes one", all.length === 4);
  check(
    "merging keeps every correct translation",
    JSON.stringify(merged.ru) === JSON.stringify(["государственный строй", "форма правления", "политический строй"]),
    JSON.stringify(merged.ru),
  );
  check(
    "a translation correct in one chapter is not also listed as tolerable",
    merged.tolerable.length === 0,
    JSON.stringify(merged.tolerable),
  );
  check("merging does not alter the source chapters", fixture.chapters[0].terms[0].ru.length === 1);
}
{
  const entries = lookupEntries(fixture);
  const sv = entries.filter((e) => e.language === "sv");
  const ru = entries.filter((e) => e.language === "ru");
  // Eight distinct pairs: "форма правления" appears in both chapters.
  check("lookup has an entry each way for every distinct pair", sv.length === ru.length && sv.length === 8, `${sv.length}/${ru.length}`);
  check("a pair tolerable in one chapter but correct in another is correct",
    sv.find((e) => e.translation === "форма правления").tolerable === false);
  check("Russian finds the Swedish term", ru.some((e) => e.source_term === "требование" && e.translation === "Fordran"));
  check("tolerable translations are searchable but flagged",
    entries.some((e) => e.source_term === "титул" && e.translation === "Rubrik" && e.tolerable));
  check("entries carry the term's colour", sv.find((e) => e.source_term === "Fordran").status === "red");
}

console.log("deck");
{
  const deck = buildDeck(termsInScope(fixture, "1"));
  check("two cards per term, one each way", deck.length === 6);
  const svCard = deck.find((c) => c.direction === "sv" && c.termKey === "statsskick");
  check("a Swedish card's answer carries correct and tolerable apart",
    svCard.answers.join() === "государственный строй" && svCard.tolerable.join() === "форма правления");
  const ruCard = deck.find((c) => c.direction === "ru" && c.termKey === "fordran");
  check("a Russian card prompts with every correct translation", ruCard.prompt.length === 2 && ruCard.answers[0] === "Fordran");
  const onlyTolerable = buildDeck([{ key: "x", sv: "X", status: "green", ru: [], tolerable: ["икс"] }]);
  check("a term with only tolerable Russian is not used as a Russian prompt",
    onlyTolerable.length === 1 && onlyTolerable[0].direction === "sv");
}

console.log("ShuffleBag");
{
  const items = Array.from({ length: 50 }, (_, i) => i);
  const bag = new ShuffleBag(items, seeded(7));
  let ok = true;
  for (let round = 0; round < 20; round += 1) {
    if (new Set(items.map(() => bag.next())).size !== items.length) ok = false;
  }
  check("every round serves every item exactly once (20 rounds)", ok);
}
{
  let repeats = 0;
  for (let seed = 1; seed <= 2000; seed += 1) {
    const bag = new ShuffleBag([0, 1, 2], seeded(seed));
    let previous = null;
    for (let i = 0; i < 30; i += 1) {
      const current = bag.next();
      if (current === previous) repeats += 1;
      previous = current;
    }
  }
  check("never the same item twice in a row, even across rounds", repeats === 0, `${repeats} repeats`);
}
{
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
  // Catches the classic Fisher-Yates off-by-one, which only produces cyclic
  // permutations: the diagonal would read zero.
  check("every item is equally likely at every position", worst < 0.1, `worst cell off by ${(worst * 100).toFixed(1)}%`);
}
{
  const bag = new ShuffleBag(["a", "b", "c", "d"], seeded(9));
  const round = [bag.next((x) => x === "a"), bag.next(), bag.next(), bag.next()];
  check("reject skips an item without dropping it from the round", new Set(round).size === 4 && round[0] !== "a");
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

console.log("StratifiedPicker");
const fakeCards = (status, count, prefix) =>
  Array.from({ length: count }, (_, i) => ({ termKey: `${prefix}${i}`, status }));
{
  // Deliberately lopsided: far more red cards than green, as in Juridik.
  const cards = [...fakeCards("green", 20, "g"), ...fakeCards("yellow", 40, "y"), ...fakeCards("red", 200, "r")];
  const picker = new StratifiedPicker(cards, { random: seeded(5) });
  const seen = { green: 0, yellow: 0, red: 0 };
  const draws = 60000;
  for (let i = 0; i < draws; i += 1) seen[picker.next().status] += 1;
  const share = (s) => seen[s] / draws;
  const total = STATUS_WEIGHT.green + STATUS_WEIGHT.yellow + STATUS_WEIGHT.red;
  const want = { green: STATUS_WEIGHT.green / total, yellow: STATUS_WEIGHT.yellow / total, red: STATUS_WEIGHT.red / total };
  check(
    "colours are drawn 60/30/10 however many cards each has",
    ["green", "yellow", "red"].every((s) => Math.abs(share(s) - want[s]) < 0.01),
    `got ${["green", "yellow", "red"].map((s) => (share(s) * 100).toFixed(1)).join("/")}`,
  );
}
{
  const cards = [...fakeCards("green", 10, "g"), ...fakeCards("yellow", 10, "y")];
  const picker = new StratifiedPicker(cards, { random: seeded(6) });
  const odds = picker.odds;
  check("an absent colour drops out and the rest share its odds",
    Math.abs(odds.green - 2 / 3) < 1e-9 && Math.abs(odds.yellow - 1 / 3) < 1e-9 && !("red" in odds),
    JSON.stringify(odds));
}
{
  // Two cards per term, as in a real deck, in a tiny deck where it is hardest.
  const deck = buildDeck([
    { key: "a", sv: "A", status: "green", ru: ["а"], tolerable: [] },
    { key: "b", sv: "B", status: "green", ru: ["б"], tolerable: [] },
    { key: "c", sv: "C", status: "red", ru: ["в"], tolerable: [] },
  ]);
  let repeats = 0;
  for (let seed = 1; seed <= 300; seed += 1) {
    const picker = new StratifiedPicker(deck, { random: seeded(seed) });
    let previous = null;
    for (let i = 0; i < 200; i += 1) {
      const card = picker.next();
      if (previous && card.termKey === previous.termKey) repeats += 1;
      previous = card;
    }
  }
  check("never the same term twice in a row, in either direction", repeats === 0, `${repeats} repeats in 60 000 draws`);
}
{
  const cards = fakeCards("green", 30, "g");
  const picker = new StratifiedPicker(cards, { random: seeded(8) });
  check("within a colour, every card comes up before any repeats",
    new Set(Array.from({ length: 30 }, () => picker.next().termKey)).size === 30);
}
{
  const picker = new StratifiedPicker([{ termKey: "only", status: "red" }]);
  check("a one-card deck keeps working", picker.next().termKey === "only" && picker.next().termKey === "only");
}
{
  // 18 unmarked headings in a deck of hundreds must not get a quarter of draws.
  const cards = [...fakeCards("green", 300, "g"), ...fakeCards("yellow", 100, "y"), ...fakeCards("none", 18, "n")];
  const picker = new StratifiedPicker(cards, { random: seeded(11) });
  const odds = picker.odds;
  check("unmarked terms are drawn with the yellow ones, not as a colour of their own",
    !("none" in odds) && Math.abs(odds.yellow - 1 / 3) < 1e-9, JSON.stringify(odds));
  let none = 0;
  for (let i = 0; i < 30000; i += 1) if (picker.next().status === "none") none += 1;
  const share = none / 30000;
  const expected = (1 / 3) * (18 / 118); // yellow's share, split by card count
  check("an unmarked card keeps its own status for display", picker.strata.some((s) => s.bag.items.some((c) => c.status === "none")));
  check("unmarked terms get their share of yellow draws", Math.abs(share - expected) < 0.01, `got ${(share * 100).toFixed(1)}%, want ${(expected * 100).toFixed(1)}%`);
}

const here = dirname(fileURLToPath(import.meta.url));
const glossaryPath = resolve(here, "..", "build", "glossary.json");
if (existsSync(glossaryPath)) {
  console.log("real glossary");
  const raw = JSON.parse(readFileSync(glossaryPath, "utf8"));
  const code = { green: "g", yellow: "y", red: "r" };
  const dictionaries = decodeGlossary({
    v: 2,
    dictionaries: raw.dictionaries.map((d) => ({
      ...d,
      chapters: d.chapters.map((c) => ({
        ...c,
        terms: c.terms.map((t) => [t.sv, code[t.status] ?? "", t.ru, t.ru_acceptable]),
      })),
    })),
  });
  check("four dictionaries, in the order asked for",
    dictionaries.map((d) => d.name).join() === "Samhälle,Sjukvård,Migration,Juridik");
  for (const dictionary of dictionaries) {
    const entries = lookupEntries(dictionary);
    const have = new Set(entries.filter((e) => e.language === "sv").map((e) => `${e.source_term}|${e.translation}`.toLowerCase()));
    const missing = dictionary.chapters.flatMap((c) =>
      c.terms.flatMap((t) => [...t.ru, ...t.tolerable].map((r) => `${t.sv}|${r}`.toLowerCase())),
    ).filter((pair) => !have.has(pair));
    const all = termsInScope(dictionary, "all");
    const deck = buildDeck(all);
    console.log(`       ${dictionary.name}: ${dictionary.chapters.length} chapters, ${termCount(dictionary)} rows, ` +
      `${all.length} distinct terms, ${deck.length} cards, ${entries.length} lookup entries`);
    check(`${dictionary.name}: every translation is searchable`, missing.length === 0, missing.slice(0, 3).join("; "));
    check(`${dictionary.name}: every chapter has a deck`,
      dictionary.chapters.every((c) => buildDeck(termsInScope(dictionary, c.id)).length > 0));
  }
}

console.log(failures === 0 ? "\nall passed" : `\n${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
