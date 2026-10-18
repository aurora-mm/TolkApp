// Unlock, search and practise the encrypted glossary entirely in the browser.
//
// The password is never compared against anything stored in this site. It is
// stretched into an AES key with PBKDF2, and that key either decrypts
// dictionary.enc.json or it does not. A wrong password is simply a key that
// fails AES-GCM's authentication check.

import { decodeGlossary, lookupEntries, termsInScope } from "./glossary.js?v=0dab3c2a08";
import { TermLookup } from "./lookup.js?v=a14f613f27";
import { DIRECTION_LABEL, StratifiedPicker, buildDeck } from "./practice.js?v=68b69f5c26";

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
const dictionaryBar = $("dictionaries");
const chapterSelect = $("chapter");
const oddsLine = $("odds");

const modeButtons = { search: $("mode-search"), practice: $("mode-practice") };
const panels = { search: $("panel-search"), practice: $("panel-practice") };
const flashcard = $("flashcard");
const frontFace = flashcard.querySelector(".front");
const backFace = flashcard.querySelector(".back");
const frontStatus = $("front-status");
const frontDirection = $("front-direction");
const frontTerm = $("front-term");
const backTerm = $("back-term");
const backTranslations = $("back-translations");
const progress = $("progress");
const nextCardButton = $("next-card");
const announcer = $("card-announcer");

// Only selections are remembered, never any of the glossary itself.
const MODE_KEY = "ordlista.mode";
const DICTIONARY_KEY = "ordlista.dictionary";
const CHAPTERS_KEY = "ordlista.chapters";

const STATUS_NAME = { green: "grönt", yellow: "gult", red: "rött", none: "omärkt" };

let glossary = [];
let dictionary = null;
const lookups = new Map();
let picker = null;
let scopeTerms = 0;
let currentCard = null;

// Start downloading while the user types the password.
const payloadPromise = fetch("dictionary.enc.json", { cache: "no-cache" }).then((response) => {
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
});

const fromBase64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
const formatNumber = (n) => n.toLocaleString("sv-SE");

function readStore(key, fallback) {
  try {
    const value = localStorage.getItem(key);
    return value === null ? fallback : JSON.parse(value);
  } catch {
    return fallback; // Storage can be blocked; the page must still work.
  }
}

function writeStore(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Not worth surfacing: remembering selections is only a convenience.
  }
}

function showError(message) {
  errorBox.textContent = message;
  errorBox.hidden = false;
}

// --------------------------------------------------------------- unlock

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
  // A newer file than this page understands means the browser is still holding
  // the previous version of the page from its cache.
  if (payload.v > 2) throw new Error("sidan har uppdaterats – ladda om sidan");
  if (payload.v !== 2) throw new Error("okänt filformat");
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
  return decodeGlossary(JSON.parse(await gunzip(plaintext)));
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
    const decoded = await unlock(password);
    if (!decoded) {
      showError("Fel lösenord.");
      passwordInput.select();
      return;
    }
    glossary = decoded;
    passwordInput.value = "";
    buildDictionaryBar();
    lockView.hidden = true;
    lookupView.hidden = false;
    const remembered = readStore(DICTIONARY_KEY, null);
    selectDictionary(glossary.some((d) => d.id === remembered) ? remembered : glossary[0].id);
    setMode(readStore(MODE_KEY, "search") === "practice" ? "practice" : "search");
  } catch (error) {
    showError(`Ordlistan kunde inte läsas in (${error.message}).`);
  } finally {
    unlockButton.disabled = false;
    unlockButton.textContent = "Öppna";
  }
});

// ---------------------------------------------------------- dictionaries

function buildDictionaryBar() {
  dictionaryBar.replaceChildren(
    ...glossary.map((d) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "dictionary";
      button.textContent = d.name;
      button.dataset.id = d.id;
      button.setAttribute("aria-pressed", "false");
      button.addEventListener("click", () => {
        selectDictionary(d.id);
        (panels.practice.hidden ? queryInput : flashcard).focus({ preventScroll: true });
      });
      return button;
    }),
  );
}

function lookupFor(d) {
  if (!lookups.has(d.id)) lookups.set(d.id, new TermLookup(lookupEntries(d)));
  return lookups.get(d.id);
}

function selectDictionary(id) {
  dictionary = glossary.find((d) => d.id === id);
  writeStore(DICTIONARY_KEY, id);
  for (const button of dictionaryBar.children) {
    button.setAttribute("aria-pressed", String(button.dataset.id === id));
  }
  status.textContent = `${formatNumber(termsInScope(dictionary).length)} termer i ${dictionary.name}.`;
  renderSearch();
  buildChapterSelect();
}

// -------------------------------------------------------------- search

function cell(text) {
  const td = document.createElement("td");
  td.textContent = text; // Never innerHTML: terms are data, not markup.
  return td;
}

function dot(statusName) {
  const element = document.createElement("span");
  element.className = `status-dot ${statusName}`;
  element.title = STATUS_NAME[statusName] ?? "";
  return element;
}

function messageRow(text) {
  const row = document.createElement("tr");
  const td = cell(text);
  td.className = "empty";
  td.colSpan = 2;
  row.append(td);
  return row;
}

function renderSearch() {
  if (!dictionary) return;
  const query = queryInput.value;
  results.replaceChildren();
  if (!query.trim()) {
    results.append(messageRow("Skriv för att söka."));
    return;
  }
  const hits = lookupFor(dictionary).search(query);
  if (hits.length === 0) {
    results.append(messageRow("Inga träffar."));
    return;
  }
  for (const entry of hits) {
    const row = document.createElement("tr");
    if (entry.tolerable) row.className = "tolerable";
    const term = cell("");
    const translation = cell("");
    const termText = Object.assign(document.createElement("span"), { textContent: entry.source_term });
    const translationText = Object.assign(document.createElement("span"), { textContent: entry.translation });
    term.title = entry.source_term;
    translation.title = entry.translation;
    term.lang = entry.language;
    // Translations run the other way, so hyphenate them in the other language.
    translation.lang = entry.language === "sv" ? "ru" : "sv";
    // The teacher's colour belongs to the Swedish term, wherever it appears.
    const swedish = entry.language === "sv" ? term : translation;
    for (const [td, text] of [[term, termText], [translation, translationText]]) {
      const wrapper = document.createElement("span");
      wrapper.className = "term-cell";
      if (td === swedish) wrapper.append(dot(entry.status));
      wrapper.append(text);
      td.append(wrapper);
    }
    row.append(term, translation);
    results.append(row);
  }
}

queryInput.addEventListener("input", renderSearch);

// ------------------------------------------------------------- chapters

function rememberedChapter(d) {
  const chosen = readStore(CHAPTERS_KEY, {})[d.id];
  return d.chapters.some((c) => c.id === chosen) ? chosen : "all";
}

function buildChapterSelect() {
  const option = (value, label) => Object.assign(document.createElement("option"), { value, textContent: label });
  // Counts are distinct terms, the same number the practice line shows: the
  // same term in two chapters is one term in "Alla kapitel".
  const count = (id) => formatNumber(termsInScope(dictionary, id).length);
  chapterSelect.replaceChildren(
    option("all", `Alla kapitel (${count("all")})`),
    ...dictionary.chapters.map((c) =>
      option(c.id, `${c.number != null ? `${c.number}. ` : ""}${c.title} (${count(c.id)})`),
    ),
  );
  chapterSelect.value = rememberedChapter(dictionary);
  rebuildDeck();
}

chapterSelect.addEventListener("change", () => {
  const chosen = readStore(CHAPTERS_KEY, {});
  chosen[dictionary.id] = chapterSelect.value;
  writeStore(CHAPTERS_KEY, chosen);
  rebuildDeck();
});

function rebuildDeck() {
  const terms = termsInScope(dictionary, chapterSelect.value);
  scopeTerms = terms.length;
  picker = new StratifiedPicker(buildDeck(terms));
  const odds = picker.odds;
  oddsLine.textContent =
    `${formatNumber(scopeTerms)} termer · ` +
    ["green", "yellow", "red"]
      .filter((s) => s in odds)
      // Non-breaking spaces keep "rött 10 %" from splitting across lines.
      .map((s) => `${STATUS_NAME[s]}\u00a0${Math.round(odds[s] * 100)}\u00a0%`)
      .join(" · ");
  currentCard = null;
  if (!panels.practice.hidden) dealNextCard();
}

// --------------------------------------------------------------- modes

function setMode(mode) {
  for (const [name, button] of Object.entries(modeButtons)) {
    button.setAttribute("aria-pressed", String(name === mode));
    panels[name].hidden = name !== mode;
  }
  writeStore(MODE_KEY, mode);
  if (mode === "practice") {
    if (!currentCard) dealNextCard();
    flashcard.focus({ preventScroll: true });
  } else {
    queryInput.focus();
  }
}

modeButtons.search.addEventListener("click", () => setMode("search"));
modeButtons.practice.addEventListener("click", () => setMode("practice"));

// ------------------------------------------------------------ practice

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

  frontStatus.className = `status-dot ${card.status}`;
  frontStatus.title = STATUS_NAME[card.status] ?? "";
  frontDirection.textContent = DIRECTION_LABEL[card.direction] ?? "";
  frontTerm.replaceChildren(...card.prompt.map((text) => span(text, "", card.promptLang)));
  frontTerm.lang = card.promptLang;
  frontTerm.classList.toggle("long", card.prompt.join(" ").length > 34);
  backTerm.textContent = card.prompt.join("; ");
  backTerm.lang = card.promptLang;
  backTranslations.replaceChildren(
    ...card.answers.map((text) => span(text, "", card.answerLang)),
    // Tolerable renderings stay visible, but as the teacher marked them.
    ...card.tolerable.map((text) => span(`(${text})`, "card-tolerable", card.answerLang)),
  );
  backTranslations.classList.toggle("long", card.answers.join(" ").length > 60);

  void flashcard.offsetWidth; // Commit the instant turn before re-enabling animation.
  flashcard.classList.remove("instant");

  progress.textContent = `Kort ${formatNumber(picker.shown)}`;
  announcer.textContent = `${DIRECTION_LABEL[card.direction] ?? ""}: ${card.prompt.join(", ")}`;
}

function dealNextCard() {
  if (picker) showCard(picker.next());
}

function flipCard() {
  if (!currentCard) return;
  const flipped = !isFlipped();
  setFlipped(flipped);
  announcer.textContent = flipped ? currentCard.answers.join(", ") : currentCard.prompt.join(", ");
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
  if (target instanceof HTMLSelectElement) return; // arrows change the chapter there

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

// Locking discards the decrypted glossary along with everything else.
$("lock-again").addEventListener("click", () => window.location.reload());
