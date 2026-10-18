// Unlock and search the encrypted dictionary entirely in the browser.
//
// The password is never compared against anything stored in this site. It is
// stretched into an AES key with PBKDF2, and that key either decrypts
// dictionary.enc.json or it does not. A wrong password is simply a key that
// fails AES-GCM's authentication check.

import { TermLookup } from "./lookup.js";

const $ = (id) => document.getElementById(id);
const lockView = $("lock");
const lookupView = $("lookup");
const form = $("lock-form");
const passwordInput = $("password");
const unlockButton = $("unlock");
const errorBox = $("lock-error");
const queryInput = $("query");
const results = $("results");
const status = $("status");

let lookup = null;

// Start downloading while the user types the password.
const payloadPromise = fetch("dictionary.enc.json", { cache: "no-cache" }).then((response) => {
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
});

const fromBase64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

function showError(message) {
  errorBox.textContent = message;
  errorBox.hidden = false;
}

async function deriveKey(password, kdf) {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: kdf.hash, salt: fromBase64(kdf.salt), iterations: kdf.iterations },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );
}

async function gunzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}

async function unlock(password) {
  const payload = await payloadPromise;
  if (payload.v !== 1) throw new Error("okänt filformat");
  const key = await deriveKey(password, payload.kdf);
  let plaintext;
  try {
    plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64(payload.cipher.iv) },
      key,
      fromBase64(payload.data),
    );
  } catch {
    return null; // Authentication failed: wrong password.
  }
  const rows = JSON.parse(await gunzip(plaintext));
  return rows.map(([source_term, translation, language, notes]) => ({
    source_term,
    translation,
    language,
    notes,
  }));
}

function cell(text, className) {
  const td = document.createElement("td");
  td.textContent = text; // Never innerHTML: terms are data, not markup.
  if (className) td.className = className;
  return td;
}

function render() {
  const query = queryInput.value;
  results.replaceChildren();
  if (!query.trim()) {
    const row = document.createElement("tr");
    const td = cell("Skriv för att söka.", "empty");
    td.colSpan = 2;
    row.append(td);
    results.append(row);
    return;
  }
  const hits = lookup.search(query);
  if (hits.length === 0) {
    const row = document.createElement("tr");
    const td = cell("Inga träffar.", "empty");
    td.colSpan = 2;
    row.append(td);
    results.append(row);
    return;
  }
  for (const entry of hits) {
    const row = document.createElement("tr");
    const term = cell(entry.source_term);
    term.title = entry.source_term;
    term.lang = entry.language;
    const translation = cell(entry.translation);
    translation.title = entry.translation;
    // Translations run the other way, so hyphenate them in the other language.
    translation.lang = entry.language === "sv" ? "ru" : "sv";
    if (entry.notes) {
      const note = document.createElement("span");
      note.className = "note";
      note.textContent = entry.notes;
      translation.append(note);
    }
    row.append(term, translation);
    results.append(row);
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  errorBox.hidden = true;
  const password = passwordInput.value;
  if (!password) {
    showError("Ange lösenordet.");
    passwordInput.focus();
    return;
  }
  if (!window.isSecureContext || !crypto?.subtle) {
    showError("Ordlistan måste öppnas via https.");
    return;
  }

  unlockButton.disabled = true;
  unlockButton.textContent = "Öppnar …";
  try {
    const entries = await unlock(password);
    if (!entries) {
      showError("Fel lösenord.");
      passwordInput.select();
      return;
    }
    lookup = new TermLookup(entries);
    passwordInput.value = "";
    status.textContent = `${lookup.size.toLocaleString("sv-SE")} termer i ordlistan.`;
    lockView.hidden = true;
    lookupView.hidden = false;
    render();
    queryInput.focus();
  } catch (error) {
    showError(`Ordlistan kunde inte läsas in (${error.message}).`);
  } finally {
    unlockButton.disabled = false;
    unlockButton.textContent = "Öppna";
  }
});

queryInput.addEventListener("input", render);

// Locking discards the decrypted entries along with everything else.
$("lock-again").addEventListener("click", () => window.location.reload());
