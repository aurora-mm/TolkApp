#!/usr/bin/env node
// Encrypt the dictionary for the static web version.
//
// GitHub Pages serves files to anyone who asks, so a password check in
// JavaScript alone would protect nothing: the data would sit in plain JSON one
// request away. Instead the dictionary is encrypted with a key derived from the
// password, and the page can only read it by deriving the same key. The
// password itself is never written anywhere.
//
// Uses Node's WebCrypto, which is the same API the browser decrypts with, so
// the two sides cannot disagree about formats.
//
// Usage:
//   python tools/parse_facit.py                  # src/*.pdf -> build/glossary.json
//   node tools/encrypt-dictionary.mjs            # build/glossary.json -> dictionary.enc.json
//   DICT_PASSWORD=... node tools/encrypt-dictionary.mjs   (non-interactive)
//
// The input is the glossary parsed from the teacher's facit PDFs: four
// dictionaries, each split into chapters, each term carrying its colour
// status, its correct translations and any merely tolerable ones.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const { subtle } = globalThis.crypto;
// getRandomValues must be called on the Crypto object; destructuring it
// loses that binding and throws.
const getRandomValues = (bytes) => globalThis.crypto.getRandomValues(bytes);

// OWASP's 2023 recommendation for PBKDF2-HMAC-SHA256. Costs roughly half a
// second per unlock on a phone, and the same per guess for anyone attacking
// the published file offline.
const ITERATIONS = 600_000;

const here = dirname(fileURLToPath(import.meta.url));
const output = resolve(here, "..", "dictionary.enc.json");
const defaultSource = resolve(here, "..", "build", "glossary.json");

const STATUS_CODE = { green: "g", yellow: "y", red: "r" };

// Compact form, to keep the download small on a phone:
//   { v: 2, dictionaries: [{ id, name, chapters: [{ id, number, title,
//     terms: [[sv, status, [correct...], [tolerable...]], ...] }] }] }
// status is "g", "y", "r" or "" for an unmarked term.
function loadGlossary(path) {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  if (raw.version !== 2 || !Array.isArray(raw.dictionaries)) {
    throw new Error(`${path} is not a parsed glossary; run tools/parse_facit.py first`);
  }
  let terms = 0;
  const dictionaries = raw.dictionaries.map((dictionary) => ({
    id: dictionary.id,
    name: dictionary.name,
    chapters: dictionary.chapters.map((chapter) => ({
      id: chapter.id,
      number: chapter.number,
      title: chapter.title,
      terms: chapter.terms
        .filter((term) => term.sv && (term.ru.length || term.ru_acceptable.length))
        .map((term) => {
          terms += 1;
          return [term.sv, STATUS_CODE[term.status] ?? "", term.ru, term.ru_acceptable];
        }),
    })),
  }));
  if (terms === 0) throw new Error(`no terms in ${path}`);
  return { content: { v: 2, dictionaries }, terms };
}

function askHidden(prompt) {
  return new Promise((resolvePassword) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl.stdoutMuted = true;
    rl._writeToOutput = (text) => {
      if (!rl.stdoutMuted || text.includes(prompt)) rl.output.write(text);
    };
    rl.question(prompt, (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolvePassword(answer);
    });
  });
}

async function deriveKey(password, salt) {
  const material = await subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: ITERATIONS },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

const b64 = (bytes) => Buffer.from(bytes).toString("base64");

async function main() {
  const source = resolve(process.argv[2] ?? defaultSource);
  const { content, terms } = loadGlossary(source);

  let password = process.env.DICT_PASSWORD;
  if (!password) {
    password = await askHidden("Lösenord: ");
    const again = await askHidden("Igen: ");
    if (password !== again) throw new Error("passwords did not match");
  }
  if (!password) throw new Error("empty password");

  // Compressed before encryption, because ciphertext does not compress and
  // GitHub Pages' own gzip would then do nothing.
  const plaintext = gzipSync(Buffer.from(JSON.stringify(content), "utf8"), { level: 9 });

  const salt = getRandomValues(new Uint8Array(16));
  const iv = getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt);
  const ciphertext = new Uint8Array(
    await subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext),
  );

  // Prove the file opens before replacing the published one.
  const check = new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext));
  if (Buffer.compare(Buffer.from(check), plaintext) !== 0) {
    throw new Error("round-trip check failed");
  }

  const payload = {
    v: 2,
    kdf: { name: "PBKDF2", hash: "SHA-256", iterations: ITERATIONS, salt: b64(salt) },
    cipher: { name: "AES-GCM", iv: b64(iv) },
    encoding: "gzip+json",
    data: b64(ciphertext),
  };
  writeFileSync(output, JSON.stringify(payload));
  console.log(
    `${terms} terms in ${content.dictionaries.length} dictionaries from ${source}\n` +
      `-> ${output} (${(JSON.stringify(payload).length / 1024).toFixed(0)} KB)`,
  );
}

main().catch((error) => {
  console.error(`encrypt-dictionary: ${error.message}`);
  process.exit(1);
});
