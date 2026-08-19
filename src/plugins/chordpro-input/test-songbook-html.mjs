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

// Five songs covering every branch of the song-list/setlist-entry credit
// line (SPEC.md §12): composer only, performer only, subtitle only, all
// three at once (composer should still win, alone), and neither a credit
// nor a key at all. Deliberately separate from CRATE_JSON/SETLIST_CRATE_JSON
// above — those fixtures are reused by many unrelated assertions elsewhere
// in this file, and adding credit/key fields to them would risk perturbing
// tests that have nothing to do with this feature.
const CREDIT_CRATE_JSON = {
  "@graph": [
    { "@id": "./", "@type": "Dataset", name: "Credits" },
    {
      "@id": "composer-only.cho.txt", "@type": "MusicComposition", name: "Composer Only",
      text: "{title: Composer Only}\n\n[C]x", composer: "Hank Williams", musicalKey: "C",
    },
    {
      "@id": "performer-only.cho.txt", "@type": "MusicComposition", name: "Performer Only",
      text: "{title: Performer Only}\n\n[D]x", performer: "Richard Thompson",
    },
    {
      "@id": "subtitle-only.cho.txt", "@type": "MusicComposition", name: "Subtitle Only",
      text: "{title: Subtitle Only}\n\n[E]x", subtitle: "a lullaby",
    },
    {
      "@id": "all-three.cho.txt", "@type": "MusicComposition", name: "All Three",
      text: "{title: All Three}\n\n[F]x", composer: "Comp Erson", performer: "Perf Ormer", subtitle: "Sub Title",
    },
    {
      "@id": "none.cho.txt", "@type": "MusicComposition", name: "No Credit No Key",
      text: "{title: No Credit No Key}\n\n[G]x",
    },
  ],
};

// A setlist with one entry of each SPEC.md §6.1 match status (exact,
// fuzzy — with its own capo override, ambiguous, unresolved), across two
// "#" sets, one entry carrying performance notes. Built directly as the
// crate entities chordpro_crate.js would have produced, not run through the
// actual matching algorithm — this file is testing what initSongbookApp
// does with that output, not the matching itself (chordprobook's own
// test-chordpro-setlist.mjs covers that). Each "#" set is its own nested
// MusicPlaylist (SPEC.md §6) — neither carries a description here (no
// freeform text between its own heading and its first entry in this
// fixture); FLATTEN_SET_NOTES_CRATE_JSON, below, covers that separately.
const SETLIST_CRATE_JSON = {
  "@graph": [
    { "@id": "./", "@type": "Dataset", name: "Songbook" },
    // musicalKey set explicitly (not just embedded in `text`), matching what
    // chordpro_crate.js's own buildSongEntity actually writes alongside
    // `text` for a song with a {key} directive (SPEC.md §5/§7) — this
    // fixture's own header comment already claims to model that real output,
    // and the setlist-entry credit/key test below (SPEC.md §12) is exactly
    // what surfaced this field having been missing until now.
    { "@id": "song-a.cho.txt", "@type": "MusicComposition", name: "Song A", text: "{title: Song A}\n{key: G}\n\n[G]Verse", musicalKey: "G" },
    { "@id": "song-b.cho.txt", "@type": "MusicComposition", name: "Song B", text: "{title: Song B}\n{key: C}\n\n[C]Verse", musicalKey: "C" },
    {
      "@id": "gig.setlist.md", "@type": "MusicPlaylist", name: "Friday Gig",
      hasPart: [
        { "@id": "gig.setlist.md#set-1" },
        { "@id": "gig.setlist.md#set-2" },
      ],
    },
    {
      "@id": "gig.setlist.md#set-1", "@type": "MusicPlaylist", name: "Set 1",
      hasPart: [{ "@id": "gig.setlist.md#entry-1" }, { "@id": "gig.setlist.md#entry-2" }],
    },
    {
      "@id": "gig.setlist.md#set-2", "@type": "MusicPlaylist", name: "Set 2",
      hasPart: [{ "@id": "gig.setlist.md#entry-3" }, { "@id": "gig.setlist.md#entry-4" }],
    },
    {
      "@id": "gig.setlist.md#entry-1", "@type": "MusicComposition", name: "Song A",
      "custom:matchStatus": "exact",
      specializationOf: { "@id": "song-a.cho.txt" },
    },
    {
      "@id": "gig.setlist.md#entry-2", "@type": "MusicComposition", name: "Song B (capo 2)",
      "custom:matchStatus": "fuzzy", "custom:capo": 2,
      text: "Play slow and quiet",
      specializationOf: { "@id": "song-b.cho.txt" },
    },
    {
      "@id": "gig.setlist.md#entry-3", "@type": "MusicComposition", name: "Songg A",
      "custom:matchStatus": "ambiguous",
      specializationOf: { "@id": "song-a.cho.txt" },
      "custom:matchCandidates": [{ "@id": "song-a.cho.txt" }],
    },
    {
      "@id": "gig.setlist.md#entry-4", "@type": "MusicComposition", name: "Unknown Song",
      "custom:matchStatus": "unresolved",
    },
  ],
};

// One "#" set with its own text (chordpro_crate.js's own property for
// freeform text between a "#" heading and its first entry — SPEC.md §6/§6.2
// — a deliberate overload of the same property name a canonical Song uses
// for its own, differently-meant, verbatim ChordPro source) — separate from
// SETLIST_CRATE_JSON above so that fixture's own row-index assertions don't
// have to account for the extra .setlist-set-notes element this produces.
const SET_NOTES_CRATE_JSON = {
  "@graph": [
    { "@id": "./", "@type": "Dataset", name: "Songbook" },
    { "@id": "song-a.cho.txt", "@type": "MusicComposition", name: "Song A", text: "{title: Song A}\n\n[C]Verse" },
    {
      "@id": "gig.setlist.md", "@type": "MusicPlaylist", name: "Friday Gig",
      hasPart: [{ "@id": "gig.setlist.md#set-1" }],
    },
    {
      "@id": "gig.setlist.md#set-1", "@type": "MusicPlaylist", name: "Set 1",
      text: "Tune guitars to drop D now.",
      hasPart: [{ "@id": "gig.setlist.md#entry-1" }],
    },
    {
      "@id": "gig.setlist.md#entry-1", "@type": "MusicComposition", name: "Song A",
      "custom:matchStatus": "exact", specializationOf: { "@id": "song-a.cho.txt" },
    },
  ],
};

// A set note with a paragraph followed by a numbered list, and an entry note
// with a blockquote containing **bold** — the same shapes the real,
// hand-authored sample.setlist.md now uses (SPEC.md §6/§6.2), to check
// renderNoteMarkdown's actual block/inline parsing, not just its single-line
// fallback (SET_NOTES_CRATE_JSON, above).
const RICH_NOTES_CRATE_JSON = {
  "@graph": [
    { "@id": "./", "@type": "Dataset", name: "Songbook" },
    { "@id": "song-a.cho.txt", "@type": "MusicComposition", name: "Song A", text: "{title: Song A}\n\n[C]Verse" },
    {
      "@id": "gig.setlist.md", "@type": "MusicPlaylist", name: "Friday Gig",
      hasPart: [{ "@id": "gig.setlist.md#set-1" }],
    },
    {
      "@id": "gig.setlist.md#set-1", "@type": "MusicPlaylist", name: "Set 1",
      // Setlist.js's own note-collection joins non-blank lines with "\n",
      // discarding the blank line that separated them in the source
      // markdown (chordprobook's own SPEC.md §3.2) — this is exactly what
      // it hands back for "This is our last gig...\n\n1. No spitting!\n2. ...".
      text: "This is our last gig so make it a good one\n1. No spitting!\n2. Not too much fighting",
      hasPart: [{ "@id": "gig.setlist.md#entry-1" }],
    },
    {
      "@id": "gig.setlist.md#entry-1", "@type": "MusicComposition", name: "Slot Machine Baby",
      "custom:matchStatus": "exact", specializationOf: { "@id": "song-a.cho.txt" },
      text: "> Play with a lively feel, start with a manic synth solo!\n>> But not **that** lively!",
    },
  ],
};

// For floor-sheet printing (SPEC.md §13, buildFloorSheetPages) — one entry
// before any "#" set (no setName at all), then a "#" set with two entries:
// one resolved with its own note, one unresolved. A floor sheet has to
// still list the unresolved one (unlike every other print path, which
// skips it — there's no song to print a *page* for, but there's nothing
// stopping a plain name from being listed old-school-style), which is the
// one thing none of the fixtures above already cover.
const FLOOR_SHEET_CRATE_JSON = {
  "@graph": [
    { "@id": "./", "@type": "Dataset", name: "Songbook" },
    { "@id": "song-a.cho.txt", "@type": "MusicComposition", name: "Song A", text: "{title: Song A}\n\n[C]Verse" },
    { "@id": "song-b.cho.txt", "@type": "MusicComposition", name: "Song B", text: "{title: Song B}\n\n[C]Verse" },
    {
      "@id": "gig.setlist.md", "@type": "MusicPlaylist", name: "Friday Gig",
      hasPart: [
        { "@id": "gig.setlist.md#entry-0" },
        { "@id": "gig.setlist.md#set-1" },
      ],
    },
    {
      "@id": "gig.setlist.md#set-1", "@type": "MusicPlaylist", name: "Set 1",
      hasPart: [{ "@id": "gig.setlist.md#entry-1" }, { "@id": "gig.setlist.md#entry-2" }],
    },
    {
      "@id": "gig.setlist.md#entry-0", "@type": "MusicComposition", name: "Intro Song",
      "custom:matchStatus": "exact", specializationOf: { "@id": "song-b.cho.txt" },
    },
    {
      "@id": "gig.setlist.md#entry-1", "@type": "MusicComposition", name: "Song A",
      "custom:matchStatus": "exact", specializationOf: { "@id": "song-a.cho.txt" },
      text: "Watch the tempo here",
    },
    {
      "@id": "gig.setlist.md#entry-2", "@type": "MusicComposition", name: "Unknown Song",
      "custom:matchStatus": "unresolved",
    },
  ],
};

// Two setlists, for "Find a setlist" (#setlist-search) — SETLIST_CRATE_JSON
// above only has one, which is enough to test opening/rendering a setlist
// but not filtering a list of them.
const TWO_SETLISTS_CRATE_JSON = {
  "@graph": [
    { "@id": "./", "@type": "Dataset", name: "Two Setlists" },
    { "@id": "song-a.cho.txt", "@type": "MusicComposition", name: "Song A", text: "{title: Song A}\n\n[C]Verse" },
    {
      "@id": "friday.setlist.md", "@type": "MusicPlaylist", name: "Friday Gig",
      hasPart: [{ "@id": "friday.setlist.md#entry-1" }],
    },
    {
      "@id": "friday.setlist.md#entry-1", "@type": "MusicComposition", name: "Song A",
      "custom:matchStatus": "exact", specializationOf: { "@id": "song-a.cho.txt" },
    },
    {
      "@id": "saturday.setlist.md", "@type": "MusicPlaylist", name: "Saturday Session",
      hasPart: [{ "@id": "saturday.setlist.md#entry-1" }],
    },
    {
      "@id": "saturday.setlist.md#entry-1", "@type": "MusicComposition", name: "Song A",
      "custom:matchStatus": "exact", specializationOf: { "@id": "song-a.cho.txt" },
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
  const attributes = {};
  return {
    textContent: "",
    innerHTML: "",
    disabled: false,
    checked: false,
    title: "",
    children: [],
    style: {},
    setAttribute(name, value) { attributes[name] = String(value); },
    getAttribute(name) { return name in attributes ? attributes[name] : null; },
    // menuBarOverflowToggle's click handler reads .bottom off #app-bar's own
    // rect to position the dropdown — 0 by default, matching an unrendered
    // element; tests exercising that specifically override it.
    getBoundingClientRect() { return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }; },
    // Layout measurements fitSongContent reads: 0 by default, matching a
    // real, unrendered element — tests exercising that function override
    // these (as plain properties, or as getters via Object.defineProperty
    // when a value needs to react to style.fontSize being set).
    offsetHeight: 0,
    offsetTop: 0,
    offsetWidth: 0,
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
    "app-bar": makeElement(),
    "menu-bar-overflow-toggle": makeElement(),
    "menu-bar-overflow": makeElement(),
    "song-view-title": makeElement(),
    "song-content": makeElement(),
    "song-header": makeElement(),
    "song-pages": makeElement(),
    "song-list": makeElement(),
    "prev-song-button": makeElement(),
    "next-song-button": makeElement(),
    "back-to-list-button": makeElement(),
    "key-select": makeElement(),
    "capo-select": makeElement(),
    "instrument-select": makeElement(),
    "chord-diagrams": makeElement(),
    "toggle-chords-button": makeElement(),
    "toggle-chords-glyph": makeElement(),
    "print-song-button": makeElement(),
    "print-book-button": makeElement(),
    "print-view": makeElement(),
    "print-content": makeElement(),
    "print-now-button": makeElement(),
    "done-printing-button": makeElement(),
    "print-instrument-select": makeElement(),
    // checked: true to match the real markup's own `checked` attribute,
    // same reasoning as facing-pages-checkbox just below.
    "include-toc-label": makeElement(),
    "include-toc-checkbox": { ...makeElement(), checked: true },
    "large-print-label": makeElement(),
    "large-print-checkbox": makeElement(),
    // checked: true to match the real markup's own `checked` attribute
    // (<input type="checkbox" id="facing-pages-checkbox" checked>) — unlike
    // every other fake element here, whose defaults all match an
    // *unrendered* real one, since HTML attributes aren't something this
    // fake document parses at all (this file's own header comment).
    "facing-pages-label": makeElement(),
    "facing-pages-checkbox": { ...makeElement(), checked: true },
    "floor-sheet-label": makeElement(),
    "floor-sheet-checkbox": makeElement(),
    "floor-sheet-notes-label": makeElement(),
    "floor-sheet-notes-checkbox": { ...makeElement(), checked: true },
    // checked: true to match the real markup's own `checked` attribute,
    // same reasoning as facing-pages-checkbox just above.
    "setlist-notes-checkbox": { ...makeElement(), checked: true },
    "setlist-notes-label": makeElement(),
    "setlist-note-modal": makeElement(),
    "setlist-note-modal-content": makeElement(),
    "fullscreen-button": makeElement(),
    "view-setlists-button": makeElement(),
    "setlist-index-view": makeElement(),
    "back-from-setlist-index-button": makeElement(),
    "setlist-list": makeElement(),
    "setlist-search": makeElement(),
    "song-search": makeElement(),
    "setlist-view": makeElement(),
    "setlist-view-title": makeElement(),
    "back-from-setlist-button": makeElement(),
    "print-setlist-button": makeElement(),
    "toggle-notes-button": makeElement(),
    "setlist-entries": makeElement(),
    "setlist-entries-search": makeElement(),
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
    // tagName recorded (uppercase, matching a real DOM Element's own),
    // needed to verify renderNoteMarkdown's actual block structure
    // (<p>/<ol>/<ul>/<blockquote>/<li>) — every other createElement() call
    // in this file only ever checks className/textContent, which never
    // needed the tag itself tracked at all.
    createElement: (tag) => ({ ...makeElement(), tagName: String(tag).toUpperCase() }),
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

// The concatenated text of every leaf under `element`, walking .children —
// this fake DOM's own .textContent is a plain, independently-settable
// property (unlike a real Element's, which computes itself from
// descendants), so it's never automatically kept in sync by appendChild the
// way renderNoteMarkdown's own real-DOM equivalent would be. Needed only for
// asserting on renderNoteMarkdown's actual (nested) output; nothing else in
// this file builds nested element trees deep enough for the difference to
// matter.
function collectText(element) {
  if (!element.children || !element.children.length) return element.textContent || "";
  return element.children.map(collectText).join("");
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
  assert.equal(isHidden(elements["prev-song-button"]), true);
  assert.equal(isHidden(elements["next-song-button"]), true);
  assert.equal(isHidden(elements["back-to-list-button"]), true);
  assert.equal(isHidden(elements["menu-bar-overflow"]), true);

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

{
  // Search also matches whichever credit a row actually displays (SPEC.md
  // §12) — composer/performer/subtitle, not just the title. Rows, sorted
  // alphabetically: All Three (composer "Comp Erson"), Composer Only
  // ("Hank Williams"), No Credit No Key, Performer Only ("Richard
  // Thompson"), Subtitle Only ("a lullaby").
  const { doc, elements } = fakeDocument(CREDIT_CRATE_JSON);
  initSongbookApp(doc, fakeWindow());
  const rows = elements["song-list"].children;

  elements["song-search"].value = "hank";
  elements["song-search"].dispatch("input");
  assert.deepEqual(rows.map(isHidden), [true, false, true, true, true]); // only Composer Only

  elements["song-search"].value = "thompson";
  elements["song-search"].dispatch("input");
  assert.deepEqual(rows.map(isHidden), [true, true, true, false, true]); // only Performer Only

  elements["song-search"].value = "lullaby";
  elements["song-search"].dispatch("input");
  assert.deepEqual(rows.map(isHidden), [true, true, true, true, false]); // only Subtitle Only

  // "Perf Ormer" is All Three's own *performer* — not shown, since its
  // composer ("Comp Erson") wins the one credit line that's actually
  // displayed (SPEC.md §12's own composer/performer/subtitle precedence) —
  // so it must not be searchable either.
  elements["song-search"].value = "perf ormer";
  elements["song-search"].dispatch("input");
  assert.deepEqual(rows.map(isHidden), [true, true, true, true, true]); // matches nothing
}

/* ---------- clicking a song: song view, rendered via chordprobook's real renderSong ---------- */

{
  const { doc, elements } = fakeDocument(CRATE_JSON);
  initSongbookApp(doc, fakeWindow());

  songLink(elements, 0).click(); // "Amazing Grace"

  assert.equal(isHidden(elements["list-view"]), true);
  assert.equal(isHidden(elements["song-view"]), false);
  assert.equal(isHidden(elements["prev-song-button"]), false);
  assert.equal(isHidden(elements["next-song-button"]), false);
  assert.equal(isHidden(elements["back-to-list-button"]), false);
  assert.equal(isHidden(elements["menu-bar-overflow"]), false);
  assert.equal(elements["song-view-title"].textContent, "Amazing Grace");

  // Rendered by chordprobook's real renderSong(), not a stub — chord
  // brackets become inlineChord spans, matching that library's own tests.
  assert.ok(elements["song-pages"].innerHTML.includes('<span class="inlineChord">[G]</span>'));
  assert.ok(elements["song-pages"].innerHTML.includes('<span class="inlineChord">[G7]</span>'));

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
  assert.ok(elements["song-pages"].innerHTML.includes('<span class="inlineChord">[F]</span>'));
  assert.ok(elements["song-pages"].innerHTML.includes('<span class="inlineChord">[F7]</span>'));
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
  assert.ok(elements["song-pages"].innerHTML.includes('<span class="inlineChord">[F]</span>'));

  elements["key-select"].value = "D";
  elements["key-select"].dispatch("change");

  assert.ok(elements["song-pages"].innerHTML.includes('<span class="inlineChord">[D]</span>'));
  assert.ok(elements["song-pages"].innerHTML.includes('<span class="inlineChord">[D7]</span>'));
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
  assert.equal(isHidden(elements["toggle-chords-button"]), true);
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
  assert.ok(elements["song-pages"].innerHTML.includes('<span class="inlineChord">[D]</span>'));

  elements["next-song-button"].click(); // -> Universe, key C, untouched
  assert.ok(elements["song-pages"].innerHTML.includes('<span class="inlineChord">[C]</span>'));
  assert.equal(elements["key-select"].children.find((o) => o.value === "C").selected, true);
}

/* ---------- hide/show chords toggle (small-screen overflow menu) ---------- */

{
  // Visible whenever the song has chords, labelled "Hide chords" (in
  // title/aria-label, not textContent — it's a fixed-size icon button now,
  // "[C]" always, same reasoning as #fullscreen-button's own label) until
  // clicked — same hasChords gate as instrument-select, above.
  const { doc, elements } = fakeDocument(CRATE_JSON);
  initSongbookApp(doc, fakeWindow());
  songLink(elements, 0).click(); // Amazing Grace

  assert.equal(isHidden(elements["toggle-chords-button"]), false);
  assert.equal(elements["toggle-chords-button"].title, "Hide chords");
  assert.equal(elements["toggle-chords-button"].getAttribute("aria-label"), "Hide chords");
  assert.equal(elements["toggle-chords-glyph"].classList.contains("struck"), false);
  assert.equal(elements["song-content"].classList.contains("chords-hidden"), false);

  elements["toggle-chords-button"].click();
  assert.equal(elements["toggle-chords-button"].title, "Show chords");
  assert.equal(elements["toggle-chords-glyph"].classList.contains("struck"), true);
  assert.equal(elements["song-content"].classList.contains("chords-hidden"), true);

  elements["toggle-chords-button"].click();
  assert.equal(elements["toggle-chords-button"].title, "Hide chords");
  assert.equal(elements["toggle-chords-glyph"].classList.contains("struck"), false);
  assert.equal(elements["song-content"].classList.contains("chords-hidden"), false);
}

{
  // Global for the session, like currentInstrument, not reset per song —
  // stays hidden across a next/previous move to a different song.
  const { doc, elements } = fakeDocument(CRATE_JSON);
  initSongbookApp(doc, fakeWindow());
  songLink(elements, 0).click(); // Amazing Grace

  elements["toggle-chords-button"].click();
  assert.equal(elements["song-content"].classList.contains("chords-hidden"), true);

  elements["next-song-button"].click(); // Universe
  assert.equal(elements["song-content"].classList.contains("chords-hidden"), true);
  assert.equal(elements["toggle-chords-button"].title, "Show chords");
  assert.equal(elements["toggle-chords-glyph"].classList.contains("struck"), true);
}

/* ---------- small-screen overflow menu (instrument select / hide-chords button) ---------- */

{
  // The hamburger toggle just flips .open on #menu-bar-overflow — the
  // breakpoint that decides whether that's visually meaningful is CSS-only
  // (see songbook_html.js's own #menu-bar-overflow-toggle/#menu-bar-overflow
  // rules), so this only checks the class, not layout. It also sets an
  // explicit top on open, computed from #app-bar's own rect — position:
  // fixed (not absolute — see that rule's own CSS comment for why) means
  // CSS alone can't express "just under the bar" the way top: 100% could
  // for an absolutely positioned element, so this is the regression test
  // for the dropdown actually landing under the bar rather than at the top
  // of the viewport (where a fixed element with no top override would sit).
  const { doc, elements } = fakeDocument(CRATE_JSON);
  initSongbookApp(doc, fakeWindow());
  songLink(elements, 0).click();
  elements["app-bar"].getBoundingClientRect = () => ({ bottom: 52 });

  assert.equal(elements["menu-bar-overflow"].classList.contains("open"), false);
  elements["menu-bar-overflow-toggle"].click();
  assert.equal(elements["menu-bar-overflow"].classList.contains("open"), true);
  assert.equal(elements["menu-bar-overflow"].style.top, "58px"); // 52 + 6
  elements["menu-bar-overflow-toggle"].click();
  assert.equal(elements["menu-bar-overflow"].classList.contains("open"), false);
}

{
  // Opening the overflow menu then moving to another song closes it again —
  // showSong() resets it, the same way it resets other song-view state.
  const { doc, elements } = fakeDocument(CRATE_JSON);
  initSongbookApp(doc, fakeWindow());
  songLink(elements, 0).click();
  elements["menu-bar-overflow-toggle"].click();
  assert.equal(elements["menu-bar-overflow"].classList.contains("open"), true);

  elements["next-song-button"].click();
  assert.equal(elements["menu-bar-overflow"].classList.contains("open"), false);
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
  assert.ok(elements["song-pages"].innerHTML.includes('<span class="inlineChord">[C]</span>')); // D - 2 = C

  elements["next-song-button"].click(); // -> Universe
  elements["prev-song-button"].click(); // back to Amazing Grace

  assert.ok(elements["song-pages"].innerHTML.includes('<span class="inlineChord">[C]</span>')); // still D capo 2
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
  assert.ok(elements2["song-pages"].innerHTML.includes('<span class="inlineChord">[C]</span>'));
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
  assert.ok(elements["song-pages"].innerHTML.includes('<span class="inlineChord">[D]</span>'));
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
  assert.equal(isHidden(elements["back-to-list-button"]), true);
  assert.equal(isHidden(elements["menu-bar-overflow"]), true);
  assert.equal(isHidden(elements["print-view"]), false);
  assert.equal(elements["print-content"].children.length, 1); // one page, this song only

  const [page] = elements["print-content"].children;
  assert.equal(page.printSongTitleElement.textContent, "Amazing Grace");
  assert.ok(page.printSongBodyContent.innerHTML.includes('<span class="inlineChord">[G]</span>'));
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

/* ---------- {new_page} in normal print: one physical page per section (SPEC.md §13) ---------- */

{
  // A song with two {new_page} directives (three sections) prints as three
  // separate pages, standalone — not joined onto one the way the on-screen
  // view and this same song's rendered.pages.join("\n") would (renderSong's
  // own `pages` array is what both this and the large-print version below
  // walk instead of joining).
  const { doc, elements } = fakeDocument({
    "@graph": [{
      "@id": "medley.cho.txt", "@type": "MusicComposition", name: "Medley",
      text: "{title: Medley}\n\n[C]First section\n{new_page}\n[D]Second section\n{new_page}\n[E]Third section",
    }],
  });
  initSongbookApp(doc, fakeWindow());
  songLink(elements, 0).click();
  elements["print-song-button"].click();

  assert.equal(elements["print-content"].children.length, 3);
  const [page1, page2, page3] = elements["print-content"].children;
  assert.ok(page1.printSongBodyContent.innerHTML.includes('<span class="inlineChord">[C]</span>'));
  assert.ok(!page1.printSongBodyContent.innerHTML.includes("Second section"));
  assert.ok(page2.printSongBodyContent.innerHTML.includes('<span class="inlineChord">[D]</span>'));
  assert.ok(!page2.printSongBodyContent.innerHTML.includes("First section"));
  assert.ok(page3.printSongBodyContent.innerHTML.includes('<span class="inlineChord">[E]</span>'));
  // No page numbers (standalone print, same as a single-section song) and
  // no "(continued)" notes either — each {new_page} break is a deliberate,
  // authored page, not an auto-split continuation (buildNormalPrintSongPages'
  // own comment).
  assert.equal(page1.children.find((c) => c.className === "print-page-number"), undefined);
  assert.equal(page1.printContinuedNoteElement, null);
  assert.equal(page2.printContinuedNoteElement, null);
  assert.equal(page3.printContinuedNoteElement, null);
  assert.ok(isFittedFontSize(page1.printSongBody.style.fontSize));
}

{
  // The same accounting inside a whole-book print — a three-section song's
  // own page numbers advance by its own actual page count (3 here), not a
  // flat 1, so the *next* song's number still comes out correctly.
  const { doc, elements } = fakeDocument({
    "@graph": [
      {
        "@id": "medley.cho.txt", "@type": "MusicComposition", name: "Medley",
        text: "{title: Medley}\n\n[C]First\n{new_page}\n[D]Second\n{new_page}\n[E]Third",
      },
      { "@id": "b.cho.txt", "@type": "MusicComposition", name: "Song B", text: "{title: Song B}\n\n[F]Verse" },
    ],
  });
  initSongbookApp(doc, fakeWindow());
  elements["print-book-button"].click();

  // 1 front page + Medley's 3 pages + Song B's 1 page = 5.
  assert.equal(elements["print-content"].children.length, 5);
  const tocEntries = elements["print-content"].children[0].children[2].children;
  assert.equal(tocEntries[0].children[1].textContent, "2"); // Medley: pages 2-4
  assert.equal(tocEntries[1].children[1].textContent, "5"); // Song B: page 5
  const pages = elements["print-content"].children;
  const pageNumbers = pages.slice(1).map((p) => p.children.find((c) => c.className === "print-page-number").textContent);
  assert.deepEqual(pageNumbers, ["2", "3", "4", "5"]);
}

/* ---------- #facing-pages-checkbox: keep multi-page songs on facing pages, normal print (SPEC.md §13) ---------- */

{
  // A single-page song (Song A) followed by a two-page one (Song B, via
  // one {new_page} directive) — Song A's own page (2, already even) needs
  // no alignment (single-page songs are always skipped — alignSongStart's
  // own comment), but it leaves Song B's naive start (3) odd, which *does*
  // need a blank page in front of it so Song B's own two pages land as a
  // true facing-page spread. Checked by default (the real markup's own
  // `checked` attribute — this fake DOM mirrors that specifically for this
  // one element, see fakeDocument's own comment), so no explicit
  // opt-in needed here.
  const { doc, elements } = fakeDocument({
    "@graph": [
      { "@id": "a.cho.txt", "@type": "MusicComposition", name: "Song A", text: "{title: Song A}\n\n[C]Verse" },
      {
        "@id": "b.cho.txt", "@type": "MusicComposition", name: "Song B",
        text: "{title: Song B}\n\n[D]First\n{new_page}\n[E]Second",
      },
    ],
  });
  initSongbookApp(doc, fakeWindow());
  elements["print-book-button"].click();

  // 1 front page + Song A's 1 page + 1 blank + Song B's 2 pages = 5.
  assert.equal(elements["print-content"].children.length, 5);
  const [frontPage, songA, blankPage, songBP1, songBP2] = elements["print-content"].children;
  assert.ok(blankPage.className.includes("print-page-blank"));
  assert.equal(blankPage.children.find((c) => c.className === "print-page-number"), undefined);
  assert.equal(songA.printSongTitleElement.textContent, "Song A");
  assert.equal(songBP1.printSongTitleElement.textContent, "Song B");

  const tocEntries = frontPage.children[2].children;
  assert.equal(tocEntries[0].children[1].textContent, "2"); // Song A
  assert.equal(tocEntries[1].children[1].textContent, "4"); // Song B: pages 4-5, not 3-4

  const pageNumbers = [songA, songBP1, songBP2].map(
    (p) => p.children.find((c) => c.className === "print-page-number").textContent,
  );
  assert.deepEqual(pageNumbers, ["2", "4", "5"]);
}

{
  // Same book, unchecked — Song B starts wherever it naturally falls (3,
  // odd), no blank page inserted at all.
  const { doc, elements } = fakeDocument({
    "@graph": [
      { "@id": "a.cho.txt", "@type": "MusicComposition", name: "Song A", text: "{title: Song A}\n\n[C]Verse" },
      {
        "@id": "b.cho.txt", "@type": "MusicComposition", name: "Song B",
        text: "{title: Song B}\n\n[D]First\n{new_page}\n[E]Second",
      },
    ],
  });
  initSongbookApp(doc, fakeWindow());
  elements["facing-pages-checkbox"].checked = false;
  elements["print-book-button"].click();

  // 1 front page + Song A's 1 page + Song B's 2 pages = 4 — no blank.
  assert.equal(elements["print-content"].children.length, 4);
  const tocEntries = elements["print-content"].children[0].children[2].children;
  assert.equal(tocEntries[0].children[1].textContent, "2"); // Song A
  assert.equal(tocEntries[1].children[1].textContent, "3"); // Song B: pages 3-4
}

{
  // Unaffected by large print's own checkbox being on at the same time —
  // both are independent settings, checked together here to confirm large
  // print doesn't bypass this one (or vice versa).
  const { doc, elements } = fakeDocument({
    "@graph": [
      { "@id": "a.cho.txt", "@type": "MusicComposition", name: "Song A", text: "{title: Song A}\n\n[C]Verse" },
      { "@id": "b.cho.txt", "@type": "MusicComposition", name: "Song B", text: "{title: Song B}\n\n[D]Verse" },
    ],
  });
  initSongbookApp(doc, fakeWindow());
  elements["large-print-checkbox"].checked = true;
  elements["facing-pages-checkbox"].checked = false;
  elements["print-book-button"].click();

  // Large print's own two-pages-per-song is unaffected by unchecking
  // facing-pages — that's a per-song variability concern (alignSongStart's
  // own comment) that large print doesn't have in the first place (every
  // song is always exactly two pages here), not something this checkbox
  // controls the *count* of.
  assert.equal(elements["print-content"].children.length, 5); // 1 front + 2 songs * 2 pages
}

/* ---------- large print: every song on two pages, aligned to facing spreads (SPEC.md §13) ---------- */

{
  // Standalone single-song print (no book/contents page) — just two pages,
  // no page numbers either way (same reasoning as the non-large-print
  // case), the second carrying a "(continued)" note the first doesn't.
  const { doc, elements } = fakeDocument(CRATE_JSON);
  initSongbookApp(doc, fakeWindow());
  songLink(elements, 0).click(); // Amazing Grace
  elements["large-print-checkbox"].checked = true;
  elements["large-print-checkbox"].dispatch("change");
  elements["print-song-button"].click();

  assert.equal(elements["print-content"].children.length, 2);
  const [page1, page2] = elements["print-content"].children;
  assert.equal(page1.printSongTitleElement.textContent, "Amazing Grace");
  assert.equal(page2.printSongTitleElement.textContent, "Amazing Grace");
  assert.equal(page1.printContinuedNoteElement, null);
  assert.equal(page2.printContinuedNoteElement.textContent, "(continued)");
  assert.equal(page1.children.find((c) => c.className === "print-page-number"), undefined);
  assert.equal(page2.children.find((c) => c.className === "print-page-number"), undefined);

  // fitLargePrintSongPages sets font-size on *printSongBodyContent*, the
  // container it actually walks/measures — .print-song-body itself is
  // never touched at all now (no clip, no offset — page 2 only ever gets
  // whatever nodes page 1 didn't keep, moved there directly, so there's
  // nothing left over to clip in the first place).
  assert.ok(isFittedFontSize(page1.printSongBodyContent.style.fontSize));
  assert.equal(page1.printSongBodyContent.style.fontSize, page2.printSongBodyContent.style.fontSize);
  assert.equal(page1.printSongBody.style.overflow, undefined);
  assert.equal(page1.printSongBody.style.height, undefined);
  // The real split (trySplit, walking printSongBodyContent's own top-level
  // children to find the largest prefix that fits without cutting one in
  // half, then moving whatever's left onto page 2) can't be exercised
  // here — this fake DOM's own .innerHTML setter never populates a real
  // .children tree from the string it's given (this file's own header
  // comment), so printSongBodyContent.children is always empty for a
  // dynamically-built print page, regardless of what its .innerHTML was
  // set to. With nothing to walk, there's nothing to move either — both
  // pages' own printSongBodyContent.children stay empty, a safe (if not
  // useful, for this specific test) no-op rather than a crash. Confirming
  // the boundary-walking itself avoids a bad cut is a real-browser
  // concern (SPEC.md §13), same as this suite's other layout caveats.
  assert.equal(page1.printSongBodyContent.children.length, 0);
  assert.equal(page2.printSongBodyContent.children.length, 0);
}

{
  // A song already split into sections at the source (ChordPro's own
  // {new_page} directive) — large print gives *each* section its own
  // two-page spread, rather than joining every section into one bigger
  // one the way normal print does (buildSongPrintPage's own
  // body.innerHTML = rendered.pages.join("\n")). Two {new_page}-separated
  // sections means two independent spreads: 4 physical pages, not 2.
  const { doc, elements } = fakeDocument({
    "@graph": [{
      "@id": "medley.cho.txt", "@type": "MusicComposition", name: "Medley",
      text: "{title: Medley}\n\n[C]First section\n{new_page}\n[D]Second section\n{new_page}\n[E]Third section",
    }],
  });
  initSongbookApp(doc, fakeWindow());
  songLink(elements, 0).click();
  elements["large-print-checkbox"].checked = true;
  elements["large-print-checkbox"].dispatch("change");
  elements["print-song-button"].click();

  // 3 sections * 2 pages each = 6 — not the flat 2 a fixed-pages-per-song
  // assumption would have produced.
  assert.equal(elements["print-content"].children.length, 6);
  const [s1p1, s1p2, s2p1, s2p2, s3p1, s3p2] = elements["print-content"].children;

  // Each section only carries its own material, not the whole song joined
  // — s1p1 (or its own continuation, s1p2) never sees section 2 or 3's
  // text, and vice versa.
  assert.ok(s1p1.printSongBodyContent.innerHTML.includes('<span class="inlineChord">[C]</span>'));
  assert.ok(!s1p1.printSongBodyContent.innerHTML.includes("Second section"));
  assert.ok(s2p1.printSongBodyContent.innerHTML.includes('<span class="inlineChord">[D]</span>'));
  assert.ok(!s2p1.printSongBodyContent.innerHTML.includes("First section"));
  assert.ok(s3p1.printSongBodyContent.innerHTML.includes('<span class="inlineChord">[E]</span>'));

  // "(continued)" only on the *second* page of each section's own pair —
  // a new {new_page} section starts fresh, not as a continuation of the
  // section before it.
  assert.equal(s1p1.printContinuedNoteElement, null);
  assert.equal(s1p2.printContinuedNoteElement.textContent, "(continued)");
  assert.equal(s2p1.printContinuedNoteElement, null);
  assert.equal(s2p2.printContinuedNoteElement.textContent, "(continued)");
  assert.equal(s3p1.printContinuedNoteElement, null);
  assert.equal(s3p2.printContinuedNoteElement.textContent, "(continued)");

  // No page numbers here either (standalone print, same as the single-
  // section case above), but each pair is still independently fitted —
  // three sections, three separate searches (even though this fake DOM's
  // own lack of real content measurement, see the single-section test's
  // own comment, means they land on the same value here).
  assert.ok(isFittedFontSize(s1p1.printSongBodyContent.style.fontSize));
  assert.ok(isFittedFontSize(s2p1.printSongBodyContent.style.fontSize));
  assert.ok(isFittedFontSize(s3p1.printSongBodyContent.style.fontSize));
}

{
  // The same {new_page} accounting inside a whole-book print — a
  // multi-section song's own page numbers advance by its own actual page
  // count (2 sections * 2 = 4 here), not a flat 2, so the *next* song's
  // number still comes out correctly.
  const { doc, elements } = fakeDocument({
    "@graph": [
      {
        "@id": "medley.cho.txt", "@type": "MusicComposition", name: "Medley",
        text: "{title: Medley}\n\n[C]First\n{new_page}\n[D]Second",
      },
      { "@id": "b.cho.txt", "@type": "MusicComposition", name: "Song B", text: "{title: Song B}\n\n[E]Verse" },
    ],
  });
  initSongbookApp(doc, fakeWindow());
  elements["large-print-checkbox"].checked = true;
  elements["print-book-button"].click();

  // 1 front page + Medley's 4 pages + Song B's 2 pages = 7.
  assert.equal(elements["print-content"].children.length, 7);
  const tocEntries = elements["print-content"].children[0].children[2].children;
  assert.equal(tocEntries[0].children[1].textContent, "2"); // Medley: pages 2-5
  assert.equal(tocEntries[1].children[1].textContent, "6"); // Song B: pages 6-7
}

{
  // Whole-book print, large print on — front matter is 1 page (2 songs,
  // well under TOC_SPLIT_THRESHOLD), so 1 + 1 = 2 is already even: the
  // first song lands straight on page 2 (its own spread is 2-3) with no
  // blank filler page needed, matching PT's own example exactly.
  const { doc, elements } = fakeDocument(CRATE_JSON);
  initSongbookApp(doc, fakeWindow());

  elements["large-print-checkbox"].checked = true;
  elements["print-book-button"].click();

  // 1 front page + 2 songs * 2 pages each = 5. No blank filler page (see
  // above) — this count is the regression test for that.
  assert.equal(elements["print-content"].children.length, 5);
  const [frontPage, songOneP1, songOneP2, songTwoP1, songTwoP2] = elements["print-content"].children;

  // frontPage.children: [h1, "Contents" h2, <ol>, page-number] — no
  // subtitle here, since no instrument is selected (matching the
  // non-large-print whole-book test's own structure above).
  const tocEntries = frontPage.children[2].children;
  assert.equal(tocEntries[0].children[1].textContent, "2"); // Amazing Grace: pages 2-3
  assert.equal(tocEntries[1].children[1].textContent, "4"); // Universe: pages 4-5

  assert.equal(songOneP1.printSongTitleElement.textContent, "Amazing Grace");
  assert.equal(songOneP2.printContinuedNoteElement.textContent, "(continued)");
  const songOneP1Number = songOneP1.children.find((c) => c.className === "print-page-number");
  const songOneP2Number = songOneP2.children.find((c) => c.className === "print-page-number");
  assert.equal(songOneP1Number.textContent, "2");
  assert.equal(songOneP2Number.textContent, "3");
  const songTwoP1Number = songTwoP1.children.find((c) => c.className === "print-page-number");
  assert.equal(songTwoP1Number.textContent, "4");

  // Unchecking and rebuilding goes straight back to one page per song —
  // the checkbox's own change handler re-invokes currentPrintRebuild(), the
  // same way #print-instrument-select's does.
  elements["large-print-checkbox"].checked = false;
  elements["large-print-checkbox"].dispatch("change");
  assert.equal(elements["print-content"].children.length, 3); // 1 front + 2 songs
}

{
  // A front-matter page *count* that's itself even (2 contents pages, for
  // more than TOC_SPLIT_THRESHOLD entries) makes the naive first-song page
  // (1 + 2 = 3) odd — large print's own alignment then has to insert one
  // blank filler page to push the first song from 3 to 4, an even start.
  const manySongs = Array.from({ length: 51 }, (_, i) => ({
    "@id": `song-${String(i).padStart(2, "0")}.cho.txt`, "@type": "MusicComposition",
    name: `Song ${String(i).padStart(2, "0")}`, text: `{title: Song ${i}}\n\nJust words, no chords.`,
  }));
  const { doc, elements } = fakeDocument({ "@graph": manySongs });
  initSongbookApp(doc, fakeWindow());

  elements["large-print-checkbox"].checked = true;
  elements["print-book-button"].click();

  // 2 contents pages + 1 blank filler + 51 songs * 2 pages = 105.
  assert.equal(elements["print-content"].children.length, 105);
  const [tocPage1, tocPage2, blankPage, firstSongP1] = elements["print-content"].children;
  assert.ok(tocPage1.className.includes("print-toc"));
  assert.ok(tocPage2.className.includes("print-toc"));
  assert.ok(blankPage.className.includes("print-page-blank"));
  assert.equal(blankPage.children.find((c) => c.className === "print-page-number"), undefined);

  const firstEntryPageNumber = tocPage1.children[2].children[0].children[1];
  assert.equal(firstEntryPageNumber.textContent, "4");
  const firstSongP1Number = firstSongP1.children.find((c) => c.className === "print-page-number");
  assert.equal(firstSongP1Number.textContent, "4");
}

{
  // Setlist print, large print on, with the unresolved entry mixed in
  // (SETLIST_CRATE_JSON: exact, fuzzy, ambiguous, then unresolved — SPEC.md
  // §6.1) — the unresolved entry contributes no pages at all (large print
  // or not), so the three resolved entries still get page numbers two
  // apart, not four, and the unresolved one still shows "—", never a
  // made-up number.
  const { doc, elements } = fakeDocument(SETLIST_CRATE_JSON);
  initSongbookApp(doc, fakeWindow());
  elements["large-print-checkbox"].checked = true;
  setlistLink(elements, 0).click();
  elements["print-setlist-button"].click();

  // 1 front page + 3 resolved entries * 2 pages each = 7.
  assert.equal(elements["print-content"].children.length, 7);
  const [frontPage, pageA1, pageA2, pageB1, , pageC1] = elements["print-content"].children;
  assert.equal(frontPage.children[0].textContent, "Friday Gig");

  const tocEntries = frontPage.children[2].children;
  assert.equal(tocEntries[0].children[1].textContent, "2"); // Song A: pages 2-3
  assert.equal(tocEntries[1].children[1].textContent, "4"); // Song B (capo 2): pages 4-5
  assert.equal(tocEntries[2].children[1].textContent, "6"); // Songg A (ambiguous): pages 6-7
  assert.equal(tocEntries[3].children[1].textContent, "—"); // Unknown Song: unresolved

  assert.equal(pageA1.printSongTitleElement.textContent, "Song A");
  assert.equal(pageA2.printContinuedNoteElement.textContent, "(continued)");
  assert.equal(pageB1.printSongTitleElement.textContent, "Song B (capo 2)");
  // Song B is key C; capo 2 shifts it down to Bb — the entry's own
  // override, not whatever's currently selected on screen. Present in the
  // markup regardless of fitLargePrintSongPages' own clipping, which is
  // visual (CSS height/overflow) rather than a change to the content itself.
  assert.ok(pageB1.printSongBodyContent.innerHTML.includes('<span class="inlineChord">[Bb]</span>'));
  assert.equal(pageC1.printSongTitleElement.textContent, "Songg A");
}

{
  // No explicit sync code needed for this (unlike #print-instrument-select,
  // which currentInstrument keeps in sync across two different selects) —
  // a checkbox's own checked state is just never reset by leaving/
  // re-entering print mode, so it stays checked on its own.
  const { doc, elements } = fakeDocument(CRATE_JSON);
  initSongbookApp(doc, fakeWindow());

  elements["large-print-checkbox"].checked = true;
  elements["large-print-checkbox"].dispatch("change");
  elements["done-printing-button"].click();
  assert.equal(isHidden(elements["print-view"]), true);

  elements["print-book-button"].click();
  assert.equal(elements["large-print-checkbox"].checked, true);
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

  // The label lives in title/aria-label, not textContent — the button is a
  // fixed-size icon square (shared with prev/next/print), and full text as
  // textContent would wrap and overflow a box that small.
  assert.equal(elements["fullscreen-button"].title, "Full screen");
  assert.equal(elements["fullscreen-button"].getAttribute("aria-label"), "Full screen");

  elements["fullscreen-button"].click();
  assert.equal(doc.fullscreenElement, doc.documentElement);
  assert.equal(elements["fullscreen-button"].title, "Exit full screen");
  assert.equal(elements["fullscreen-button"].getAttribute("aria-label"), "Exit full screen");

  elements["fullscreen-button"].click();
  assert.equal(doc.fullscreenElement, null);
  assert.equal(elements["fullscreen-button"].title, "Full screen");
  assert.equal(elements["fullscreen-button"].getAttribute("aria-label"), "Full screen");
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
  assert.equal(isHidden(elements["prev-song-button"]), true);
  assert.equal(isHidden(elements["next-song-button"]), true);
  assert.equal(isHidden(elements["back-to-list-button"]), true);
  assert.equal(isHidden(elements["menu-bar-overflow"]), true);
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
  elements["app-bar"].offsetHeight = 60;

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
  elements["app-bar"].offsetHeight = 60;

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
  elements["app-bar"].offsetHeight = 60;

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
  elements["app-bar"].offsetHeight = 60;

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

/* ---------- fitSongHeaderTitle: keeps title/key/capo on one line (SPEC.md §12) ---------- */
// These tests model titleMeasurer's own scrollWidth as scaling with its
// font-size, which is what a *correct* measurement looks like — but this
// fake DOM has no real flex/layout engine at all, so it was never capable of
// reproducing the actual bug this file's own history is about: a real
// browser's #song-view-title (a flex item with flex-grow:1) reports a
// scrollWidth driven by flexbox's own box-width allocation, decoupled from
// its font-size or text — found only via real (headless-Chrome)
// measurement against real chart files, not this suite. That's why
// fitSongHeaderTitle measures on an off-flow clone (titleMeasurer) instead
// of #song-view-title itself; these tests check the resulting arithmetic is
// correct given a trustworthy width signal, not that #song-view-title's own
// scrollWidth would have been trustworthy — it isn't, which is the whole
// point of not reading it directly.

{
  // A very short song drives the body font-size all the way to its own
  // ceiling (80px — see the fitSongContent tests above) — 1.3x that (104)
  // would make the title dominate the page, so TITLE_MAX_FONT_PX (36) caps
  // it regardless of how much header width is actually available (2000px
  // here — plenty).
  const { doc, elements } = fakeDocument(CRATE_JSON);
  const content = elements["song-content"];
  const title = elements["song-view-title"];
  const header = elements["song-header"];
  content.clientWidth = 1000;
  Object.defineProperty(content, "scrollHeight", { get() { return (parseInt(content.style.fontSize) || 0) * 8; } });
  Object.defineProperty(content, "scrollWidth", { get() { return (parseInt(content.style.fontSize) || 0) * 3; } });
  elements["app-bar"].offsetHeight = 60;
  header.clientWidth = 2000;

  const win = fakeWindow({ innerHeight: 800 }); // body settles at 80px (see fitSongContent tests)
  initSongbookApp(doc, win);
  // titleMeasurer only exists once initSongbookApp has run — see
  // fitSongHeaderTitle's own comment on why the *title element's* own
  // scrollWidth isn't what's measured (it's a flex item; its scrollWidth
  // reflects flexbox's own box-width allocation, not its text).
  const measurer = header.children.find((c) => c.className === "title-measurer");
  Object.defineProperty(measurer, "scrollWidth", { get() { return (parseInt(measurer.style.fontSize) || 0) * 5; } });
  songLink(elements, 0).click(); // Amazing Grace — has chords, so key/capo are shown

  assert.equal(content.style.fontSize, "80px");
  assert.equal(title.style.fontSize, "36px"); // TITLE_MAX_FONT_PX, not 80 * 1.3 (104)
}

{
  // The bug this function's own comment documents: a *long* song (lots of
  // lyrics, forcing the body font-size all the way down to FIT_MIN_FONT_PX,
  // 10px here) used to collapse the title's own ceiling to exactly
  // TITLE_MIN_FONT_PX too (`min(36, max(16, 10 * 1.3=13))` = 16, since
  // `max(16, 13)` pulls it back up to the floor) — forcing a tiny title even
  // with a huge, mostly-empty header (2000px here) that had plenty of room
  // for a much bigger one. The fix: the title's own ceiling is now a flat
  // TITLE_MAX_FONT_PX regardless of the body's own font-size, so with this
  // much header width free, it settles at the real ceiling (36px), not the
  // floor.
  const { doc, elements } = fakeDocument(CRATE_JSON);
  const content = elements["song-content"];
  const title = elements["song-view-title"];
  const header = elements["song-header"];
  const keySelect = elements["key-select"];
  const capoSelect = elements["capo-select"];
  content.clientWidth = 1000;
  // A huge multiplier stands in for "lots of lyrics text" — even at
  // FIT_MIN_FONT_PX (10px) this still exceeds any reasonable available
  // height, so the body's own binary search settles at the floor.
  Object.defineProperty(content, "scrollHeight", { get() { return (parseInt(content.style.fontSize) || 0) * 1000; } });
  Object.defineProperty(content, "scrollWidth", { get() { return (parseInt(content.style.fontSize) || 0) * 3; } });
  elements["app-bar"].offsetHeight = 60;
  header.clientWidth = 2000;
  keySelect.offsetWidth = 30;
  capoSelect.offsetWidth = 25;

  const win = fakeWindow({ innerHeight: 800 });
  initSongbookApp(doc, win);
  const measurer = header.children.find((c) => c.className === "title-measurer");
  Object.defineProperty(measurer, "scrollWidth", { get() { return (parseInt(measurer.style.fontSize) || 0) * 4; } });
  songLink(elements, 0).click();

  assert.equal(content.style.fontSize, "10px"); // FIT_MIN_FONT_PX
  assert.equal(title.style.fontSize, "36px"); // TITLE_MAX_FONT_PX — not 16, the old bug's result
}

{
  // A more modest body font-size (20px) and a header too narrow for the
  // title at that size once key/capo's own reserved width is taken into
  // account: the title has to shrink to keep all three on one line, landing
  // on a real binary-search result (20px, well within TITLE_MIN_FONT_PX..
  // TITLE_MAX_FONT_PX) rather than either boundary — a case where *width*,
  // not the ceiling, is what actually binds.
  const { doc, elements } = fakeDocument(CRATE_JSON);
  const content = elements["song-content"];
  const title = elements["song-view-title"];
  const header = elements["song-header"];
  const keySelect = elements["key-select"];
  const capoSelect = elements["capo-select"];
  content.clientWidth = 1000; // wide enough that width never binds the body fit
  Object.defineProperty(content, "scrollHeight", { get() { return (parseInt(content.style.fontSize) || 0) * 40; } });
  Object.defineProperty(content, "scrollWidth", { get() { return (parseInt(content.style.fontSize) || 0) * 3; } });
  elements["app-bar"].offsetHeight = 0;
  header.clientWidth = 160;
  keySelect.offsetWidth = 30;
  capoSelect.offsetWidth = 25;

  const win = fakeWindow({ innerHeight: 800 }); // 20 * 40 = 800 <= 800; 21 * 40 = 840 > 800
  initSongbookApp(doc, win);
  const measurer = header.children.find((c) => c.className === "title-measurer");
  Object.defineProperty(measurer, "scrollWidth", { get() { return (parseInt(measurer.style.fontSize) || 0) * 4; } });
  songLink(elements, 0).click();
  assert.equal(content.style.fontSize, "20px");

  // ceiling is the flat TITLE_MAX_FONT_PX (36); reserved = 30 + 25 +
  // (20 * 0.6) * 2 = 79; available = 160 - 79 = 81. Largest fontPx (16..36)
  // with fontPx * 4 <= 81 is 20 (80 <= 81, 84 > 81) — width binds well
  // before the ceiling would.
  assert.equal(title.style.fontSize, "20px");
}

{
  // A header too narrow for the title at *any* size, even TITLE_MIN_FONT_PX
  // (16px) — settles on that floor rather than shrinking further into
  // unreadable territory (SPEC.md §12); a real page relies on
  // #song-view-title's own ellipsis CSS to make this look intentional
  // rather than broken.
  const { doc, elements } = fakeDocument(CRATE_JSON);
  const content = elements["song-content"];
  const title = elements["song-view-title"];
  const header = elements["song-header"];
  const keySelect = elements["key-select"];
  const capoSelect = elements["capo-select"];
  content.clientWidth = 1000;
  Object.defineProperty(content, "scrollHeight", { get() { return (parseInt(content.style.fontSize) || 0) * 8; } });
  Object.defineProperty(content, "scrollWidth", { get() { return (parseInt(content.style.fontSize) || 0) * 3; } });
  elements["app-bar"].offsetHeight = 60;
  header.clientWidth = 50; // already less than key/capo's own reserved width
  keySelect.offsetWidth = 60;
  capoSelect.offsetWidth = 50;

  const win = fakeWindow({ innerHeight: 800 });
  initSongbookApp(doc, win);
  const measurer = header.children.find((c) => c.className === "title-measurer");
  Object.defineProperty(measurer, "scrollWidth", { get() { return (parseInt(measurer.style.fontSize) || 0) * 4; } });
  songLink(elements, 0).click();

  assert.equal(title.style.fontSize, "16px"); // TITLE_MIN_FONT_PX, not lower
}

{
  // Song-list rows: a composer/performer/subtitle credit line — composer
  // preferred, then performer, then subtitle, never more than one at once —
  // plus the song's own key, both omitted entirely when a song has neither
  // (SPEC.md §12's "Credit line and key in list rows"). Both live inside the
  // row's own <a> (appendListCredit), so the whole row stays one clickable
  // target — checked by class name, not position, since which of
  // credit/key a given song has varies.
  const { doc, elements } = fakeDocument(CREDIT_CRATE_JSON);
  initSongbookApp(doc, fakeWindow());

  // Sorted alphabetically by name: All Three, Composer Only, No Credit No
  // Key, Performer Only, Subtitle Only.
  const rows = elements["song-list"].children;
  assert.equal(rows.length, 5);

  function creditAndKey(row) {
    const link = row.children[0];
    const credit = link.children.find((c) => c.className === "list-credit");
    const key = link.children.find((c) => c.className === "list-key");
    return { credit: credit ? credit.textContent : null, key: key ? key.textContent : null };
  }

  assert.deepEqual(creditAndKey(rows[0]), { credit: "Comp Erson", key: null }); // All Three — composer wins over performer/subtitle
  assert.deepEqual(creditAndKey(rows[1]), { credit: "Hank Williams", key: "C" }); // Composer Only
  assert.deepEqual(creditAndKey(rows[2]), { credit: null, key: null }); // No Credit No Key
  assert.deepEqual(creditAndKey(rows[3]), { credit: "Richard Thompson", key: null }); // Performer Only
  assert.deepEqual(creditAndKey(rows[4]), { credit: "a lullaby", key: null }); // Subtitle Only
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

  // Set 1 heading, entry 1 (exact — key only, no status badge, no notes),
  // entry 2 (fuzzy — key, status badge, and notes), Set 2 heading, entry 3
  // (ambiguous — still a link and still shows a key, since matchEntryToSong
  // resolves it to a first-candidate song even though it isn't a clean
  // match), entry 4 (unresolved — no song to link to or pull a key from,
  // plain text). Neither song-a.cho.txt nor song-b.cho.txt has a
  // composer/performer/subtitle of its own (SETLIST_CRATE_JSON), so every
  // resolved entry's own credit line (SPEC.md §12) is absent here — that's
  // covered on its own, independent of setlists entirely, by the
  // CREDIT_CRATE_JSON test above.
  const rows = elements["setlist-entries"].children;
  assert.equal(rows.length, 6);

  assert.equal(rows[0].className, "setlist-set-name");
  assert.equal(rows[0].textContent, "Set 1");

  const entry1 = rows[1];
  assert.equal(entry1.children.length, 3); // position, name, key — no status, no notes
  assert.equal(entry1.children[1].textContent, "Song A");
  assert.equal(entry1.children[1].href, "#"); // a real link — entry.songIndex >= 0
  assert.equal(entry1.children[2].className, "list-key");
  assert.equal(entry1.children[2].textContent, "G"); // song-a.cho.txt's own {key}

  const entry2 = rows[2];
  assert.equal(entry2.children.length, 5); // position, name, key, status, notes
  assert.equal(entry2.children[1].textContent, "Song B (capo 2)");
  assert.equal(entry2.children[2].textContent, "C"); // song-b.cho.txt's own {key} — not the entry's capo:2 override
  // The status mark is a small "~", not the message itself (SPEC.md §11) —
  // the full text lives in `title`, a native hover/focus tooltip.
  assert.equal(entry2.children[3].textContent, "~");
  assert.ok(entry2.children[3].title.includes("matched approximately"));
  // Rendered as Markdown (SPEC.md §6.2), via real DOM nodes rather than an
  // HTML string (renderNoteMarkdown's own comment on why) — a single line
  // with no special syntax becomes one plain <p>.
  assert.equal(entry2.children[4].children.length, 1);
  assert.equal(entry2.children[4].children[0].tagName, "P");
  assert.equal(collectText(entry2.children[4]), "Play slow and quiet");
  assert.equal(isHidden(entry2.children[4]), false); // notesVisible starts true

  assert.equal(rows[3].className, "setlist-set-name");
  assert.equal(rows[3].textContent, "Set 2");

  const entry3 = rows[4];
  assert.equal(entry3.children.length, 4); // position, name (still a link), key, status
  assert.ok(entry3.children[1].href !== undefined); // <a>, not <span> — songIndex >= 0
  assert.equal(entry3.children[2].textContent, "G"); // resolved to song-a.cho.txt, same as entry 1
  assert.equal(entry3.children[3].textContent, "~");
  assert.ok(entry3.children[3].title.includes("matches more than one song"));

  const entry4 = rows[5];
  assert.equal(entry4.children.length, 3); // position, name (plain, no song to link to), status — no key
  assert.equal(entry4.children[1].href, undefined); // <span> — songIndex === -1
  assert.equal(entry4.children[2].textContent, "~");
  assert.ok(entry4.children[2].title.includes("no matching song found"));
}

{
  // A "#" set's own freeform note (SPEC.md §6/§6.2) — chordpro_crate.js's
  // description on the nested set entity — renders as a .setlist-set-notes
  // element right after that set's "Set N" heading, before its first entry.
  const { doc, elements } = fakeDocument(SET_NOTES_CRATE_JSON);
  initSongbookApp(doc, fakeWindow());
  setlistLink(elements, 0).click();

  const rows = elements["setlist-entries"].children;
  assert.equal(rows.length, 3); // "Set 1" heading, its note, then the one entry
  assert.equal(rows[0].className, "setlist-set-name");
  assert.equal(rows[0].textContent, "Set 1");
  assert.equal(rows[1].className, "setlist-set-notes");
  // Rendered as Markdown (SPEC.md §6.2) via real DOM nodes — a single plain
  // line becomes one <p>.
  assert.equal(rows[1].children.length, 1);
  assert.equal(rows[1].children[0].tagName, "P");
  assert.equal(collectText(rows[1]), "Tune guitars to drop D now.");
  assert.equal(rows[2].className, "setlist-entry");
  assert.equal(rows[2].children[1].textContent, "Song A");

  // Not treated as a search target — "Find in this setlist" leaves it
  // shown regardless of the query, the same as the heading above it.
  elements["setlist-entries-search"].value = "nothing matches this";
  elements["setlist-entries-search"].dispatch("input");
  assert.equal(isHidden(rows[0]), false);
  assert.equal(isHidden(rows[1]), false);
  assert.equal(isHidden(rows[2]), true);
}

{
  // renderNoteMarkdown's actual block/inline parsing (SPEC.md §6.2) — a set
  // note with a paragraph followed by a numbered list, and an entry note
  // with a blockquote containing **bold** — the same shapes the real
  // sample.setlist.md now uses, not just the single-plain-line case above.
  const { doc, elements } = fakeDocument(RICH_NOTES_CRATE_JSON);
  initSongbookApp(doc, fakeWindow());
  setlistLink(elements, 0).click();

  const rows = elements["setlist-entries"].children;
  const setNotes = rows[1]; // "Set 1" heading is rows[0]
  assert.equal(setNotes.className, "setlist-set-notes");
  assert.equal(setNotes.children.length, 2); // one <p>, then one <ol>
  assert.equal(setNotes.children[0].tagName, "P");
  assert.equal(collectText(setNotes.children[0]), "This is our last gig so make it a good one");
  assert.equal(setNotes.children[1].tagName, "OL");
  assert.equal(setNotes.children[1].children.length, 2);
  assert.equal(setNotes.children[1].children[0].tagName, "LI");
  assert.equal(collectText(setNotes.children[1].children[0]), "No spitting!");
  assert.equal(collectText(setNotes.children[1].children[1]), "Not too much fighting");

  const entryNotes = rows[2].children.find((c) => c.className === "setlist-entry-notes");
  assert.ok(entryNotes, "expected the entry's own notes element");
  assert.equal(entryNotes.children.length, 1); // both ">"-prefixed lines flatten into one blockquote
  assert.equal(entryNotes.children[0].tagName, "BLOCKQUOTE");
  const quoteLines = entryNotes.children[0].children;
  assert.equal(quoteLines.length, 2);
  assert.equal(quoteLines[0].tagName, "P");
  assert.equal(collectText(quoteLines[0]), "Play with a lively feel, start with a manic synth solo!");
  // "**that**" actually renders as emphasis now, not literal asterisks.
  assert.equal(collectText(quoteLines[1]), "But not that lively!");
  const bold = quoteLines[1].children.find((c) => c.tagName === "STRONG");
  assert.ok(bold, "expected a <strong> element for **that**");
  assert.equal(bold.textContent, "that");
}

{
  // A modal over the song itself, shown when opening it from within a
  // setlist (SPEC.md §6.2) — PT: "put up a modal over the song with the
  // notes on it eg 'Tune guitars to drop D now' - any click on that should
  // make it go away, and add a checkbox in the menu bar to show/not show
  // notes". Uses RICH_NOTES_CRATE_JSON's own entry, which has a note.
  const { doc, elements } = fakeDocument(RICH_NOTES_CRATE_JSON);
  initSongbookApp(doc, fakeWindow());

  // Opening a song from the *global* list never shows it, and the checkbox
  // controlling it stays hidden too — there's no entry, and so no note, in
  // that context at all.
  songLink(elements, 0).click();
  assert.equal(isHidden(elements["setlist-notes-label"]), true);
  assert.equal(isHidden(elements["setlist-note-modal"]), true);

  // Opening the same underlying song from within the setlist that performs
  // it does show it, checkbox included.
  setlistLink(elements, 0).click(); // into "Friday Gig"
  const entryLink = elements["setlist-entries"].children[2].children[1]; // Slot Machine Baby's own row
  entryLink.click();
  assert.equal(isHidden(elements["setlist-notes-label"]), false);
  assert.equal(isHidden(elements["setlist-note-modal"]), false);
  assert.equal(
    collectText(elements["setlist-note-modal-content"]),
    "Play with a lively feel, start with a manic synth solo!But not that lively!",
  );

  // "Any click on that should make it go away" (PT) — the whole modal is
  // the dismiss target.
  elements["setlist-note-modal"].click();
  assert.equal(isHidden(elements["setlist-note-modal"]), true);

  // Unchecking "Show notes" hides an already-open modal immediately, not
  // just from the next song opened.
  entryLink.click();
  assert.equal(isHidden(elements["setlist-note-modal"]), false);
  elements["setlist-notes-checkbox"].checked = false;
  elements["setlist-notes-checkbox"].dispatch("change");
  assert.equal(isHidden(elements["setlist-note-modal"]), true);

  // And stays off — re-opening a song with a note doesn't show it again
  // while the checkbox is unchecked.
  entryLink.click();
  assert.equal(isHidden(elements["setlist-note-modal"]), true);

  // Leaving the song view closes it too, so it can't linger, fixed open,
  // over an unrelated view.
  elements["setlist-notes-checkbox"].checked = true;
  elements["setlist-notes-checkbox"].dispatch("change");
  entryLink.click();
  assert.equal(isHidden(elements["setlist-note-modal"]), false);
  elements["back-to-list-button"].click();
  assert.equal(isHidden(elements["setlist-note-modal"]), true);
}

{
  // "Find a setlist" (#setlist-search) — same filtering idea as "Find a
  // song" (#song-search) above, against #setlist-list's own rows.
  const { doc, elements } = fakeDocument(TWO_SETLISTS_CRATE_JSON);
  initSongbookApp(doc, fakeWindow());
  elements["view-setlists-button"].click();
  assert.equal(elements["setlist-list"].children.length, 2);

  elements["setlist-search"].value = "friday";
  elements["setlist-search"].dispatch("input");
  assert.equal(isHidden(elements["setlist-list"].children[0]), false); // Friday Gig
  assert.equal(isHidden(elements["setlist-list"].children[1]), true); // Saturday Session

  elements["setlist-search"].value = "SESSION"; // case-insensitive
  elements["setlist-search"].dispatch("input");
  assert.equal(isHidden(elements["setlist-list"].children[0]), true);
  assert.equal(isHidden(elements["setlist-list"].children[1]), false);

  elements["setlist-search"].value = "";
  elements["setlist-search"].dispatch("input");
  assert.equal(isHidden(elements["setlist-list"].children[0]), false);
  assert.equal(isHidden(elements["setlist-list"].children[1]), false);
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
  assert.ok(elements["song-pages"].innerHTML.includes('<span class="inlineChord">[Bb]</span>'));
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
  assert.ok(elements["song-pages"].innerHTML.includes('<span class="inlineChord">[Bb]</span>'));

  elements["next-song-button"].click(); // -> Song A again (the ambiguous entry also resolved to it)
  assert.equal(elements["song-view-title"].textContent, "Song A");
  // No override on the ambiguous entry — back to Song A's own key (G), not
  // Bb-via-capo-2 left over from the entry before it.
  assert.ok(elements["song-pages"].innerHTML.includes('<span class="inlineChord">[G]</span>'));
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
  // children[4]: position, name, key, status, notes (entry 2's own key —
  // SPEC.md §12 — pushes notes one slot later than it would sit without it).
  assert.equal(isHidden(elements["setlist-entries"].children[2].children[4]), true);

  elements["toggle-notes-button"].click();
  assert.equal(elements["toggle-notes-button"].textContent, "Hide notes");
  assert.equal(isHidden(elements["setlist-entries"].children[2].children[4]), false);
}

{
  // "Find in this setlist" (#setlist-entries-search) — filters entry rows
  // by substring match against name, credit, and notes (whatever
  // buildSetlistEntryRow stashed as that row's own searchText), while the
  // "Set 1"/"Set 2" heading rows (rows[0], rows[3]) stay visible regardless
  // — they have no searchText at all, which applySetlistEntriesFilter
  // treats as "never hide this".
  const { doc, elements } = fakeDocument(SETLIST_CRATE_JSON);
  initSongbookApp(doc, fakeWindow());
  setlistLink(elements, 0).click();
  const rows = elements["setlist-entries"].children;
  const search = elements["setlist-entries-search"];

  search.value = "song b";
  search.dispatch("input");
  assert.equal(isHidden(rows[0]), false); // "Set 1" heading — always shown
  assert.equal(isHidden(rows[1]), true); // Song A
  assert.equal(isHidden(rows[2]), false); // Song B (capo 2)
  assert.equal(isHidden(rows[3]), false); // "Set 2" heading — always shown
  assert.equal(isHidden(rows[4]), true); // Songg A
  assert.equal(isHidden(rows[5]), true); // Unknown Song

  // Matches the entry's own performance note too, not just its heading.
  search.value = "quiet";
  search.dispatch("input");
  assert.equal(isHidden(rows[2]), false); // Song B (capo 2) — "Play slow and quiet"
  assert.equal(isHidden(rows[1]), true);

  search.value = "";
  search.dispatch("input");
  assert.equal(isHidden(rows[1]), false);
  assert.equal(isHidden(rows[2]), false);

  // Survives a same-setlist re-render (toggling notes) — renderSetlistEntries
  // rebuilds every row, and would otherwise silently drop the filter.
  search.value = "song b";
  search.dispatch("input");
  elements["toggle-notes-button"].click();
  const rowsAfterToggle = elements["setlist-entries"].children;
  assert.equal(search.value, "song b"); // box itself untouched by the toggle
  assert.equal(isHidden(rowsAfterToggle[1]), true); // Song A — still filtered out
  assert.equal(isHidden(rowsAfterToggle[2]), false); // Song B (capo 2)

  // Re-opening a setlist — even the same one — clears the box and drops
  // the filter, unlike a same-setlist re-render (above): a leftover query
  // from a previous viewing isn't assumed still relevant.
  setlistLink(elements, 0).click();
  assert.equal(elements["setlist-entries-search"].value, "");
  const rowsAfterReopen = elements["setlist-entries"].children;
  assert.equal(isHidden(rowsAfterReopen[1]), false);
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
  assert.ok(pageB.printSongBodyContent.innerHTML.includes('<span class="inlineChord">[Bb]</span>'));
  assert.equal(pageC.printSongTitleElement.textContent, "Songg A");

  // "Done printing" returns to the setlist that was open, not the list —
  // exitPrintView() checks currentSetlistIndex specifically for this.
  elements["done-printing-button"].click();
  assert.equal(isHidden(elements["setlist-view"]), false);
  assert.equal(elements["setlist-view-title"].textContent, "Friday Gig");
}

/* ---------- "Include TOC and title page" checkbox (SPEC.md §13) ---------- */

{
  // Checked by default (the markup's own `checked` attribute) — unticking
  // it drops buildFrontMatterPages entirely from a whole-book print, and
  // the first song starts at page 1 instead of after a front-matter page.
  const { doc, elements } = fakeDocument(CRATE_JSON);
  initSongbookApp(doc, fakeWindow());
  elements["print-book-button"].click();
  assert.equal(elements["print-content"].children.length, 3); // front page + 2 songs

  elements["include-toc-checkbox"].checked = false;
  elements["include-toc-checkbox"].dispatch("change");
  assert.equal(elements["print-content"].children.length, 2); // just the 2 songs, no front matter
  const [pageA] = elements["print-content"].children;
  assert.equal(pageA.printSongTitleElement.textContent, "Amazing Grace");
}

{
  // Same toggle, scoped to a setlist print.
  const { doc, elements } = fakeDocument(SETLIST_CRATE_JSON);
  initSongbookApp(doc, fakeWindow());
  setlistLink(elements, 0).click();
  elements["print-setlist-button"].click();
  assert.equal(elements["print-content"].children.length, 4); // front page + 3 resolved entries

  elements["include-toc-checkbox"].checked = false;
  elements["include-toc-checkbox"].dispatch("change");
  assert.equal(elements["print-content"].children.length, 3); // just the 3 songs
}

/* ---------- floor sheets: old-school, chords-free setlist print (SPEC.md §13) ---------- */

{
  // The floor-sheet controls only ever make sense for a setlist print —
  // hidden for a single-song or whole-book print, along with large
  // print/facing pages/instrument selection and the TOC checkbox once
  // floor-sheet mode itself is switched on for a setlist.
  const { doc, elements } = fakeDocument(SETLIST_CRATE_JSON);
  initSongbookApp(doc, fakeWindow());

  elements["print-book-button"].click();
  assert.equal(isHidden(elements["floor-sheet-label"]), true);
  assert.equal(isHidden(elements["floor-sheet-notes-label"]), true);
  assert.equal(isHidden(elements["include-toc-label"]), false);

  setlistLink(elements, 0).click();
  elements["print-setlist-button"].click();
  assert.equal(isHidden(elements["floor-sheet-label"]), false);
  assert.equal(isHidden(elements["floor-sheet-notes-label"]), true); // floor-sheet-checkbox starts unticked
  assert.equal(isHidden(elements["include-toc-label"]), false);
  assert.equal(isHidden(elements["large-print-label"]), false);
  assert.equal(isHidden(elements["facing-pages-label"]), false);
  assert.equal(isHidden(elements["print-instrument-select"]), false);

  elements["floor-sheet-checkbox"].checked = true;
  elements["floor-sheet-checkbox"].dispatch("change");
  assert.equal(isHidden(elements["floor-sheet-notes-label"]), false);
  assert.equal(isHidden(elements["include-toc-label"]), true);
  assert.equal(isHidden(elements["large-print-label"]), true);
  assert.equal(isHidden(elements["facing-pages-label"]), true);
  assert.equal(isHidden(elements["print-instrument-select"]), true);
}

{
  // One page per "#" set, plus one further page for any entries before the
  // first set — every entry gets a line, resolved or not, since a floor
  // sheet lists names, not songs. "Include notes" starts unticked
  // (SPEC.md §13's own default reasoning matches includeTocCheckbox: on
  // for a normal print, but floor sheets default to bare names).
  const { doc, elements } = fakeDocument(FLOOR_SHEET_CRATE_JSON);
  initSongbookApp(doc, fakeWindow());
  setlistLink(elements, 0).click();
  elements["print-setlist-button"].click();
  elements["floor-sheet-checkbox"].checked = true;
  elements["floor-sheet-checkbox"].dispatch("change");

  const pages = elements["print-content"].children;
  assert.equal(pages.length, 2); // the ungrouped leading entry, then Set 1

  const [introPage, set1Page] = pages;
  assert.equal(introPage.className, "print-page print-floor-sheet");
  assert.equal(introPage.printFloorSheetTitleElement.tagName, "H1");
  assert.equal(introPage.printFloorSheetTitleElement.textContent, "Friday Gig"); // no setName of its own
  assert.equal(introPage.printFloorSheetListElement.tagName, "OL");
  assert.equal(introPage.printFloorSheetListElement.children.length, 1);
  assert.equal(introPage.printFloorSheetListElement.children[0].tagName, "LI");
  assert.equal(collectText(introPage.printFloorSheetListElement.children[0]), "Intro Song");

  assert.equal(set1Page.printFloorSheetTitleElement.textContent, "Set 1");
  const set1Items = set1Page.printFloorSheetListElement.children;
  assert.equal(set1Items.length, 2);
  // "Include notes" is checked by default (the markup's own `checked`
  // attribute) — entry-1's own note renders right under its name.
  assert.equal(set1Items[0].children.length, 2);
  assert.equal(set1Items[0].children[1].className, "print-floor-sheet-note");
  assert.equal(collectText(set1Items[0].children[1]), "Watch the tempo here");
  assert.equal(collectText(set1Items[0].children[0]), "Song A");
  // The unresolved entry ("Unknown Song", no specializationOf) still gets
  // a line, with no note element (it has none) — the one behaviour that
  // sets a floor sheet apart from every other print path in this file,
  // which all skip it entirely.
  assert.equal(set1Items[1].children.length, 1);
  assert.equal(collectText(set1Items[1]), "Unknown Song");
}

{
  // "Include notes" unticked — no note element at all, not just a hidden
  // one, even though entry-1 has its own text.
  const { doc, elements } = fakeDocument(FLOOR_SHEET_CRATE_JSON);
  initSongbookApp(doc, fakeWindow());
  setlistLink(elements, 0).click();
  elements["print-setlist-button"].click();
  elements["floor-sheet-checkbox"].checked = true;
  elements["floor-sheet-checkbox"].dispatch("change");
  elements["floor-sheet-notes-checkbox"].checked = false;
  elements["floor-sheet-notes-checkbox"].dispatch("change");

  const [, set1Page] = elements["print-content"].children;
  const set1Items = set1Page.printFloorSheetListElement.children;
  assert.equal(set1Items[0].children.length, 1);
  assert.equal(collectText(set1Items[0]), "Song A");
  assert.equal(set1Items[1].children.length, 1);
}

{
  // No "#" sets at all — a single page for the whole setlist, headed by
  // the setlist's own name (TWO_SETLISTS_CRATE_JSON's own setlists are
  // both flat, direct hasPart-to-entry — no set entities in the middle).
  const { doc, elements } = fakeDocument(TWO_SETLISTS_CRATE_JSON);
  initSongbookApp(doc, fakeWindow());
  setlistLink(elements, 0).click(); // "Friday Gig"
  elements["print-setlist-button"].click();
  elements["floor-sheet-checkbox"].checked = true;
  elements["floor-sheet-checkbox"].dispatch("change");

  assert.equal(elements["print-content"].children.length, 1);
  const [page] = elements["print-content"].children;
  assert.equal(page.printFloorSheetTitleElement.textContent, "Friday Gig");
  assert.equal(page.printFloorSheetListElement.children.length, 1);
  assert.equal(collectText(page.printFloorSheetListElement.children[0]), "Song A");
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
  assert.ok(html.includes('<input type="checkbox" id="large-print-checkbox"'));
  assert.ok(html.includes('<input type="checkbox" id="facing-pages-checkbox" checked'));
  assert.ok(html.includes('<input type="checkbox" id="include-toc-checkbox" checked'));
  assert.ok(html.includes('<input type="checkbox" id="floor-sheet-checkbox"'));
  assert.ok(html.includes('<input type="checkbox" id="floor-sheet-notes-checkbox" checked'));
  // "Done printing" is now a small close-button icon, positioned outside
  // #print-banner entirely (its own CSS comment) — SPEC.md §13's own
  // literal phrasing, "close button top right [x Done printing]" — rather
  // than one more inline text button in the banner's row of controls.
  assert.ok(html.includes('<button id="done-printing-button" type="button" title="Done printing"'));
  assert.ok(html.indexOf("done-printing-button") < html.indexOf('id="print-banner"'));
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
