// Unlock and search the encrypted dictionary entirely in the browser.
//
// The password is never compared against anything stored in this site. It is
// stretched into an AES key with PBKDF2, and that key either decrypts
// dictionary.enc.json or it does not. A wrong password is simply a key that
// fails AES-GCM's authentication check.

import { TermLookup } from "./lookup.js";
import { DIRECTION_LABEL, ShuffleBag, answerLanguage, buildCards } from "./practice.js";

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

const modeButtons = { search: $("mode-search"), practice: $("mode-practice") };
const panels = { search: $("panel-search"), practice: $("panel-practice") };
const flashcard = $("flashcard");
const frontFace = flashcard.querySelector(".front");
const backFace = flashcard.querySelector(".back");
const frontDirection = $("front-direction");
const frontTerm = $("front-term");
const backTerm = $("back-term");
const backTranslations = $("back-translations");
const progress = $("progress");
const nextCardButton = $("next-card");
const announcer = $("card-announcer");

const MODE_KEY = "ordlista.mode";

let lookup = null;
let bag = null;
let currentCard = null;

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
    bag = new ShuffleBag(buildCards(entries));
    passwordInput.value = "";
    status.textContent = `${lookup.size.toLocaleString("sv-SE")} termer i ordlistan.`;
    lockView.hidden = true;
    lookupView.hidden = false;
    render();
    setMode(rememberedMode());
  } catch (error) {
    showError(`Ordlistan kunde inte läsas in (${error.message}).`);
  } finally {
    unlockButton.disabled = false;
    unlockButton.textContent = "Öppna";
  }
});

queryInput.addEventListener("input", render);

// ------------------------------------------------------------- modes

function rememberedMode() {
  try {
    return localStorage.getItem(MODE_KEY) === "practice" ? "practice" : "search";
  } catch {
    return "search"; // Storage can be blocked; the page must still work.
  }
}

function setMode(mode) {
  for (const [name, button] of Object.entries(modeButtons)) {
    button.setAttribute("aria-pressed", String(name === mode));
    panels[name].hidden = name !== mode;
  }
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    // Not worth surfacing: remembering the mode is only a convenience.
  }
  if (mode === "practice") {
    if (!currentCard) dealNextCard();
    flashcard.focus({ preventScroll: true });
  } else {
    queryInput.focus();
  }
}

modeButtons.search.addEventListener("click", () => setMode("search"));
modeButtons.practice.addEventListener("click", () => setMode("practice"));

// ---------------------------------------------------------- practice

function isFlipped() {
  return flashcard.getAttribute("aria-pressed") === "true";
}

function setFlipped(flipped) {
  flashcard.setAttribute("aria-pressed", String(flipped));
  // Only the visible face is exposed to screen readers.
  frontFace.setAttribute("aria-hidden", String(flipped));
  backFace.setAttribute("aria-hidden", String(!flipped));
}

function span(text, className, lang) {
  const element = document.createElement("span");
  element.textContent = text;
  if (className) element.className = className;
  if (lang) element.lang = lang;
  return element;
}

function showCard(card) {
  currentCard = card;
  // Turn the card face-up instantly before swapping its contents: animating
  // that turn would sweep the new card's answer past on the way round.
  flashcard.classList.add("instant");
  setFlipped(false);

  frontDirection.textContent = DIRECTION_LABEL[card.language] ?? "";
  frontTerm.textContent = card.term;
  frontTerm.lang = card.language;
  backTerm.textContent = card.term;
  backTerm.lang = card.language;
  backTranslations.replaceChildren(
    ...card.translations.map((translation) => span(translation, "", answerLanguage(card))),
    ...card.notes.map((note) => span(note, "card-note")),
  );

  void flashcard.offsetWidth; // Commit the instant turn before re-enabling animation.
  flashcard.classList.remove("instant");

  const size = bag.size.toLocaleString("sv-SE");
  const position = bag.positionInRound.toLocaleString("sv-SE");
  progress.textContent =
    bag.round > 1 ? `Kort ${position} av ${size} · omgång ${bag.round}` : `Kort ${position} av ${size}`;
  announcer.textContent = `${DIRECTION_LABEL[card.language] ?? ""}: ${card.term}`;
}

function dealNextCard() {
  showCard(bag.next());
}

function flipCard() {
  if (!currentCard) return;
  const flipped = !isFlipped();
  setFlipped(flipped);
  announcer.textContent = flipped ? currentCard.translations.join(", ") : currentCard.term;
}

flashcard.addEventListener("click", flipCard);

nextCardButton.addEventListener("click", () => {
  dealNextCard();
  // Keep focus on the card, so Space flips the new card instead of pressing
  // Nästa again.
  flashcard.focus({ preventScroll: true });
});

document.addEventListener("keydown", (event) => {
  if (panels.practice.hidden || lookupView.hidden) return;
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  const target = event.target;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;

  if (event.key === "ArrowRight" || event.key === "n" || event.key === "N") {
    event.preventDefault();
    dealNextCard();
    flashcard.focus({ preventScroll: true });
  } else if (event.key === " " && !(target instanceof HTMLButtonElement)) {
    // Buttons already turn Space into a click; this covers focus elsewhere.
    event.preventDefault();
    flipCard();
  }
});


// Locking discards the decrypted entries along with everything else.
$("lock-again").addEventListener("click", () => window.location.reload());
