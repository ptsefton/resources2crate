// Replicates chordprosite's output shape — a standalone HTML page carrying
// both the song data and the code that displays it, rendered client-side,
// not chordprosite's own implementation of that shape (concatenating its
// own source files as text; see chordprobook's own SPEC.md §1) — from the
// RO-Crate the chordpro-input plugin already built. See SPEC.md's
// "Songbook HTML output" and "UI" sections for the incremental plan this
// is a step of and for the navigation design this step adds: a clickable
// song list, a song view rendered with chordprobook's own renderSong(), a
// menu bar back to the list, and next/previous buttons at opposite screen
// edges.
//
// A separate plugin object from chordpro-input's own `plugin` (index.js) —
// deliberately: that one is registered in INPUT_PLUGINS (mutually
// exclusive, dispatched on ctx.options.inputMode); this one is registered
// in PLUGINS (additive, every entry's hooks run), tapping OUTPUT_WRITE
// alongside ro-crate-json-output/xlsx-output/html-output. Colocated in this
// same folder rather than a separate plugin directory since it only makes
// sense for, and only ever runs after, a chordpro-mode build.
//
// Reads the ro-crate-metadata.json this same build already wrote (via
// crate_index.js, not the `ro-crate` library — see that file's own header)
// rather than reaching into ctx.crate directly: a future standalone
// site-compiler will only ever have that written file to work from, not a
// live crate object, so building this against the same interface now keeps
// this code close to what that compiler will actually need. crate_index.js
// is used here only to count songs for the build log — the page's own
// client-side rendering (below) does not use it.
import { HOOKS } from "../hooks.js";
import { readJsonFromFolder, writeFile, fileExists } from "../../fs_helpers.js";
import { buildCrateIndex, entitiesOfType } from "./crate_index.js";
import {
  CHORDPROBOOK_BROWSER_BUNDLE,
  CHORDPROBOOK_INSTRUMENTS_DATA,
  CHORDPROBOOK_CHORD_DATA,
} from "./generated/chordprobook_browser_bundle.js";

const CRATE_FILE = "ro-crate-metadata.json";
// Exported so ro-crate-html-output/index.js can point its own chordpro-mode
// redirect page (ro-crate-preview.html) at this file's actual name, rather
// than a second, hand-kept-in-sync copy of the string.
export const OUTPUT_FILE = "songbook.html";

// A canonical Song entity, not a setlist-entry proxy — both are typed
// MusicComposition (chordpro-input's own SPEC.md §7). Told apart by
// specializationOf (PROV, not schema.org — but present in RO-Crate's own
// context regardless), the semantically correct relationship for this:
// an entry that resolved to a song genuinely *is* a specialization of it,
// so checking for that property's presence is a meaningful test, not an
// arbitrary flag — never checked by @id shape or by which of an entity's
// other properties happen to exist (this used to check for `text`, back
// when only a canonical Song ever had any — now that an entry's own
// performance note is *also* written as `text`, SPEC.md §6/§7, that check
// would misclassify any entry with a note as a canonical song).
// specializationOf alone isn't quite complete, though: an *unresolved*
// entry (chordpro_crate.js's own matchEntryToSong found no song at all —
// SPEC.md §6.1) has no specializationOf either, since there's genuinely
// nothing for it to specialize — common enough in real setlists to matter,
// not a hypothetical edge case. custom:matchStatus closes that gap: unlike
// specializationOf, chordpro_crate.js writes it unconditionally onto every
// entry regardless of resolution, and never onto a canonical Song, so it's
// a complete signal on its own for the one case specializationOf can't
// cover — not a fallback to id-sniffing, a second, equally real property.
// Used only for the build-log song count (see the module comment above) —
// the embedded client-side app (below) re-expresses this same test itself,
// inline, since it cannot import this function into the page.
function isCanonicalSong(entity) {
  return !("specializationOf" in entity) && !("custom:matchStatus" in entity);
}

// Guards against a literal "</script" inside the embedded JSON (e.g. in a
// song's own title or text) closing the <script> element early — the one
// thing embedding arbitrary JSON as literal text in HTML has to defend
// against, regardless of the script's `type`.
function escapeForInlineScript(jsonText) {
  return jsonText.replace(/<\/script/gi, "<\\/script");
}

// The page's whole client-side app: renders the song list, and switches to
// a song view — rendered with chordprobook's own ChordProSong/renderSong/
// Transposer/ChordDiagram, all four bare globals here because they're
// defined by CHORDPROBOOK_BROWSER_BUNDLE, concatenated into the page
// immediately before this function's own source (see renderSongbookHtml
// below and scripts/bundle-chordprobook-for-browser.mjs for why that has to
// be a build-time-generated bundle rather than a normal import) — on click,
// with a menu bar back to the list, next/previous buttons, key/capo
// dropdowns that re-render the current song transposed, and an instrument
// select that shows chord grids for whatever the song uses.
//
// Deliberately a plain function, taking `document`/`window` as parameters
// rather than reading the globals — embedded into the page via `.toString()`
// so there is exactly one copy of this logic to keep correct, not a
// hand-written string duplicating it; the parameters are what make it
// callable directly from a test with a fake `document`/`window`, and what
// the embedded call site passes the real ones to. `setTimeout`/`clearTimeout`
// (used by the resize handling below) are read as true globals rather than
// added as parameters for the same reason `Math`/`JSON` are not: they exist
// identically under Node and in a browser, so there is nothing environment-
// specific to inject.
//
// Deliberately self-contained: it must not reference anything from this
// module's own scope (imports, other functions here) — none of that exists
// any more once this function's source is the only part of the file that
// ends up in the page. It re-implements the "is this a canonical song"
// check inline for the same reason, rather than importing crate_index.js's
// equivalent.
export function initSongbookApp(document, window) {
  const crate = JSON.parse(document.getElementById("crate-data").textContent);
  const graph = Array.isArray(crate["@graph"]) ? crate["@graph"] : [];
  const asArray = (value) => (value === undefined || value === null ? [] : Array.isArray(value) ? value : [value]);

  // A minimal, dependency-free Markdown-ish renderer for setlist/set notes
  // (SPEC.md §6/§6.2) — these can be real Markdown (chordprosite's own
  // sample setlist already mixed blockquote syntax with **bold** — SPEC.md
  // §6), so rendering as plain textContent left "**that**" showing its own
  // literal asterisks rather than emphasis. Deliberately not a general
  // Markdown implementation: only what a setlist note actually uses —
  // paragraphs, blockquote lines ("> "/">> ", any depth flattened to one
  // level), numbered ("1. ") and bullet ("- "/"* ") lists, and inline
  // **bold**/*italic* — rather than embedding a full Markdown library into
  // a page that has to stay one dependency-free file, openable via file://.
  //
  // Builds real DOM nodes via createElement, appended directly into a given
  // container, rather than assembling an HTML string for .innerHTML — the
  // same reason buildFrontMatterPages (§13) builds its own table-of-contents
  // via createElement/textContent instead of a string of list-item markup:
  // this function's own source is embedded into the page via .toString(),
  // so an HTML-string template literal spelling out an actual tag would
  // leave that literal text sitting in the page's own embedded script —
  // indistinguishable, to a build-time check for "did anything get
  // pre-rendered", from the page actually shipping one. Using createElement
  // with a bare tag-name string instead avoids that entirely, and needs no
  // HTML-escaping of the note's own text either, since textContent is never
  // interpreted as markup to begin with.
  //
  // Works line by line rather than splitting on blank lines between
  // paragraphs: Setlist.js's own note-collection (chordprobook's
  // parseSetlist) already discards blank lines while joining a note's
  // non-blank ones with "\n" (SPEC.md §6), so by the time text reaches
  // here, a blank-line-separated paragraph and the list right after it are
  // already just adjacent lines with no blank line between them to split
  // on. A block boundary is instead wherever a line's own detected type
  // (blockquote/ordered-list/bullet-list/paragraph) changes from the line
  // before it — consecutive lines of the same type join into one block.
  function appendInlineMarkdown(parent, text) {
    for (const token of text.split(/(\*\*[^*]+\*\*|\*[^*]+\*)/).filter(Boolean)) {
      let tag = "span";
      let content = token;
      if (/^\*\*[^*]+\*\*$/.test(token)) { tag = "strong"; content = token.slice(2, -2); }
      else if (/^\*[^*]+\*$/.test(token)) { tag = "em"; content = token.slice(1, -1); }
      const el = document.createElement(tag);
      el.textContent = content;
      parent.appendChild(el);
    }
  }
  function renderNoteMarkdown(container, text) {
    container.replaceChildren();
    const lines = String(text ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
    let type = null;
    let blockElement = null; // the current paragraph/ordered-list/bullet-list/blockquote element, created fresh whenever type changes
    for (const line of lines) {
      let lineType, content;
      if (/^>+\s?/.test(line)) { lineType = "blockquote"; content = line.replace(/^>+\s?/, ""); }
      else if (/^\d+\.\s/.test(line)) { lineType = "ol"; content = line.replace(/^\d+\.\s/, ""); }
      else if (/^[-*]\s/.test(line)) { lineType = "ul"; content = line.replace(/^[-*]\s/, ""); }
      else { lineType = "p"; content = line; }

      if (lineType !== type) {
        type = lineType;
        blockElement = document.createElement(lineType);
        container.appendChild(blockElement);
      }

      if (lineType === "ol" || lineType === "ul") {
        const item = document.createElement("li");
        appendInlineMarkdown(item, content);
        blockElement.appendChild(item);
      } else if (lineType === "blockquote") {
        // Any ">" depth flattens to one level — a blockquote holding one
        // paragraph per line, rather than modelling true nesting depth.
        const p = document.createElement("p");
        appendInlineMarkdown(p, content);
        blockElement.appendChild(p);
      } else {
        if (blockElement.children.length) blockElement.appendChild(document.createElement("br"));
        appendInlineMarkdown(blockElement, content);
      }
    }
  }

  // composer/performer/subtitle/key: read via asArray()[0], same defensive
  // habit as `name` just below — chordpro_crate.js itself only ever writes
  // these as plain strings (SPEC.md §7), but nothing here can assume the
  // `ro-crate` library never flattens a single value into a one-element
  // array on its way through resolveContext()/getJson(). "" (not undefined)
  // for a song with no such directive, so every consumer below can test
  // truthiness directly rather than each needing its own `|| ""`.
  // Canonical songs only, not setlist-entry proxies — both share the
  // MusicComposition type, told apart by specializationOf/custom:matchStatus
  // (module-level isCanonicalSong's own comment explains why both, not
  // just one), not by whether `text` happens to be present: an entry can
  // carry its own `text` too now (its performance note, SPEC.md §6/§7),
  // which would wrongly include it here if this still checked for that.
  const songs = graph
    .filter((entity) => asArray(entity["@type"]).includes("MusicComposition")
      && !("specializationOf" in entity) && !("custom:matchStatus" in entity))
    .map((entity) => ({
      id: entity["@id"],
      name: String(asArray(entity.name)[0] || entity["@id"]),
      text: entity.text,
      composer: String(asArray(entity.composer)[0] || ""),
      performer: String(asArray(entity.performer)[0] || ""),
      subtitle: String(asArray(entity.subtitle)[0] || ""),
      key: String(asArray(entity.musicalKey)[0] || ""),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  // The one credit shown under a title in a list row (SPEC.md §12) —
  // composer preferred, then performer (a song's own {artist}), then
  // subtitle, never more than one at once. A display preference only; a
  // song can carry more than one of these fields at a time (unlike {st:},
  // which chordpro_crate.js's own st_directive.js migrates to exactly one
  // of artist/composer/both — that's a data-cleanup precedence, this is a
  // separate, purely cosmetic one).
  function creditFor(song) {
    return song.composer || song.performer || song.subtitle || "";
  }

  // Appends the credit line + key (SPEC.md §12) to a list row that already
  // has its title/name element — shared by the song list (below) and
  // setlist entry rows (buildSetlistEntryRow), which show this the same
  // way. `song` is null for a setlist entry with no matching song at all
  // (SPEC.md §6.1's "unresolved" case) — silently does nothing then, the
  // same as it does for a resolved song with neither a credit nor a key:
  // never an empty <em> or a bare key label left in the row.
  function appendListCredit(row, song) {
    if (!song) return;
    const credit = creditFor(song);
    if (credit) {
      const creditElement = document.createElement("em");
      creditElement.className = "list-credit";
      creditElement.textContent = credit;
      row.appendChild(creditElement);
    }
    if (song.key) {
      const keyElement = document.createElement("span");
      keyElement.className = "list-key";
      keyElement.textContent = song.key;
      row.appendChild(keyElement);
    }
  }

  // Setlist-entry proxies (SPEC.md §7): MusicComposition entities carrying
  // specializationOf and/or custom:matchStatus — the same test the songs
  // filter above uses, from the other side (not "no text of their own": an
  // entry can carry its own `text` now, its performance note). songIndex
  // resolves specializationOf to a position in `songs` once, here, rather
  // than re-searching it every time an entry is rendered or clicked; -1 for
  // an entry matchEntryToSong (chordpro_crate.js, build time) never
  // resolved to a real song at all (no specializationOf at all, in that
  // case — matchStatus alone is what still marks it as an entry, not a
  // canonical song). Which set (if any) an entry belongs to is no longer a
  // property on the entry itself (custom:setName is gone — SPEC.md §6/§7)
  // — flattenSetlistParts, below, derives it from the set/sub-playlist
  // hierarchy instead.
  const entriesById = {};
  for (const entity of graph) {
    const isEntry = "specializationOf" in entity || "custom:matchStatus" in entity;
    if (!asArray(entity["@type"]).includes("MusicComposition") || !isEntry) continue;
    const songId = entity.specializationOf && entity.specializationOf["@id"];
    entriesById[entity["@id"]] = {
      name: String(asArray(entity.name)[0] || entity["@id"]),
      matchStatus: entity["custom:matchStatus"] || "unresolved",
      notes: entity.text || "",
      transpose: entity["custom:transpose"],
      capo: Number.isInteger(entity["custom:capo"]) ? entity["custom:capo"] : undefined,
      songIndex: songId ? songs.findIndex((song) => song.id === songId) : -1,
    };
  }

  // Every MusicPlaylist entity, keyed by @id — both a top-level setlist and
  // a nested "# Set" sub-playlist inside one share this one @type
  // (chordpro_crate.js, SPEC.md §6), told apart only by @id shape: a nested
  // set's is always `<setlist path>#set-N`, which a real setlist file's own
  // path can never look like (a "#" isn't valid in one).
  const playlistEntitiesById = {};
  for (const entity of graph) {
    if (asArray(entity["@type"]).includes("MusicPlaylist")) playlistEntitiesById[entity["@id"]] = entity;
  }

  // Turns one setlist's own hasPart — a mix of direct entry references and
  // nested "# Set" sub-playlist references, in file order (SPEC.md §6) —
  // into the flat entries array renderSetlistEntries()/getActivePlaylist()/
  // showPrintSetlist() etc. already expect, same as before this hierarchy
  // existed at all. Each entry gets its own setName/setNotes attached fresh
  // here (never mutating entriesById's own shared objects, which a future
  // change could end up referencing from more than one place) — setNotes
  // (a set's own freeform text between its "#" heading and its first entry,
  // chordpro_crate.js's own `text` on the set entity — SPEC.md §6/§7) is
  // attached to only the *first* entry of that set, so a flat walk through
  // the result renders it exactly once, right where the "Set N" heading
  // belongs.
  function flattenSetlistParts(hasPart) {
    const flat = [];
    for (const ref of asArray(hasPart)) {
      const part = playlistEntitiesById[ref["@id"]];
      if (part) {
        const setName = String(asArray(part.name)[0] || "");
        const setNotes = part.text || "";
        asArray(part.hasPart).forEach((entryRef, i) => {
          const entry = entriesById[entryRef["@id"]];
          if (entry) flat.push({ ...entry, setName, setNotes: i === 0 ? setNotes : "" });
        });
      } else {
        const entry = entriesById[ref["@id"]];
        if (entry) flat.push({ ...entry, setName: "", setNotes: "" });
      }
    }
    return flat;
  }

  // Only entities actually reachable this way count as a "setlist" for the
  // #setlist-list index — a nested "# Set" sub-playlist is also typed
  // MusicPlaylist, but is only ever meant to be reached by walking a real
  // setlist's own hasPart (above), never listed as its own top-level entry.
  // Still told apart by @id shape here, unlike a canonical Song vs. a
  // setlist-entry proxy (isCanonicalSong, above) — hasPart is used the same
  // way in both directions (a setlist containing sets, a set containing
  // entries), with no directional relationship like specializationOf to
  // check for instead. Distinguishing via the crate root's own hasPart
  // (only a real top-level file is ever listed there) would avoid @id
  // shape entirely too, but isn't done here to keep this change scoped to
  // what was actually asked for.
  const setlists = graph
    .filter((entity) => asArray(entity["@type"]).includes("MusicPlaylist") && !String(entity["@id"]).includes("#"))
    .map((entity) => ({
      name: String(asArray(entity.name)[0] || entity["@id"]),
      entries: flattenSetlistParts(entity.hasPart),
    }));

  const listView = document.getElementById("list-view");
  const songView = document.getElementById("song-view");
  // #app-bar is always mounted, sticky, and a single line — no second row
  // — so #fullscreen-button can live inside it directly rather than as a
  // separate fixed element that has to be kept from overlapping it by
  // hand. Every other control in it is individually setHidden() by the
  // view-switching functions below (there's no longer one wrapper element
  // whose own hidden state implies all of theirs).
  const appBar = document.getElementById("app-bar");
  const menuBarOverflowToggle = document.getElementById("menu-bar-overflow-toggle");
  const menuBarOverflow = document.getElementById("menu-bar-overflow");
  const setlistNotesLabel = document.getElementById("setlist-notes-label");
  const setlistNotesCheckbox = document.getElementById("setlist-notes-checkbox");
  const setlistNoteModal = document.getElementById("setlist-note-modal");
  const setlistNoteModalContent = document.getElementById("setlist-note-modal-content");
  const songViewTitle = document.getElementById("song-view-title");
  // #song-content is the box fitSongContent() scales font-size against —
  // #song-header (title/key/capo, moved here from #app-bar so they scale
  // and column-flow with the song itself, rather than taking up fixed
  // space in the sticky bar above) is its first child and stays put across
  // renders; only #song-pages, the second child, gets overwritten on every
  // renderCurrentSong() call. Both participate in #song-content's own
  // multi-column flow when .two-columns is set — CSS multi-col treats all
  // of a container's children as one continuous flow, which is what puts
  // #song-header at the top of the *left* column specifically, with no
  // extra CSS needed for that placement.
  const songContent = document.getElementById("song-content");
  const songHeader = document.getElementById("song-header");
  // An off-flow clone used only to measure #song-view-title's own text at a
  // candidate font-size — see fitSongHeaderTitle's own comment on why
  // reading #song-view-title's own scrollWidth directly doesn't work.
  // Appended as a child of #song-header so it inherits the exact same
  // font-family #song-view-title does; position:absolute takes it out of
  // the flex flow entirely, so it never affects #song-header's own layout.
  const titleMeasurer = document.createElement("span");
  // Not reachable via getElementById (it has no id) — findable in tests via
  // #song-header's own children instead, by this class name.
  titleMeasurer.className = "title-measurer";
  titleMeasurer.style.position = "absolute";
  titleMeasurer.style.visibility = "hidden";
  titleMeasurer.style.whiteSpace = "nowrap";
  titleMeasurer.style.fontWeight = "700"; // matches #song-view-title's own CSS
  songHeader.appendChild(titleMeasurer);
  const songPagesElement = document.getElementById("song-pages");
  const songListElement = document.getElementById("song-list");
  const prevButton = document.getElementById("prev-song-button");
  const nextButton = document.getElementById("next-song-button");
  const backButton = document.getElementById("back-to-list-button");
  const keySelect = document.getElementById("key-select");
  const capoSelect = document.getElementById("capo-select");
  const instrumentSelect = document.getElementById("instrument-select");
  const chordDiagramsPanel = document.getElementById("chord-diagrams");
  const toggleChordsButton = document.getElementById("toggle-chords-button");
  const toggleChordsGlyph = document.getElementById("toggle-chords-glyph");
  const printSongButton = document.getElementById("print-song-button");
  const printBookButton = document.getElementById("print-book-button");
  const printView = document.getElementById("print-view");
  const printContent = document.getElementById("print-content");
  const printNowButton = document.getElementById("print-now-button");
  const donePrintingButton = document.getElementById("done-printing-button");
  const printInstrumentSelect = document.getElementById("print-instrument-select");
  const includeTocLabel = document.getElementById("include-toc-label");
  const includeTocCheckbox = document.getElementById("include-toc-checkbox");
  const largePrintLabel = document.getElementById("large-print-label");
  const largePrintCheckbox = document.getElementById("large-print-checkbox");
  const facingPagesLabel = document.getElementById("facing-pages-label");
  const facingPagesCheckbox = document.getElementById("facing-pages-checkbox");
  const floorSheetLabel = document.getElementById("floor-sheet-label");
  const floorSheetCheckbox = document.getElementById("floor-sheet-checkbox");
  const floorSheetNotesLabel = document.getElementById("floor-sheet-notes-label");
  const floorSheetNotesCheckbox = document.getElementById("floor-sheet-notes-checkbox");
  const fullscreenButton = document.getElementById("fullscreen-button");
  const viewSetlistsButton = document.getElementById("view-setlists-button");
  const setlistIndexView = document.getElementById("setlist-index-view");
  const backFromSetlistIndexButton = document.getElementById("back-from-setlist-index-button");
  const setlistListElement = document.getElementById("setlist-list");
  const setlistView = document.getElementById("setlist-view");
  const setlistViewTitle = document.getElementById("setlist-view-title");
  const backFromSetlistButton = document.getElementById("back-from-setlist-button");
  const printSetlistButton = document.getElementById("print-setlist-button");
  const toggleNotesButton = document.getElementById("toggle-notes-button");
  const setlistEntriesElement = document.getElementById("setlist-entries");
  const songSearchInput = document.getElementById("song-search");
  const setlistSearchInput = document.getElementById("setlist-search");
  const setlistEntriesSearchInput = document.getElementById("setlist-entries-search");

  // currentIndex: position within getActivePlaylist() (below) — the
  // global song list while browsing it, but a specific setlist's own
  // order once one is active (currentSetlistIndex >= 0), which is not
  // necessarily the same as a raw index into `songs`. currentSongIndex is
  // that raw index, resolved once by showSong() at the same time it sets
  // currentIndex, so every other function that needs the actual song
  // (renderCurrentSong, showPrintSong, saveCurrentSelection, the key/capo
  // change handlers) reads it directly rather than re-deriving it from
  // the active playlist itself each time.
  let currentIndex = -1;
  let currentSongIndex = -1;
  // Which instrument's chord grids to show, or null for none — global for
  // the whole viewing session rather than per-song like currentTranspose/
  // currentCapo: which instrument PT is holding doesn't change from one
  // song to the next the way a song's own key does, so it isn't reset in
  // showSong() and isn't part of the per-song sessionStorage record either.
  let currentInstrument = null;
  // null in either means "use the song's own {key}/{transpose}/{capo}
  // directives, untouched". showSong sets these from whatever's saved for
  // that song's id (see loadSavedSelection below), defaulting to null when
  // nothing is saved yet — so a song that's never been touched still opens
  // at its own values.
  let currentTranspose = null;
  let currentCapo = null;
  let currentSetlistIndex = -1;
  // Whether notes render at all, not per-entry — a single toggle for the
  // whole setlist rather than a control on every row, matching PT's own
  // ask ("make them hidable") for a capability, not a per-entry UI.
  let notesVisible = true;
  // Whether inline chord names (renderSong()'s own .inlineChord spans)
  // render at all — global for the session like currentInstrument, not
  // reset per song. Scoped deliberately to the inline chord names in the
  // lyrics themselves, not the #chord-diagrams panel: that's a separately
  // opted-into feature (via instrument selection), not something this
  // toggle needs to also suppress. Print is unaffected — a printed chart
  // always shows its chords regardless of this on-screen preference.
  let chordsHidden = false;
  // Whichever showPrintSong/showPrintBook/showPrintSetlist call is
  // currently on screen, re-invocable with no arguments — set at the start
  // of each of those functions. Changing the instrument from
  // #print-instrument-select calls this to redraw the same print job with
  // the new instrument's chord grids, rather than needing to leave print
  // preview and re-click print to see the effect.
  let currentPrintRebuild = null;

  // Session persistence for the key/capo choice — chordprosite's own
  // equivalent is a "Remember key, capo for this playlist" checkbox
  // (template.njk), checked by default, that writes into the playlist data
  // itself; this uses sessionStorage instead, scoped to this browser tab
  // rather than to a file this page has no way to write back to (SPEC.md
  // §2 rules out editing/writing to the source folder entirely — this page
  // only ever reads the crate embedded in it). "Session" is deliberately
  // sessionStorage, not localStorage: closing the tab forgets the choice,
  // matching what PT actually asked for ("remember changes for a session")
  // rather than a choice that outlives the browsing session and lingers
  // indefinitely against a page that may be reopened from an entirely
  // different folder later.
  //
  // Wrapped in try/catch — not defensive programming against a
  // hypothetical, but a real, known failure mode specific to this page's
  // own deployment target: SPEC.md's own "Songbook HTML output" section
  // requires this to work opened directly as a file:// URL, and
  // sessionStorage access can throw under file:// in some browsers/privacy
  // modes rather than simply being unavailable. Losing persistence there is
  // an acceptable degradation; losing the whole page is not.
  const SELECTIONS_STORAGE_KEY = "chordpro-songbook:key-capo";

  function loadSavedSelections() {
    try {
      const raw = window.sessionStorage.getItem(SELECTIONS_STORAGE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  }

  function saveCurrentSelection() {
    const song = songs[currentSongIndex];
    if (!song) return;
    try {
      const all = loadSavedSelections();
      all[song.id] = { transpose: currentTranspose, capo: currentCapo };
      window.sessionStorage.setItem(SELECTIONS_STORAGE_KEY, JSON.stringify(all));
    } catch {
      // Choice still works for as long as this song stays open (see above)
      // — it just won't survive navigating away and back.
    }
  }

  // Toggling a "hidden" class, not element.style.display directly: setting
  // style.display = "" *clears* an inline override rather than making the
  // element visible again — it then falls back to whatever the stylesheet
  // itself says, which for #song-view/#back-to-list-button/etc. is still `display:
  // none` (see the <style> block in renderSongbookHtml). That was a real
  // bug here, not a hypothetical one — both views ended up hidden after
  // clicking a song, which is exactly "blank". classList avoids it: an
  // element with no "hidden" class simply gets its own normal display value
  // from the stylesheet, whatever that is per element, rather than this
  // function needing to know or hardcode it.
  function setHidden(element, hidden) {
    element.classList.toggle("hidden", hidden);
  }

  function isHidden(element) {
    return element.classList.contains("hidden");
  }

  // Key/capo controls — ported from chordprosite's own makeKeyDropdown()/
  // makeCapoDropdown() (scripts.js), including their one real quirk worth
  // keeping deliberately: choosing a key only ever changes which note it
  // is, never switching a minor key to major or back — chordprosite's own
  // dropdown is built from `Transposer.notes` with a fixed `m` suffix
  // decided once, from the song's own original key, not offered as a
  // choice. Both selects are populated fresh on every render (a song
  // opening, or either dropdown changing) rather than built once, since
  // what belongs in them — which note is "selected", what each capo
  // option's shape-key label reads — depends on currentTranspose/
  // currentCapo, which change on every render.
  //
  // Transposer: a third bare global from CHORDPROBOOK_BROWSER_BUNDLE,
  // alongside ChordProSong/renderSong (see this function's own header
  // comment) — needed here for its `notes` table and `transposeKey()`,
  // not for chord transposition itself, which renderSong already does.
  function populateKeySelect(parsedSong) {
    if (!parsedSong.hasChords) {
      setHidden(keySelect, true);
      keySelect.replaceChildren();
      return;
    }
    setHidden(keySelect, false);
    keySelect.replaceChildren();

    if (parsedSong.key) {
      const minor = parsedSong.key.endsWith("m");
      const soundingKey = currentTranspose ?? parsedSong.key;
      for (const note of Transposer.notes) {
        const value = minor ? `${note}m` : note;
        const option = document.createElement("option");
        option.value = value;
        option.textContent = value;
        if (value === soundingKey) option.selected = true;
        keySelect.appendChild(option);
      }
    } else {
      // No {key} directive at all — chordprosite's own "originalKey ===
      // null" branch: a plain semitone-offset dropdown, since there's no
      // note name to offer choices around.
      const soundingOffset = currentTranspose ?? 0;
      Transposer.notes.forEach((_, index) => {
        const option = document.createElement("option");
        option.value = String(index);
        option.textContent = `+${index}`;
        if (index === soundingOffset) option.selected = true;
        keySelect.appendChild(option);
      });
    }
  }

  function populateCapoSelect(parsedSong) {
    if (!parsedSong.hasChords) {
      setHidden(capoSelect, true);
      capoSelect.replaceChildren();
      return;
    }
    setHidden(capoSelect, false);
    capoSelect.replaceChildren();

    const soundingKey = parsedSong.key
      ? (typeof currentTranspose === "string" ? currentTranspose : parsedSong.key)
      : null;
    const capo = currentCapo ?? parsedSong.capo ?? 0;

    const noCapoOption = document.createElement("option");
    noCapoOption.value = "";
    noCapoOption.textContent = "0 - No Capo";
    if (capo === 0) noCapoOption.selected = true;
    capoSelect.appendChild(noCapoOption);

    for (let i = 1; i <= 12; i += 1) {
      const option = document.createElement("option");
      option.value = String(i);
      // chordprosite's own label formula (Transposer.transposeKey(song.key,
      // -i)) is used verbatim here — but chordprosite calls it even when
      // there's no key at all, at which point transposeKey(null, ...)
      // returns null and the label reads "i - (null shapes)". `soundingKey`
      // being null skips that: a plain "Capo i" with no shapes claim, since
      // there's no key to derive one from and "null shapes" isn't a real
      // answer worth reproducing.
      option.textContent = soundingKey ? `${i} - (${Transposer.transposeKey(soundingKey, -i)} shapes)` : `Capo ${i}`;
      if (i === capo) option.selected = true;
      capoSelect.appendChild(option);
    }
  }

  // Instrument list — built once, not per-song: it's the same list
  // regardless of which song is open, unlike the key/capo selects, which
  // depend on the current song's own key and chord content.
  // Takes the select to populate as a parameter — there are two of these
  // now (the menu bar's own #instrument-select, and #print-instrument-select
  // in the print banner, added so the choice can be made/changed without
  // leaving print preview to go find a song first), both listing the exact
  // same instruments.
  function populateInstrumentSelect(select) {
    const noneOption = document.createElement("option");
    noneOption.value = "";
    noneOption.textContent = "No chord grids";
    noneOption.selected = true;
    select.appendChild(noneOption);

    for (const instrument of CHORDPROBOOK_INSTRUMENTS_DATA) {
      const option = document.createElement("option");
      option.value = instrument.name;
      option.textContent = instrument.name;
      select.appendChild(option);
    }
  }

  // The two instrument selects (menu bar, print banner) always agree —
  // this is the one place currentInstrument is actually assigned, so
  // nothing can set it without keeping both in sync.
  function setCurrentInstrument(name) {
    currentInstrument = name || null;
    instrumentSelect.value = currentInstrument || "";
    printInstrumentSelect.value = currentInstrument || "";
  }

  // Chord grids for the instrument currently selected, one per distinct
  // chord the song actually uses (`chordsUsed`, already computed by
  // renderSong — not recomputed here). Ported from chordprosite's own
  // addChordsToDiv()/drawChordForInstrument() (template.njk/ChordDiagram.js),
  // with one deliberate change: a fresh ChordDiagram instance per chord,
  // not chordprosite's single reused instance/canvas. That matters for a
  // chord with no shape data for the chosen instrument — chordprosite's
  // drawChordForInstrument() simply does nothing when it can't find a
  // definition, leaving whatever the previous chord in the loop last drew
  // still on the shared canvas, mislabelled as the chord that just failed
  // to find a shape. A fresh instance per chord can't inherit a previous
  // chord's drawing; it just has nothing to render, which this skips
  // instead of showing (checking `diagram.strings.length` — parseDefinition,
  // called by drawChordForInstrument only when a definition was actually
  // found, is what populates it).
  // Shared between the on-screen chord panel (renderChordDiagrams) and
  // print pages (buildSongPrintPage) — printing "needs to add chord grids
  // if the user has selected that" (PT), the same instrument choice either
  // way, since it's global for the session (currentInstrument's own
  // declaration above), not a separate on-screen/print setting.
  function buildChordDiagramElements(chordsUsed) {
    const instrument = currentInstrument
      ? CHORDPROBOOK_INSTRUMENTS_DATA.find((candidate) => candidate.name === currentInstrument)
      : null;
    if (!instrument) return [];

    const diagramElements = [];
    for (const chordName of chordsUsed) {
      // ChordDiagram: a fourth bare global from CHORDPROBOOK_BROWSER_BUNDLE
      // (see this function's own header comment above), alongside
      // ChordProSong/renderSong/Transposer.
      const diagram = new ChordDiagram(chordName);
      diagram.loadDefinitionData(CHORDPROBOOK_CHORD_DATA);
      diagram.drawChordForInstrument(instrument, chordName);
      if (diagram.strings.length) {
        const wrapper = document.createElement("div");
        wrapper.innerHTML = diagram.toSvg();
        diagramElements.push(wrapper);
      }
    }
    return diagramElements;
  }

  function renderChordDiagrams(chordsUsed) {
    const diagramElements = buildChordDiagramElements(chordsUsed);
    if (!diagramElements.length) {
      setHidden(chordDiagramsPanel, true);
      chordDiagramsPanel.replaceChildren();
      return;
    }
    chordDiagramsPanel.replaceChildren(...diagramElements);
    setHidden(chordDiagramsPanel, false);
  }

  function renderCurrentSong() {
    const song = songs[currentSongIndex];
    // ChordProSong/renderSong: bare globals from CHORDPROBOOK_BROWSER_BUNDLE
    // (see this function's own header comment above).
    const parsedSong = new ChordProSong(song.text);
    const rendered = renderSong(parsedSong, song.text, { transpose: currentTranspose, capo: currentCapo });

    songPagesElement.innerHTML = rendered.pages.join("\n");
    songContent.classList.toggle("chords-hidden", chordsHidden);
    populateKeySelect(parsedSong);
    populateCapoSelect(parsedSong);
    setHidden(instrumentSelect, !parsedSong.hasChords);
    setHidden(toggleChordsButton, !parsedSong.hasChords);
    renderChordDiagrams(parsedSong.hasChords ? rendered.chordsUsed : []);
    fitSongContent();
  }

  // A compact "[C]" glyph, not a text label — this button now sits among
  // the other icon buttons (fullscreen/prev/next/print), so it gets the
  // same treatment #fullscreen-button's own label already does: only
  // title/aria-label change with state, not the glyph itself, striking
  // through the C instead to show "chords are hidden" at a glance.
  function updateToggleChordsButtonLabel() {
    const label = chordsHidden ? "Show chords" : "Hide chords";
    toggleChordsButton.title = label;
    toggleChordsButton.setAttribute("aria-label", label);
    toggleChordsGlyph.classList.toggle("struck", chordsHidden);
  }

  // Scaling song text to fill the available screen — ported from
  // chordprosite's own fillPage()/fillPages() (template.njk), which PT
  // named as the feature this whole page is really for. There is still no
  // CSS-only way to do this: font-size determines how much text wraps,
  // which determines how tall the content becomes, which is exactly what
  // has to fit inside a box of known height — content-dependent in a way
  // clamp()/container query units can't express, since those size a font
  // from the container's own dimensions, never from how much a given size
  // makes a specific piece of text wrap. Measuring the rendered result and
  // adjusting is still the only way to do this, as it was when chordprosite
  // was last touched.
  //
  // Two deliberate departures from chordprosite's own version, not a
  // like-for-like port: a binary search over font-size in place of its
  // 1px-at-a-time decrement loop (the same handful of comparisons chosen
  // well, rather than up to 3000 of them run blindly — chordprosite's own
  // loop caps itself at exactly that many iterations, which is the tell),
  // and an explicit floor (FIT_MIN_FONT_PX) — chordprosite's loop has none,
  // and for content that cannot fit at all keeps decrementing the font
  // size toward zero and past it into invalid negative values, which is not
  // a fit, just an unbounded search for one.
  const FIT_MIN_FONT_PX = 10;
  const FIT_MAX_FONT_PX = 80;

  // The binary search itself, factored out of fitSongContent so print mode
  // (below) can fit a song onto its own printed page the same way —
  // PT: chordprosite doesn't clip a song that's too long for one page, it
  // resizes it to fit, the same fillPage() the on-screen view uses. An
  // earlier version of this print feature let a long song spill onto a
  // second physical page instead, on the mistaken belief that chordprosite
  // clips; it doesn't, so this doesn't either.
  // maxFontPx/minFontPx default to FIT_MAX_FONT_PX/FIT_MIN_FONT_PX for the
  // two like-for-like ports below (fitSongContent/fitPrintSongPage) —
  // fitSongHeaderTitle (below) passes its own, much lower ceiling (a title
  // has no business growing past what its own em-based CSS size would
  // already give it just because there happens to be room) and a higher
  // floor (unlike body text, a title that can't fit should stop shrinking
  // once it's unreadable and ellipsis instead — see #song-view-title's own
  // CSS — rather than keep shrinking all the way to FIT_MIN_FONT_PX).
  function fitTextToBox(element, availableHeight, availableWidth, maxFontPx = FIT_MAX_FONT_PX, minFontPx = FIT_MIN_FONT_PX) {
    let low = minFontPx;
    let high = maxFontPx;
    let bestFit = minFontPx;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      element.style.fontSize = `${mid}px`;
      const fits = element.scrollHeight <= availableHeight && element.scrollWidth <= availableWidth;
      if (fits) {
        bestFit = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    element.style.fontSize = `${bestFit}px`;
  }

  // Keeps #song-view-title on the same line as #key-select/#capo-select
  // (SPEC.md §12) even when the title is long or the screen is narrow — the
  // same binary-search idea as fitTextToBox, but sized against the *header's*
  // own leftover width rather than the whole page, and clamped to a fixed
  // TITLE_MIN_FONT_PX..TITLE_MAX_FONT_PX range. Run after fitSongContent
  // (which it's called from) has already settled #song-content's own
  // font-size and, in turn, key/capo's em-based widths — this only ever
  // shrinks the title to make room for whatever those two already are,
  // never the other way around.
  //
  // TITLE_MIN_FONT_PX is a readable floor: below it, the title ellipsis-
  // truncates instead (#song-view-title's own white-space/overflow/
  // text-overflow) — a readable-but-truncated title beats a technically-
  // whole but microscopic one. TITLE_MAX_FONT_PX caps how big a title ever
  // gets, full stop — including for a very short song, whose own body
  // font-size can reach FIT_MAX_FONT_PX (80px); without an independent cap
  // here, a title scaled proportionally to that (e.g. the CSS default,
  // 1.3em) would dominate the page.
  //
  // Earlier versions of this instead computed a *body-font-derived* ceiling
  // (`min(TITLE_MAX_FONT_PX, max(TITLE_MIN_FONT_PX, bodyFontPx * 1.3))`) —
  // meant only to cap the oversized-title case above, but with a real bug:
  // for any normal-to-long song, whose own body text has to shrink well
  // below FIT_MAX_FONT_PX to fit all its lyrics, `bodyFontPx * 1.3` could
  // fall *below* TITLE_MIN_FONT_PX — at which point `max(TITLE_MIN_FONT_PX,
  // ...)` pulled the ceiling back up to exactly TITLE_MIN_FONT_PX, making it
  // equal the floor. With ceiling == floor, fitTextToBox's own binary search
  // has no range left to search at all, and — since its own `bestFit`
  // starts at the floor and a search with high < low never updates it —
  // silently forced the title to TITLE_MIN_FONT_PX (16px) regardless of how
  // much header width was actually free. That's a title-size bug, not a
  // does-it-fit one: it fired for any song whose *lyrics* needed a small
  // font, which has nothing to do with whether the *title* had room. A flat
  // TITLE_MAX_FONT_PX ceiling already fully covers the one case this was
  // meant for (a very short song's blown-up body font) — `min(36, 80 * 1.3)`
  // and a flat `36` land on exactly the same number — so the body-font term
  // was pure liability with no corresponding benefit, and is gone.
  const TITLE_MIN_FONT_PX = 16;
  const TITLE_MAX_FONT_PX = 36;
  // Keep in sync by hand with #song-header's own `gap: 0.6em` — this
  // function has no way to read that value back out of the stylesheet (no
  // getComputedStyle() — see fitSongHeaderTitle's own comment on why), so it
  // keeps its own copy instead. Still read relative to bodyFontPx (not a
  // fixed px value): the *gap itself* genuinely is meant to scale with the
  // body's own font-size, unlike the title's own ceiling above — reserving
  // the wrong width for it would misjudge how much room the title actually
  // has to work with.
  const SONG_HEADER_GAP_EM = 0.6;
  function fitSongHeaderTitle() {
    if (isHidden(songViewTitle)) return;
    const bodyFontPx = parseFloat(songContent.style.fontSize) || FIT_MAX_FONT_PX;
    const gapPx = bodyFontPx * SONG_HEADER_GAP_EM;
    let reservedWidth = 0;
    let visibleSiblings = 0;
    if (!isHidden(keySelect)) { reservedWidth += keySelect.offsetWidth; visibleSiblings += 1; }
    if (!isHidden(capoSelect)) { reservedWidth += capoSelect.offsetWidth; visibleSiblings += 1; }
    reservedWidth += gapPx * visibleSiblings; // one gap per sibling, between it and whatever precedes it
    const availableWidth = Math.max(0, songHeader.clientWidth - reservedWidth);
    // Measured on titleMeasurer (an off-flow clone — see its own
    // declaration comment), not #song-view-title itself: #song-view-title
    // is a flex item with flex-grow:1 inside #song-header, so its own
    // scrollWidth reflects whatever box width flexbox happens to allocate
    // it — stretched to fill leftover header space when there's room,
    // shrunk against key/capo's own fixed width when there isn't — which is
    // *not* the same thing as how wide its text actually is at a given
    // font-size. A short title (e.g. "Aeroplane") could easily get
    // stretched to fill hundreds of pixels of leftover space yet still
    // report a scrollWidth around that same size regardless of font-size,
    // making the fits check meaningless and settling on an arbitrary result
    // — reliably reproduced as a title stuck at TITLE_MIN_FONT_PX even with
    // acres of free header width. titleMeasurer has no box of its own to be
    // stretched or shrunk into, so its scrollWidth is governed purely by
    // its text and font-size, the way fitTextToBox's binary search assumes.
    // Height never binds here — #song-view-title is white-space: nowrap
    // (its own CSS), so at any font size in range it's exactly one line
    // tall; this bound only has to be generously larger than that.
    titleMeasurer.textContent = songViewTitle.textContent;
    fitTextToBox(titleMeasurer, FIT_MAX_FONT_PX * 4, availableWidth, TITLE_MAX_FONT_PX, TITLE_MIN_FONT_PX);
    songViewTitle.style.fontSize = titleMeasurer.style.fontSize;
  }

  function fitSongContent() {
    if (currentIndex < 0) return;

    const availableHeight = window.innerHeight - appBar.offsetHeight;
    const availableWidth = songContent.clientWidth;

    // Landscape-proportioned space — more available width than height —
    // gets two columns, the same trigger chordprosite itself uses. Decided
    // before the search below, since it changes how the same font size
    // wraps: a column layout roughly halves the height a given amount of
    // text needs, so column count has to be settled first, not fitted
    // around afterwards.
    songContent.classList.toggle("two-columns", availableHeight < availableWidth);
    fitTextToBox(songContent, availableHeight, availableWidth);
    fitSongHeaderTitle();
  }

  // chordprosite registers this same idea (`window.addEventListener('resize',
  // fillPages(songDiv))`) but calls fillPages immediately and passes its
  // (undefined) return value as the listener — a real bug, found by reading
  // that line rather than by running it: it re-fits once at load and never
  // again on an actual resize or rotation. Debounced here (150ms) since
  // resize fires continuously while a window is being dragged, and each
  // call re-measures and re-searches.
  let resizeTimer = null;
  function scheduleFit() {
    if (resizeTimer !== null) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(fitSongContent, 150);
  }
  window.addEventListener("resize", scheduleFit);
  window.addEventListener("orientationchange", scheduleFit);

  // Print mode — ported from chordprosite's own displayPrint()/printSong()
  // (template.njk), with the one change PT specifically asked for: this
  // replaces the current screen (a third top-level view, alongside list and
  // song) rather than opening `window.open('', '_blank')` — that call is
  // blocked or silently no-ops in some contexts a standalone HTML page like
  // this one may be opened from (SharePoint, Dropbox's own preview), which
  // is the actual bug report this responds to. window.print() itself,
  // unlike window.open(), prints whatever the *current* window is showing,
  // which is why replacing the screen is enough — no popup is needed at all.
  //
  // Every section of a song gets exactly one physical page — almost always
  // the whole song, since renderSong()'s own `pages` array (one entry per
  // {new_page} directive in the source) is length 1 unless the source
  // asks for more (buildNormalPrintSongPages) — same as chordprosite's own
  // version: not by clipping it (chordprosite doesn't do that either — an
  // earlier version of this feature assumed it did, and let a long song
  // spill onto a second page instead, which was simply a misreading of the
  // original), but by fitting it to the page with the exact same
  // fitTextToBox() the on-screen view uses, applied to a fixed A4-sized box
  // instead of the viewport. That's also what makes the table of contents'
  // page numbers below trustworthy: every song's own page count is known
  // up front (buildNormalPrintSongPages/buildLargePrintSongPages both
  // return exactly as many pages as they were going to build, before any
  // page is fitted), so later songs' numbers can be computed correctly
  // without waiting to see how any of it actually renders.
  //
  // .print-page's own physical sizing (width/padding, below in the <style>
  // block) is deliberately not confined to @media print — chordprosite's
  // own popup-window version applies it unconditionally too, which is what
  // lets fitPrintSongPage measure real A4-sized boxes immediately, before
  // the user ever asks to print, rather than only once print CSS is
  // actually in effect (which JS run beforehand can't observe at all).
  const MM_PER_PX = 25.4 / 96; // CSS reference pixel: 1in = 96px = 25.4mm
  const A4_WIDTH_MM = 210;
  const A4_HEIGHT_MM = 297;
  // Tightened from chordprosite's own 15mm (PT: "make the printed pages a
  // bit tighter... we want the largest possible print for stage use and
  // visually impaired colleagues") — this number has to match the
  // .print-page padding declared in the <style> block in renderSongbookHtml
  // below exactly; the two can't share one source value the way the rest
  // of this file avoids duplication, since that block is a different
  // function's own string template, not something this function's code can
  // reach into.
  const PRINT_PAGE_PADDING_MM = 10;
  const PRINT_CONTENT_WIDTH_PX = (A4_WIDTH_MM - PRINT_PAGE_PADDING_MM * 2) / MM_PER_PX;
  const PRINT_CONTENT_HEIGHT_PX = (A4_HEIGHT_MM - PRINT_PAGE_PADDING_MM * 2) / MM_PER_PX;

  function addPageNumber(page, pageNumber) {
    const label = document.createElement("div");
    label.className = "print-page-number";
    label.textContent = String(pageNumber);
    page.appendChild(label);
  }

  // Returns the page element; the title/body elements fitPrintSongPage
  // needs are reached via printSongTitleElement/printSongBody, plain
  // properties set directly on it rather than a querySelector lookup —
  // this is an element only this module's own code ever looks back into.
  // Chord grids (print-chord-diagrams), alongside the body rather than
  // above it — same reasoning as the on-screen #chord-diagrams side panel
  // (SPEC.md §10): a side panel's width comes out of the body's own
  // clientWidth for free once laid out, without fitPrintSongPage needing to
  // know the panel exists or subtract its width itself.
  //
  // A small "Chords for X" note under the song's own title, when this
  // particular song actually got at least one diagram — PT: a single
  // printed page, out of context from the rest of the book (photocopied,
  // handed to one musician), should still say what instrument its own
  // chord shapes are for. Checked per song, unlike the front-matter page's
  // broader statement (buildFrontMatterPages, below), since not every song
  // is guaranteed to have a shape for every chord it uses.
  //
  // pageNumber (null by default) is only given by showPrintBook/
  // showPrintSetlist — a standalone single-song print (showPrintSong) has
  // no book/contents page for a number to refer back to, so it omits one
  // rather than printing a lone, meaningless "1".
  //
  // continued (false by default) is only ever true for a large-print
  // song's second page (buildLargePrintSongPages, below) — a small "(cont-
  // inued)" note under the title, so a page landing on its own (photocopied,
  // separated from the rest of a spread) doesn't read as a different,
  // truncated song rather than the back half of one that's two pages long.
  function buildSongPrintPage(name, rendered, pageNumber = null, continued = false) {
    const page = document.createElement("div");
    page.className = "print-page";
    const heading = document.createElement("h1");
    heading.className = "print-song-title";
    heading.textContent = name;
    page.appendChild(heading);

    let continuedNote = null;
    if (continued) {
      continuedNote = document.createElement("p");
      continuedNote.className = "print-continued-note";
      continuedNote.textContent = "(continued)";
      page.appendChild(continuedNote);
    }

    const row = document.createElement("div");
    row.className = "print-song-row";
    const body = document.createElement("div");
    body.className = "print-song-body";
    // The actual rendered lyrics live in this inner element, not directly
    // in .print-song-body itself — large print (fitLargePrintSongPages)
    // needs a container holding *only* renderSong()'s own top-level chunks
    // (.heading/.line/blockquote/pre/img), so it can walk them and move
    // whichever ones don't fit onto page 2's own .print-song-body-content
    // directly, without also picking up unrelated siblings .print-song-
    // body might otherwise hold. Normal print (fitPrintSongPage) never
    // reaches into this at all — its own scrollHeight still bubbles up
    // from this same content regardless of how many divs it's nested
    // inside, so the extra nesting is invisible to it.
    const bodyContent = document.createElement("div");
    bodyContent.className = "print-song-body-content";
    bodyContent.innerHTML = rendered.pages.join("\n");
    body.appendChild(bodyContent);
    row.appendChild(body);

    const diagramElements = buildChordDiagramElements(rendered.chordsUsed);
    let chordsForNote = null;
    if (diagramElements.length) {
      chordsForNote = document.createElement("p");
      chordsForNote.className = "print-chords-for-note";
      chordsForNote.textContent = `Chords for ${currentInstrument}`;
      page.appendChild(chordsForNote);

      const diagrams = document.createElement("div");
      diagrams.className = "print-chord-diagrams";
      diagrams.replaceChildren(...diagramElements);
      row.appendChild(diagrams);
    }

    page.appendChild(row);
    if (pageNumber !== null) addPageNumber(page, pageNumber);
    page.printSongTitleElement = heading;
    page.printContinuedNoteElement = continuedNote;
    page.printChordsForNoteElement = chordsForNote;
    page.printSongBody = body;
    page.printSongBodyContent = bodyContent;
    return page;
  }

  // Only meaningful once `page` is actually attached and visible (see
  // enterPrintView()'s own ordering below) — scrollHeight/offsetHeight/
  // clientWidth are 0 for anything still inside a display:none ancestor,
  // same reason showSong() toggles visibility before calling
  // fitSongContent(). Width comes from printSongBody's own clientWidth,
  // not the fixed PRINT_CONTENT_WIDTH_PX constant directly — the same
  // change fitSongContent's own on-screen version already made for the
  // same reason: a visible chord-diagrams panel (above) already narrows
  // it, and measuring rather than assuming means this doesn't need its
  // own copy of that arithmetic. The page number itself never needs
  // subtracting here — it's position:absolute, so it never takes up flow
  // space the way the title/chords-for note do.
  function fitPrintSongPage(page) {
    const chordsForHeight = page.printChordsForNoteElement ? page.printChordsForNoteElement.offsetHeight : 0;
    const availableHeight = PRINT_CONTENT_HEIGHT_PX - page.printSongTitleElement.offsetHeight - chordsForHeight;
    fitTextToBox(page.printSongBody, availableHeight, page.printSongBody.clientWidth);
  }

  // A song's own {new_page}/{np} directives (renderSong()'s own `pages`
  // array — almost always length 1, but not always) get one physical page
  // each, rather than being joined into one continuous flow on a single
  // page the way a plain body.innerHTML = rendered.pages.join("\n") would
  // (buildSongPrintPage builds one page from exactly one rendered.pages
  // entry, which is what makes this just a map over them rather than a
  // change to that function itself). No "(continued)" note on any of
  // them — unlike large print's own per-section pairs (below), where the
  // second page of a pair really is an auto-split continuation of content
  // that didn't fit, each of *these* pages is a deliberate, authored break
  // in the source; every one of them starts clean. firstPageNumber is a
  // single starting number (or null for a standalone print with no book
  // context — SPEC.md §13); each section after the first advances it by 1,
  // the same as advancing to the next song would.
  function buildNormalPrintSongPages(name, rendered, firstPageNumber) {
    const sections = rendered.pages.length ? rendered.pages : [""];
    return sections.map((sectionHtml, sectionIndex) => {
      const sectionRendered = { ...rendered, pages: [sectionHtml] };
      const pageNumber = firstPageNumber === null ? null : firstPageNumber + sectionIndex;
      return buildSongPrintPage(name, sectionRendered, pageNumber);
    });
  }

  // Large print: every song spans two physical pages instead of one,
  // showing roughly double the text size for the same content — not by
  // literally doubling the font-size number, but by fitting the *whole*
  // song against a box twice as tall as one printed page (fitTextToBox is
  // reused unchanged for this — see fitLargePrintSongPages below), which
  // naturally lands on a font size well above what fitPrintSongPage would
  // have found for the same song on one page, since it's now allowed to
  // take up to twice the room.
  //
  // Page 1 of each pair is built from buildSongPrintPage as normal, holding
  // the section's full rendered content; page 2 starts with none of its
  // own — fitLargePrintSongPages (below) moves whatever doesn't fit on
  // page 1 onto page 2 directly, once page 1's own split point is known.
  // Building page 2 with a *second, separate rendering* of the same markup
  // and relying on a computed clip+offset to show "the other half" (an
  // earlier version of this did exactly that) depends on that second copy
  // reflowing pixel-for-pixel identically to the first — page 2 held
  // identical HTML, but was still laid out independently, and small
  // divergences there chopped text right at the seam. Moving the actual
  // DOM nodes instead means page 2 can only ever show precisely the nodes
  // page 1 didn't keep, with no reflow assumption at all.
  //
  // A song can already be split into several sections at the source
  // (ChordPro's own {new_page} directive — renderSong's own `pages` array,
  // almost always length 1, but not always: normal print mode joins every
  // section into one continuous flow on one page regardless — see
  // buildSongPrintPage's own body.innerHTML — but large print gives each
  // section its own two-page spread instead of joining them into one
  // bigger one, which is what the loop below is for. firstPageNumber is a
  // single starting number (or null for a standalone print with no book
  // context — SPEC.md §13); each section after the first advances it by 2,
  // the same as advancing to the next *song* would.
  function buildLargePrintSongPages(name, rendered, firstPageNumber) {
    const sections = rendered.pages.length ? rendered.pages : [""];
    return sections.map((sectionHtml, sectionIndex) => {
      const sectionRendered = { ...rendered, pages: [sectionHtml] };
      const pageNumber1 = firstPageNumber === null ? null : firstPageNumber + sectionIndex * 2;
      const pageNumber2 = pageNumber1 === null ? null : pageNumber1 + 1;
      const page1 = buildSongPrintPage(name, sectionRendered, pageNumber1);
      const page2 = buildSongPrintPage(name, { ...sectionRendered, pages: [""] }, pageNumber2, true);
      return [page1, page2];
    });
  }

  // Only meaningful once both pages are attached and visible, same caveat
  // as fitPrintSongPage above.
  //
  // Doesn't reuse fitTextToBox directly, unlike every other fit in this
  // file — those fit one box to one height/width; this has to fit one
  // piece of content split across *two* independently-sized boxes (page
  // 1's own availableHeight1, page 2's own availableHeight2 — usually
  // close but not identical, since page 2 alone carries a "(continued)"
  // note), and, more importantly, has to choose *where* to split it.
  // Cutting at an arbitrary height (the midpoint of a doubled box, an
  // earlier version of this did) can land mid-line or mid-chorus, visually
  // chopping a heading or lyric in half across the page break — a real bug
  // that shipped before this was fixed. trySplit (below) walks
  // bodyContent's own top-level children (renderSong()'s own
  // .heading/.line/blockquote/pre/img chunks) instead, and only ever cuts
  // *between* two of them: a whole blockquote (chorus/bridge — several
  // lines wrapped in one element) moves to page 2 entirely rather than
  // being split mid-block, which is the case that most obviously exposed a
  // bad cut. It only ever *decides where* the cut falls, though — the
  // actual move happens once, below, after the search settles on a font
  // size and a matching index into page 1's own (unmodified until then)
  // children.
  function fitLargePrintSongPages(page1, page2) {
    const chordsHeight1 = page1.printChordsForNoteElement ? page1.printChordsForNoteElement.offsetHeight : 0;
    const chordsHeight2 = page2.printChordsForNoteElement ? page2.printChordsForNoteElement.offsetHeight : 0;
    const continuedHeight2 = page2.printContinuedNoteElement ? page2.printContinuedNoteElement.offsetHeight : 0;
    const availableHeight1 = PRINT_CONTENT_HEIGHT_PX - page1.printSongTitleElement.offsetHeight - chordsHeight1;
    const availableHeight2 = PRINT_CONTENT_HEIGHT_PX - page2.printSongTitleElement.offsetHeight - chordsHeight2 - continuedHeight2;
    const availableWidth = page1.printSongBody.clientWidth;
    const content = page1.printSongBodyContent;

    // How many of bodyContent's own children fit on page 1 without
    // exceeding availableHeight1, and whether everything *after* that
    // point still fits within availableHeight2, at a given font size.
    // offsetTop — not a running sum of offsetHeight — is what actually
    // accounts for the real margins between these children, including any
    // collapsing between adjacent ones; a manually-summed height would
    // silently drift from the real rendered layout. Nothing is moved here
    // — repeated for several candidate font sizes during the search below,
    // so it has to stay read-only.
    function trySplit(fontPx) {
      content.style.fontSize = `${fontPx}px`;
      const contentTop = content.offsetTop;
      const children = Array.from(content.children);
      let cutIndex = children.length;
      let prefixHeight = 0;
      for (let i = 0; i < children.length; i += 1) {
        const bottom = (children[i].offsetTop - contentTop) + children[i].offsetHeight;
        if (bottom > availableHeight1) { cutIndex = i; break; }
        prefixHeight = bottom;
      }
      const remaining = content.scrollHeight - prefixHeight;
      const fits = remaining <= availableHeight2 && content.scrollWidth <= availableWidth;
      return { cutIndex, fits };
    }

    let low = FIT_MIN_FONT_PX;
    let high = FIT_MAX_FONT_PX;
    let best = { fontPx: FIT_MIN_FONT_PX, ...trySplit(FIT_MIN_FONT_PX) };
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const result = trySplit(mid);
      if (result.fits) {
        best = { fontPx: mid, ...result };
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    content.style.fontSize = `${best.fontPx}px`;
    page2.printSongBodyContent.style.fontSize = `${best.fontPx}px`;
    // Moves the actual overflow nodes onto page 2 — not a clip-and-offset
    // trick against a *second*, separately-laid-out copy of the same
    // markup (buildLargePrintSongPages' own comment on why not) — so page
    // 1 keeps exactly the children just proven to fit its own budget, and
    // page 2 receives exactly, and only, the ones that didn't; neither
    // page's own .print-song-body needs an explicit height/overflow clip
    // at all, since there's nothing left over to clip.
    Array.from(content.children).slice(best.cutIndex)
      .forEach((child) => page2.printSongBodyContent.appendChild(child));
  }

  // A multi-page song sometimes needs one blank filler page in front of it
  // to align its own first page onto an even page number (alignSongStart,
  // below) — left unnumbered and explicitly marked, the same convention
  // real printed books use for a deliberately blank page, so it doesn't
  // read as a printing mistake.
  function buildBlankPrintPage() {
    const page = document.createElement("div");
    page.className = "print-page print-page-blank";
    const note = document.createElement("p");
    note.className = "print-blank-note";
    note.textContent = "This page is intentionally blank.";
    page.appendChild(note);
    return page;
  }

  // Whether a blank filler page has to go immediately before a song, so a
  // multi-page song's own spread lands as a true open-book pair — PT:
  // "keep songs on facing pages [for] double-sided printing"
  // (#facing-pages-checkbox, checked by default). An even page number and
  // the odd page immediately after it are what a reader actually sees
  // together when a bound book is opened (page 1 is always alone, on the
  // right); an odd-then-even pair never is, since it straddles two
  // different spreads instead of forming one.
  //
  // Checked before *every* song in sequence (showPrintBook/showPrintSetlist's
  // own running pageNumber), not just once at the front of the book — a
  // normal-print song's own page count varies now ({new_page} directives,
  // buildNormalPrintSongPages), so any song along the way, not only the
  // first, can land on an odd start after an earlier odd-length one.
  // Single-page songs are skipped entirely: there's no spread to protect,
  // so aligning them would just scatter blank pages through the book for
  // no benefit. Large print doesn't have this per-song variability (every
  // song is always exactly two pages, or two pages per {new_page} section
  // — buildLargePrintSongPages), so in practice this only ever fires
  // there for the first song the whole book — every later one is already
  // aligned automatically, since an even page count added to an even
  // start always lands on another even number — but the check itself
  // doesn't need to know that; it just always re-verifies.
  function alignSongStart(pageNumber, pageCount, keepFacingPages) {
    if (!keepFacingPages || pageCount <= 1 || pageNumber % 2 === 0) {
      return { pageNumber, blankPageNeeded: false };
    }
    return { pageNumber: pageNumber + 1, blankPageNeeded: true };
  }

  function enterPrintView() {
    closeSetlistNoteModal();
    setHidden(listView, true);
    setHidden(songView, true);
    setHidden(prevButton, true);
    setHidden(nextButton, true);
    setHidden(printSongButton, true);
    setHidden(songViewTitle, true);
    setHidden(backButton, true);
    setHidden(keySelect, true);
    setHidden(capoSelect, true);
    setHidden(menuBarOverflow, true);
    setHidden(menuBarOverflowToggle, true);
    setHidden(setlistView, true);
    setHidden(setlistIndexView, true);
    setHidden(printView, false);
    printInstrumentSelect.value = currentInstrument || "";
  }

  // Returns to whichever view was showing before print mode — the song or
  // setlist being viewed, if either, otherwise the list. Reuses
  // showSong()/showSetlist()/showList() directly rather than tracking a
  // separate "what to return to" flag: currentIndex/currentSetlistIndex
  // already record that, untouched by anything print mode does (both
  // showSong() and showSetlist() do reset the *other* one when entering,
  // which is exactly why checking currentIndex first here is safe — it's
  // never left over from before print mode was entered).
  function exitPrintView() {
    if (currentIndex >= 0) showSong(currentIndex);
    else if (currentSetlistIndex >= 0) showSetlist(currentSetlistIndex);
    else showList();
  }

  function showPrintSong() {
    const song = songs[currentSongIndex];
    if (!song) return;
    currentPrintRebuild = showPrintSong;
    // No front matter, facing-page alignment (a book-binding concept — see
    // alignSongStart's own comment), or floor-sheet mode makes sense for
    // one standalone song, so those stay hidden here; large print still
    // applies (used below), same as instrument selection.
    setHidden(includeTocLabel, true);
    setHidden(largePrintLabel, false);
    setHidden(facingPagesLabel, true);
    setHidden(floorSheetLabel, true);
    setHidden(floorSheetNotesLabel, true);
    setHidden(printInstrumentSelect, false);
    // ChordProSong/renderSong: bare globals from CHORDPROBOOK_BROWSER_BUNDLE
    // (see this function's own header comment above).
    const parsedSong = new ChordProSong(song.text);
    const rendered = renderSong(parsedSong, song.text, { transpose: currentTranspose, capo: currentCapo });
    // No page numbers either way — a standalone single-song print has no
    // book/contents page for one to refer back to (buildSongPrintPage's own
    // comment) — and no facing-page alignment concern either: that's a
    // book-binding concept (alignSongStart's own comment), and
    // there's no book here, just however many loose sheets this song itself
    // needs.
    if (largePrintCheckbox.checked) {
      const pairs = buildLargePrintSongPages(song.name, rendered, null);
      printContent.replaceChildren(...pairs.flat());
      enterPrintView();
      pairs.forEach(([page1, page2]) => fitLargePrintSongPages(page1, page2));
    } else {
      const pages = buildNormalPrintSongPages(song.name, rendered, null);
      printContent.replaceChildren(...pages);
      enterPrintView();
      pages.forEach(fitPrintSongPage);
    }
  }

  // Title + contents share one page (PT: "put the songbook title and TOC
  // on the same page") — unless there are enough entries that they
  // shouldn't: "if the number of pages goes over about 50 then use
  // multiple pages for the toc and put page numbers on the pages as well."
  // Read literally as a threshold on entry count (which is what actually
  // drives page count here, one song per page), not a second, separate
  // pass over the built pages to count them.
  const TOC_SPLIT_THRESHOLD = 50;
  const TOC_ENTRIES_PER_PAGE = 50;

  // How many front-matter pages (title + contents) entryCount produces —
  // needed *before* building anything, since every song page's own number
  // depends on how many pages precede it, and every contents entry's own
  // page number depends on that same count.
  function frontMatterPageCount(entryCount) {
    return entryCount > TOC_SPLIT_THRESHOLD ? Math.ceil(entryCount / TOC_ENTRIES_PER_PAGE) : 1;
  }

  // titleText goes through textContent, not an HTML string — unlike
  // "Songbook" (showPrintBook's own title, fixed at build time), a
  // setlist's own name (showPrintSetlist) is user content from the setlist
  // markdown, and this is the one caller that has to handle both without
  // knowing which it was given.
  //
  // "With chords for X" under the title, when an instrument is selected —
  // PT: readers need to know, from the title page alone, which instrument
  // the chord shapes throughout the book are for. Tied to currentInstrument
  // being set at all, not to whether any particular song actually has
  // diagrams (buildSongPrintPage's own smaller, per-song note is the
  // finer-grained version of that check).
  //
  // entries already carry their final pageNumber (or null — SPEC.md §6.1's
  // unresolved case, rendered as "—": a setlist entry with no matching song
  // has no page to point to, and a made-up number would be worse than
  // admitting there isn't one) — this function only lays them out, split
  // across pages of TOC_ENTRIES_PER_PAGE once there are more than
  // TOC_SPLIT_THRESHOLD of them, matching frontMatterPageCount()'s own math
  // exactly (same threshold, same chunk size) so the two never disagree
  // about how many pages this actually produces.
  function buildFrontMatterPages(titleText, entries) {
    const chunkSize = entries.length > TOC_SPLIT_THRESHOLD ? TOC_ENTRIES_PER_PAGE : entries.length || 1;
    const chunks = [];
    for (let i = 0; i < entries.length; i += chunkSize) chunks.push(entries.slice(i, i + chunkSize));
    if (chunks.length === 0) chunks.push([]); // no entries at all — still a title page

    return chunks.map((chunk, chunkIndex) => {
      const page = document.createElement("div");
      page.className = "print-page print-title-page print-toc";

      if (chunkIndex === 0) {
        const heading = document.createElement("h1");
        heading.textContent = titleText;
        page.appendChild(heading);
        if (currentInstrument) {
          const subtitle = document.createElement("p");
          subtitle.className = "print-chords-for";
          subtitle.textContent = `With chords for ${currentInstrument}`;
          page.appendChild(subtitle);
        }
      }

      const tocHeading = document.createElement("h2");
      tocHeading.textContent = chunks.length > 1 ? `Contents (${chunkIndex + 1}/${chunks.length})` : "Contents";
      page.appendChild(tocHeading);

      const list = document.createElement("ol");
      // Built via createElement/textContent rather than an HTML string of
      // list-item tags — not for the song titles' sake (escapeForInlineScript
      // only guards the *embedded JSON-LD* script tag, not this one), but
      // because this function's own source, embedded into the page via
      // .toString(), would otherwise contain that tag's own literal text —
      // indistinguishable, to a build step checking the *page's* markup for
      // pre-rendered list items, from the page actually shipping one. (Yes,
      // spelling it out that carefully above is deliberate, for the same
      // reason.)
      for (const entry of chunk) {
        const item = document.createElement("li");
        item.className = "print-toc-entry";
        const title = document.createElement("span");
        title.textContent = entry.name;
        const pageNumber = document.createElement("span");
        pageNumber.textContent = entry.pageNumber === null ? "—" : String(entry.pageNumber);
        item.appendChild(title);
        item.appendChild(pageNumber);
        list.appendChild(item);
      }
      page.appendChild(list);
      addPageNumber(page, chunkIndex + 1);
      return page;
    });
  }

  function showPrintBook() {
    currentPrintRebuild = showPrintBook;
    setHidden(includeTocLabel, false);
    setHidden(largePrintLabel, false);
    setHidden(facingPagesLabel, false);
    setHidden(floorSheetLabel, true);
    setHidden(floorSheetNotesLabel, true);
    setHidden(printInstrumentSelect, false);
    const large = largePrintCheckbox.checked;
    const keepFacingPages = facingPagesCheckbox.checked;
    const includeToc = includeTocCheckbox.checked;

    // Rendered once per song, up front — each song's own page *count* has
    // to be known before any page *number* can be assigned (alignSongStart
    // needs it too, to decide whether *this* song needs a blank page in
    // front of it), since every later song's number depends on how many
    // pages every earlier one actually took. Normally that's a flat 1 (one
    // rendered.pages section) or 2 (large print's own two-page spread per
    // section), but a song with its own {new_page} directive(s) takes one
    // page per section in normal print (buildNormalPrintSongPages) or one
    // section-pair per section in large print (buildLargePrintSongPages).
    // 0 instead of frontMatterPageCount() when the "Title page & contents"
    // checkbox is unticked (SPEC.md §13) — no front matter pages means
    // every song's own numbering starts from page 1 itself.
    let pageNumber = 1 + (includeToc ? frontMatterPageCount(songs.length) : 0);
    const songPages = [];
    const fitJobs = [];
    const tocEntries = songs.map((song) => {
      const parsedSong = new ChordProSong(song.text);
      // Each song in its own key/capo, not whatever is currently selected
      // on screen (SPEC.md §11) — that selection belongs to viewing one
      // song, not to a whole-book print a reader didn't make that choice
      // for.
      const rendered = renderSong(parsedSong, song.text, {});
      const sectionCount = rendered.pages.length || 1;
      const pageCount = large ? sectionCount * 2 : sectionCount;
      const aligned = alignSongStart(pageNumber, pageCount, keepFacingPages);
      if (aligned.blankPageNeeded) songPages.push(buildBlankPrintPage());
      pageNumber = aligned.pageNumber;
      const entryPageNumber = pageNumber;

      if (large) {
        const pairs = buildLargePrintSongPages(song.name, rendered, pageNumber);
        pairs.forEach(([page1, page2]) => {
          songPages.push(page1, page2);
          fitJobs.push(() => fitLargePrintSongPages(page1, page2));
        });
      } else {
        const pages = buildNormalPrintSongPages(song.name, rendered, pageNumber);
        pages.forEach((page) => {
          songPages.push(page);
          fitJobs.push(() => fitPrintSongPage(page));
        });
      }
      pageNumber += pageCount;
      return { name: song.name, pageNumber: entryPageNumber };
    });

    const frontPages = includeToc ? buildFrontMatterPages("Songbook", tocEntries) : [];

    printContent.replaceChildren(...frontPages, ...songPages);
    enterPrintView();
    fitJobs.forEach((job) => job());
  }

  // "Old school" floor sheets (SPEC.md §13, PT: "for putting at your feet
  // while you play") — just each entry's own name in a numbered list, no
  // chords or lyrics at all, so an entry with no matching song
  // (entry.songIndex === -1) still gets a line here, unlike every other
  // print path in this file — there's no page to build *for* a song that
  // isn't there, but there's nothing stopping a plain name from being
  // listed. Grouped the same consecutive-setName-run way
  // groupEntriesIntoSets (chordpro_crate.js) groups a setlist file's own
  // entries in the first place — entries sharing a setName with the one
  // right before them stay together, and a changed or absent setName
  // starts a new group. A setlist with no "#" sets at all becomes a
  // single group under its own name; a setlist that does use sets gets one
  // page per set (plus, if the setlist mixes in ungrouped entries before
  // its first "#" heading, one further page for just those, also under the
  // setlist's own name).
  function groupSetlistEntriesForFloorSheet(entries) {
    const groups = [];
    for (const entry of entries) {
      const last = groups[groups.length - 1];
      if (last && last.setName === entry.setName) last.entries.push(entry);
      else groups.push({ setName: entry.setName, entries: [entry] });
    }
    return groups;
  }

  // heading/entries/includeNotes -> one floor-sheet page. Notes (when
  // included) reuse renderNoteMarkdown, same as the on-screen setlist view
  // — no separate rendering path for print here. No page number: like
  // showPrintSong's own standalone print, there's no book/contents page
  // for one to refer back to.
  function buildFloorSheetPage(heading, entries, includeNotes) {
    const page = document.createElement("div");
    page.className = "print-page print-floor-sheet";
    const title = document.createElement("h1");
    title.className = "print-floor-sheet-title";
    title.textContent = heading;
    page.appendChild(title);

    const list = document.createElement("ol");
    list.className = "print-floor-sheet-list";
    for (const entry of entries) {
      const item = document.createElement("li");
      const name = document.createElement("span");
      name.className = "print-floor-sheet-name";
      name.textContent = entry.name;
      item.appendChild(name);
      if (includeNotes && entry.notes) {
        const note = document.createElement("div");
        note.className = "print-floor-sheet-note";
        renderNoteMarkdown(note, entry.notes);
        item.appendChild(note);
      }
      list.appendChild(item);
    }
    page.appendChild(list);

    page.printFloorSheetTitleElement = title;
    page.printFloorSheetListElement = list;
    return page;
  }

  function buildFloorSheetPages(setlist, includeNotes) {
    const hasSets = setlist.entries.some((entry) => entry.setName);
    if (!hasSets) return [buildFloorSheetPage(setlist.name, setlist.entries, includeNotes)];
    return groupSetlistEntriesForFloorSheet(setlist.entries).map((group) =>
      buildFloorSheetPage(group.setName || setlist.name, group.entries, includeNotes),
    );
  }

  // Same binary-search fit as fitPrintSongPage, against just the list —
  // the heading stays whatever size it renders at, same fixed-title/
  // scaled-body split fitPrintSongPage already uses.
  function fitFloorSheetPage(page) {
    const availableHeight = PRINT_CONTENT_HEIGHT_PX - page.printFloorSheetTitleElement.offsetHeight;
    fitTextToBox(page.printFloorSheetListElement, availableHeight, PRINT_CONTENT_WIDTH_PX);
  }

  // Same shape as showPrintBook, scoped to one setlist's own entries in
  // setlist order, each in that entry's own transpose/capo override
  // (falling back to the song's own value when an entry doesn't specify
  // one — renderSong's own `transpose ?? chordProSong.transpose` already
  // does this correctly when entry.transpose/entry.capo are simply
  // undefined, so there's nothing extra to resolve here). An entry with no
  // matching song (entry.songIndex === -1 — SPEC.md §6.1's unresolved/
  // ambiguous case) has nothing to print a page *for*, so it's skipped
  // from songPages, but still listed in the contents page (with "—" in
  // place of a page number) — silently dropping it from the printed book
  // entirely would hide the exact mismatch this whole feature is meant to
  // surface. frontMatterPageCount() is given every entry, resolved or not,
  // for the same reason: the contents page lists all of them either way.
  function showPrintSetlist(index) {
    const setlist = setlists[index];
    if (!setlist) return;
    currentPrintRebuild = () => showPrintSetlist(index);
    const floorSheet = floorSheetCheckbox.checked;
    // Floor-sheet mode is a setlist-only alternative to the normal
    // book-style print below, not a variant of it (SPEC.md §13) — none of
    // large print/facing pages/instrument/TOC apply to a page that carries
    // no chords or lyrics at all, so they're hidden rather than merely
    // ignored, and the function returns before reaching any of that code.
    setHidden(floorSheetLabel, false);
    setHidden(floorSheetNotesLabel, !floorSheet);
    setHidden(includeTocLabel, floorSheet);
    setHidden(largePrintLabel, floorSheet);
    setHidden(facingPagesLabel, floorSheet);
    setHidden(printInstrumentSelect, floorSheet);
    if (floorSheet) {
      const pages = buildFloorSheetPages(setlist, floorSheetNotesCheckbox.checked);
      printContent.replaceChildren(...pages);
      enterPrintView();
      pages.forEach(fitFloorSheetPage);
      return;
    }

    const large = largePrintCheckbox.checked;
    const keepFacingPages = facingPagesCheckbox.checked;
    const includeToc = includeTocCheckbox.checked;
    let pageNumber = 1 + (includeToc ? frontMatterPageCount(setlist.entries.length) : 0);

    const songPages = [];
    const fitJobs = [];
    const tocEntries = setlist.entries.map((entry) => {
      if (entry.songIndex < 0) return { name: entry.name, pageNumber: null };
      const song = songs[entry.songIndex];
      const parsedSong = new ChordProSong(song.text);
      const rendered = renderSong(parsedSong, song.text, { transpose: entry.transpose, capo: entry.capo });
      const sectionCount = rendered.pages.length || 1;
      const pageCount = large ? sectionCount * 2 : sectionCount;
      const aligned = alignSongStart(pageNumber, pageCount, keepFacingPages);
      if (aligned.blankPageNeeded) songPages.push(buildBlankPrintPage());
      pageNumber = aligned.pageNumber;
      const entryPageNumber = pageNumber;

      if (large) {
        const pairs = buildLargePrintSongPages(entry.name, rendered, pageNumber);
        pairs.forEach(([page1, page2]) => {
          songPages.push(page1, page2);
          fitJobs.push(() => fitLargePrintSongPages(page1, page2));
        });
      } else {
        const pages = buildNormalPrintSongPages(entry.name, rendered, pageNumber);
        pages.forEach((page) => {
          songPages.push(page);
          fitJobs.push(() => fitPrintSongPage(page));
        });
      }
      pageNumber += pageCount;
      return { name: entry.name, pageNumber: entryPageNumber };
    });
    const frontPages = includeToc ? buildFrontMatterPages(setlist.name, tocEntries) : [];

    printContent.replaceChildren(...frontPages, ...songPages);
    enterPrintView();
    fitJobs.forEach((job) => job());
  }

  // Setlists (SPEC.md §6) — display and print only in this pass, per PT's
  // own ordering ("just display them and make them printable before
  // tackling editing them and making new ones"). No hamburger menu here
  // either, same as instrument selection/print: the setlist list is just
  // another section of #list-view, and #setlist-view is a fourth
  // top-level view alongside list/song/print (enterPrintView() hides it
  // the same way it hides the other two; showList()/showSong() hide it
  // for the same reason they hide #print-view).
  function updateToggleNotesButtonLabel() {
    toggleNotesButton.textContent = notesVisible ? "Hide notes" : "Show notes";
  }

  // One row per entry, grouped under a heading whenever setName changes
  // from the entry before it (SPEC.md §6's own set groupings, e.g. "Set 1"/
  // "Set 2" in the source markdown, now expressed as nested MusicPlaylist
  // entities rather than a flat property — flattenSetlistParts, above, is
  // what attaches setName/setNotes to each entry) — entries without a
  // setName at all just don't get a heading, rather than one reading
  // "undefined".
  function renderSetlistEntries(setlist) {
    setlistEntriesElement.replaceChildren();
    let lastSetName = null;
    // Tracks each entry's own position within the *playable* subset —
    // getActivePlaylist()'s own filtering (songIndex >= 0), kept in exact
    // step with it here so a click on entry N always opens showSong() at
    // the same position getActivePlaylist() would put it at.
    let playablePosition = 0;
    setlist.entries.forEach((entry, index) => {
      if (entry.setName && entry.setName !== lastSetName) {
        const heading = document.createElement("h3");
        heading.className = "setlist-set-name";
        heading.textContent = entry.setName;
        setlistEntriesElement.appendChild(heading);
        lastSetName = entry.setName;
        // Freeform text between the set's own "#" heading and this, its
        // first entry (e.g. "Tune guitars to drop D now") — no searchText
        // property, so "Find in this setlist" (applySetlistEntriesFilter)
        // treats it the same as the heading right above it: always shown.
        if (entry.setNotes) {
          const setNotes = document.createElement("div");
          setNotes.className = "setlist-set-notes";
          renderNoteMarkdown(setNotes, entry.setNotes);
          setlistEntriesElement.appendChild(setNotes);
        }
      }
      const isPlayable = entry.songIndex >= 0;
      setlistEntriesElement.appendChild(
        buildSetlistEntryRow(entry, index + 1, isPlayable ? playablePosition : null),
      );
      if (isPlayable) playablePosition += 1;
    });
    // Re-applies whatever's currently typed in "Find in this setlist"
    // (below) — this function also runs on a plain notes-visibility toggle
    // (toggleNotesButton's own handler), not only when a genuinely
    // different setlist opens (showSetlist, which clears the search box
    // first); without this, that toggle would silently drop an active
    // filter by rebuilding every row with none of them hidden.
    applySetlistEntriesFilter();
  }

  // "Find in this setlist" (#setlist-entries-search) — filters
  // #setlist-entries' own entry rows (never the "Set N" heading rows
  // interspersed among them, identifiable by having no searchText at all —
  // see buildSetlistEntryRow's own comment) by substring match against each
  // row's own searchText. Not index-parallel with `setlist.entries` the way
  // #song-search/#setlist-search are with their own arrays: headings mean a
  // row's position in setlistEntriesElement.children doesn't line up with
  // its position in setlist.entries, so matching is done from data stashed
  // directly on each row at build time instead.
  function applySetlistEntriesFilter() {
    const query = setlistEntriesSearchInput.value.trim().toLowerCase();
    Array.from(setlistEntriesElement.children).forEach((item) => {
      if (item.searchText === undefined) return; // a "Set N" heading — always shown
      setHidden(item, query.length > 0 && !item.searchText.includes(query));
    });
  }

  // position (its own display number, 1-based) is just for the row's own
  // label; playablePosition (null for an unresolved entry) is what
  // showSong() actually needs — see renderSetlistEntries' own comment on
  // why the two can diverge (an unresolved entry earlier in the list still
  // counts toward `position`, but never toward `playablePosition`).
  function buildSetlistEntryRow(entry, position, playablePosition) {
    const row = document.createElement("div");
    row.className = "setlist-entry";

    const positionElement = document.createElement("span");
    positionElement.className = "setlist-entry-position";
    positionElement.textContent = String(position);
    row.appendChild(positionElement);

    // A link only when there's a real song behind this entry to jump to —
    // an unresolved entry (below) has nothing showSong() could open.
    const nameElement = document.createElement(entry.songIndex >= 0 ? "a" : "span");
    nameElement.className = "setlist-entry-name";
    nameElement.textContent = entry.name;
    if (entry.songIndex >= 0) {
      nameElement.href = "#";
      nameElement.addEventListener("click", (event) => {
        event.preventDefault();
        showSong(playablePosition);
      });
    }
    row.appendChild(nameElement);
    // The underlying song's own credit/key (SPEC.md §12), never anything of
    // the entry's own — an entry carries no composer/performer/subtitle/key
    // itself, only transpose/capo overrides and freeform notes (§6/§7).
    // null for an unresolved entry (entry.songIndex === -1), which
    // appendListCredit treats the same as a resolved song with nothing to
    // show: nothing rendered.
    appendListCredit(row, entry.songIndex >= 0 ? songs[entry.songIndex] : null);

    // Directly actionable, not just descriptive: matchStatus/
    // matchCandidates are written at crate-build time (chordpro_crate.js)
    // from this entry's own heading text in the setlist markdown — a
    // mismatch here means that heading doesn't clearly identify one real
    // song, which is fixed by editing the .setlist.md file and rebuilding
    // the crate, not by anything this read-only page can do itself
    // (SPEC.md §2 rules out writing back to the source folder). The full
    // message lives in `title` (a native tooltip on hover/focus) rather
    // than sitting in the row itself — PT: a small "~" mark instead of a
    // full warning box, so a row with a mismatch doesn't visually dominate
    // the rows around it; the detail is still one hover away, not lost.
    if (entry.matchStatus !== "exact") {
      const statusMessages = {
        unresolved: "no matching song found — check this entry's heading against the song titles",
        ambiguous: "matches more than one song — make this entry's heading more specific",
        fuzzy: "matched approximately, not exactly — check this is the right song",
      };
      const message = statusMessages[entry.matchStatus] || entry.matchStatus;
      const status = document.createElement("span");
      status.className = "setlist-entry-status";
      status.textContent = "~";
      status.title = message;
      status.setAttribute("aria-label", message);
      row.appendChild(status);
    }

    if (entry.notes) {
      const notes = document.createElement("div");
      notes.className = "setlist-entry-notes";
      renderNoteMarkdown(notes, entry.notes);
      setHidden(notes, !notesVisible);
      row.appendChild(notes);
    }

    // A plain JS property, not an attribute — nothing outside this file
    // ever needs to read it back off real HTML, only applySetlistEntriesFilter
    // (below), so there's no reason to serialize it into the DOM at all.
    // Combines the same text the row actually shows (heading, credit,
    // notes) — matching "Find a song"'s own precedent (SPEC.md §12) of
    // searching what's displayed, not raw underlying data the row doesn't
    // surface.
    const credit = entry.songIndex >= 0 ? creditFor(songs[entry.songIndex]) : "";
    row.searchText = `${entry.name} ${credit} ${entry.notes || ""}`.toLowerCase();

    return row;
  }

  function showSetlist(index) {
    const setlist = setlists[index];
    if (!setlist) return;
    currentSetlistIndex = index;
    currentIndex = -1;
    currentSongIndex = -1;
    closeSetlistNoteModal();

    setHidden(listView, true);
    setHidden(songView, true);
    setHidden(prevButton, true);
    setHidden(nextButton, true);
    setHidden(printSongButton, true);
    setHidden(songViewTitle, true);
    setHidden(backButton, true);
    setHidden(keySelect, true);
    setHidden(capoSelect, true);
    setHidden(menuBarOverflow, true);
    setHidden(menuBarOverflowToggle, true);
    setHidden(printView, true);
    setHidden(setlistIndexView, true);
    setHidden(setlistView, false);

    setlistViewTitle.textContent = setlist.name;
    updateToggleNotesButtonLabel();
    // Cleared here, not inside renderSetlistEntries itself — that function
    // also runs on a plain notes-visibility toggle within the *same*
    // setlist (toggleNotesButton's own handler), where a search the reader
    // just typed should survive the refresh, not vanish. Opening a setlist
    // at all — including re-opening the one already open, from the index —
    // is the one point a leftover query from a previous setlist should not.
    setlistEntriesSearchInput.value = "";
    renderSetlistEntries(setlist);
  }

  function showSetlistIndex() {
    currentIndex = -1;
    currentSongIndex = -1;
    currentSetlistIndex = -1;
    closeSetlistNoteModal();
    setHidden(listView, true);
    setHidden(songView, true);
    setHidden(prevButton, true);
    setHidden(nextButton, true);
    setHidden(printSongButton, true);
    setHidden(songViewTitle, true);
    setHidden(backButton, true);
    setHidden(keySelect, true);
    setHidden(capoSelect, true);
    setHidden(menuBarOverflow, true);
    setHidden(menuBarOverflowToggle, true);
    setHidden(printView, true);
    setHidden(setlistView, true);
    setHidden(setlistIndexView, false);
  }

  function showList() {
    currentIndex = -1;
    currentSongIndex = -1;
    currentSetlistIndex = -1;
    closeSetlistNoteModal();
    setHidden(listView, false);
    setHidden(songView, true);
    setHidden(prevButton, true);
    setHidden(nextButton, true);
    setHidden(printSongButton, true);
    setHidden(songViewTitle, true);
    setHidden(backButton, true);
    setHidden(keySelect, true);
    setHidden(capoSelect, true);
    setHidden(menuBarOverflow, true);
    setHidden(menuBarOverflowToggle, true);
    setHidden(chordDiagramsPanel, true);
    setHidden(printView, true);
    setHidden(setlistView, true);
    setHidden(setlistIndexView, true);
  }

  // Once a setlist is open, it *is* "the list" (PT) — next/previous page
  // through that setlist's own order, not the global song list, until the
  // reader explicitly leaves it (the "Back to songs" button on
  // #setlist-index-view, or a song opened from the global list directly).
  // currentSetlistIndex (-1 for "no active setlist") decides which; this
  // is the one place that decision gets made, so showSong() and the
  // prev/next handlers never have to know which context they're in
  // themselves — just what position they're at within whichever this
  // returns. Position, not song identity: a setlist entry's own place in
  // *this* list is what "next"/"previous" and the disabled state at either
  // end have to be relative to, not the entry's underlying song's place in
  // the alphabetical global list.
  function getActivePlaylist() {
    if (currentSetlistIndex >= 0) {
      return setlists[currentSetlistIndex].entries
        .filter((entry) => entry.songIndex >= 0)
        .map((entry) => ({ songIndex: entry.songIndex, transpose: entry.transpose, capo: entry.capo, notes: entry.notes }));
    }
    return songs.map((_song, index) => ({ songIndex: index, transpose: undefined, capo: undefined, notes: "" }));
  }

  // position indexes into getActivePlaylist(), not directly into `songs` —
  // identical to a song index while browsing the global list (that
  // playlist is just every song, in order), but not once a setlist is
  // active. transpose/capo come from whichever slot that playlist has at
  // this position: undefined for the global list (nothing to override),
  // or a setlist entry's own override, if it has one (SPEC.md §6) — falling
  // back to the song's session-saved or default value, exactly as if
  // nothing had overridden it, when it doesn't.
  function showSong(position) {
    const playlist = getActivePlaylist();
    const slot = playlist[position];
    if (!slot) return;
    const song = songs[slot.songIndex];
    if (!song) return;
    currentIndex = position;
    currentSongIndex = slot.songIndex;

    if (slot.transpose !== undefined || slot.capo !== undefined) {
      currentTranspose = slot.transpose ?? null;
      currentCapo = slot.capo ?? null;
    } else {
      // Restores whatever was last chosen for this song's own id, this
      // session — falling back to null (the song's own key/capo) for a
      // song that's never been touched, or when nothing was saved at all.
      const saved = loadSavedSelections()[song.id];
      currentTranspose = saved ? saved.transpose : null;
      currentCapo = saved ? saved.capo : null;
    }

    // Visibility toggled before content/fit, not after: fitSongContent()
    // reads appBar.offsetHeight and songContent.clientWidth, both of which
    // are 0 for a display:none element — measuring before these are shown
    // would size the fit against the wrong (empty) box.
    setHidden(listView, true);
    setHidden(songView, false);
    setHidden(prevButton, false);
    setHidden(nextButton, false);
    setHidden(printSongButton, false);
    setHidden(songViewTitle, false);
    setHidden(backButton, false);
    setHidden(menuBarOverflow, false);
    setHidden(menuBarOverflowToggle, false);
    setHidden(printView, true);
    setHidden(setlistView, true);
    setHidden(setlistIndexView, true);
    menuBarOverflow.classList.remove("open");
    // Meaningless outside a setlist — there's no entry, and so no note, to
    // show or hide a modal for (SPEC.md §6.2) — hidden the same way every
    // other setlist-only control in this bar already is.
    setHidden(setlistNotesLabel, currentSetlistIndex < 0);

    songViewTitle.textContent = song.name;
    prevButton.disabled = position <= 0;
    nextButton.disabled = position >= playlist.length - 1;

    renderCurrentSong();

    // Re-evaluated on every call, not just once per setlist — a different
    // entry can have a different note (or none at all), so this has to be
    // freshly decided each time a song is opened, including navigating
    // between two songs that are both in the same setlist.
    if (currentSetlistIndex >= 0 && slot.notes && setlistNotesCheckbox.checked) {
      openSetlistNoteModal(slot.notes);
    } else {
      closeSetlistNoteModal();
    }
  }

  // A modal shown over the song itself when opening it from within a
  // setlist (SPEC.md §6.2) — PT: "put up a modal over the song with the
  // notes on it eg 'Tune guitars to drop D now'". Rendered as Markdown, the
  // same as the setlist-list's own entry/set notes (§6/§6.2) — it's the
  // exact same note text, just surfaced a second time at the moment it's
  // actually needed (about to play this song), not only back in the list a
  // reader may have scrolled away from already. Dismissed by a click
  // anywhere on it (PT's own spec), not just a specific close button.
  function openSetlistNoteModal(notes) {
    renderNoteMarkdown(setlistNoteModalContent, notes);
    setHidden(setlistNoteModal, false);
  }
  function closeSetlistNoteModal() {
    setHidden(setlistNoteModal, true);
  }

  // "Back to list" means back to whichever list is currently active — the
  // setlist a song was opened from, if any, otherwise the global list.
  // Not the same check as exitPrintView()'s own (which also has to
  // consider "back to the song itself"): this button only ever shows while
  // a song is open, so there's no "back to a song" case to worry about
  // here.
  function backToCurrentList() {
    if (currentSetlistIndex >= 0) showSetlist(currentSetlistIndex);
    else showList();
  }

  populateInstrumentSelect(instrumentSelect);
  populateInstrumentSelect(printInstrumentSelect);

  // #view-setlists-button, not the setlist list shown inline at all times —
  // PT: "don't just put a list down the bottom unless there's a button to
  // go to it." Built once, same as the song list below; only shown at all
  // if the crate actually has setlists.
  if (setlists.length) {
    setHidden(viewSetlistsButton, false);
    setlists.forEach((setlist, index) => {
      const item = document.createElement("li");
      const link = document.createElement("a");
      link.href = "#";
      link.textContent = setlist.name;
      link.addEventListener("click", (event) => {
        event.preventDefault();
        showSetlist(index);
      });
      item.appendChild(link);
      setlistListElement.appendChild(item);
    });
  } else {
    setHidden(viewSetlistsButton, true);
  }
  viewSetlistsButton.addEventListener("click", showSetlistIndex);
  backFromSetlistIndexButton.addEventListener("click", showList);

  // "Find a setlist" — same idea as "Find a song" below (#song-search),
  // filtering #setlist-list's own rows in place by case-insensitive
  // substring match against the setlist's own name. #setlist-list is
  // index-parallel with `setlists` (built from it, in the same order, just
  // above), so filtering by index needs no querySelector/lookup, same as
  // the song list.
  setlistSearchInput.addEventListener("input", () => {
    const query = setlistSearchInput.value.trim().toLowerCase();
    Array.from(setlistListElement.children).forEach((item, index) => {
      setHidden(item, query.length > 0 && !setlists[index].name.toLowerCase().includes(query));
    });
  });

  setlistEntriesSearchInput.addEventListener("input", applySetlistEntriesFilter);

  // "Any click on that should make it go away" (PT, SPEC.md §6.2) — the
  // whole modal is the dismiss target, not a specific close button.
  setlistNoteModal.addEventListener("click", closeSetlistNoteModal);
  // Unchecking while a note is already showing hides it immediately, rather
  // than waiting for the reader to navigate to another song before the new
  // preference takes effect.
  setlistNotesCheckbox.addEventListener("change", () => {
    if (!setlistNotesCheckbox.checked) closeSetlistNoteModal();
  });

  songs.forEach((song, index) => {
    const item = document.createElement("li");
    const link = document.createElement("a");
    link.href = "#";
    // Setting textContent first, then appendChild-ing credit/key after —
    // not the other way around: textContent replaces all of an element's
    // existing children with one text node, so anything appended afterward
    // survives, but anything appended *before* would be wiped out.
    link.textContent = song.name;
    // Credit/key live inside the link itself, not as siblings after it, so
    // the whole row — not just the title text — is one clickable target and
    // wraps together as a unit (see #song-list a's own flex-row CSS above).
    appendListCredit(link, song);
    link.addEventListener("click", (event) => {
      event.preventDefault();
      showSong(index);
    });
    item.appendChild(link);
    songListElement.appendChild(item);
  });

  // "Find a song" — filters #song-list's own rows in place by substring
  // match, ported from chordprosite's own #searchBox (template.njk); the
  // list is index-parallel with `songs` (built from it, in the same order,
  // just above), so filtering by index needs no querySelector/lookup.
  //
  // Array.from(...) — not a stylistic choice: a real element's .children is
  // a live HTMLCollection, which has no .forEach at all (unlike NodeList,
  // which does). This did nothing at all in a real browser as a result —
  // caught only by actually opening the page, since this file's own fake
  // DOM models .children as a plain array, which does have one.
  // Matches against the same text the row actually shows (SPEC.md §12) —
  // the title plus whichever one credit creditFor() picked, not all of
  // composer/performer/subtitle independently: a song hidden behind its
  // composer's name should be findable by typing that name, but there's no
  // reason to also match a performer/subtitle the row never displays.
  songSearchInput.addEventListener("input", () => {
    const query = songSearchInput.value.trim().toLowerCase();
    Array.from(songListElement.children).forEach((item, index) => {
      const song = songs[index];
      const haystack = `${song.name} ${creditFor(song)}`.toLowerCase();
      setHidden(item, query.length > 0 && !haystack.includes(query));
    });
  });

  backButton.addEventListener("click", backToCurrentList);
  prevButton.addEventListener("click", () => { if (currentIndex > 0) showSong(currentIndex - 1); });
  nextButton.addEventListener("click", () => {
    if (currentIndex < getActivePlaylist().length - 1) showSong(currentIndex + 1);
  });

  // Attached once, here, rather than freshly inside every renderCurrentSong()
  // call — a real browser would otherwise accumulate one more "change"
  // listener on the same element each time a song opens, all of them firing
  // on the next change. Reading songs[currentSongIndex]/parsedSong.key live
  // (rather than closing over values captured when the song first opened)
  // is what makes that safe: this pair of handlers works correctly no
  // matter which song is current when either one actually fires.
  keySelect.addEventListener("change", () => {
    const parsedSong = new ChordProSong(songs[currentSongIndex].text);
    currentTranspose = parsedSong.key ? keySelect.value : parseInt(keySelect.value, 10);
    // Matches chordprosite's own key-change handler (`display(this.value,
    // 0)`): picking a different key always clears any capo choice back to
    // none, rather than keeping a capo picked for a different key.
    currentCapo = 0;
    saveCurrentSelection();
    renderCurrentSong();
  });
  capoSelect.addEventListener("change", () => {
    currentCapo = capoSelect.value === "" ? 0 : parseInt(capoSelect.value, 10);
    saveCurrentSelection();
    renderCurrentSong();
  });
  // Not part of saveCurrentSelection()/the per-song sessionStorage record —
  // see currentInstrument's own declaration above for why.
  instrumentSelect.addEventListener("change", () => {
    setCurrentInstrument(instrumentSelect.value);
    renderCurrentSong();
  });
  toggleChordsButton.addEventListener("click", () => {
    chordsHidden = !chordsHidden;
    updateToggleChordsButtonLabel();
    songContent.classList.toggle("chords-hidden", chordsHidden);
  });
  // #menu-bar-overflow-toggle/#menu-bar-overflow only do anything visible
  // below the small-screen breakpoint (their own CSS) — harmless to wire
  // unconditionally above it, since the toggle itself stays hidden there.
  //
  // #menu-bar-overflow is position: fixed, not absolute, when open (its
  // own CSS) — #app-bar has overflow-x: auto (so the icon row itself can
  // scroll rather than wrap on a truly tiny screen), and per the CSS
  // overflow spec, setting overflow-x to anything but visible silently
  // forces overflow-y to 'auto' too, which would clip an absolutely
  // positioned descendant the instant it extends past #app-bar's own
  // bottom edge — exactly what a dropdown does. position: fixed escapes
  // that (its containing block is the viewport, not #app-bar), at the cost
  // of needing its own top set here rather than a CSS top: 100%, which
  // only means something relative to a box, not the viewport.
  menuBarOverflowToggle.addEventListener("click", () => {
    if (!menuBarOverflow.classList.contains("open")) {
      menuBarOverflow.style.top = `${appBar.getBoundingClientRect().bottom + 6}px`;
    }
    menuBarOverflow.classList.toggle("open");
  });
  // The print-banner's own copy of the same control — PT: let the
  // instrument be picked/changed from print preview itself, not only from
  // a song viewed beforehand. Redraws whatever's currently on screen
  // (single song, whole book, or a setlist) with the new choice rather
  // than requiring a trip back out of print mode to see the effect.
  printInstrumentSelect.addEventListener("change", () => {
    setCurrentInstrument(printInstrumentSelect.value);
    if (currentPrintRebuild) currentPrintRebuild();
  });
  // No separate state to sync here — largePrintCheckbox.checked is read
  // directly wherever large print matters (showPrintSong/showPrintBook/
  // showPrintSetlist), and a checkbox's own checked state is unaffected by
  // hiding/showing it (setHidden's classList toggle, entering/leaving print
  // view), so there's nothing to restore on re-entry either.
  largePrintCheckbox.addEventListener("change", () => {
    if (currentPrintRebuild) currentPrintRebuild();
  });
  // Checked by default in the markup itself (<input ... checked>), not set
  // here — PT: default on for double-sided printing. Same no-separate-
  // state reasoning as largePrintCheckbox just above.
  facingPagesCheckbox.addEventListener("change", () => {
    if (currentPrintRebuild) currentPrintRebuild();
  });
  // Checked by default (SPEC.md §13) — unticking it skips
  // buildFrontMatterPages entirely (showPrintBook/showPrintSetlist), for a
  // reader who's printing a short set and doesn't want a title/contents
  // page ahead of it. Same no-separate-state reasoning as the checkboxes
  // above.
  includeTocCheckbox.addEventListener("change", () => {
    if (currentPrintRebuild) currentPrintRebuild();
  });
  // Only ever visible/relevant for a setlist print (showPrintSetlist shows
  // floorSheetLabel; showPrintSong/showPrintBook never do — see those
  // functions' own setHidden calls), so there's no need to guard this
  // listener itself on what's currently being printed.
  floorSheetCheckbox.addEventListener("change", () => {
    setHidden(floorSheetNotesLabel, !floorSheetCheckbox.checked);
    if (currentPrintRebuild) currentPrintRebuild();
  });
  floorSheetNotesCheckbox.addEventListener("change", () => {
    if (currentPrintRebuild) currentPrintRebuild();
  });

  printSongButton.addEventListener("click", showPrintSong);
  printBookButton.addEventListener("click", showPrintBook);
  printNowButton.addEventListener("click", () => window.print());
  donePrintingButton.addEventListener("click", exitPrintView);
  // Back to the setlist *index* (one level up), not all the way to the
  // global song list — "Back to songs" on #setlist-index-view is the one
  // that goes there.
  backFromSetlistButton.addEventListener("click", showSetlistIndex);
  printSetlistButton.addEventListener("click", () => showPrintSetlist(currentSetlistIndex));
  toggleNotesButton.addEventListener("click", () => {
    notesVisible = !notesVisible;
    updateToggleNotesButtonLabel();
    renderSetlistEntries(setlists[currentSetlistIndex]);
  });
  // Escape only exits print mode specifically — it's not a general
  // "close whatever's open" shortcut elsewhere in this app, just the one
  // PT asked to be told about before printing, as an easy way back.
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !isHidden(printView)) exitPrintView();
  });

  // Full screen — usable from any view (see #fullscreen-button's own CSS
  // comment); a plain toggle against the Fullscreen API rather than
  // tracking its own state, since fullscreenchange also fires when the
  // browser itself exits fullscreen (Escape key, unrelated to this app's
  // own Escape handler above, which only ever checks print view).
  // Only the accessible label changes with state, not the glyph itself —
  // this button is a fixed-size icon square (matches prev/next/print/
  // fullscreen's shared row style), and "Exit full screen" as literal
  // textContent wraps and overflows a box that small.
  function updateFullscreenButtonLabel() {
    const label = document.fullscreenElement ? "Exit full screen" : "Full screen";
    fullscreenButton.title = label;
    fullscreenButton.setAttribute("aria-label", label);
  }
  fullscreenButton.addEventListener("click", () => {
    const request = document.fullscreenElement
      ? document.exitFullscreen()
      : document.documentElement.requestFullscreen();
    // Both return a promise that can reject (permissions policy, calling
    // it outside a genuine user gesture in some browser) — nothing useful
    // to do about that for a convenience feature beyond not leaving an
    // unhandled rejection behind.
    request.catch(() => {});
  });
  document.addEventListener("fullscreenchange", updateFullscreenButtonLabel);
  updateFullscreenButtonLabel();
  updateToggleChordsButtonLabel();

  showList();
}

export function renderSongbookHtml(crateJson) {
  const embeddedJson = escapeForInlineScript(JSON.stringify(crateJson, null, 2));

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Songbook</title>
<style>
/* High contrast, on PT's explicit instruction: no filled panels behind any
   text (no --surface-alt tint anywhere — chorus/bridge and tab blocks are
   marked by a rule/border, never a background fill), the page reduced to
   plain black-on-white (white-on-black under prefers-color-scheme: dark),
   and --chord left constant across both themes rather than following
   --ink/--bg, so it stays the one bright, unmistakable colour on the page
   — reserved for chord names and nothing else, which is why every other
   control below uses --ink/--accent (effectively black/white) rather than
   reaching for colour of its own.

   .hidden still carries !important for the reason recorded in
   initSongbookApp's own setHidden() — an ID selector elsewhere in this
   block would otherwise beat a plain .hidden rule on the same element. */
:root {
  --bg: #ffffff;
  --surface: #ffffff;
  --ink: #000000;
  --muted: #555555;
  --accent: #000000;
  --accent-contrast: #ffffff;
  --border: #000000;
  --chord: #ff0000;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #000000;
    --surface: #000000;
    --ink: #ffffff;
    --muted: #b3b3b3;
    --accent: #ffffff;
    --accent-contrast: #000000;
    --border: #ffffff;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  font-family: Georgia, "Iowan Old Style", "Palatino Linotype", serif;
  line-height: 1.5;
}
.hidden { display: none !important; }

/* One single-line bar, always — never a second row. #prev-song-button is
   first, so it's leftmost by DOM order; #next-song-button gets its own
   margin-left: auto (below) to push itself all the way to the right edge,
   since the title that used to do that job by taking flex: 1 has moved
   into #song-content itself (see #song-header below) — freeing up this
   bar's height for song content, at the cost of needing an explicit way to
   hold prev/next apart now that nothing else in the bar is elastic. If the
   bar's total content can't fit a given viewport, it scrolls horizontally
   (overflow-x) rather than wrapping to a second line — wrapping is exactly
   the two-line layout this replaced. */
#app-bar {
  position: sticky;
  top: 0;
  z-index: 10;
  display: flex;
  align-items: center;
  flex-wrap: nowrap;
  overflow-x: auto;
  gap: 0.4rem;
  padding: 0.5rem 0.75rem;
  background: var(--surface);
  border-bottom: 2px solid var(--border);
  font-family: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif;
}
/* Icon buttons (fullscreen/prev/next/print/overflow-toggle) share one
   compact square footprint so the cluster reads as a single unit rather
   than a row of differently-sized controls — the glyphs are the label, so
   there's no text width to size around. */
#fullscreen-button, #prev-song-button, #next-song-button,
#print-song-button, #menu-bar-overflow-toggle, #toggle-chords-button {
  flex-shrink: 0;
  width: 2.25rem;
  height: 2.25rem;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-family: inherit;
  font-size: 1.15rem;
  line-height: 1;
  border: 1px solid var(--ink);
  background: var(--bg);
  color: var(--ink);
  cursor: pointer;
}
#prev-song-button, #next-song-button {
  border-color: var(--accent);
  background: var(--accent);
  color: var(--accent-contrast);
  font-weight: 700;
  font-size: 1.4rem;
}
#next-song-button {
  margin-left: auto;
}
#prev-song-button:disabled, #next-song-button:disabled {
  background: var(--bg);
  color: var(--muted);
  border-color: var(--muted);
  cursor: not-allowed;
}
#back-to-list-button {
  flex-shrink: 0;
  padding: 0.5rem 0.9rem;
  border: 2px solid var(--ink);
  background: var(--bg);
  color: var(--ink);
  font-weight: 700;
  font-family: inherit;
  font-size: 0.95rem;
  cursor: pointer;
}
#instrument-select {
  flex-shrink: 0;
  font-family: inherit;
  font-size: 0.85rem;
  padding: 0.3rem 0.4rem;
  border: 1px solid var(--ink);
  background: var(--bg);
  color: var(--ink);
}
/* "[C]" rather than a text label — chosen so this reads as an icon among
   the other icon buttons it now sits alongside (print moved in here too,
   below), not a stray text button. Only the C itself strikes through for
   the "hidden" state (updateToggleChordsButtonLabel, songbook_html.js);
   title/aria-label carry the actual "Hide chords"/"Show chords" text, the
   same split #fullscreen-button's own label already uses. */
#toggle-chords-glyph.struck {
  text-decoration: line-through;
}
/* display: contents — #menu-bar-overflow itself contributes no box, so
   #instrument-select/#toggle-chords-button/#print-song-button lay out as
   if they were direct #app-bar children, right in the single line. Print
   moved in here (from its own place in the row) specifically so tight
   layouts fold it under the hamburger menu along with the other two,
   rather than it staying a fourth icon competing for room in the row
   itself. Below the breakpoint this switches to a real box that detaches
   from the line entirely and opens as a dropdown under the hamburger
   toggle instead — never a second row of the bar itself. */
#menu-bar-overflow {
  display: contents;
}
/* Hidden by default — shown by the media query below, not by the .hidden
   convention: JS's setHidden() already uses .hidden to scope this button
   to song view (see showSong()/showList()/etc.), so this rule has to
   compose with that rather than replace it, which is why it's a plain
   display toggle rather than a class the JS could stomp on. */
#menu-bar-overflow-toggle {
  display: none;
}
@media (max-width: 640px) {
  #menu-bar-overflow-toggle {
    display: inline-flex;
  }
  /* position: fixed, not absolute, and top set from JS (menuBarOverflowToggle's
     own click handler, songbook_html.js) rather than a CSS top: 100% —
     #app-bar has overflow-x: auto (so the icon row can scroll rather than
     wrap on a truly tiny screen), and per the CSS overflow spec, setting
     overflow-x to anything but visible silently forces overflow-y to
     'auto' too. That would clip this the instant it extends past
     #app-bar's own bottom edge if it stayed position: absolute (whose
     containing block, #app-bar's own sticky positioning context, is also
     the clipping ancestor) — fixed's containing block is the viewport
     instead, which #app-bar's overflow has no say over. */
  #menu-bar-overflow {
    display: none;
    position: fixed;
    top: 0;
    right: 0.75rem;
    flex-direction: column;
    align-items: stretch;
    gap: 0.5rem;
    min-width: 10rem;
    padding: 0.6rem;
    background: var(--surface);
    border: 2px solid var(--border);
    z-index: 15;
  }
  #menu-bar-overflow.open {
    display: flex;
  }
  #instrument-select {
    width: 100%;
  }
}

#list-view, #setlist-index-view {
  max-width: 46rem;
  margin: 0 auto;
  padding: 1.5rem 1.25rem 4rem;
}
#list-view h1, #setlist-index-view h1 {
  font-size: 1.6rem;
  font-weight: 700;
  border-bottom: 2px solid var(--border);
  padding-bottom: 0.5rem;
}
/* align-items: center, not flex's own default (stretch) — without it,
   "Print this songbook" and "Setlists" (very different label lengths, but
   that's exactly what shouldn't matter) would stretch to match whichever
   of the two is tallest, rather than each sizing to its own content — the
   actual cause of "Setlists" reading oddly large (PT). */
#list-view-buttons { display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap; margin-top: 1rem; }
#list-view-buttons button, #back-from-setlist-index-button {
  padding: 0.5rem 1rem;
  border: 2px solid var(--ink);
  background: var(--bg);
  color: var(--ink);
  font-family: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif;
  font-size: 0.95rem;
  cursor: pointer;
}
#song-search, #setlist-search, #setlist-entries-search {
  display: block;
  width: 100%;
  margin-top: 1rem;
  padding: 0.6rem 0.75rem;
  border: 1px solid var(--ink);
  background: var(--bg);
  color: var(--ink);
  font-family: inherit;
  font-size: 1rem;
  box-sizing: border-box;
}
/* "Cap the list to a screenful and make it scroll" (PT) — the list itself
   scrolls independently of the page once it's taller than this, rather
   than pushing the search box and page itself further down as the crate
   grows. */
#song-list, #setlist-list {
  list-style: none;
  margin: 1rem 0 0;
  padding: 0;
  max-height: 60vh;
  overflow-y: auto;
}
#song-list li, #setlist-list li { border-bottom: 1px solid var(--border); }
#song-list a, #setlist-list a {
  display: block;
  padding: 0.65rem 0.25rem;
  color: var(--ink);
  text-decoration: none;
}
#song-list a:hover, #setlist-list a:hover { text-decoration: underline; }
/* #song-list's own rows carry a credit line + key alongside the title
   (SPEC.md §12) — a flex row rather than plain block flow so the whole
   thing (title, credit, key) wraps together as one clickable row on a
   narrow screen, instead of the credit/key sitting outside the link. Not
   applied to #setlist-list (the plain list of setlist *names*, which never
   has a credit/key of its own). */
#song-list a { display: flex; align-items: baseline; flex-wrap: wrap; gap: 0.5rem; }
.list-credit { font-style: italic; color: var(--muted); }
.list-key { color: var(--muted); font-size: 0.85em; }

/* Deliberately no max-width/centring here, unlike #list-view: the fitting
   algorithm in initSongbookApp (fitSongContent) sizes #song-content's own
   font to fill whatever width this section actually has, so constraining
   that width to a comfortable reading column would work against the point
   of the feature — using as much of the screen as the device has, which is
   what an on-stage, hands-off-the-keyboard use case wants.

   A flex row, #song-content and #chord-diagrams side by side (chordprosite's
   own layout too — its .content-container/.chords), not stacked: that's
   what makes #chord-diagrams' width, when visible, come out of
   #song-content's own clientWidth for free — fitSongContent reads that
   directly, so it never needs to know the chord panel exists or subtract
   its width itself. Vertically the two are independent: #chord-diagrams
   scrolls on its own rather than growing #song-view taller than the
   fitted text already made it. */
#song-view { display: flex; padding: 1rem 1.5rem 3rem; gap: 1.5rem; }
#song-content { flex: 1; min-width: 0; }
#chord-diagrams {
  flex: 0 0 auto;
  width: 11rem;
  display: flex;
  flex-wrap: wrap;
  align-content: flex-start;
  gap: 0.5rem;
  max-height: calc(100vh - 6rem);
  overflow-y: auto;
  border-left: 1px solid var(--border);
  padding-left: 1rem;
}
#chord-diagrams svg { display: block; }

/* Shared between #song-content (the on-screen, fitted view) and
   #print-content (print mode, below) — both hold the same renderSong()
   output markup, so both need the same rules for it. */
#song-content .heading, #print-content .heading { margin: 1.1em 0 0.3em; font-weight: 700; }
#song-content .line, #print-content .line { margin: 0.1em 0; }
/* Collapses consecutive blank lines (renderSong emits an empty .line div
   for some blank source lines) down to one — ported directly from
   chordprosite's own template.njk, which uses the same rule for the same
   reason: wasted vertical space here is wasted headroom for the font-size
   search in fitSongContent to grow into. */
#song-content .line:empty + .line:empty, #print-content .line:empty + .line:empty { display: none; }
#song-content .inlineChord, #print-content .inlineChord {
  color: var(--chord);
  font-weight: 700;
  font-family: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif;
  font-size: 0.95em;
}
/* #toggle-chords-button's on-screen-only preference (chordsHidden, see
   initSongbookApp) — scoped to #song-content, never #print-content, since
   a printed chart always shows its chords regardless of this toggle. */
#song-content.chords-hidden .inlineChord { display: none; }
#song-content blockquote.chorus, #song-content blockquote.bridge,
#print-content blockquote.chorus, #print-content blockquote.bridge {
  margin: 0.75em 0;
  padding: 0.2em 0 0.2em 1em;
  border-left: 4px solid var(--ink);
}
#song-content pre, #print-content pre {
  border: 1px solid var(--border);
  padding: 0.75em 1em;
  overflow-x: auto;
  font-family: "SF Mono", Menlo, Consolas, monospace;
  font-size: 0.9em;
}
/* Landscape-proportioned screens get two columns instead of one long
   scroll — toggled by fitSongContent, not fixed at build time, since
   whether a screen counts as "landscape" here depends on how much height
   the sticky menu bar leaves, not just raw viewport orientation. */
#song-content.two-columns {
  column-count: 2;
  column-gap: 2rem;
}

/* Title/key/capo, moved here from #app-bar so they scale with the song
   (fitSongContent sets #song-content's own font-size; nothing here
   overrides it, so em-based sizing below inherits that value directly) and
   column-flow with it. No column-span here deliberately — CSS multi-col
   lays a container's children out as one continuous flow, so as the very
   first content in #song-content, #song-header lands at the top of column
   1 on its own, without needing to span both. break-inside: avoid-column
   keeps title and key/capo together as one unit rather than letting the
   column break fall between them; flex-wrap: nowrap keeps them on one
   *row*, full stop — fitSongHeaderTitle (songbook_html.js) is what actually
   guarantees that fits, by shrinking #song-view-title's own font-size
   (set inline, overriding the em value below) rather than letting it wrap
   or push key/capo onto a second line.

   Keep in sync by hand: this rule's own gap value (0.6em) and
   fitSongHeaderTitle's SONG_HEADER_GAP_EM constant. That function has no
   way to read this value back out of the stylesheet (no getComputedStyle()
   — see its own comment), so it keeps its own copy instead; changing one
   without the other means fitSongHeaderTitle reserves the wrong amount of
   width for the gaps between title/key/capo. */
#song-header {
  display: flex;
  align-items: center;
  flex-wrap: nowrap;
  gap: 0.6em;
  margin-bottom: 0.5em;
  break-inside: avoid-column;
}
#song-view-title {
  flex: 1 1 auto;
  min-width: 2em;
  font-weight: 700;
  font-size: 1.3em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
#key-select, #capo-select {
  flex-shrink: 0;
  font-family: inherit;
  /* Scales with the song like the title (SPEC.md §12), but capped in
     absolute terms — without this, a very short song can drive the body
     font-size (and this 0.7em along with it) up far enough that these two
     controls alone eat most of #song-header's width, leaving
     fitSongHeaderTitle almost nothing to work with. */
  font-size: min(0.7em, 1.25rem);
  padding: 0.2em 0.35em;
  border: 1px solid var(--ink);
  background: var(--bg);
  color: var(--ink);
  /* A <select>'s own rendered width in Chrome is driven by its *widest*
     option, not the currently-selected one — populateCapoSelect's own
     "N - (key shapes)" labels (SPEC.md §12) can run to 15-17 characters for
     a song with a real {key} (worse for a minor one: the trailing "m" adds
     a character to every option), against as little as "Capo N" for a
     keyless song. That difference alone can eat 50-90px more of
     #song-header's width for no reason connected to the song itself, at
     fitSongHeaderTitle's direct expense. Capped here rather than by
     shortening the label text itself, which stays fully readable in the
     open dropdown either way. */
  max-width: 5.5rem;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* #print-song-button and #fullscreen-button both live in #app-bar now and
   get their sizing/border/etc. from the shared icon-button rule above — no
   rule of their own needed. */

/* #print-view is a third top-level view alongside #list-view/#song-view
   (see enterPrintView()/exitPrintView() in initSongbookApp). position:
   relative so #done-printing-button (an absolutely-positioned child, right
   below) anchors to this view's own box. */
#print-view { position: relative; padding: 1.5rem; overflow-x: auto; }
/* PT: "the done printing box is more like a window / modal close button" —
   a small fixed "x" in the view's own top-right corner, same spot a
   browser tab or dialog's own close control sits, rather than an inline
   text button competing for space in the banner's row of other controls
   below. */
#done-printing-button {
  position: absolute;
  top: 0.75rem;
  right: 0.75rem;
  width: 2.25rem;
  height: 2.25rem;
  line-height: 1;
  border: 2px solid var(--ink);
  border-radius: 999px;
  background: var(--bg);
  color: var(--ink);
  font-size: 1.4rem;
  font-family: inherit;
  cursor: pointer;
}
#print-banner {
  max-width: 46rem;
  margin: 0 auto 1.5rem;
  padding: 1rem 3rem 1rem 1rem;
  border: 2px solid var(--ink);
}
#print-banner button, #print-banner select {
  margin-top: 0.75rem;
  margin-right: 0.5rem;
  padding: 0.5rem 1rem;
  border: 2px solid var(--ink);
  background: var(--bg);
  color: var(--ink);
  font-family: inherit;
  font-size: 0.95rem;
  cursor: pointer;
}
#include-toc-label, #large-print-label, #facing-pages-label, #floor-sheet-label, #floor-sheet-notes-label {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  margin: 0.75rem 0.5rem 0 0;
  font-family: inherit;
  font-size: 0.95rem;
  cursor: pointer;
}
/* Real A4, not chordprosite's own 210mm/297mm scaled by 1.5 (315mm x
   445.5mm — not a real paper size, and not one this rewrite reproduces).
   Deliberately NOT confined to @media print — see this section's own
   header comment (initSongbookApp) for why fitPrintSongPage needs this box
   to already have its real size on screen, before printing, not only once
   print-specific CSS takes effect. 10mm padding, not chordprosite's own
   15mm (PT: "make the printed pages a bit tighter... largest possible
   print for stage use and visually impaired colleagues") — this value has
   to match initSongbookApp's own PRINT_PAGE_PADDING_MM constant exactly;
   see that constant's own comment for why the two can't share one source.
   position: relative so .print-page-number (an absolutely-positioned
   child) anchors to this page's own box, not some other ancestor. */
.print-page {
  position: relative;
  width: 210mm;
  margin: 0 auto 1.5rem;
  padding: 10mm;
  box-sizing: border-box;
  background: var(--surface);
  border: 1px solid var(--border);
}
/* margin: 0 on the heading itself, not just a tight value — killing off
   the browser's own default <h1> margin is what "put the heading higher
   up" (PT) actually means: that default margin, not this page's own
   padding, was the biggest single gap above the title. */
.print-title-page h1, .print-song-title { text-align: center; margin: 0 0 0.15rem; }
/* "The 'with chords for' text right under it" (PT) — margin-top: 0 puts it
   directly against the heading above; the bottom margin is what actually
   separates it from the contents list/song text below. */
.print-chords-for { text-align: center; color: var(--muted); margin: 0 0 0.75rem; }
.print-chords-for-note {
  text-align: center;
  color: var(--muted);
  font-size: 0.75rem;
  font-style: italic;
  margin: 0 0 0.5rem;
}
/* Large print's own second page (buildSongPrintPage's continued param,
   fitLargePrintSongPages) — same treatment as .print-chords-for-note
   (small, muted, centred, directly under the title) since the two never
   appear together on one page (a large-print page's chords-for-note, if
   any, sits below this instead — see buildSongPrintPage's own append
   order), so there's no risk of them visually competing. */
.print-continued-note {
  text-align: center;
  color: var(--muted);
  font-size: 0.85rem;
  font-style: italic;
  margin: 0 0 0.5rem;
}
/* The filler pages a multi-page song sometimes needs (alignSongStart's own
   comment) — same real A4 box as every other .print-page, just with
   nothing else on it besides this one explanatory line, centred a little
   below where a title would normally sit. */
.print-blank-note {
  text-align: center;
  color: var(--muted);
  font-style: italic;
  margin: 40mm 0 0;
}
.print-toc-entry {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
  font-variant-numeric: tabular-nums;
}
/* Absolutely positioned — never takes up flow space, so fitPrintSongPage
   never needs to account for it (its own comment). PT: "if the number of
   pages goes over about 50... put page numbers on the pages as well." */
.print-page-number {
  position: absolute;
  top: 10mm;
  right: 10mm;
  font-size: 9pt;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}
/* Chord grids beside the song text, not above it — same side-panel
   reasoning as the on-screen #chord-diagrams (its own CSS comment) — width
   comes out of .print-song-body's own clientWidth for free, which is what
   lets fitPrintSongPage measure it directly instead of subtracting a
   diagrams-panel width itself. */
.print-song-row { display: flex; gap: 1rem; }
.print-song-body { flex: 1; min-width: 0; }
.print-chord-diagrams {
  flex: 0 0 auto;
  width: 9rem;
  display: flex;
  flex-wrap: wrap;
  align-content: flex-start;
  gap: 0.4rem;
}

/* Floor sheets (SPEC.md §13, buildFloorSheetPage/buildFloorSheetPages) —
   just a title and a plain numbered list of names, no chord-row layout at
   all, so this gets its own, much simpler rules rather than reusing
   .print-song-row/.print-song-body. Sized larger than a normal song page's
   body text by default (readable from further away, at your feet) —
   fitFloorSheetPage's own binary search only ever scales this *down* from
   here, when a set has enough entries (or long enough notes) to need it. */
/* margin: 0 0 0.15rem, not a bigger, more "designed" gap — same reasoning
   as .print-title-page h1/.print-song-title's own identical rule: the
   default user-agent margin above an <h1> is exactly what
   fitFloorSheetPage's own availableHeight budget can't see (offsetHeight
   excludes margin entirely), so a non-zero top margin here would silently
   eat into the space it thinks the list still has. */
.print-floor-sheet-title { margin: 0 0 0.15rem; }
.print-floor-sheet-list {
  margin: 0;
  padding-left: 1.5em;
  font-size: 1.3rem;
  line-height: 1.6;
}
/* padding-bottom, not margin-bottom — a margin on the *last* list item
   collapses straight through .print-floor-sheet-list's own bottom edge (no
   padding/border there to stop it) and inflates the page's real height
   beyond what fitFloorSheetPage measured via the list's own scrollHeight,
   which can't see a margin that already escaped it. Padding never
   collapses. */
.print-floor-sheet-list li { padding-bottom: 0.4em; }
.print-floor-sheet-name { font-weight: 700; }
.print-floor-sheet-note { font-size: 0.7em; font-weight: 400; color: var(--muted); font-style: italic; }

@media print {
  /* Only #print-content is meant to end up on paper — the on-screen
     instructions/buttons above it, and anything from the other two views
     that isn't already display:none, have no reason to print. #fullscreen-
     button lives in #app-bar, which stays mounted (and un-hidden) across
     every view specifically so it's always reachable — "always", it turns
     out, still isn't supposed to include an actual printed page. */
  #print-banner, #fullscreen-button, #done-printing-button { display: none; }
  #print-view { padding: 0; overflow: visible; }
  /* The border/gap between pages is an on-screen page-separator cue only —
     printed pages are separated by actual paper, not a rule between them,
     and page-break-after replaces the margin-based gap with a real break. */
  .print-page { margin: 0 auto; border: none; page-break-after: always; }
  .print-page:last-child { page-break-after: auto; }
  @page { margin: 0; }
}

/* Setlists (SPEC.md §6) — #setlist-index-view (the list of setlists,
   #song-list/#setlist-list's shared styling above) and #setlist-view (one
   setlist's own entries), two more top-level views alongside list/song/
   print. */
#setlist-view { max-width: 46rem; margin: 0 auto; padding: 1rem 1.5rem 3rem; }
#setlist-menu-bar {
  display: flex;
  align-items: center;
  gap: 1rem;
  flex-wrap: wrap;
  padding-bottom: 1rem;
  margin-bottom: 1rem;
  border-bottom: 2px solid var(--border);
  font-family: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif;
}
#setlist-view-title { flex: 1; min-width: 0; font-size: 1.3rem; margin: 0; }
#setlist-menu-bar button {
  flex-shrink: 0;
  padding: 0.5rem 0.9rem;
  border: 1px solid var(--ink);
  background: var(--bg);
  color: var(--ink);
  font-family: inherit;
  font-size: 0.9rem;
  cursor: pointer;
}
.setlist-set-name { margin: 1.5rem 0 0.5rem; font-size: 1.05rem; }
/* A set's own freeform note (SPEC.md §6/§6.2), between its "Set N" heading
   and its first entry — same treatment as an entry's own .setlist-entry-notes
   below, so the two read as the same kind of thing at a glance. */
.setlist-set-notes { margin: -0.25rem 0 0.5rem; color: var(--muted); font-style: italic; }
.setlist-entry {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 0.6rem;
  padding: 0.5rem 0;
  border-bottom: 1px solid var(--border);
}
.setlist-entry-position { color: var(--muted); font-variant-numeric: tabular-nums; }
.setlist-entry-name { color: var(--ink); font-weight: 600; }
a.setlist-entry-name:hover { text-decoration: underline; }
/* A small red mark, not the full message inline — PT explicitly asked for
   this over the previous bordered warning box, which dominated the row it
   sat in. A deliberate, narrow exception to red (--chord) otherwise being
   reserved exclusively for chord names on the song page (SPEC.md §14) —
   the two never appear in the same view, so there's no real ambiguity risk
   in practice, but it is a second thing red now means, not one. The full
   message lives in the title attribute (a native hover/focus tooltip),
   not in visible text at all. */
.setlist-entry-status {
  color: var(--chord);
  font-weight: 700;
  cursor: help;
}
.setlist-entry-notes { flex-basis: 100%; color: var(--muted); font-style: italic; }
/* Both notes fields render Markdown now (SPEC.md §6.2), not plain text — a
   browser's own default paragraph/list margins are too generous for a
   compact list row, so they're tightened here rather than left at default. */
.setlist-set-notes p, .setlist-set-notes ul, .setlist-set-notes ol, .setlist-set-notes blockquote,
.setlist-entry-notes p, .setlist-entry-notes ul, .setlist-entry-notes ol, .setlist-entry-notes blockquote,
.print-floor-sheet-note p, .print-floor-sheet-note ul, .print-floor-sheet-note ol, .print-floor-sheet-note blockquote {
  margin: 0.25em 0;
  padding-left: 1.25em;
}
.setlist-set-notes p:first-child, .setlist-entry-notes p:first-child,
.print-floor-sheet-note p:first-child { margin-top: 0; }
.setlist-set-notes p:last-child, .setlist-entry-notes p:last-child,
.print-floor-sheet-note p:last-child { margin-bottom: 0; }
.setlist-set-notes blockquote, .setlist-entry-notes blockquote,
.print-floor-sheet-note blockquote { padding-left: 0.75em; border-left: 2px solid var(--border); }
/* A modal over the song itself, shown when opening it from within a
   setlist (SPEC.md §6.2) — the dimmed backdrop is UI chrome signalling a
   modal state, not a background tint on content (SPEC.md §14's own rule is
   about song text, not this). The box itself stays plain --bg/--ink, no
   colour of its own, same as everywhere else in this page. */
#setlist-note-modal {
  position: fixed;
  inset: 0;
  z-index: 20;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1rem;
  padding: 2rem;
  background: rgba(0, 0, 0, 0.6);
  cursor: pointer;
}
#setlist-note-modal-content {
  background: var(--bg);
  color: var(--ink);
  border: 1px solid var(--ink);
  padding: 1.5rem 2rem;
  max-width: 32rem;
  max-height: 70vh;
  overflow-y: auto;
  font-size: 1.2rem;
  cursor: auto;
}
#setlist-note-modal-hint { color: #fff; font-size: 0.85rem; margin: 0; }
</style>
</head>
<body>

<header id="app-bar">
<button id="prev-song-button" type="button" class="hidden" title="Previous song" aria-label="Previous song">&lsaquo;</button>
<button id="fullscreen-button" type="button" title="Full screen" aria-label="Full screen">&#9974;</button>
<button id="back-to-list-button" type="button" class="hidden">Back to list</button>
<div id="menu-bar-overflow" class="hidden">
<select id="instrument-select" class="hidden" aria-label="Instrument"></select>
<button id="toggle-chords-button" type="button" class="hidden" title="Hide chords" aria-label="Hide chords">[<span id="toggle-chords-glyph">C</span>]</button>
<button id="print-song-button" type="button" class="hidden" title="Print this song" aria-label="Print this song">&#128424;&#65039;</button>
<label id="setlist-notes-label" class="hidden"><input type="checkbox" id="setlist-notes-checkbox" checked> Show notes</label>
</div>
<button id="menu-bar-overflow-toggle" type="button" class="hidden" aria-label="More song options">&#9776;</button>
<button id="next-song-button" type="button" class="hidden" title="Next song" aria-label="Next song">&rsaquo;</button>
</header>

<section id="list-view">
<h1>Songs</h1>
<div id="list-view-buttons">
<button id="print-book-button" type="button">Print this songbook</button>
<button id="view-setlists-button" type="button" class="hidden">Setlists</button>
</div>
<input id="song-search" type="search" placeholder="Find a song&hellip;" aria-label="Find a song">
<ul id="song-list"></ul>
</section>

<section id="setlist-index-view" class="hidden">
<h1>Setlists</h1>
<button id="back-from-setlist-index-button" type="button">Back to songs</button>
<input id="setlist-search" type="search" placeholder="Find a setlist&hellip;" aria-label="Find a setlist">
<ul id="setlist-list"></ul>
</section>

<section id="song-view" class="hidden">
<div id="song-content"><div id="song-header"><span id="song-view-title" class="hidden"></span><select id="key-select" class="hidden" aria-label="Key"></select><select id="capo-select" class="hidden" aria-label="Capo"></select></div><div id="song-pages"></div></div>
<div id="chord-diagrams" class="hidden"></div>
</section>

<div id="setlist-note-modal" class="hidden">
<div id="setlist-note-modal-content"></div>
<p id="setlist-note-modal-hint">Click anywhere to continue</p>
</div>

<section id="setlist-view" class="hidden">
<nav id="setlist-menu-bar">
<button id="back-from-setlist-button" type="button">Back to setlists</button>
<h1 id="setlist-view-title"></h1>
<button id="toggle-notes-button" type="button">Hide notes</button>
<button id="print-setlist-button" type="button">Print this setlist</button>
</nav>
<input id="setlist-entries-search" type="search" placeholder="Find in this setlist&hellip;" aria-label="Find in this setlist">
<div id="setlist-entries"></div>
</section>

<section id="print-view" class="hidden">
<button id="done-printing-button" type="button" title="Done printing" aria-label="Done printing">&times;</button>
<div id="print-banner">
<p>When you're done printing (or if you change your mind), press <kbd>Escape</kbd> or click
the &times; button top right to come back. Printing opens in this same window rather than a
new one — a new window doesn't work in some contexts (SharePoint, Dropbox) this page may be
opened from.</p>
<select id="print-instrument-select" aria-label="Instrument"></select>
<label id="include-toc-label"><input type="checkbox" id="include-toc-checkbox" checked> Title page &amp; contents</label>
<label id="large-print-label"><input type="checkbox" id="large-print-checkbox"> Large print</label>
<label id="facing-pages-label"><input type="checkbox" id="facing-pages-checkbox" checked> Keep songs on facing pages</label>
<label id="floor-sheet-label" class="hidden"><input type="checkbox" id="floor-sheet-checkbox"> Floor sheet (song list only)</label>
<label id="floor-sheet-notes-label" class="hidden"><input type="checkbox" id="floor-sheet-notes-checkbox" checked> Include notes</label>
<button id="print-now-button" type="button">Print now</button>
</div>
<div id="print-content"></div>
</section>

<script type="application/ld+json" id="crate-data">
${embeddedJson}
</script>
<script>
${CHORDPROBOOK_BROWSER_BUNDLE}
var CHORDPROBOOK_INSTRUMENTS_DATA = ${JSON.stringify(CHORDPROBOOK_INSTRUMENTS_DATA)};
var CHORDPROBOOK_CHORD_DATA = ${JSON.stringify(CHORDPROBOOK_CHORD_DATA)};
</script>
<script>
(${initSongbookApp.toString()})(document, window);
</script>
</body>
</html>
`;
}

export const songbookHtmlPlugin = {
  name: "chordpro-songbook-html-output",
  hooks: {
    [HOOKS.OUTPUT_WRITE]: async (ctx) => {
      if (ctx.options.inputMode !== "chordpro") return;

      if (!ctx.options.overwrite && (await fileExists(ctx.dirHandle, OUTPUT_FILE))) {
        ctx.log(`Songbook HTML: ${OUTPUT_FILE} exists and overwrite is off — skipped.`, "warn");
        return;
      }

      const crateJson = await readJsonFromFolder(ctx.dirHandle, CRATE_FILE);
      if (!crateJson) {
        ctx.log(`Songbook HTML: ${CRATE_FILE} not found — skipped.`, "warn");
        return;
      }

      const index = buildCrateIndex(crateJson);
      const songCount = entitiesOfType(index, "MusicComposition").filter(isCanonicalSong).length;
      await writeFile(ctx.dirHandle, OUTPUT_FILE, renderSongbookHtml(crateJson));
      ctx.log(`Songbook HTML: wrote ${OUTPUT_FILE} (${songCount} song(s); data, chordprobook, and the app are all embedded).`, "ok");
    },
  },
};
