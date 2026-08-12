# `chordpro-input` — spec

## 1. What this plugin does

`chordpro-input` turns a folder of ChordPro song files and Markdown setlists into an
RO-Crate, and then separately renders a conformant crate it built into a standalone, interactive, printable
songbook HTML page.

It has three Stages:

- **Harvesting** (`index.js`, `chordpro_crate.js`): walks a picked folder, parses each song
  and setlist file, and produces RO-Crate entities for them. This half only reads the source
  folder — it never writes back to it, edits songs, transposes chords, or draws chord
  diagrams.

-  **Metadata entry** and cleanup -- TODO

- **Songbook rendering** (`songbook_html.js`): reads the RO-Crate this half of the plugin
  just wrote and produces `songbook.html`, a single file containing the crate's own data
  plus a client-side app that displays it — a song list, individual song views with
  transposition and chord diagrams, setlists, and a print mode. This file is meant to be
  opened directly (including as a `file://` URL) with no server and no build step.

The first and last stages depend on [`chordprobook`](https://github.com/ptsefton/chordprobook) (a sibling
repository, `"chordprobook": "file:../chordprobook"` in `package.json`) for ChordPro/setlist
parsing, chord transposition, and chord-diagram rendering.

## 2. Scope

**In scope:**
- Discover song files (ChordPro) and setlist files (Markdown) in a picked folder.
- Parse each song's metadata directives and capture its full raw text.
- Parse each setlist's structure (title, set groupings, ordered entries, per-entry
  overrides, freeform notes) and resolve each entry to a song.
- Produce RO-Crate entities for both, writable as JSON/xlsx/HTML by the rest of the
  resources2crate pipeline.
- Render the resulting crate into a standalone songbook HTML page: song list, song view,
  setlists, key/capo/instrument controls, chord diagrams, print mode.

**Out of scope (permanent, not deferred):**
- Editing songs or setlists, or writing back to the source folder.
- Bundling any default chord-shape data or `{define:}` directives from a song's own text —
  chord shapes shown on screen or in print come only from chordprobook's own bundled data
  (§7).
- Any music-theory logic beyond what chordprobook already provides — transposition, capo
  math, and Nashville numbering are chordprobook's responsibility, not reimplemented here.

**Deferred (§9):** creating or editing setlists in the songbook page; loading additional
songs into an already-open page; exporting the crate as a downloadable RO-Crate file.

## 3. Plugin registration

This is an **input-mode plugin** (`INPUT_PLUGINS`, keyed by `inputMode: "chordpro"`), the
same category as `docx-input`. See [ARCHITECTURE.md §4.5](../../../ARCHITECTURE.md).

- `index.js` registers `plugin` (`buildCrate(ctx)`, dynamically importing `chordpro_crate.js`
  so its dependencies stay out of the main bundle until a chordpro build actually runs).
- `songbook_html.js` separately registers `songbookHtmlPlugin`, an **additive** hook tap in
  `PLUGINS` (not `INPUT_PLUGINS`) on `OUTPUT_WRITE`, alongside `ro-crate-json-output`/
  `ro-crate-xlsx-output`/`ro-crate-html-output`. It guards on
  `ctx.options.inputMode === "chordpro"` and no-ops otherwise.
- A chordpro build does not run `FILES_ANALYZE` (this plugin does its own folder walk inside
  `buildCrate`, like `docx-input`), so hook handlers that tap `FILES_ANALYZE` (e.g.
  `austlang`) do not run against a chordpro-mode build.
- The `inputMode` select in `CORE_SETTINGS_SCHEMA` (`src/main.js`) is a hardcoded list, not
  derived from the plugin registry — adding this mode required a corresponding edit there.
- No MASP profile currently sets `buildOptions.inputMode: "chordpro"` (§9).

## 4. File discovery

The picked folder is scanned recursively; subfolders carry no structural meaning. Each file
is classified by extension:

| Extension (default) | Treated as |
|---|---|
| `.pro`, `.cho`, `.cho.txt` | Song (ChordPro) |
| `.setlist.md` | Setlist (Markdown) |
| anything else | ignored |

Both are configurable via `optionSchema`:

```js
optionSchema: {
  key: "chordproSongExtensions",
  label: "Song file extensions",
  default: [".pro", ".cho", ".cho.txt"],
  hint: "Files with these extensions are parsed as ChordPro song charts.",
},
```

Dotfiles and common editor/OS artifacts (`.DS_Store`, `~$*`, etc.) are skipped, matching
`docx-input`'s own convention.

## 5. Parsing a song file

Only metadata extraction happens here — no rendering, transposition, or chord-diagram logic.

| Directive(s) | Extracted as |
|---|---|
| `{title}` / `{t}` | `name` |
| `{subtitle}` / `{artist}` / `{st}` | `custom:artist` |
| `{key}` | `musicalKey` |
| `{capo}` | `custom:capo` (integer) |
| `{transpose}` / `{tr}` | `custom:transpose` |
| `{composer}` | `composer` |
| everything else | retained as part of raw text, not extracted |

Every directive is first-wins (the first occurrence in the file is kept; later repeats of
the same directive are ignored).

- **Raw text.** The file's original text, unmodified, is stored verbatim as `text` on the
  Song entity. **The Song entity is the only place this text is ever written** — a setlist
  entry naming the same song (§6) never carries its own copy.
- **No file payload.** The source file's bytes are not copied into the crate; the Song
  entity carries its content as data (`text`) only.
- **Identity.** `@id` is the file's path relative to the picked folder.
- **Title fallback.** A file with no `{title}` directive falls back to its filename, minus
  extension.

## 6. Parsing a setlist file

Setlist files are Markdown with a specific dialect layered on top:

```
{Title: Gig number 1,000}      <- optional, first non-blank line only, {directive: value}
                                   syntax (not YAML frontmatter). Falls back to filename.

# Set 1                        <- a set/section heading (H1) — informational grouping only.

## Slot Machine Baby           <- a setlist entry (H2): the heading text is matched against
                                   known song titles (§6.1)

> Play with a lively feel...   <- performance notes: any non-blank, non-heading line(s)
>> But not **that** lively!       immediately following an entry, up to the next heading,
                                   concatenated verbatim into that entry's description.
                                   Blockquote ("> ") markup is not required — any non-blank,
                                   non-heading line counts as a note.

## Baby {transpose: -2}        <- inline {directive: value} after the title overrides that
                                   entry's transpose/capo for this performance, independent
                                   of the matched song's own values
```

- **Each entry is its own `MusicComposition`** — a proxy for one performance slot, linked to
  the canonical Song it performs via `specializationOf`. It never carries `text` (§5).
- **Sets are a plain string, not their own entity.** Each entry carries the text of the
  nearest preceding `#` heading as `custom:setName`.
- **Entry-level overrides.** `{transpose: N}` / `{tr: N}` and `{capo: N}` found inline on a
  `##` line become `custom:transpose` / `custom:capo` directly on the entry, taking
  precedence over the matched Song's own values — the same song can appear in two setlists
  performed in two different keys.

### 6.1 Matching an entry to a song

1. Strip any trailing `{...}` directive text and surrounding whitespace from the heading to
   get the bare entry name.
2. Attempt an exact match against a song's title (case-insensitive).
3. If no exact match, build a regex by joining the entry name's words with `.*?` and test it
   case-insensitively against every song title (`"Amazing"` matches `"Amazing Grace"`). This
   is intentionally permissive.
4. **Zero matches:** entry retained with no `specializationOf`; `custom:matchStatus:
   "unresolved"`.
5. **Exactly one match:** linked via `specializationOf`; `custom:matchStatus` is `"exact"` or
   `"fuzzy"` depending on which step matched.
6. **Multiple matches:** the first match is used and linked via `specializationOf` (so an
   entry always has a definite `specializationOf` when any match exists at all), but the
   ambiguity is recorded as data: `custom:matchStatus: "ambiguous"` plus
   `custom:matchCandidates` listing every candidate's `@id`. A build-log warning is also
   emitted.

`matchStatus` is present on every entry, not only ones that failed to resolve.

## 7. Entity shapes

No custom `@type` is minted. A Song and a setlist entry are both typed `MusicComposition`;
a Setlist is typed `MusicPlaylist`.

```jsonc
{
  "@id": "AmazingGrace.cho.txt",
  "@type": "MusicComposition",
  "name": "Amazing Grace",
  "text": "{title: Amazing Grace}\n{key: G}\n\nA-[G]maz-ing [G7]Grace, ...",
  "musicalKey": "G"
  // composer / custom:artist / custom:capo / custom:transpose are omitted entirely when
  // the source file had no matching directive — never written as null or empty.
}
```

```jsonc
{
  "@id": "sample.setlist.md",
  "@type": "MusicPlaylist",
  "name": "Gig number 1,000",
  "hasPart": [
    { "@id": "sample.setlist.md#entry-1" },
    { "@id": "sample.setlist.md#entry-2" }
    // Array order is performance order — significant, but not enforced by JSON-LD itself.
  ]
},
{
  "@id": "sample.setlist.md#entry-1",
  "@type": "MusicComposition",
  "name": "Slot Machine Baby",
  "specializationOf": { "@id": "slot_machine_baby.cho.txt" },
  "custom:setName": "Set 1",
  "custom:matchStatus": "exact",
  "description": "Play with a lively feel, start with a manic synth solo!\n>> But not **that** lively!"
  // No "text" — the full song text lives exactly once, on the Song entity above.
}
```

| Field | Property | Standard or custom? |
|---|---|---|
| a song's title / an entry's raw heading | `name` | standard (`Thing`) |
| a song's full source text | `text` | standard (`CreativeWork`) |
| a song's key | `musicalKey` | standard (`MusicComposition`) |
| a song's composer credit | `composer` | standard (`MusicComposition`) — a bare string, not a Person/Organization reference |
| a setlist's ordered entries | `hasPart` | standard (`CreativeWork`) |
| an entry's link to the song it performs | `specializationOf` | standard (`CreativeWork`) |
| an entry's performance notes | `description` | standard (`Thing`) |
| performer/attribution credit | `custom:artist` | custom |
| capo position | `custom:capo` | custom |
| transpose value | `custom:transpose` | custom |
| which set/section an entry belongs to | `custom:setName` | custom |
| this plugin's confidence in a match | `custom:matchStatus` | custom |
| every candidate when a match was ambiguous | `custom:matchCandidates` | custom |

`rdf:Property` definitions are added only when at least one entity in the build actually
uses them:

| `@id` | `name` |
|---|---|
| `arcp://name,custom/terms#capo` | Capo |
| `arcp://name,custom/terms#transpose` | Transpose |
| `arcp://name,custom/terms#artist` | Artist |
| `arcp://name,custom/terms#setName` | Set Name |
| `arcp://name,custom/terms#matchStatus` | Match Status |
| `arcp://name,custom/terms#matchCandidates` | Match Candidates |

(`name`, `text`, `musicalKey`, `composer`, `hasPart`, `specializationOf`, `description` are
standard schema.org properties already defined by every profile's base context.)

## 8. File layout

```
src/plugins/chordpro-input/
  SPEC.md                     this document
  index.js                    plugin registration: name, inputMode: "chordpro", buildCrate(ctx)
  chordpro_crate.js            folder walk and RO-Crate entity assembly; imports
                               ChordProSong/parseSetlist/matchEntryToSong from chordprobook
  crate_index.js                dependency-free @id/@type index over a written crate's JSON
                               (buildCrateIndex/toArray/firstValue/resolveRef/entitiesOfType)
                               — does not use the `ro-crate` npm library
  songbook_html.js              renders the crate into songbook.html — see §10-§13
  generated/
    chordprobook_browser_bundle.js
                               generated; do not edit by hand — see §10
  samples/                     chordprosite's own sample files, used as test fixtures
  test-chordpro-song.mjs       regression test for chordprobook's ChordProSong
  test-chordpro-setlist.mjs    regression test for chordprobook's parseSetlist/matchEntryToSong
  test-chordpro-crate.mjs      integration test for chordpro_crate.js against samples/
  test-crate-index.mjs         unit tests for crate_index.js
  test-songbook-html.mjs       unit/integration tests for songbook_html.js
```

`chordprobook` is dynamically imported from `buildCrate` (via `chordpro_crate.js`, itself
dynamically imported from `index.js`), so it stays out of the main application bundle until
a chordpro build actually runs.

Tests are colocated with the plugin's own code, discovered recursively by
`scripts/run-tests.mjs`, rather than living under the top-level `tests/` folder.

A `docs/chordpro-authoring.md` file, parallel to `docs/docx-authoring.md`, documenting the
setlist dialect (§6), matching behaviour (§6.1), and configurable extensions (§4) for the
person writing song/setlist files, has not yet been written.

## 9. Deferred and open

**Deferred (not built):**
- Creating a new setlist or editing an existing one from within the songbook page (adding
  songs, reordering by dragging, saving the update back into the HTML file).
- Loading additional songs into an already-open songbook page, from a folder or pasted
  ChordPro text.
- Exporting the crate as a downloadable RO-Crate (data only, or with source files written
  out via the File System Access API).
- A dedicated print view for setlists that separates them by matching confidence, or any
  further setlist-editing UI.

**Open questions:**
1. Whether a top-level folder should carry structural meaning (a grouping entity, as
   `generic-input`/`docx-input` treat top-level folders), or remain unrepresented regardless
   of how files are organised on disk.
2. Whether archival fidelity — retaining byte-identical original files, not just their
   parsed text — is required, given the crate currently stores only parsed text.
3. First-wins-for-every-directive (§5) has not been checked against a real song library
   that might depend on chordprosite's own accumulate-title behaviour.
4. Duplicate or near-duplicate song titles from different files are not deduplicated or
   cross-referenced in any way; they simply coexist as unrelated entities.
5. No MASP profile currently selects `inputMode: "chordpro"` (§3), so an end-to-end build
   requires manual configuration in Settings.

---

## 10. Songbook HTML output — what the file contains

`renderSongbookHtml(crateJson)` in `songbook_html.js` produces one self-contained HTML file,
written as `songbook.html` alongside (not replacing) `ro-crate-html-output`'s own
`ro-crate-preview.html`. It contains three `<script>` elements, all **classic, not
`type="module"`** — a module script's cross-origin rules block it entirely when the page is
opened as a `file://` URL, which is how this file is meant to be opened:

1. `<script type="application/ld+json" id="crate-data">` — the crate's own JSON-LD,
   pretty-printed, with a defensive escape of any literal `</script` inside it.
2. A classic `<script>` containing `CHORDPROBOOK_BROWSER_BUNDLE`, `CHORDPROBOOK_INSTRUMENTS_DATA`,
   and `CHORDPROBOOK_CHORD_DATA` — see below.
3. A classic `<script>` invoking `initSongbookApp(document, window)` — a plain function
   exported from `songbook_html.js` and embedded via `.toString()` (its actual source, not
   a hand-written duplicate), constituting the entire client-side app.

**Embedding chordprobook.** `initSongbookApp` calls `ChordProSong`, `renderSong`,
`Transposer`, and `ChordDiagram` as bare globals, since nothing can `import` anything once
this is a classic script. Those globals, plus the two data constants above, are produced at
build time by `scripts/bundle-chordprobook-for-browser.mjs` (run via `npm run
generate:chordprobook-bundle`; nothing regenerates it automatically) from:
- chordprobook's own `chords/Transposer.js`, `chords/ChordDiagram.js`, `ChordProSong.js`,
  `Song.js` source, concatenated with `import`/`export` stripped and each file's body
  wrapped in its own closure exposing only its own exported names. **The per-file closure
  matters**: `ChordProSong.js` and `Song.js` each declare their own private
  `DIRECTIVE_NAMES`/`Directive`, and bare top-level declarations from both would collide as
  a `SyntaxError` once concatenated into one classic-script scope without it.
- `instruments.yaml`, parsed with the `yaml` package at generation time (a devDependency of
  resources2crate, used only by this script) and emitted as plain JSON — the browser never
  parses YAML itself.
- `chords/chord_data/*.cho`, parsed with chordprobook's `parseChordDataText()` at generation
  time and emitted as plain JSON — the browser never parses raw `.cho` text.

A generated `.js` file exporting plain string/JSON constants is what makes this importable
identically under Vite (this app's real bundle) and under plain Node (this repo's own
tests); a Vite `?raw` import only works under Vite, and `fs.readFileSync` only works under
Node.

`initSongbookApp` cannot import `crate_index.js` or chordprobook normally — it runs inside
the generated page, on whatever machine later opens it, not inside resources2crate. It
re-implements the "is this a canonical song" check (`"text" in entity`) inline for the same
reason. `test-songbook-html.mjs` calls `initSongbookApp` directly against a fake
`document`/`window`, including simulating real clicks, as the one copy of this logic that's
actually tested.

## 11. Songbook HTML output — views and navigation

The page has five top-level views, each shown by hiding all the others (`setHidden()`
toggles a `hidden` class — **not** `element.style.display` directly: setting
`style.display = ""` clears an inline override and falls back to whatever the stylesheet
itself specifies, which for these elements is itself `display: none`; the `.hidden` CSS rule
carries `!important` because e.g. `#back-to-list-button`'s own `display: inline-flex` would
otherwise win on specificity while both apply):

| View | Shown by | Contains |
|---|---|---|
| `#list-view` | `showList()` | all songs (searchable, scrollable), a "Print this songbook" button, a "Setlists" button (hidden if the crate has none) |
| `#setlist-index-view` | `showSetlistIndex()` | every setlist by name |
| `#setlist-view` | `showSetlist(index)` | one setlist's entries: position, heading, match-status badge, notes, print/notes-toggle controls |
| `#song-view` | `showSong(position)` | one song, with the sticky `#app-bar` (prev/next, fullscreen, instrument select, print, hide/show chords) and, inside `#song-content` itself, `#song-header` (title, key/capo — §12) |
| `#print-view` | `enterPrintView()` | whatever's being printed (§12) |

**`#app-bar`** is always mounted and sticky (not song-view-only — unlike everything else in
the table above, it isn't one of the five hidden/shown views), and is always a single line:
`flex-wrap: nowrap`, with `overflow-x: auto` as a fallback if a viewport is ever too narrow
for its contents, rather than wrapping onto a second line. `#prev-song-button` is first, so
it's leftmost by DOM order; `#next-song-button` gets its own `margin-left: auto` to push
itself to the right edge — nothing else in the bar is elastic now that the title (which used
to do that job by taking `flex: 1`) has moved into `#song-content` itself (§12), freeing up
the bar's own height for song content. `#fullscreen-button` (visible in every view, including
print, though it's excluded from the printed page itself — §12) sits right after
`#prev-song-button`; every other control in the bar (`#back-to-list-button`, `#menu-bar-
overflow`, `#menu-bar-overflow-toggle`, `#print-song-button`) is song-view-only and
`setHidden()` individually by every view-switching function — there's no single wrapper
element left whose own hidden state implies all of theirs, the way `#menu-bar-row2` once did
in an earlier two-row version of this bar.

**Small-screen overflow menu.** `#menu-bar-overflow` (a container for `#instrument-select`,
`#toggle-chords-button`, and `#print-song-button` — print moved in here from its own place in
the row specifically so a tight layout folds it under the hamburger menu too, rather than it
staying a fourth icon competing for room in the row itself) is `display: contents` by default,
so its children lay out as if they were direct `#app-bar` children, right in the single line,
contributing no box of their own. Below a `640px` viewport width, it instead becomes a real
box that opens as a dropdown under `#menu-bar-overflow-toggle`'s hamburger icon, rather than
sitting inline or forcing a second row: detaching it from the flow entirely, instead of
wrapping, is what keeps the bar a single line even here.

That dropdown is `position: fixed`, not `absolute`, with its `top` set from
`menuBarOverflowToggle`'s own click handler (`appBar.getBoundingClientRect().bottom`, plus a
small gap) rather than a CSS `top: 100%`. `#app-bar` has `overflow-x: auto` (so the icon row
itself can scroll rather than wrap on a truly tiny screen, per its own comment above) — and
per the CSS overflow spec, setting `overflow-x` to anything but `visible` silently forces
`overflow-y` to `auto` too. An absolutely-positioned dropdown's containing block would be
`#app-bar` itself (its sticky positioning context), which is *also* the clipping ancestor
under that forced `overflow-y: auto` — the dropdown would be clipped the instant it extended
past `#app-bar`'s own bottom edge, which is exactly what a dropdown does, and exactly what
made the hamburger menu appear to not work at all. `position: fixed`'s containing block is
the viewport instead, which `#app-bar`'s own overflow has no say over — at the cost of
needing an explicit `top`, which only JS (not a percentage in CSS) can express relative to
the viewport.

The `display: contents` switch and the dropdown's own positioning are CSS media-query rules
(`@media (max-width: 640px)`), not JS: nothing in `initSongbookApp` reads viewport width
itself, beyond the `top` calculation above. `menuBarOverflowToggle`'s click handler toggles an
`.open` class on `#menu-bar-overflow` (setting `top` only when opening); `showSong()` clears
that class on every song change so switching songs doesn't leave the menu open. This is purely
a narrow-viewport layout concern — the fake-DOM test suite can check the class toggle itself
but, per this file's own recurring caveat about that suite (§10), cannot verify the CSS
breakpoint actually looks right on a real phone.

**A setlist becomes the active browsing context once opened.** `getActivePlaylist()`
returns either every song (global browsing) or, when `currentSetlistIndex >= 0`, one
setlist's own entries in setlist order, each carrying its own transpose/capo override where
it has one, and never including an entry with no matching song. `showSong(position)` takes
a position in *whichever* of these is active, not a raw song index — next/previous and
their disabled state at either end are relative to that position. `currentSongIndex` (the
resolved index into the global `songs` array) is separate state, resolved once by
`showSong()`, so every other function that needs the actual song
(`renderCurrentSong`/`showPrintSong`/`saveCurrentSelection`/the key-capo change handlers)
reads it directly without knowing which playlist is active.

`backToCurrentList()` returns to the setlist a song was opened from, if any, otherwise the
global list — a setlist stays "the list" until the reader explicitly leaves it via
`#back-from-setlist-index-button` (setlist index → global list) or
`#back-from-setlist-button` (one setlist → setlist index).

Clicking a setlist entry that resolved to a song opens that song with the entry's own
transpose/capo override; the song view shows the **canonical song's own name**, never the
entry's own display heading (they can differ — SPEC.md §6/§7).

A non-exact match gets a specific, actionable message next to it (e.g. "matches more than
one song — make this entry's heading more specific") rather than the bare status word — the
only way to actually fix a mismatch is editing the `.setlist.md` file and rebuilding the
crate, since this page cannot write back to the source folder (§2); the message says so.
Styled as a bordered badge, not a colour — see §13's note on why colour is reserved for
chord names.

Notes are hidable with one toggle for the whole setlist (`#toggle-notes-button` flips
`notesVisible` and re-renders every entry), not a control on every row.

## 12. Songbook HTML output — features

**Fit-to-window.** `fitTextToBox(element, availableHeight, availableWidth)` is a binary
search over font-size (`FIT_MIN_FONT_PX`–`FIT_MAX_FONT_PX`, 10–80px) that finds the largest
size at which `element.scrollHeight`/`scrollWidth` still fit the given box, used both
on-screen (`fitSongContent`, against the viewport minus the menu bar's height, toggling a
`two-columns` class when the available space is landscape-proportioned) and in print
(`fitPrintSongPage`, §13). There is no CSS-only way to do this: font-size determines how
much text wraps, which determines height, which is exactly what has to fit a box of known
height — `clamp()`/container query units size from the container's own dimensions, not from
how a given size makes a specific piece of text wrap. `fitSongContent` re-runs on window
resize/orientation change, debounced 150ms.

**Title, key, capo.** `#song-header` — `#song-view-title`, `#key-select`/`#capo-select`
(`populateKeySelect`/`populateCapoSelect`) — is the first child of `#song-content`, not part
of `#app-bar`: `renderCurrentSong()` only ever overwrites `#song-pages`, `#song-content`'s
*other* child, so `#song-header` and the listeners bound to its selects survive every
re-render untouched. Living inside `#song-content` means it inherits whatever font-size
`fitSongContent` (§12) computes for the song itself — set in `em` there deliberately, not
`rem`, so title/key/capo scale up and down with the song rather than staying a fixed
toolbar size, clamped in both directions (below) so a very short or very long song can't push
the header to an absurd size — and participates in `#song-content`'s own column flow: CSS
multi-column
layout treats a container's children as one continuous flow regardless of how many there
are, so as the first content, `#song-header` lands at the top of the *left* column when
`.two-columns` is active, with no extra CSS needed for that placement beyond `break-inside:
avoid-column` (keeping title and key/capo together as one unit rather than letting the
column break fall between them).

`#song-header` is `flex-wrap: nowrap` — title, key, and capo always stay on one row, never
wrapping onto a second. What actually guarantees that fits is `fitSongHeaderTitle()`, called
at the end of `fitSongContent` once the song's own font-size (and, through it, key/capo's
own em-based widths) has settled: a binary search over `#song-view-title`'s own font-size,
the same idea as `fitTextToBox` but bounded by the *header's* leftover width (`#song-header`'s
own width minus whichever of `#key-select`/`#capo-select` are visible, minus a gap per
visible one) rather than the whole page.

Its ceiling is normally 1.3x the body's own font-size — matching what a plain `font-size:
1.3em` would give the title — but clamped to `TITLE_MIN_FONT_PX`..`TITLE_MAX_FONT_PX` (16–36px)
regardless: a very short song can drive the body font-size all the way to `FIT_MAX_FONT_PX`
(80px), and 1.3x *that* would make the title dominate the page — a lot of width in
single-column layouts, and height eaten out of what `fitSongContent` measured as available
for the lyrics themselves — so `TITLE_MAX_FONT_PX` caps it there instead. `TITLE_MIN_FONT_PX`
is the same idea in the other direction: this same short-song effect also inflates key/capo's
own em-based width (`#key-select`/`#capo-select`'s own CSS caps *that* growth at `1.25rem` for
the same reason, though it doesn't eliminate it), which used to leave the title almost no
header width and shrink it to near-nothing to compensate; below this floor it ellipsis-
truncates instead (`#song-view-title`'s own `white-space`/`overflow`/`text-overflow`) — a
readable-but-truncated title beats a technically-whole but microscopic one. `fitTextToBox`
gained two more optional parameters for this, `maxFontPx`/`minFontPx` (defaulting to
`FIT_MAX_FONT_PX`/`FIT_MIN_FONT_PX` for its two original call sites, so their behaviour is
unchanged).

> **Keep in sync by hand:** `fitSongHeaderTitle`'s `SONG_HEADER_GAP_EM` constant
> (`songbook_html.js`, currently `0.6`) and `#song-header`'s own `gap: 0.6em` in the `<style>`
> block. `fitSongHeaderTitle` has no way to read the gap back out of the stylesheet — there's
> no `getComputedStyle()` available (the test suite's fake DOM has no equivalent, and a real
> browser would need a layout pass to resolve it) — so it keeps its own copy instead;
> changing one without the other means it reserves the wrong width for the gaps between
> title/key/capo.

Choosing a key only ever changes which note it is, never switches major to minor or back.
Choosing a key resets any capo choice to none. A song with no `{key}` directive gets a
`+0`..`+11` semitone-offset dropdown instead of note names. Both selects are hidden entirely
for a song with no chords at all (`ChordProSong.hasChords`). State
(`currentTranspose`/`currentCapo`) resets to the song's own values on every song change
unless a setlist entry override or a session-saved value (below) applies.

**Instrument and chord grids.** `#instrument-select` (also mirrored as
`#print-instrument-select` in the print banner — `setCurrentInstrument()` is the one place
`currentInstrument` is assigned, keeping both in sync) drives `#chord-diagrams`, a side
panel next to the song text populated per distinct chord `renderSong()`'s own `chordsUsed`
reports. `currentInstrument` is global for the whole session, not per-song. A chord with no
shape data for the chosen instrument is simply skipped (checked via
`diagram.strings.length`, a fresh `ChordDiagram` instance per chord).

**Session persistence.** Key/capo choices are saved to `sessionStorage` (not
`localStorage` — forgotten when the tab closes), keyed by song id
(`chordpro-songbook:key-capo`), wrapped in try/catch since `sessionStorage` access is known
to throw under `file://` in some browsers/privacy modes.

**Full screen.** `#fullscreen-button`, right after `#prev-song-button` in `#app-bar` (§11) —
a plain toggle against `document.documentElement.requestFullscreen()`/
`document.exitFullscreen()`. The glyph itself never changes (it's a fixed-size icon square,
shared with prev/next/print — §11); only `title`/`aria-label` ("Full screen"/"Exit full
screen") update, via the `fullscreenchange` event — setting the full text as `textContent`
on a box that small wraps and overflows it. Hidden in `@media print` alongside
`#print-banner`, since `#app-bar` stays mounted and un-hidden across every view (including
print) and would otherwise appear on the printed page itself.

**Hide/show chords.** `#toggle-chords-button`, in `#menu-bar-overflow` alongside
`#instrument-select`/`#print-song-button` — toggles the module-level `chordsHidden` flag and
a `chords-hidden` class on `#song-content`, which the stylesheet uses to hide every
`.inlineChord` span (`renderSong()`'s own chord-name markup). Global for the session like
`currentInstrument`, not reset per song. Scoped deliberately to the inline chord names in the
lyrics themselves, not `#chord-diagrams`: that panel is a separately opted-into feature (via
instrument selection), not something this toggle also suppresses. Print is unaffected — a
printed chart always shows its chords regardless of this on-screen preference, so the CSS
rule targets `#song-content.chords-hidden` specifically, never `#print-content`.

The button's own content is a fixed `[<span id="toggle-chords-glyph">C</span>]`, not a text
label — like `#fullscreen-button` (above), it's an icon among icons now, so only
`title`/`aria-label` change with state ("Hide chords"/"Show chords"); the visual state change
is the glyph's C striking through (a `.struck` class on `#toggle-chords-glyph`, driven by
`chordsHidden`) rather than any text swap.

**Song search.** `#song-search` filters `#song-list`'s rows by case-insensitive substring
match. Implemented over `Array.from(songListElement.children)`, not `.children.forEach`
directly — a real element's `.children` is a live `HTMLCollection`, which has no `.forEach`
(unlike `NodeList`, which does); the test suite's own fake DOM models `.children` as a plain
array, which does have one, so this exact mistake will pass every test here while doing
nothing in a real browser. `#song-list`/`#setlist-list` are both capped to
`max-height: 60vh` with their own scroll, rather than growing the whole page taller.

## 13. Songbook HTML output — print

`#print-view` replaces the whole screen rather than opening `window.open()` in a new
window — `window.open()` is blocked or silently does nothing in some contexts this
standalone page may be opened from (SharePoint, Dropbox's own preview); `window.print()`
itself prints whatever the *current* window shows, so no popup is needed. An on-screen
banner (hidden in `@media print`) tells the reader to press Escape or click "Done printing"
to return to the app; `exitPrintView()` returns to whichever of a song, a setlist, or the
global list was open beforehand.

Three entry points, each setting `currentPrintRebuild` (re-invocable with no arguments, so
changing the instrument mid-preview via `#print-instrument-select` redraws the same job):

- `showPrintSong()` — the one song currently open, `#print-song-button` (menu bar).
- `showPrintBook()` — every song, `#print-book-button` (list view), each in its own key/capo
  rather than whatever's selected on screen.
- `showPrintSetlist(index)` — one setlist's own entries in setlist order,
  `#print-setlist-button` (setlist view), each in that entry's own transpose/capo override.
  An entry with no matching song has no page to print, so it's skipped from the song pages,
  but stays on the contents page with "—" in place of a page number.

**Page layout.** Every song is fitted onto exactly one A4 page via `fitPrintSongPage`
(§12's `fitTextToBox`, against a fixed A4-sized box instead of the viewport) — not clipped.
`.print-page`'s physical A4 sizing (width, padding) is applied unconditionally, **not**
confined to `@media print`, so `fitPrintSongPage` can measure and fit against the page's
real size immediately, before the reader ever asks to print; a size that only existed once
print CSS took effect would be invisible to JS run beforehand. `@media print` itself only
adds `page-break-after`, hides the on-screen banner/fullscreen button, and zeroes `@page`
margins.

> **Keep in sync by hand:** `PRINT_PAGE_PADDING_MM` (`songbook_html.js`, currently `10`) and
> the `.print-page { padding: ... }` value in the `<style>` block must match exactly. They
> can't share one source value — one lives inside `initSongbookApp`'s own embedded-via-
> `.toString()` function body, the other in a separate template string in
> `renderSongbookHtml` — so changing one without the other silently breaks
> `fitPrintSongPage`'s available-space calculation.

**Front matter.** `buildFrontMatterPages(titleText, entries)` produces the title + contents
page(s): one combined page (title, an optional "With chords for [instrument]" subtitle when
one is selected, and the contents list) for up to `TOC_SPLIT_THRESHOLD` (50) entries; above
that, the contents list splits into `Math.ceil(entryCount / TOC_ENTRIES_PER_PAGE)` pages of
`TOC_ENTRIES_PER_PAGE` (50) entries each, headed "Contents (i/N)", title/subtitle only on
the first. `frontMatterPageCount(entryCount)` computes the same page count independently,
since every song's own page number has to be known before any page is actually built.

**Page numbers.** Every page — front matter or song — carries its own number
(`.print-page-number`, absolutely positioned in a corner, so it never affects
`fitPrintSongPage`'s own height measurement). `showPrintSong()` (no book context) omits one.

**Chord grids in print.** `buildChordDiagramElements()` (the same logic the on-screen
`#chord-diagrams` panel uses) is called by `buildSongPrintPage` too, laid out as a side
panel next to the song text — its width comes out of the song body's own `clientWidth` once
laid out, so `fitPrintSongPage` doesn't need to subtract it. A song that actually got at
least one diagram also gets a small "Chords for [instrument]" note under its own title
(`.print-chords-for-note`), independent of whether the book-level subtitle is showing, since
not every song is guaranteed a shape for every chord it uses; both notes' rendered heights
are subtracted from `fitPrintSongPage`'s own budget.

## 14. Visual design

High contrast: plain black-on-white (white-on-black under `prefers-color-scheme: dark`).
**Red (`--chord`) is reserved exclusively for chord names** — every other control (buttons,
borders, the menu bar, match-status badges) uses black/white rather than a colour of its
own, so red stays a single, unambiguous marker. Chorus/bridge passages and tab blocks are
set off by a border rule, never a background tint — no filled panel sits behind any text
anywhere on the page. Song text is serif; UI chrome (buttons, the menu bar) is a plain sans.

**Not yet built:** a hide-chords toggle, Nashville-number display, or any further style
controls beyond what's listed in §12.
