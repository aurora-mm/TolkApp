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
//   node tools/encrypt-dictionary.mjs [path/to/dictionary.json]
//   DICT_PASSWORD=... node tools/encrypt-dictionary.mjs   (non-interactive)
//
// Defaults to the desktop app's live dictionary.

import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
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
const defaultSource = join(
  homedir(),
  "Library",
  "Application Support",
  "InterpreterAid",
  "dictionary.json",
);

function loadEntries(path) {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const items = Array.isArray(raw)
    ? raw
    : Object.entries(raw).map(([term, payload]) => ({ source_term: term, ...payload }));

  const entries = [];
  for (const item of items) {
    const term = String(item.source_term ?? "").trim();
    const translation = String(item.translation ?? "").trim();
    if (!term || !translation) continue;
    let language = item.language ?? item.source_language;
    if (language !== "sv" && language !== "ru") {
      language = /[Ѐ-ӿ]/u.test(term) ? "ru" : "sv";
    }
    entries.push([term, translation, language, String(item.notes ?? "").trim()]);
  }
  return entries;
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
  const entries = loadEntries(source);
  if (entries.length === 0) throw new Error(`no usable entries in ${source}`);

  let password = process.env.DICT_PASSWORD;
  if (!password) {
    password = await askHidden("Lösenord: ");
    const again = await askHidden("Igen: ");
    if (password !== again) throw new Error("passwords did not match");
  }
  if (!password) throw new Error("empty password");

  // Compressed before encryption, because ciphertext does not compress and
  // GitHub Pages' own gzip would then do nothing.
  const plaintext = gzipSync(Buffer.from(JSON.stringify(entries), "utf8"), { level: 9 });

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
    v: 1,
    kdf: { name: "PBKDF2", hash: "SHA-256", iterations: ITERATIONS, salt: b64(salt) },
    cipher: { name: "AES-GCM", iv: b64(iv) },
    encoding: "gzip+json",
    data: b64(ciphertext),
  };
  writeFileSync(output, JSON.stringify(payload));
  console.log(
    `${entries.length} entries from ${source}\n` +
      `-> ${output} (${(JSON.stringify(payload).length / 1024).toFixed(0)} KB)`,
  );
}

main().catch((error) => {
  console.error(`encrypt-dictionary: ${error.message}`);
  process.exit(1);
});
