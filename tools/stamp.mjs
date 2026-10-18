#!/usr/bin/env node
// Give every script and stylesheet a content-hash URL: app.js?v=1a2b3c4d.
//
// GitHub Pages lets browsers cache files for ten minutes. After an update, a
// browser could then pair a cached old app.js with a freshly fetched new
// practice.js - which happened during testing, and the page failed to load
// because the old file imported a function the new one no longer had. With
// hashed URLs a changed file is always fetched fresh and an unchanged one is
// reused, so the versions always match.
//
// Run after changing any page file:   node tools/stamp.mjs
// Re-encrypting the dictionary changes no code and needs no stamp.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (name) => readFileSync(resolve(root, name), "utf8");
const hash = (text) => createHash("sha256").update(text).digest("hex").slice(0, 10);

// Modules with no local imports come first, so the module that imports them is
// hashed with their final URLs inside it and changes whenever they do.
const LEAVES = ["lookup.js", "glossary.js", "practice.js"];
const ENTRY = "app.js";
const STYLES = "styles.css";

const versions = {};
for (const name of LEAVES) versions[name] = hash(read(name));

let entry = read(ENTRY);
for (const name of LEAVES) {
  const pattern = new RegExp(`(from\\s+"\\./${name.replace(".", "\\.")})(\\?v=[0-9a-f]+)?(")`, "g");
  if (!pattern.test(entry)) throw new Error(`${ENTRY} does not import ./${name}`);
  entry = entry.replace(pattern, `$1?v=${versions[name]}$3`);
}
writeFileSync(resolve(root, ENTRY), entry);
versions[ENTRY] = hash(entry);
versions[STYLES] = hash(read(STYLES));

let html = read("index.html");
for (const [attribute, name] of [["src", ENTRY], ["href", STYLES]]) {
  const pattern = new RegExp(`(${attribute}="${name.replace(".", "\\.")})(\\?v=[0-9a-f]+)?(")`);
  if (!pattern.test(html)) throw new Error(`index.html does not reference ${name}`);
  html = html.replace(pattern, `$1?v=${versions[name]}$3`);
}
writeFileSync(resolve(root, "index.html"), html);

for (const [name, version] of Object.entries(versions)) console.log(`  ${name.padEnd(12)} ?v=${version}`);
