// Integration test for songbook_html.js — the standalone page's embedded
// data, embedded chordprobook bundle, and embedded, click-driven app (song
// list -> song view, menu bar, next/previous). See SPEC.md's "Songbook
// HTML output" and "UI" sections.
import assert from "node:assert/strict";
import { ChordProSong, renderSong, Transposer, ChordDiagram } from "chordprobook";
import { HOOKS } from "../hooks.js";
import { songbookHtmlPlugin, renderSongbookHtml, initSongbookApp } from "./songbook_html.js";
import {
  CHORDPROBOOK_BROWSER_BUNDLE,
  CHORDPROBOOK_INSTRUMENTS_DATA,
  CHORDPROBOOK_CHORD_DATA,
} from "./generated/chordprobook_browser_bundle.js";

// initSongbookApp references ChordProSong/renderSong/Transposer/ChordDiagram
// and CHORDPROBOOK_INSTRUMENTS_DATA/CHORDPROBOOK_CHORD_DATA as bare globals
// — in the real page, the generated bundle module defines all of these
// before this function's own embedded script runs (see songbook_html.js's
// own header comment and renderSongbookHtml's script assembly).
// Replicating that same globals-based linking here, rather than importing
// them into this function directly, is what makes calling it here a
// faithful test of what the real page actually does — not a convenient
// shortcut around it.
globalThis.ChordProSong = ChordProSong;
globalThis.renderSong = renderSong;
globalThis.Transposer = Transposer;
globalThis.ChordDiagram = ChordDiagram;
globalThis.CHORDPROBOOK_INSTRUMENTS_DATA = CHORDPROBOOK_INSTRUMENTS_DATA;
globalThis.CHORDPROBOOK_CHORD_DATA = CHORDPROBOOK_CHORD_DATA;

/* ---------- fixture: a small, realistic crate graph, with real ChordPro text ---------- */

const CRATE_JSON = {
  "@graph": [
    { "@id": "./", "@type": "Dataset", name: "Songbook" },
    {
      "@id": "AmazingGrace.cho.txt", "@type": "MusicComposition", name: "Amazing Grace",
      text: "{title: Amazing Grace}\n{key: G}\n\nA-[G]maz-ing [G7]Grace",
    },
    {
      "@id": "uni-verse.cho.txt", "@type": "MusicComposition", name: "Universe",
      text: "{title: Universe}\n{key: C}\n\n[C]This is a song",
    },
    {
      "@id": "sample.setlist.md#entry-1", "@type": "MusicComposition", name: "Amazing",
      specializationOf: { "@id": "AmazingGrace.cho.txt" }, "custom:matchStatus": "fuzzy",
      // No "text" — a setlist-entry proxy, not a canonical song (SPEC.md
      // §7) — must not appear in the rendered song list.
    },
  ],
};

// A minor key ("Dm") and no {key} directive at all, respectively — the two
// cases populateKeySelect/populateCapoSelect branch on, alongside the plain
// major-key case CRATE_JSON's own songs already cover.
const MINOR_KEY_SONG = {
  "@id": "minor-key.cho.txt", "@type": "MusicComposition", name: "Minor Key Song",
  text: "{title: Minor Key Song}\n{key: Dm}\n\n[Dm]Sombre [C]verse",
};
const NO_KEY_SONG = {
  "@id": "no-key.cho.txt", "@type": "MusicComposition", name: "No Key Song",
  text: "{title: No Key Song}\n\n[G]Chords [D]but no key directive",
};
// A flat-spelled key — PT reported the capo dropdown showing "1" as the
// same key as the root for a real song like this one (see
// Transposer.transposeKey's own fix, chordprobook/src/chords/Transposer.js).
const FLAT_KEY_SONG = {
  "@id": "flat-key.cho.txt", "@type": "MusicComposition", name: "Flat Key Song",
  text: "{title: Flat Key Song}\n{key: Eb}\n\n[Eb]Verse [Bb]line",
};

// A setlist with one entry of each SPEC.md §6.1 match status (exact,
// fuzzy — with its own capo override, ambiguous, unresolved), across two
// sets, one entry carrying performance notes. Built directly as the crate
// entities chordpro_crate.js would have produced, not run through the
// actual matching algorithm — this file is testing what initSongbookApp
// does with that output, not the matching itself (chordprobook's own
// test-chordpro-setlist.mjs covers that).
const SETLIST_CRATE_JSON = {
  "@graph": [
    { "@id": "./", "@type": "Dataset", name: "Songbook" },
    { "@id": "song-a.cho.txt", "@type": "MusicComposition", name: "Song A", text: "{title: Song A}\n{key: G}\n\n[G]Verse" },
    { "@id": "song-b.cho.txt", "@type": "MusicComposition", name: "Song B", text: "{title: Song B}\n{key: C}\n\n[C]Verse" },
    {
      "@id": "gig.setlist.md", "@type": "MusicPlaylist", name: "Friday Gig",
      hasPart: [
        { "@id": "gig.setlist.md#entry-1" },
        { "@id": "gig.setlist.md#entry-2" },
        { "@id": "gig.setlist.md#entry-3" },
        { "@id": "gig.setlist.md#entry-4" },
      ],
    },
    {
      "@id": "gig.setlist.md#entry-1", "@type": "MusicComposition", name: "Song A",
      "custom:setName": "Set 1", "custom:matchStatus": "exact",
      specializationOf: { "@id": "song-a.cho.txt" },
    },
    {
      "@id": "gig.setlist.md#entry-2", "@type": "MusicComposition", name: "Song B (capo 2)",
      "custom:setName": "Set 1", "custom:matchStatus": "fuzzy", "custom:capo": 2,
      description: "Play slow and quiet",
      specializationOf: { "@id": "song-b.cho.txt" },
    },
    {
      "@id": "gig.setlist.md#entry-3", "@type": "MusicComposition", name: "Songg A",
      "custom:setName": "Set 2", "custom:matchStatus": "ambiguous",
      specializationOf: { "@id": "song-a.cho.txt" },
      "custom:matchCandidates": [{ "@id": "song-a.cho.txt" }],
    },
    {
      "@id": "gig.setlist.md#entry-4", "@type": "MusicComposition", name: "Unknown Song",
      "custom:setName": "Set 2", "custom:matchStatus": "unresolved",
    },
  ],
};

/* ---------- a minimal, interactive fake DOM ---------- */
// Supports exactly what initSongbookApp calls: getElementById/createElement,
// on an element: classList (add/remove/contains/toggle), textContent,
// innerHTML, disabled, appendChild, addEventListener, plus a test-only
// click() that invokes whatever handler was registered, so a test can
// simulate a real user click rather than only inspecting structure.
//
// classList here is a plain Set with the right method names — real enough
// to check *which class initSongbookApp asked for*, but it has no CSS
// cascade behind it, so it cannot catch what a stylesheet actually resolves
// a class to. That gap is exactly how a real bug got through this test
// suite once already: an earlier version toggled element.style.display
// directly, this file asserted the value it was set to, and every assertion
// passed while the real page rendered blank, because style.display = ""
// doesn't mean "visible" — it means "deferred to the stylesheet", which
// still said `display: none`. Switching both the implementation and these
// assertions to classList.contains("hidden") is the fix, but confirming the
// class actually *looks* hidden/visible in a real browser is still outside
// what this test — or anything else in this repo's test suite — can check.
//
// children here is a plain array, which is a second, similarly real gap:
// a real element's own .children is a live HTMLCollection, which has
// .length and index access and is iterable, but no .forEach/.map/.find —
// unlike a plain array, or NodeList (querySelectorAll's own return type,
// which does have .forEach). initSongbookApp's own song-search filter once
// called .children.forEach() directly and passed every assertion here,
// while doing nothing at all in a real browser — TypeError, silently
// swallowed by the event listener, the moment anyone typed into the search
// box. Fixed by wrapping it in Array.from() at the one call site
// (songbook_html.js), not by making this fake stricter to match — tempting
// as a way to catch the *next* one of these automatically, but it would
// also break every existing .children.find()/.map() already written
// against this file's own test code below, for a payoff this file can't
// fully deliver anyway (still no real HTMLCollection, just a pickier fake
// one). Documented here instead, the same way the classList gap above is.
function makeElement() {
  const listeners = {};
  const classes = new Set();
  return {
    textContent: "",
    innerHTML: "",
    disabled: false,
    children: [],
    style: {},
    // Layout measurements fitSongContent reads: 0 by default, matching a
    // real, unrendered element — tests exercising that function override
    // these (as plain properties, or as getters via Object.defineProperty
    // when a value needs to react to style.fontSize being set).
    offsetHeight: 0,
    clientWidth: 0,
    scrollHeight: 0,
    scrollWidth: 0,
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name),
      toggle: (name, force) => {
        const shouldHave = force === undefined ? !classes.has(name) : force;
        if (shouldHave) classes.add(name); else classes.delete(name);
        return shouldHave;
      },
    },
    appendChild(child) { this.children.push(child); },
    // Element.replaceChildren() — real, native DOM, not a fake-only
    // convenience — clears and replaces in one call, so populateKeySelect/
    // populateCapoSelect don't need innerHTML="" (which, on this object,
    // would desync from `children`: they're tracked separately here, unlike
    // in a real DOM where innerHTML and the children collection are the
    // same underlying tree) plus a manual removeChild loop.
    replaceChildren(...newChildren) { this.children = newChildren; },
    addEventListener(type, handler) { listeners[type] = handler; },
    // click() is the pre-existing sugar for dispatch("click", ...); selects
    // in the tests below use dispatch("change") directly — a plain object,
    // since nothing here reads the event argument itself.
    dispatch(type, event = {}) { (listeners[type] || (() => {}))(event); },
    click() { this.dispatch("click", { preventDefault() {} }); },
  };
}

// A real sessionStorage implementation is a plain string-keyed store behind
// getItem/setItem — this is exactly that, backed by a Map instead of a
// browser's own persistent-per-tab storage, which is the only thing that
// actually differs (this one doesn't survive past the test itself, which is
// the right amount of fidelity for testing what initSongbookApp does with
// the API, not how long a real tab keeps it around).
function fakeSessionStorage() {
  const store = new Map();
  return {
    getItem(key) { return store.has(key) ? store.get(key) : null; },
    setItem(key, value) { store.set(key, String(value)); },
  };
}

// A fake `window`: initSongbookApp reads innerHeight (fitSongContent) and
// sessionStorage (loadSavedSelections/saveCurrentSelection), and registers
// resize/orientationchange listeners (scheduleFit) on it. dispatch() is
// test-only, standing in for a real resize/rotation event.
function fakeWindow(overrides = {}) {
  const listeners = {};
  return {
    innerHeight: 800,
    innerWidth: 600,
    sessionStorage: fakeSessionStorage(),
    printCallCount: 0,
    print() { this.printCallCount += 1; },
    addEventListener(type, handler) { listeners[type] = handler; },
    dispatch(type) { (listeners[type] || (() => {}))(); },
    ...overrides,
  };
}

function fakeDocument(crateJson, { rejectFullscreen = false } = {}) {
  const elements = {
    "crate-data": { textContent: JSON.stringify(crateJson) },
    "list-view": makeElement(),
    "song-view": makeElement(),
    "menu-bar": makeElement(),
    "song-view-title": makeElement(),
    "song-content": makeElement(),
    "song-list": makeElement(),
    "prev-song-button": makeElement(),
    "next-song-button": makeElement(),
    "back-to-list-button": makeElement(),
    "key-select": makeElement(),
    "capo-select": makeElement(),
    "instrument-select": makeElement(),
    "chord-diagrams": makeElement(),
    "print-song-button": makeElement(),
    "print-book-button": makeElement(),
    "print-view": makeElement(),
    "print-content": makeElement(),
    "print-now-button": makeElement(),
    "done-printing-button": makeElement(),
    "print-instrument-select": makeElement(),
    "fullscreen-button": makeElement(),
    "view-setlists-button": makeElement(),
    "setlist-index-view": makeElement(),
    "back-from-setlist-index-button": makeElement(),
    "setlist-list": makeElement(),
    "song-search": makeElement(),
    "setlist-view": makeElement(),
    "setlist-view-title": makeElement(),
    "back-from-setlist-button": makeElement(),
    "print-setlist-button": makeElement(),
    "toggle-notes-button": makeElement(),
    "setlist-entries": makeElement(),
  };
  // document.addEventListener itself, not just individual elements' — the
  // Escape-key handler is registered on the document, matching where a
  // real keydown actually fires from regardless of which element (if any)
  // has focus.
  const docListeners = {};
  // fullscreenElement is a genuinely live property in a real document —
  // it changes as a *result* of request/exitFullscreen resolving, which is
  // why these are getters rather than plain fields snapshotted once.
  let fullscreenElement = null;
  const documentElement = {
    requestFullscreen() {
      if (rejectFullscreen) return Promise.reject(new Error("denied"));
      fullscreenElement = documentElement;
      (docListeners.fullscreenchange || (() => {}))();
      return Promise.resolve();
    },
  };
  const doc = {
    getElementById: (id) => elements[id],
    createElement: () => makeElement(),
    addEventListener(type, handler) { docListeners[type] = handler; },
    dispatchKeydown(key) { (docListeners.keydown || (() => {}))({ key }); },
    get documentElement() { return documentElement; },
    get fullscreenElement() { return fullscreenElement; },
    exitFullscreen() {
      fullscreenElement = null;
      (docListeners.fullscreenchange || (() => {}))();
      return Promise.resolve();
    },
  };
  return { doc, elements };
}

// The nth <li>'s <a> link, in list order — what a test "clicks" to open a song.
function songLink(elements, index) {
  return elements["song-list"].children[index].children[0];
}

// The nth <li>'s <a> link in the setlists section, in list order.
function setlistLink(elements, index) {
  return elements["setlist-list"].children[index].children[0];
}

function isHidden(element) {
  return element.classList.contains("hidden");
}

/* ---------- initSongbookApp: initial state is the list, canonical songs only ---------- */

{
  const { doc, elements } = fakeDocument(CRATE_JSON);
  initSongbookApp(doc, fakeWindow());

  assert.equal(isHidden(elements["list-view"]), false);
  assert.equal(isHidden(elements["song-view"]), true);
  assert.equal(isHidden(elements["menu-bar"]), true);
  assert.equal(isHidden(elements["prev-song-button"]), true);
  assert.equal(isHidden(elements["next-song-button"]), true);

  // Two canonical songs, alphabetically sorted — the setlist-entry proxy
  // ("Amazing", no "text") is absent.
  assert.equal(elements["song-list"].children.length, 2);
  assert.equal(songLink(elements, 0).textContent, "Amazing Grace");
  assert.equal(songLink(elements, 1).textContent, "Universe");
}

{
  // "Find a song" (#song-search) — filters #song-list's own rows by
  // substring match, case-insensitively, ported from chordprosite's own
  // #searchBox. The list stays index-parallel with `songs` throughout, so
  // this checks each row's own hidden state directly rather than the
  // filtered *count* (nothing is removed, only hidden).
  const { doc, elements } = fakeDocument(CRATE_JSON);
  initSongbookApp(doc, fakeWindow());

  elements["song-search"].value = "univ";
  elements["song-search"].dispatch("input");
  assert.equal(isHidden(elements["song-list"].children[0]), true); // Amazing Grace
  assert.equal(isHidden(elements["song-list"].children[1]), false); // Universe

  elements["song-search"].value = "AMAZING"; // case-insensitive
  elements["song-search"].dispatch("input");
  assert.equal(isHidden(elements["song-list"].children[0]), false);
  assert.equal(isHidden(elements["song-list"].children[1]), true);

  elements["song-search"].value = "";
  elements["song-search"].dispatch("input");
  assert.equal(isHidden(elements["song-list"].children[0]), false);
  assert.equal(isHidden(elements["song-list"].children[1]), false);
}

/* ---------- clicking a song: song view, rendered via chordprobook's real renderSong ---------- */

{
  const { doc, elements } = fakeDocument(CRATE_JSON);
  initSongbookApp(doc, fakeWindow());

  songLink(elements, 0).click(); // "Amazing Grace"

  assert.equal(isHidden(elements["list-view"]), true);
  assert.equal(isHidden(elements["song-view"]), false);
  assert.equal(isHidden(elements["menu-bar"]), false);
  assert.equal(isHidden(elements["prev-song-button"]), false);
  assert.equal(isHidden(elements["next-song-button"]), false);
  assert.equal(elements["song-view-title"].textContent, "Amazing Grace");

  // Rendered by chordprobook's real renderSong(), not a stub — chord
  // brackets become inlineChord spans, matching that library's own tests.
  assert.ok(elements["song-content"].innerHTML.includes('<span class="inlineChord">[G]</span>'));
  assert.ok(elements["song-content"].innerHTML.includes('<span class="inlineChord">[G7]</span>'));

  // First song: previous is disabled, next is not.
  assert.equal(elements["prev-song-button"].disabled, true);
  assert.equal(elements["next-song-button"].disabled, false);
}

/* ---------- key/capo dropdowns: populated per song, drive a re-render ---------- */

{
  // Amazing Grace: key G, has chords — the ordinary case, no {capo}/
  // {transpose} directives of its own.
  const { doc, elements } = fakeDocument(CRATE_JSON);
  initSongbookApp(doc, fakeWindow());
  songLink(elements, 0).click();

  const keySelect = elements["key-select"];
  const capoSelect = elements["capo-select"];

  assert.equal(isHidden(keySelect), false);
  assert.equal(isHidden(capoSelect), false);
  // A major key: plain note names, no "m" suffix — one option per
  // Transposer.notes entry, the same table chordprosite's own dropdown uses.
  assert.deepEqual(keySelect.children.map((o) => o.value), Transposer.notes);
  assert.equal(keySelect.children.find((o) => o.value === "G").selected, true);

  assert.equal(capoSelect.children.length, 13); // "No Capo" + frets 1-12
  assert.equal(capoSelect.children[0].textContent, "0 - No Capo");
  assert.equal(capoSelect.children[0].selected, true); // no {capo} directive in this song
  assert.equal(capoSelect.children[2].textContent, `2 - (${Transposer.transposeKey("G", -2)} shapes)`);
}

{
  // Capo alone shifts the displayed chords down by that many semitones —
  // the shapes you'd actually play, the reverse of what a capo does to
  // sounding pitch — without touching the key dropdown at all.
  const { doc, elements } = fakeDocument(CRATE_JSON);
  initSongbookApp(doc, fakeWindow());
  songLink(elements, 0).click(); // Amazing Grace, key G

  elements["capo-select"].value = "2";
  elements["capo-select"].dispatch("change");

  // G down 2 semitones is F.
  assert.ok(elements["song-content"].innerHTML.includes('<span class="inlineChord">[F]</span>'));
  assert.ok(elements["song-content"].innerHTML.includes('<span class="inlineChord">[F7]</span>'));
  assert.equal(elements["capo-select"].children[2].selected, true);
}

{
  // Choosing a new key transposes the rendered chords, and resets capo back
  // to none — chordprosite's own key-change handler does the same
  // (`display(this.value, 0)`), rather than keeping a capo picked against
  // the song's old key.
  const { doc, elements } = fakeDocument(CRATE_JSON);
  initSongbookApp(doc, fakeWindow());
  songLink(elements, 0).click(); // Amazing Grace, key G

  elements["capo-select"].value = "2";
  elements["capo-select"].dispatch("change");
  assert.ok(elements["song-content"].innerHTML.includes('<span class="inlineChord">[F]</span>'));

  elements["key-select"].value = "D";
  elements["key-select"].dispatch("change");

  assert.ok(elements["song-content"].innerHTML.includes('<span class="inlineChord">[D]</span>'));
  assert.ok(elements["song-content"].innerHTML.includes('<span class="inlineChord">[D7]</span>'));
  assert.equal(elements["capo-select"].children[0].selected, true); // back to "No Capo"
}

{
  // No {key} directive, but real chords — chordprosite's own
  // "originalKey === null" branch: a plain semitone-offset dropdown, since
  // there's no note name to build key options around.
  const { doc, elements } = fakeDocument({ "@graph": [NO_KEY_SONG] });
  initSongbookApp(doc, fakeWindow());
  songLink(elements, 0).click();

  const keySelect = elements["key-select"];
  assert.equal(isHidden(keySelect), false);
  assert.deepEqual(keySelect.children.map((o) => o.textContent), Transposer.notes.map((_, i) => `+${i}`));
  assert.equal(keySelect.children[0].selected, true); // "+0" — no transpose chosen yet

  // No key to derive a shapes label from. chordprosite's own formula
  // (Transposer.transposeKey(song.key, -i)) would print "2 - (null
  // shapes)" here (transposeKey(null, ...) returns null) — a gap in the
  // original worth not reproducing, not a behaviour to port faithfully.
  assert.equal(elements["capo-select"].children[2].textContent, "Capo 2");
}

{
  // A minor key stays minor across all twelve choices — chordprosite's own
  // dropdown never offers switching major/minor, only which note.
  const { doc, elements } = fakeDocument({ "@graph": [MINOR_KEY_SONG] });
  initSongbookApp(doc, fakeWindow());
  songLink(elements, 0).click();

  const keySelect = elements["key-select"];
  assert.deepEqual(keySelect.children.map((o) => o.value), Transposer.notes.map((n) => `${n}m`));
  assert.equal(keySelect.children.find((o) => o.value === "Dm").selected, true);
}

{
  // Regression: a flat-spelled root key ("Eb") — PT reported the capo
  // dropdown's "1" option reading the same key as the root, for a real song
  // in a flat key. That traced back to Transposer.transposeKey's own regex
  // dropping a #/b accidental before looking the note up (fixed in
  // chordprobook/src/chords/Transposer.js, with its own dedicated test) —
  // not a bug in this dropdown's own code, but this asserts the fix from
  // the same place the symptom was actually reported: the capo menu itself.
  const { doc, elements } = fakeDocument({ "@graph": [FLAT_KEY_SONG] });
  initSongbookApp(doc, fakeWindow());
  songLink(elements, 0).click();

  const capoSelect = elements["capo-select"];
  assert.equal(capoSelect.children[1].textContent, "1 - (D shapes)"); // not "1 - (Eb shapes)"
  assert.equal(capoSelect.children[2].textContent, "2 - (C# shapes)");
}

{
  // No chords at all — neither dropdown has anything to offer, so both stay
  // hidden, the same gate chordprosite applies via song.hasChords.
  const { doc, elements } = fakeDocument({
    "@graph": [{
      "@id": "lyrics.cho.txt", "@type": "MusicComposition", name: "Lyrics Only",
      text: "{title: Lyrics Only}\n\nJust words, no chords at all.",
    }],
  });
  initSongbookApp(doc, fakeWindow());
  songLink(elements, 0).click();

  assert.equal(isHidden(elements["key-select"]), true);
  assert.equal(isHidden(elements["capo-select"]), true);
  assert.equal(isHidden(elements["instrument-select"]), true);
  assert.equal(elements["key-select"].children.length, 0);
  assert.equal(elements["capo-select"].children.length, 0);
}

/* ---------- instrument select and chord grids ---------- */

{
  // Populated once, from CHORDPROBOOK_INSTRUMENTS_DATA — "No chord grids"
  // first and selected by default, then one option per instrument, in the
  // same order instruments.yaml lists them.
  const { doc, elements } = fakeDocument(CRATE_JSON);
  initSongbookApp(doc, fakeWindow());

  const instrumentSelect = elements["instrument-select"];
  assert.equal(instrumentSelect.children[0].textContent, "No chord grids");
  assert.equal(instrumentSelect.children[0].selected, true);
  assert.deepEqual(
    instrumentSelect.children.slice(1).map((o) => o.value),
    CHORDPROBOOK_INSTRUMENTS_DATA.map((i) => i.name),
  );
}

{
  // Selecting an instrument shows one chord grid per distinct chord the
  // song actually uses (renderSong's own chordsUsed, not recomputed here) —
  // Amazing Grace uses G and G7, both present in guitar_chords.cho.
  const { doc, elements } = fakeDocument(CRATE_JSON);
  initSongbookApp(doc, fakeWindow());
  songLink(elements, 0).click(); // Amazing Grace: [G], [G7]

  assert.equal(isHidden(elements["chord-diagrams"]), true); // nothing selected yet

  elements["instrument-select"].value = "Guitar";
  elements["instrument-select"].dispatch("change");

  assert.equal(isHidden(elements["chord-diagrams"]), false);
  assert.equal(elements["chord-diagrams"].children.length, 2); // G, G7

  elements["instrument-select"].value = "";
  elements["instrument-select"].dispatch("change");
  assert.equal(isHidden(elements["chord-diagrams"]), true);
  assert.equal(elements["chord-diagrams"].children.length, 0);
}

{
  // A chord with no shape data for the chosen instrument is skipped, not
  // shown as a blank/mislabelled diagram — see renderChordDiagrams' own
  // comment on why a fresh ChordDiagram instance per chord makes that the
  // natural outcome rather than something to special-case.
  const { doc, elements } = fakeDocument({
    "@graph": [{
      "@id": "exotic.cho.txt", "@type": "MusicComposition", name: "Exotic Chord",
      // "Bb13#11" survives chordsUsed as a real (if unusual) chord name, but
      // isn't in guitar_chords.cho — confirmed directly against that file.
      text: "{title: Exotic Chord}\n{key: G}\n\n[G]Hello [Bbmaj13#11]world [G7]end",
    }],
  });
  initSongbookApp(doc, fakeWindow());
  songLink(elements, 0).click();

  elements["instrument-select"].value = "Guitar";
  elements["instrument-select"].dispatch("change");

  assert.equal(elements["chord-diagrams"].children.length, 2); // G, G7 — not 3
}

{
  // The instrument choice is global for the session, not per-song like
  // key/capo — it stays selected, and the chord panel stays populated,
  // across a next/previous move to a different song.
  const { doc, elements } = fakeDocument(CRATE_JSON);
  initSongbookApp(doc, fakeWindow());
  songLink(elements, 0).click(); // Amazing Grace

  elements["instrument-select"].value = "Guitar";
  elements["instrument-select"].dispatch("change");
  assert.equal(isHidden(elements["chord-diagrams"]), false);

  elements["next-song-button"].click(); // Universe: [C]
  assert.equal(elements["instrument-select"].value, "Guitar");
  assert.equal(isHidden(elements["chord-diagrams"]), false);
  assert.equal(elements["chord-diagrams"].children.length, 1); // C
}

{
  // Moving to a *different* song — next/previous, not just closing and
  // reopening the same one — starts that other song at its own key,
  // untouched, per-song persistence (below) keys by song id specifically so
  // Universe's own state is independent of whatever was chosen for Amazing
  // Grace.
  const { doc, elements } = fakeDocument(CRATE_JSON);
  initSongbookApp(doc, fakeWindow());
  songLink(elements, 0).click(); // Amazing Grace, key G

  elements["key-select"].value = "D";
  elements["key-select"].dispatch("change");
  assert.ok(elements["song-content"].innerHTML.includes('<span class="inlineChord">[D]</span>'));

  elements["next-song-button"].click(); // -> Universe, key C, untouched
  assert.ok(elements["song-content"].innerHTML.includes('<span class="inlineChord">[C]</span>'));
  assert.equal(elements["key-select"].children.find((o) => o.value === "C").selected, true);
}

/* ---------- remembering a key/capo choice for the session (sessionStorage) ---------- */

{
  // Coming back to the *same* song — via next/previous, not just leaving
  // the choice in place by never navigating away — restores what was
  // chosen, rather than resetting to the song's own key/capo. This is the
  // actual feature: showSong() used to unconditionally reset both to null;
  // now it looks up whatever saveCurrentSelection() last wrote for this
  // song's id.
  const { doc, elements } = fakeDocument(CRATE_JSON);
  const win = fakeWindow();
  initSongbookApp(doc, win);
  songLink(elements, 0).click(); // Amazing Grace, key G

  elements["key-select"].value = "D";
  elements["key-select"].dispatch("change");
  elements["capo-select"].value = "2";
  elements["capo-select"].dispatch("change");
  assert.ok(elements["song-content"].innerHTML.includes('<span class="inlineChord">[C]</span>')); // D - 2 = C

  elements["next-song-button"].click(); // -> Universe
  elements["prev-song-button"].click(); // back to Amazing Grace

  assert.ok(elements["song-content"].innerHTML.includes('<span class="inlineChord">[C]</span>')); // still D capo 2
  assert.equal(elements["key-select"].children.find((o) => o.value === "D").selected, true);
  assert.equal(elements["capo-select"].children.find((o) => o.value === "2").selected, true);

  // Genuinely persisted, not just retained on the same songs[] entry in
  // memory: a fresh initSongbookApp call against the same window (same
  // sessionStorage) picks the choice straight back up on first open, with
  // no dropdown interaction in this second instance at all — the same
  // scenario as reloading the page within one browser session.
  const { doc: doc2, elements: elements2 } = fakeDocument(CRATE_JSON);
  initSongbookApp(doc2, win);
  songLink(elements2, 0).click(); // Amazing Grace, opened fresh
  assert.ok(elements2["song-content"].innerHTML.includes('<span class="inlineChord">[C]</span>'));
}

{
  // sessionStorage access throwing (privacy mode, some file:// origins —
  // SPEC.md's own note on why this is wrapped in try/catch) degrades to
  // "no persistence", not a crash: the song still opens and renders.
  const { doc, elements } = fakeDocument(CRATE_JSON);
  const win = fakeWindow({
    sessionStorage: {
      getItem() { throw new Error("blocked"); },
      setItem() { throw new Error("blocked"); },
    },
  });
  initSongbookApp(doc, win);

  assert.doesNotThrow(() => songLink(elements, 0).click());
  assert.doesNotThrow(() => {
    elements["key-select"].value = "D";
    elements["key-select"].dispatch("change");
  });
  assert.ok(elements["song-content"].innerHTML.includes('<span class="inlineChord">[D]</span>'));
}

/* ---------- print mode: replaces the current screen, not a new window ---------- */

function isFittedFontSize(value) {
  return /^\d+px$/.test(value);
}

{
  // Printing the current song, from song view.
  const { doc, elements } = fakeDocument(CRATE_JSON);
  initSongbookApp(doc, fakeWindow());
  songLink(elements, 0).click(); // Amazing Grace

  elements["print-song-button"].click();

  assert.equal(isHidden(elements["list-view"]), true);
  assert.equal(isHidden(elements["song-view"]), true);
  assert.equal(isHidden(elements["menu-bar"]), true);
  assert.equal(isHidden(elements["print-view"]), false);
  assert.equal(elements["print-content"].children.length, 1); // one page, this song only

  const [page] = elements["print-content"].children;
  assert.equal(page.printSongTitleElement.textContent, "Amazing Grace");
  assert.ok(page.printSongBody.innerHTML.includes('<span class="inlineChord">[G]</span>'));
  // Fit onto its own A4 page the same way the on-screen view fits the
  // viewport — not clipped, not left to overflow onto a second page. The
  // exact resulting size is fitTextToBox's own concern, already covered by
  // the dedicated fitSongContent tests above; this just confirms it ran.
  assert.ok(isFittedFontSize(page.printSongBody.style.fontSize));

  // "Done printing" returns to the song that was open, not the list —
  // exitPrintView() reuses showSong(currentIndex), and currentIndex was
  // never touched by any of this.
  elements["done-printing-button"].click();
  assert.equal(isHidden(elements["song-view"]), false);
  assert.equal(isHidden(elements["print-view"]), true);
  assert.equal(elements["song-view-title"].textContent, "Amazing Grace");
}

{
  // Printing the whole songbook, from the list — one combined title +
  // contents page (PT: "put the songbook title and TOC on the same
  // page" — they stay combined up to TOC_SPLIT_THRESHOLD entries), then
  // one page per song, each in its own key/capo rather than whatever's
  // currently selected on screen.
  const { doc, elements } = fakeDocument(CRATE_JSON);
  initSongbookApp(doc, fakeWindow());

  elements["print-book-button"].click();

  assert.equal(isHidden(elements["list-view"]), true);
  assert.equal(isHidden(elements["print-view"]), false);
  // front-matter page + 2 songs (Amazing Grace, Universe) = 3.
  assert.equal(elements["print-content"].children.length, 3);

  const [frontPage, songOne, songTwo] = elements["print-content"].children;
  assert.ok(frontPage.className.includes("print-title-page"));
  assert.ok(frontPage.className.includes("print-toc"));
  // frontPage.children: [h1, "Contents" h2, <ol>, page-number] — no
  // "with chords for" subtitle here, since no instrument is selected.
  assert.equal(frontPage.children[1].textContent, "Contents");

  // Built via createElement, not an HTML string — see buildFrontMatterPages'
  // own comment for why — so this checks real child elements, not markup.
  // Page numbers are trustworthy specifically because every song is fitted
  // onto exactly one page (below) — one combined front-matter page (1)
  // means the first song starts at page 2.
  const tocEntries = frontPage.children[2].children;
  assert.equal(tocEntries.length, 2);
  assert.equal(tocEntries[0].children[0].textContent, "Amazing Grace");
  assert.equal(tocEntries[0].children[1].textContent, "2");
  assert.equal(tocEntries[1].children[0].textContent, "Universe");
  assert.equal(tocEntries[1].children[1].textContent, "3");
  // The front-matter page itself is numbered too.
  assert.equal(frontPage.children[3].textContent, "1");

  assert.equal(songOne.printSongTitleElement.textContent, "Amazing Grace");
  assert.equal(songTwo.printSongTitleElement.textContent, "Universe");
  assert.ok(isFittedFontSize(songOne.printSongBody.style.fontSize));
  assert.ok(isFittedFontSize(songTwo.printSongBody.style.fontSize));
  // Each song page carries its own page number too (position:absolute
  // .print-page-number — PT's own "put page numbers on the pages as well").
  const songOnePageNumber = songOne.children.find((child) => child.className === "print-page-number");
  const songTwoPageNumber = songTwo.children.find((child) => child.className === "print-page-number");
  assert.equal(songOnePageNumber.textContent, "2");
  assert.equal(songTwoPageNumber.textContent, "3");

  // "Done printing" returns to the list, this time — currentIndex is still
  // -1, since the book was printed from list view, not a song.
  elements["done-printing-button"].click();
  assert.equal(isHidden(elements["list-view"]), false);
  assert.equal(isHidden(elements["print-view"]), true);
}

{
  // "If the number of pages goes over about 50 then use multiple pages for
  // the toc" (PT) — 60 songs split the contents across 2 pages
  // (TOC_ENTRIES_PER_PAGE = 50: 50 entries on the first, 10 on the second),
  // and songs start after *both* of those, not just one.
  const manySongs = Array.from({ length: 60 }, (_, i) => ({
    "@id": `song-${String(i).padStart(2, "0")}.cho.txt`, "@type": "MusicComposition",
    name: `Song ${String(i).padStart(2, "0")}`, text: `{title: Song ${i}}\n\nJust words, no chords.`,
  }));
  const { doc, elements } = fakeDocument({ "@graph": manySongs });
  initSongbookApp(doc, fakeWindow());

  elements["print-book-button"].click();

  // 2 contents pages + 60 songs = 62.
  assert.equal(elements["print-content"].children.length, 62);
  const [tocPage1, tocPage2, firstSong] = elements["print-content"].children;

  assert.ok(tocPage1.className.includes("print-toc"));
  assert.equal(tocPage1.children[1].textContent, "Contents (1/2)");
  const tocPage1Entries = tocPage1.children[2].children;
  assert.equal(tocPage1Entries.length, 50);
  assert.equal(tocPage1Entries[0].children[1].textContent, "3"); // 1 (toc1) + 1 (toc2) + 1
  const tocPage1PageNumber = tocPage1.children.find((c) => c.className === "print-page-number");
  assert.equal(tocPage1PageNumber.textContent, "1");

  // No title/subtitle repeated on the second contents page.
  assert.equal(tocPage2.children[0].textContent, "Contents (2/2)");
  const tocPage2Entries = tocPage2.children[1].children;
  assert.equal(tocPage2Entries.length, 10);
  const tocPage2PageNumber = tocPage2.children.find((c) => c.className === "print-page-number");
  assert.equal(tocPage2PageNumber.textContent, "2");

  // The 61st page overall — 2 contents pages + the first song.
  const firstSongPageNumber = firstSong.children.find((c) => c.className === "print-page-number");
  assert.equal(firstSongPageNumber.textContent, "3");
}

{
  // Escape exits print mode specifically — checked here by confirming it
  // does nothing while print view *isn't* showing (an Escape press with
  // nothing to close), then confirming it does exit once print view is up.
  const { doc, elements } = fakeDocument(CRATE_JSON);
  initSongbookApp(doc, fakeWindow());

  assert.doesNotThrow(() => doc.dispatchKeydown("Escape"));
  assert.equal(isHidden(elements["list-view"]), false); // unaffected

  elements["print-book-button"].click();
  assert.equal(isHidden(elements["print-view"]), false);

  doc.dispatchKeydown("Escape");
  assert.equal(isHidden(elements["print-view"]), true);
  assert.equal(isHidden(elements["list-view"]), false);
}

{
  // "Print now" calls window.print() — printing in the same window rather
  // than opening a new one is the entire point of this feature (SPEC.md
  // §10/§11: window.open() is blocked or silently fails in some contexts
  // this page may be opened from).
  const { doc, elements } = fakeDocument(CRATE_JSON);
  const win = fakeWindow();
  initSongbookApp(doc, win);

  elements["print-book-button"].click();
  elements["print-now-button"].click();
  assert.equal(win.printCallCount, 1);
}

/* ---------- full screen: usable from any view, toggles via the Fullscreen API ---------- */

{
  const { doc, elements } = fakeDocument(CRATE_JSON);
  initSongbookApp(doc, fakeWindow());

  assert.equal(elements["fullscreen-button"].textContent, "Full screen");

  elements["fullscreen-button"].click();
  assert.equal(doc.fullscreenElement, doc.documentElement);
  assert.equal(elements["fullscreen-button"].textContent, "Exit full screen");

  elements["fullscreen-button"].click();
  assert.equal(doc.fullscreenElement, null);
  assert.equal(elements["fullscreen-button"].textContent, "Full screen");
}

{
  // Usable regardless of which view is showing — not tied to song view the
  // way key/capo/instrument/print-song are.
  const { doc, elements } = fakeDocument(CRATE_JSON);
  initSongbookApp(doc, fakeWindow());
  songLink(elements, 0).click();

  elements["fullscreen-button"].click();
  assert.equal(doc.fullscreenElement, doc.documentElement);
}

{
  // A rejected requestFullscreen() (denied permissions policy, not called
  // from a genuine user gesture in some browser) doesn't throw — there's
  // nothing more useful to do with it for a convenience feature than not
  // leaving an unhandled rejection behind.
  const { doc, elements } = fakeDocument(CRATE_JSON, { rejectFullscreen: true });
  initSongbookApp(doc, fakeWindow());

  assert.doesNotThrow(() => elements["fullscreen-button"].click());
}

/* ---------- next/previous navigation, with disabled state at each end ---------- */

{
  const { doc, elements } = fakeDocument(CRATE_JSON);
  initSongbookApp(doc, fakeWindow());
  songLink(elements, 0).click(); // Amazing Grace (index 0)

  elements["next-song-button"].click(); // -> Universe (index 1, the last song)
  assert.equal(elements["song-view-title"].textContent, "Universe");
  assert.equal(elements["prev-song-button"].disabled, false);
  assert.equal(elements["next-song-button"].disabled, true);

  // Already at the last song — clicking next again (as if the disabled
  // attribute were somehow bypassed) must not move past the end.
  elements["next-song-button"].click();
  assert.equal(elements["song-view-title"].textContent, "Universe");

  elements["prev-song-button"].click(); // back to Amazing Grace
  assert.equal(elements["song-view-title"].textContent, "Amazing Grace");
  assert.equal(elements["prev-song-button"].disabled, true);

  // Already at the first song — same guard, the other direction.
  elements["prev-song-button"].click();
  assert.equal(elements["song-view-title"].textContent, "Amazing Grace");
}

/* ---------- back to list ---------- */

{
  const { doc, elements } = fakeDocument(CRATE_JSON);
  initSongbookApp(doc, fakeWindow());
  songLink(elements, 1).click(); // Universe
  elements["back-to-list-button"].click();

  assert.equal(isHidden(elements["list-view"]), false);
  assert.equal(isHidden(elements["song-view"]), true);
  assert.equal(isHidden(elements["menu-bar"]), true);
  assert.equal(isHidden(elements["prev-song-button"]), true);
  assert.equal(isHidden(elements["next-song-button"]), true);
}

/* ---------- fitSongContent: exercised through showSong()/resize, not called directly — it's a closure private to initSongbookApp ---------- */

{
  // A synthetic layout model, not a real one: scrollHeight/scrollWidth are
  // defined as simple functions of the font-size fitSongContent itself
  // sets, standing in for "a bigger font needs more pixels to show the same
  // wrapped text" without any real CSS engine behind it — the same
  // limitation this file's own header comment already records for
  // classList. It's enough to check the binary search's own logic (finds
  // the largest font size that fits, respects the floor and ceiling,
  // degrades to the floor rather than looping forever when nothing fits) —
  // not to confirm what a real browser would actually render.
  const { doc, elements } = fakeDocument(CRATE_JSON);
  const content = elements["song-content"];
  content.clientWidth = 300;
  Object.defineProperty(content, "scrollHeight", { get() { return (parseInt(content.style.fontSize) || 0) * 8; } });
  Object.defineProperty(content, "scrollWidth", { get() { return (parseInt(content.style.fontSize) || 0) * 3; } });
  elements["menu-bar"].offsetHeight = 60;

  const win = fakeWindow({ innerHeight: 800 }); // available height: 800 - 60 = 740
  initSongbookApp(doc, win);
  songLink(elements, 0).click();

  // 8 * 80 = 640 <= 740 — the whole 10-80px range fits, so the search lands
  // on the ceiling, not some ordinary value inside the range.
  assert.equal(content.style.fontSize, "80px");
  // 740 (available height) > 300 (available width) — not landscape-shaped.
  assert.equal(content.classList.contains("two-columns"), false);
}

{
  // Same available height (740), but a steeper height-per-pixel-of-font
  // relationship (10 instead of 8) — now the ceiling doesn't fit
  // (10 * 80 = 800 > 740) and the exact largest size that does (74, since
  // 10 * 74 = 740 and 10 * 75 = 750) has to come from the search itself,
  // not from either boundary.
  const { doc, elements } = fakeDocument(CRATE_JSON);
  const content = elements["song-content"];
  content.clientWidth = 1000; // wide enough that width never binds here
  Object.defineProperty(content, "scrollHeight", { get() { return (parseInt(content.style.fontSize) || 0) * 10; } });
  Object.defineProperty(content, "scrollWidth", { get() { return (parseInt(content.style.fontSize) || 0) * 3; } });
  elements["menu-bar"].offsetHeight = 60;

  const win = fakeWindow({ innerHeight: 800 });
  initSongbookApp(doc, win);
  songLink(elements, 0).click();

  assert.equal(content.style.fontSize, "74px");
  // 740 (available height) < 1000 (available width) — landscape-shaped.
  assert.equal(content.classList.contains("two-columns"), true);
}

{
  // A width that no font size fixes — standing in for a long unwrapped tab
  // line — must not be searched around forever (chordprosite's own
  // unbounded version would keep shrinking past zero for input like this);
  // it has to settle on the floor, the one thing this content model can't
  // make worse.
  const { doc, elements } = fakeDocument(CRATE_JSON);
  const content = elements["song-content"];
  content.clientWidth = 300;
  content.scrollHeight = 10; // height is never the problem here
  content.scrollWidth = 5000; // ...but width never fits, at any font size
  elements["menu-bar"].offsetHeight = 60;

  const win = fakeWindow({ innerHeight: 800 });
  initSongbookApp(doc, win);
  songLink(elements, 0).click();

  assert.equal(content.style.fontSize, "10px"); // FIT_MIN_FONT_PX, not 0 or negative
}

{
  // Resizing re-fits the song currently on screen — chordprosite's own
  // equivalent line (`window.addEventListener('resize', fillPages(songDiv))`)
  // calls fillPages once immediately and registers its return value
  // (undefined) as the actual listener, so it never re-fits on a real
  // resize at all; this is the regression test for not repeating that.
  const { doc, elements } = fakeDocument(CRATE_JSON);
  const content = elements["song-content"];
  content.clientWidth = 1000;
  Object.defineProperty(content, "scrollHeight", { get() { return (parseInt(content.style.fontSize) || 0) * 8; } });
  Object.defineProperty(content, "scrollWidth", { get() { return (parseInt(content.style.fontSize) || 0) * 3; } });
  elements["menu-bar"].offsetHeight = 60;

  const win = fakeWindow({ innerHeight: 800 }); // 800 - 60 = 740; 8*80=640 fits -> 80px
  initSongbookApp(doc, win);
  songLink(elements, 0).click();
  assert.equal(content.style.fontSize, "80px");

  win.innerHeight = 200; // 200 - 60 = 140; 8*80=640 no longer fits -> must shrink
  win.dispatch("resize");
  // Debounced (150ms) — real timers, since this is genuine browser-facing
  // code, not a Workflow script; the wait below is for the debounce alone.
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(content.style.fontSize, "17px"); // 8*17=136<=140, 8*18=144>140
}

/* ---------- setlists: display and print (SPEC.md §6) — no editing/creation yet ---------- */

{
  // No setlists at all (CRATE_JSON's own fixture) — the "Setlists" button
  // stays hidden rather than opening onto an empty list (PT: "don't just
  // put a list down the bottom unless there's a button to go to it").
  const { doc, elements } = fakeDocument(CRATE_JSON);
  initSongbookApp(doc, fakeWindow());
  assert.equal(isHidden(elements["view-setlists-button"]), true);
  assert.equal(elements["setlist-list"].children.length, 0);
}

{
  const { doc, elements } = fakeDocument(SETLIST_CRATE_JSON);
  initSongbookApp(doc, fakeWindow());

  assert.equal(isHidden(elements["view-setlists-button"]), false);
  assert.equal(isHidden(elements["setlist-index-view"]), true); // not shown until the button is clicked

  elements["view-setlists-button"].click();
  assert.equal(isHidden(elements["list-view"]), true);
  assert.equal(isHidden(elements["setlist-index-view"]), false);

  assert.equal(elements["setlist-list"].children.length, 1);
  assert.equal(setlistLink(elements, 0).textContent, "Friday Gig");

  setlistLink(elements, 0).click();

  assert.equal(isHidden(elements["setlist-index-view"]), true);
  assert.equal(isHidden(elements["setlist-view"]), false);
  assert.equal(elements["setlist-view-title"].textContent, "Friday Gig");

  // Set 1 heading, entry 1 (exact — no status badge, no notes), entry 2
  // (fuzzy — status badge + notes), Set 2 heading, entry 3 (ambiguous —
  // still a link, since matchEntryToSong resolves it to a first-candidate
  // song even though it isn't a clean match), entry 4 (unresolved — no
  // song to link to, plain text).
  const rows = elements["setlist-entries"].children;
  assert.equal(rows.length, 6);

  assert.equal(rows[0].className, "setlist-set-name");
  assert.equal(rows[0].textContent, "Set 1");

  const entry1 = rows[1];
  assert.equal(entry1.children.length, 2); // position, name — no status, no notes
  assert.equal(entry1.children[1].textContent, "Song A");
  assert.equal(entry1.children[1].href, "#"); // a real link — entry.songIndex >= 0

  const entry2 = rows[2];
  assert.equal(entry2.children.length, 4); // position, name, status, notes
  assert.equal(entry2.children[1].textContent, "Song B (capo 2)");
  assert.ok(entry2.children[2].textContent.includes("matched approximately"));
  assert.equal(entry2.children[3].textContent, "Play slow and quiet");
  assert.equal(isHidden(entry2.children[3]), false); // notesVisible starts true

  assert.equal(rows[3].className, "setlist-set-name");
  assert.equal(rows[3].textContent, "Set 2");

  const entry3 = rows[4];
  assert.equal(entry3.children.length, 3); // position, name (still a link), status
  assert.ok(entry3.children[1].href !== undefined); // <a>, not <span> — songIndex >= 0
  assert.ok(entry3.children[2].textContent.includes("matches more than one song"));

  const entry4 = rows[5];
  assert.equal(entry4.children.length, 3); // position, name (plain, no song to link to), status
  assert.equal(entry4.children[1].href, undefined); // <span> — songIndex === -1
  assert.ok(entry4.children[2].textContent.includes("no matching song found"));
}

{
  // Clicking a matched entry opens that song, applying the entry's own
  // transpose/capo override rather than the song's session-saved or
  // default values — a setlist can ask for a different key/capo for one
  // particular performance than the song file itself specifies.
  const { doc, elements } = fakeDocument(SETLIST_CRATE_JSON);
  initSongbookApp(doc, fakeWindow());
  setlistLink(elements, 0).click();

  const entry2NameLink = elements["setlist-entries"].children[2].children[1]; // "Song B (capo 2)"
  entry2NameLink.click();

  assert.equal(isHidden(elements["setlist-view"]), true);
  assert.equal(isHidden(elements["song-view"]), false);
  // The canonical song's own name ("Song B"), not the entry's own display
  // heading ("Song B (capo 2)") — that heading is this setlist's own text
  // for this one performance slot, not the song's title (SPEC.md §6/§7).
  assert.equal(elements["song-view-title"].textContent, "Song B");
  // Song B is key C; the entry's capo:2 override shifts it down to Bb.
  assert.ok(elements["song-content"].innerHTML.includes('<span class="inlineChord">[Bb]</span>'));
}

{
  // Once a setlist is open, it *is* "the list" (PT) — next/previous page
  // through the setlist's own order (skipping the unresolved entry, which
  // has no song to show), not the global alphabetical song list, and
  // "Back to list" returns to that setlist, not the global list either.
  const { doc, elements } = fakeDocument(SETLIST_CRATE_JSON);
  initSongbookApp(doc, fakeWindow());
  setlistLink(elements, 0).click();

  const entry1Link = elements["setlist-entries"].children[1].children[1]; // Song A (exact)
  entry1Link.click();
  assert.equal(elements["song-view-title"].textContent, "Song A");
  assert.equal(elements["prev-song-button"].disabled, true); // first in this setlist's own playlist
  assert.equal(elements["next-song-button"].disabled, false);

  elements["next-song-button"].click(); // -> Song B (capo 2 override)
  assert.equal(elements["song-view-title"].textContent, "Song B");
  assert.ok(elements["song-content"].innerHTML.includes('<span class="inlineChord">[Bb]</span>'));

  elements["next-song-button"].click(); // -> Song A again (the ambiguous entry also resolved to it)
  assert.equal(elements["song-view-title"].textContent, "Song A");
  // No override on the ambiguous entry — back to Song A's own key (G), not
  // Bb-via-capo-2 left over from the entry before it.
  assert.ok(elements["song-content"].innerHTML.includes('<span class="inlineChord">[G]</span>'));
  assert.equal(elements["next-song-button"].disabled, true); // last of 3 playable entries

  elements["prev-song-button"].click(); // back to Song B
  assert.equal(elements["song-view-title"].textContent, "Song B");

  // "Back to list" goes to the setlist that was open, not the global list.
  elements["back-to-list-button"].click();
  assert.equal(isHidden(elements["setlist-view"]), false);
  assert.equal(isHidden(elements["list-view"]), true);
}

{
  // Opening a song from the *global* list, after having browsed a setlist
  // earlier in the same session, uses the global list's own order again —
  // currentSetlistIndex only stays set by staying inside that setlist's
  // own context, not permanently once touched once.
  const { doc, elements } = fakeDocument(SETLIST_CRATE_JSON);
  initSongbookApp(doc, fakeWindow());
  setlistLink(elements, 0).click();
  elements["setlist-entries"].children[1].children[1].click(); // into the setlist's own Song A
  elements["back-to-list-button"].click(); // -> setlist view
  elements["back-from-setlist-button"].click(); // -> setlist index
  elements["back-from-setlist-index-button"].click(); // -> global list

  songLink(elements, 0).click(); // Song A, alphabetically first of 2 in the global list
  assert.equal(elements["song-view-title"].textContent, "Song A");
  assert.equal(elements["prev-song-button"].disabled, true);
  assert.equal(elements["next-song-button"].disabled, false);

  elements["next-song-button"].click();
  assert.equal(elements["song-view-title"].textContent, "Song B");
  assert.equal(elements["next-song-button"].disabled, true); // last of 2, not 3 — the global list, not the setlist

  elements["back-to-list-button"].click();
  assert.equal(isHidden(elements["list-view"]), false); // the global list, not the setlist
}

{
  // Toggling notes hides/shows every entry's notes at once, not per-row —
  // re-renders the whole setlist, so this re-reads setlist-entries'
  // children fresh after each toggle rather than keeping stale references.
  const { doc, elements } = fakeDocument(SETLIST_CRATE_JSON);
  initSongbookApp(doc, fakeWindow());
  setlistLink(elements, 0).click();

  assert.equal(elements["toggle-notes-button"].textContent, "Hide notes");

  elements["toggle-notes-button"].click();
  assert.equal(elements["toggle-notes-button"].textContent, "Show notes");
  assert.equal(isHidden(elements["setlist-entries"].children[2].children[3]), true);

  elements["toggle-notes-button"].click();
  assert.equal(elements["toggle-notes-button"].textContent, "Hide notes");
  assert.equal(isHidden(elements["setlist-entries"].children[2].children[3]), false);
}

{
  // "Back to setlists" from a specific setlist goes up one level, to the
  // setlist index — not all the way to the global song list. "Back to
  // songs" on the setlist index is the one that goes there.
  const { doc, elements } = fakeDocument(SETLIST_CRATE_JSON);
  initSongbookApp(doc, fakeWindow());
  setlistLink(elements, 0).click();
  elements["back-from-setlist-button"].click();

  assert.equal(isHidden(elements["setlist-index-view"]), false);
  assert.equal(isHidden(elements["setlist-view"]), true);
  assert.equal(isHidden(elements["list-view"]), true);

  elements["back-from-setlist-index-button"].click();
  assert.equal(isHidden(elements["list-view"]), false);
  assert.equal(isHidden(elements["setlist-index-view"]), true);
}

{
  // Printing a setlist: title page (the setlist's own name, not
  // "Songbook"), a contents page listing every entry (including the
  // unresolved one, with "—" instead of a page number — silently dropping
  // it would hide the exact mismatch this feature is meant to surface),
  // and a song page for every entry that *does* resolve to a song
  // (including the ambiguous one — it still resolved to a candidate),
  // each in that entry's own transpose/capo override.
  const { doc, elements } = fakeDocument(SETLIST_CRATE_JSON);
  initSongbookApp(doc, fakeWindow());
  setlistLink(elements, 0).click();
  elements["print-setlist-button"].click();

  assert.equal(isHidden(elements["setlist-view"]), true);
  assert.equal(isHidden(elements["print-view"]), false);

  // one combined title + contents page + 3 song pages (exact, fuzzy,
  // ambiguous — not the unresolved entry, which has no song to print a
  // page for).
  assert.equal(elements["print-content"].children.length, 4);
  const [frontPage, pageA, pageB, pageC] = elements["print-content"].children;
  assert.equal(frontPage.children[0].textContent, "Friday Gig");

  const tocEntries = frontPage.children[2].children;
  assert.equal(tocEntries.length, 4);
  assert.equal(tocEntries[0].children[1].textContent, "2"); // Song A
  assert.equal(tocEntries[1].children[1].textContent, "3"); // Song B (capo 2)
  assert.equal(tocEntries[2].children[1].textContent, "4"); // Songg A (ambiguous)
  assert.equal(tocEntries[3].children[1].textContent, "—"); // Unknown Song (unresolved)

  assert.equal(pageA.printSongTitleElement.textContent, "Song A");
  assert.equal(pageB.printSongTitleElement.textContent, "Song B (capo 2)");
  // Song B is key C; capo 2 shifts it down to Bb — the entry's own
  // override, not whatever's currently selected on screen.
  assert.ok(pageB.printSongBody.innerHTML.includes('<span class="inlineChord">[Bb]</span>'));
  assert.equal(pageC.printSongTitleElement.textContent, "Songg A");

  // "Done printing" returns to the setlist that was open, not the list —
  // exitPrintView() checks currentSetlistIndex specifically for this.
  elements["done-printing-button"].click();
  assert.equal(isHidden(elements["setlist-view"]), false);
  assert.equal(elements["setlist-view-title"].textContent, "Friday Gig");
}

{
  // Chord grids appear on print pages too when an instrument is selected —
  // currentInstrument is global for the session (its own declaration in
  // initSongbookApp), so selecting it once while viewing any song carries
  // over into printing a setlist or the whole book later, not just the
  // on-screen chord panel.
  const { doc, elements } = fakeDocument(SETLIST_CRATE_JSON);
  initSongbookApp(doc, fakeWindow());
  songLink(elements, 0).click(); // Song A — instrument-select is only reachable while a song is open
  elements["instrument-select"].value = "Guitar";
  elements["instrument-select"].dispatch("change");
  elements["back-to-list-button"].click();

  setlistLink(elements, 0).click();
  elements["print-setlist-button"].click();

  const [, pageA] = elements["print-content"].children;
  // page.children: [heading, chordsForNote, row, page-number] once a
  // diagram exists (page-number since this came from showPrintSetlist, not
  // the standalone single-song print) — row.children: [body, diagrams].
  assert.equal(pageA.children.length, 4);
  assert.equal(pageA.children[1].className, "print-chords-for-note");
  assert.equal(pageA.children[1].textContent, "Chords for Guitar");
  const row = pageA.children[2];
  assert.equal(row.children.length, 2);
  assert.ok(row.children[1].className.includes("print-chord-diagrams"));
}

{
  // The book/setlist title page states which instrument's chords are used
  // throughout, once one is selected — readers need this from the title
  // page alone (PT), not per song.
  const { doc, elements } = fakeDocument(CRATE_JSON);
  initSongbookApp(doc, fakeWindow());
  songLink(elements, 0).click();
  elements["instrument-select"].value = "Guitar";
  elements["instrument-select"].dispatch("change");
  elements["back-to-list-button"].click();

  elements["print-book-button"].click();
  const [titlePage] = elements["print-content"].children;
  assert.equal(titlePage.children[1].className, "print-chords-for");
  assert.equal(titlePage.children[1].textContent, "With chords for Guitar");
}

{
  // The instrument can be picked/changed from print preview itself
  // (#print-instrument-select, in the banner alongside "Print now"/"Done
  // printing") — PT: "let the user select an instrument from the print
  // page" — without having gone to a song first, and it redraws whatever's
  // currently on screen (currentPrintRebuild) to reflect the change
  // immediately, rather than requiring a trip back out of print mode.
  const { doc, elements } = fakeDocument(CRATE_JSON);
  initSongbookApp(doc, fakeWindow());

  elements["print-book-button"].click();
  // [h1, "Contents" h2, <ol>, page-number] — no "with chords for" subtitle
  // yet, since no instrument is selected.
  assert.equal(elements["print-content"].children[0].children.length, 4);

  elements["print-instrument-select"].value = "Guitar";
  elements["print-instrument-select"].dispatch("change");

  const [titlePage] = elements["print-content"].children;
  assert.equal(titlePage.children[1].textContent, "With chords for Guitar");
  // Both selects agree — checking the menu bar's own after changing the
  // print banner's is what actually confirms they're kept in sync, not
  // just that the one just changed remembers its own value.
  assert.equal(elements["instrument-select"].value, "Guitar");
}

/* ---------- renderSongbookHtml: the page everything above is embedded into ---------- */

{
  const html = renderSongbookHtml(CRATE_JSON);
  assert.ok(html.startsWith("<!doctype html>"));
  assert.ok(html.includes('<ul id="song-list"></ul>'));
  assert.ok(html.includes('<button id="prev-song-button"'));
  assert.ok(html.includes('<button id="next-song-button"'));
  assert.ok(html.includes('<button id="back-to-list-button"'));
  assert.ok(html.includes('<select id="key-select"'));
  assert.ok(html.includes('<select id="capo-select"'));
  assert.ok(html.includes('<select id="instrument-select"'));
  assert.ok(html.includes('<div id="chord-diagrams"'));
  assert.ok(!html.includes("type=\"module\"")); // file:// must work — see SPEC.md's UI section

  // The chordprobook bundle is embedded, and defines the globals the app
  // script depends on — as is the instrument list and chord-shape data,
  // precomputed at build time (scripts/bundle-chordprobook-for-browser.mjs)
  // rather than parsed client-side from YAML/.cho text.
  assert.ok(html.includes(CHORDPROBOOK_BROWSER_BUNDLE));
  assert.ok(html.includes("CHORDPROBOOK_INSTRUMENTS_DATA"));
  assert.ok(html.includes(JSON.stringify(CHORDPROBOOK_CHORD_DATA)));

  // The embedded JSON-LD round-trips to the exact crate that went in.
  const embeddedMatch = html.match(/<script type="application\/ld\+json" id="crate-data">\n([\s\S]*?)\n<\/script>/);
  assert.ok(embeddedMatch);
  assert.deepEqual(JSON.parse(embeddedMatch[1]), CRATE_JSON);

  assert.ok(html.includes(")(document, window);")); // the app is invoked, not just defined
  assert.ok(!html.includes("<li>")); // nothing pre-rendered — the browser builds these, not this build step
}

{
  // A "</script" inside the data doesn't break out of the element it's embedded in.
  const html = renderSongbookHtml({
    "@graph": [{ "@id": "x", "@type": "MusicComposition", name: "</script><script>alert(1)</script>", text: "t" }],
  });
  assert.ok(!html.includes("</script><script>alert(1)</script>"));
  assert.ok(html.includes("<\\/script>"));
}

/* ---------- the plugin: end to end against a mock folder ---------- */

function notFoundError() {
  const e = new Error("not found");
  e.name = "NotFoundError";
  return e;
}

function memoryDirHandle(initialFiles = {}) {
  const files = new Map(Object.entries(initialFiles));
  function wrapFileHandle(name) {
    return {
      async getFile() { return new File([files.get(name)], name); },
      async createWritable() {
        return {
          async write(contents) { files.set(name, typeof contents === "string" ? contents : new TextDecoder().decode(contents)); },
          async close() {},
        };
      },
    };
  }
  return {
    async getFileHandle(name, { create = false } = {}) {
      if (!files.has(name) && !create) throw notFoundError();
      if (!files.has(name) && create) files.set(name, "");
      return wrapFileHandle(name);
    },
    readFile: (name) => files.get(name),
  };
}

function makeCtx(overrides = {}) {
  const messages = [];
  return {
    dirHandle: memoryDirHandle({ "ro-crate-metadata.json": JSON.stringify(CRATE_JSON) }),
    options: { inputMode: "chordpro", overwrite: true },
    log: (msg, level) => messages.push({ msg, level }),
    messages,
    ...overrides,
  };
}

{
  const ctx = makeCtx();
  await songbookHtmlPlugin.hooks[HOOKS.OUTPUT_WRITE](ctx);
  const written = ctx.dirHandle.readFile("songbook.html");
  assert.ok(written);
  assert.ok(written.includes(JSON.stringify(CRATE_JSON, null, 2).slice(0, 40)));
  assert.ok(ctx.messages.some((m) => m.level === "ok" && m.msg.includes("2 song(s)")));
}

{
  // Not a chordpro build — must do nothing at all, not even read the folder.
  const ctx = makeCtx({ options: { inputMode: "generic", overwrite: true } });
  await songbookHtmlPlugin.hooks[HOOKS.OUTPUT_WRITE](ctx);
  assert.equal(ctx.dirHandle.readFile("songbook.html"), undefined);
  assert.equal(ctx.messages.length, 0);
}

{
  // No crate JSON in the folder at all — logs a warning, doesn't throw.
  const ctx = makeCtx({ dirHandle: memoryDirHandle({}) });
  await assert.doesNotReject(() => songbookHtmlPlugin.hooks[HOOKS.OUTPUT_WRITE](ctx));
  assert.ok(ctx.messages.some((m) => m.level === "warn" && m.msg.includes("not found")));
}

{
  // overwrite: false and the file already exists — skipped, existing
  // content left untouched.
  const ctx = makeCtx({ options: { inputMode: "chordpro", overwrite: false } });
  await ctx.dirHandle.getFileHandle("songbook.html", { create: true })
    .then((h) => h.createWritable())
    .then((w) => w.write("PRE-EXISTING"));
  await songbookHtmlPlugin.hooks[HOOKS.OUTPUT_WRITE](ctx);
  assert.equal(ctx.dirHandle.readFile("songbook.html"), "PRE-EXISTING");
  assert.ok(ctx.messages.some((m) => m.level === "warn" && m.msg.includes("overwrite is off")));
}

console.log("test-songbook-html.mjs: all assertions passed.");
