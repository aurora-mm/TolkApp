#!/usr/bin/env node
// Prove the web lookup returns exactly what the desktop app returns.
//
// Generates thousands of queries in Python - exact terms, prefixes, typos,
// diacritic-free Swedish, Latin transliterations of Russian, Cyrillic
// fragments, noise - runs each through the app's own TermLookup, then through
// lookup.js, and fails on the first difference in results or order.
//
// Run from anywhere inside the main repository:
//   node dictionary-web/tools/parity-test.mjs [path/to/dictionary.json]
// PYTHON overrides the interpreter (defaults to the repo's .venv).

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { TermLookup } from "../lookup.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..");
const dictionaryPath = resolve(
  process.argv[2] ??
    join(homedir(), "Library", "Application Support", "InterpreterAid", "dictionary.json"),
);
const python = process.env.PYTHON ?? join(repo, ".venv", "bin", "python");
if (!existsSync(python)) {
  console.error(`parity-test: no Python at ${python}; set PYTHON`);
  process.exit(2);
}

const generator = String.raw`
import json, random, sys
sys.path.insert(0, sys.argv[1])
from interpreter_note_assistant.dictionary_manager import validate_dictionary
from interpreter_note_assistant.term_lookup import TermLookup
from interpreter_note_assistant.transliteration import transliterate_ru_to_latin

entries = validate_dictionary(json.load(open(sys.argv[2], encoding="utf-8")))
lookup = TermLookup(entries)
rng = random.Random(20261018)
terms = [e.source_term for e in entries]

def typo(text):
    if len(text) < 3:
        return text
    i = rng.randrange(len(text) - 1)
    kind = rng.randrange(3)
    if kind == 0:
        return text[:i] + text[i + 1:]
    if kind == 1:
        return text[:i] + text[i + 1] + text[i] + text[i + 2:]
    return text[:i] + rng.choice("aeiouknrst") + text[i + 1:]

queries = set(terms)
for term in rng.sample(terms, 1500):
    queries.update({term[:3], term[:5], term[:8], typo(term), term.upper(), "  " + term + "!"})
    queries.add(term.replace("å", "a").replace("ä", "a").replace("ö", "o"))
for e in rng.sample([e for e in entries if e.language == "ru"], 800):
    latin = transliterate_ru_to_latin(e.source_term)
    queries.update({latin, latin[:6], typo(latin), e.source_term[:4]})
queries.update(["", " ", "ekg", "EKG", "hjart", "serdce", "сердце", "infarkt", "x", "zz9", "ß", "Ё"])

expected = {q: [r.source_term for r in lookup.search(q)] for q in sorted(queries)}
print(json.dumps(expected, ensure_ascii=False))
`;

const expected = JSON.parse(
  execFileSync(python, ["-c", generator, repo, dictionaryPath], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  }),
);

const raw = JSON.parse(readFileSync(dictionaryPath, "utf8"));
const entries = (Array.isArray(raw) ? raw : Object.entries(raw).map(([t, p]) => ({ source_term: t, ...p })))
  .map((e) => ({
    source_term: String(e.source_term ?? "").trim(),
    translation: String(e.translation ?? "").trim(),
    language: e.language ?? e.source_language,
    notes: String(e.notes ?? "").trim(),
  }))
  .filter((e) => e.source_term && e.translation);

const lookup = new TermLookup(entries);
const queries = Object.keys(expected);
let failures = 0;
for (const query of queries) {
  const actual = lookup.search(query).map((entry) => entry.source_term);
  const want = expected[query];
  if (JSON.stringify(actual) !== JSON.stringify(want)) {
    failures += 1;
    if (failures <= 10) {
      console.log(`MISMATCH ${JSON.stringify(query)}\n  python: ${JSON.stringify(want)}\n  js:     ${JSON.stringify(actual)}`);
    }
  }
}

const withResults = queries.filter((q) => expected[q].length > 0).length;
console.log(
  `${queries.length} queries (${withResults} with results) over ${entries.length} entries: ` +
    (failures === 0 ? "identical" : `${failures} mismatches`),
);
process.exit(failures === 0 ? 0 : 1);
