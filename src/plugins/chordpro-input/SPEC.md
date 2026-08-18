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

- **Metadata entry and cleanup** (`fix_st_directive_ui.js`, `st_directive.js`,
  `scripts/fix-st-directive.mjs`): a standalone tool, wired directly into the app's UI rather
  than through this plugin's own `HOOKS` taps, for fixing up old charts whose metadata
  predates this project's own `{artist}`/`{subtitle}` split (§5) — specifically, `{st: ...}`
  used as a stand-in for a performer or composer credit. Unlike Harvesting and Songbook
  rendering, this stage **can** write back into the picked folder: it rewrites `{st:}`
  directives to `{artist:}`/`{composer:}` under a human's own per-occurrence choice, after
  first backing up the affected files to a zip kept inside the folder itself. See §15.

- **Songbook rendering** (`songbook_html.js`): reads the RO-Crate this half of the plugin
  just wrote and produces `songbook.html`, a single file containing the crate's own data
  plus a client-side app that displays it — a song list, individual song views with
  transposition and chord diagrams, setlists, and a print mode. This file is meant to be
  opened directly (including as a `file://` URL) with no server and no build step. A
  chordpro-mode build never runs `ro-crate-html-output`'s own static-site rendering — that
  machinery targets generic tabular/document crates, not this one — so `ro-crate-preview.html`
  becomes a small redirect to `songbook.html` instead (§10).

The three stages depend on [`chordprobook`](https://github.com/ptsefton/chordprobook) (a sibling
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
- Editing songs or setlists, or writing back to the source folder — true of Harvesting and
  Songbook rendering (§1), which never do either. The one deliberate exception is the
  `{st:}` cleanup tool (§1, §15), a standalone action outside
  `runPipeline()`/`processFolder()` entirely, authorised specifically for that narrow
  purpose.
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
| `{artist}` | `performer` |
| `{subtitle}` / `{st}` | `subtitle` |
| `{key}` | `musicalKey` |
| `{capo}` | `custom:capo` (string containing an integer) |
| `{transpose}` / `{tr}` | `custom:transpose` (string — either a signed integer or a key name, e.g. `Em`) |
| `{composer}` | `composer` |
| everything else | retained as part of raw text, not extracted |

Every directive is first-wins (the first occurrence in the file is kept; later repeats of
the same directive are ignored).

- **Raw text.** The file's original text, unmodified, is stored verbatim as `text` on the
  Song entity — so the crate can function without file access, independent of the metadata
  extracted from it above. **The Song entity is the only place this text is ever written** —
  a setlist entry naming the same song (§6) never carries its own copy.
- **Identity.** `@id` is the file's path relative to the picked folder.
- **Title fallback.** A file with no `{title}` directive falls back to its filename, minus
  extension with s/_/ /g.

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
  // composer / performer / subtitle / custom:capo / custom:transpose are omitted entirely
  // when the source file had no matching directive — never written as null or empty.
}
```

```jsonc
{
  "@id": "i_called_your_name.cho.txt",
  "@type": "MusicComposition",
  "name": "I Called Your name",
  "text": "{title: I Called Your name}\n{st: Peter Sefton}\n...",
  "musicalKey": "C",
  "subtitle": "Peter Sefton",
  // {capo: 2} would appear as "custom:capo": "2" — a string, like every other
  // extracted directive here, not the JS number ChordProSong itself parses it into.
  "custom:transpose": "+7"
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
| a song's `{artist}` credit | `performer` | standard (`MusicComposition`/`Event`) — a bare string, not a Person/Organization reference, same simplification as `composer` |
| a song's `{subtitle}`/`{st}` | `subtitle` | standard (`CreativeWork`) |
| a setlist's ordered entries | `hasPart` | standard (`CreativeWork`) |
| an entry's link to the song it performs | `specializationOf` | standard (`CreativeWork`) |
| an entry's performance notes | `description` | standard (`Thing`) |
| capo position | `custom:capo` | custom — a string containing an integer on a Song entity (a song's own `{capo}`, SPEC.md §5); a JS number on a setlist entry (an inline `{capo: N}` override, parsed independently by `Setlist.js`, SPEC.md §6) — the one property in this crate whose type depends on which kind of entity carries it |
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
| `arcp://name,custom/terms#setName` | Set Name |
| `arcp://name,custom/terms#matchStatus` | Match Status |
| `arcp://name,custom/terms#matchCandidates` | Match Candidates |

(`name`, `text`, `musicalKey`, `composer`, `performer`, `subtitle`, `hasPart`,
`specializationOf`, `description` are standard schema.org properties already defined by every
profile's base context — none of them gets an entry in the table above.)

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
  st_directive.js              isomorphic {st:} match/rewrite core — see §15
  fix_st_directive_ui.js       browser-only shell (folder walk, zip backup, write-back) — see §15
  test-st-directive.mjs        unit tests for st_directive.js
  build-songbook.mjs            standalone Node CLI: builds songbook.html with no browser/app
                               UI involved — see §10
```

`chordprobook` is dynamically imported from `buildCrate` (via `chordpro_crate.js`, itself
dynamically imported from `index.js`), so it stays out of the main application bundle until
a chordpro build actually runs.

Tests are colocated with the plugin's own code, discovered recursively by
`scripts/run-tests.mjs`, rather than living under the top-level `tests/` folder.

**This plugin is meant to eventually move into its own repository**, installable standalone
without resources2crate at all — nothing decided yet about packaging or distribution, but it's
why `build-songbook.mjs` (§10) is written to depend on nothing outside this folder besides
Node builtins and the `chordprobook` npm package this plugin already requires regardless, and
why `st_directive.js` (§15) is a pure, dependency-free module in the same spirit. Everything
else here — `chordpro_crate.js`'s own imports of `crate.js`'s `GENERATED_FILENAMES`/
`CONTROL_FILENAMES`, `fix_st_directive_ui.js`'s of `fs_helpers.js`, `songbook_html.js`'s
`HOOKS`-tapped plugin object itself — still reaches into resources2crate proper, since those
only matter inside the app; an eventual extraction would need to address each of those
separately, not just this one script.

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
3. Duplicate or near-duplicate song titles from different files are not deduplicated or
   cross-referenced in any way; they simply coexist as unrelated entities.
4. No MASP profile currently selects `inputMode: "chordpro"` (§3), so an end-to-end build
   requires manual configuration in Settings.

---

## 10. Songbook HTML output — what the file contains

`renderSongbookHtml(crateJson)` in `songbook_html.js` produces one self-contained HTML file,
written as `songbook.html`. It contains three `<script>` elements, all **classic, not
`type="module"`** — a module script's cross-origin rules block it entirely when the page is
opened as a `file://` URL, which is how this file is meant to be opened:

1. `<script type="application/ld+json" id="crate-data">` — the crate's own JSON-LD,
   pretty-printed, with a defensive escape of any literal `</script` inside it.
2. A classic `<script>` containing `CHORDPROBOOK_BROWSER_BUNDLE`, `CHORDPROBOOK_INSTRUMENTS_DATA`,
   and `CHORDPROBOOK_CHORD_DATA` — see below.
3. A classic `<script>` invoking `initSongbookApp(document, window)` — a plain function
   exported from `songbook_html.js` and embedded via `.toString()` (its actual source, not
   a hand-written duplicate), constituting the entire client-side app.

**`ro-crate-preview.html` is a redirect to this file, not a second preview.**
`ro-crate-html-output/index.js`'s own `OUTPUT_WRITE` hook guards on
`ctx.options.inputMode === "chordpro"` — for every other mode it runs the usual
ro-crate-static-site rendering (`crateToPreviewHtml`/`crateToMultiPageHtml`), but for chordpro
mode it skips that entirely (before ever touching `ctx.crate`) and writes a small,
purpose-built redirect page instead (`buildChordproRedirectHtml`, same file). `songbook.html`
is this mode's real preview; a second, generic rendering of the same crate would be redundant
and wouldn't render a song/setlist crate meaningfully anyway. `ro-crate-preview.html` is kept
as a real (if trivial) file rather than omitted because `main.js`'s own "Show" step still
expects an `HTML_FILE` to open when one exists, ahead of falling back to JSON/xlsx.

That redirect page posts the same `{ source: "r2c-preview", page: "songbook.html" }` message
`main.js`'s own `PREVIEW_NAV_SCRIPT` sends on a click-through, directly on load, rather than a
plain relative-URL navigation: the app's own preview popup (`openHtmlInNewTab`/
`openPageInPreview`) shows crate-generated pages via `blob:` URLs, which a normal relative
`href`/`location` change can't navigate away from correctly. `window.opener` is what makes
this work from inside that popup; opened with no opener at all (a real `file://` URL, e.g.
someone double-clicking it outside the app), it falls back to a plain
`window.location.replace("songbook.html")` instead. Tested by
`tests/test-chordpro-preview-redirect.mjs` (top-level `tests/`, not this plugin's own folder —
the code under test is `ro-crate-html-output/index.js`, not anything in `chordpro-input/`).

**Building a songbook without the app at all.** `build-songbook.mjs` is a standalone Node CLI
that runs the same two steps a real app build does for chordpro mode — `buildCrateFromChordProFolder`
then `renderSongbookHtml` — directly against a real folder on disk, with no browser, no File
System Access API, and no resources2crate UI in between:

```
node src/plugins/chordpro-input/build-songbook.mjs <folder>
npm run build:songbook -- <folder>
```

It wraps the folder in a small read-only stand-in for the File System Access API's own
directory-handle shape (`values()` yielding `{kind, name, getFile()|values()}`) —
`buildCrateFromChordProFolder` itself has no idea whether it's talking to a real browser handle
or this Node-backed one — writes `ro-crate-metadata.json` (`crate.getJson()`, the same plain
graph object a real build's `ro-crate-json-output` plugin serializes — this script doesn't
import that plugin or `crate.js`'s own one-line `crateToJsonString` wrapper, for the
self-containment reason in the script's own header comment, but produces byte-for-byte
equivalent JSON), then `songbook.html`. Reports song/setlist counts and any unresolved/
ambiguous setlist-entry matches (SPEC.md §6.1) to stdout, the same warnings `onProgress`
already surfaces inside the app's own build log. Does not write `ro-crate-preview.html` — that
redirect stub exists only for the app's own "Show" button (this section, above), which a
headless CLI run has no equivalent of.

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
| `#list-view` | `showList()` | all songs (searchable, scrollable), each with a composer/artist/subtitle credit line and key (§12), a "Print this songbook" button, a "Setlists" button (hidden if the crate has none) |
| `#setlist-index-view` | `showSetlistIndex()` | every setlist by name |
| `#setlist-view` | `showSetlist(index)` | one setlist's entries: position, heading, credit line and key (§12), match-status badge, notes, print/notes-toggle controls |
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

Its search range is a flat `TITLE_MIN_FONT_PX`..`TITLE_MAX_FONT_PX` (16–36px), independent of
the body's own font-size — not, as an earlier version tried, a ceiling *derived* from it
(`min(TITLE_MAX_FONT_PX, max(TITLE_MIN_FONT_PX, bodyFontPx * 1.3))`, matching what a plain
`font-size: 1.3em` would give the title). That formula was meant only to stop a very short
song — whose body font-size can reach `FIT_MAX_FONT_PX` (80px) — from scaling the title up
into dominating the page, but a flat `TITLE_MAX_FONT_PX` ceiling already fully covers that case
on its own (`min(36, 80 * 1.3)` and a flat `36` are the same number), so the body-font term
added no benefit — and cost a real bug: for any normal-to-long song, whose body text has to
shrink well below `FIT_MAX_FONT_PX` to fit all its lyrics, `bodyFontPx * 1.3` could land
*below* `TITLE_MIN_FONT_PX`, at which point `max(TITLE_MIN_FONT_PX, ...)` pulled the ceiling
back up to exactly the floor — collapsing the search range to nothing and forcing the title to
16px regardless of how much header width was actually free. That fired for any song whose
*lyrics* needed a small font, which has nothing to do with whether the *title* had room — a
long song with a perfectly ordinary amount of header space would render with a visibly tiny
title next to a short song's much larger one, for no reason connected to the title's own fit.
`TITLE_MIN_FONT_PX` is a readable floor for a different reason: a title that can't fit even
this small, at the header's actual available width, ellipsis-truncates instead
(`#song-view-title`'s own `white-space`/`overflow`/`text-overflow`) — a readable-but-truncated
title beats a technically-whole but microscopic one. `fitTextToBox` gained two more optional
parameters for this, `maxFontPx`/`minFontPx` (defaulting to `FIT_MAX_FONT_PX`/`FIT_MIN_FONT_PX`
for its two original call sites, so their behaviour is unchanged).

**`#key-select`/`#capo-select` are also capped at `max-width: 5.5rem` (with `overflow:
hidden`/`text-overflow: ellipsis`)** — found via real (headless-Chrome) measurement, not the
fake-DOM test suite, which can't observe a real `<select>`'s own rendered width at all: Chrome
sizes a `<select>` by its *widest option*, not its currently-selected one.
`populateCapoSelect`'s own `"N - (key shapes)"` labels (§12, above) run noticeably longer for
any song with a real `{key}` — worse for a minor key, whose every option gets an extra
trailing "m" — than a keyless song's plain `"Capo N"` fallback. That difference alone could
reserve 50-90px more of `#song-header`'s width for a keyed song, at direct, otherwise-invisible
cost to `fitSongHeaderTitle`'s own available width — a keyed song's title could end up
noticeably smaller than a keyless one's for a reason with nothing to do with the title itself.
Capped via CSS rather than by shortening the label text — which stays fully intact and
readable in the open dropdown either way, only the *closed* box's width is bounded.

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
match against the title *and* whatever `creditFor()` picked for that row's credit line (§12,
below) — composer, else performer, else subtitle, matching what's actually visible, not all
three independently regardless of which one a row displays. Implemented over
`Array.from(songListElement.children)`, not `.children.forEach` directly — a real element's
`.children` is a live `HTMLCollection`, which has no `.forEach` (unlike `NodeList`, which
does); the test suite's own fake DOM models `.children` as a plain array, which does have one,
so this exact mistake will pass every test here while doing nothing in a real browser.
`#song-list`/`#setlist-list` are both capped to `max-height: 60vh` with their own scroll,
rather than growing the whole page taller.

**Credit line and key in list rows.** Both `#song-list` (`showList()`) and `#setlist-entries`
(`renderSetlistEntries()`/`buildSetlistEntryRow()`) show, under each title, a single italic
credit line — `composer`, else `performer` (a song's own `{artist}`), else `subtitle`
(`{subtitle}`/`{st}`) — the first of those three the song actually has, never more than one at
once. This is a *display* preference for one line under a title, unrelated to and no more
authoritative than `chordpro_crate.js`'s own precedence for what a `{st:}` directive should be
migrated *to* (SPEC.md §15) — a song can perfectly well carry both a `composer` and a
`performer`, in which case only the composer shows here. The song's own `musicalKey` (`{key}`)
is shown alongside it, not italicized. A song with none of `composer`/`performer`/`subtitle`,
or no `{key}`, simply omits whichever part it has nothing for — nothing renders an empty
credit line or a bare "Key:" label.

A setlist entry (`buildSetlistEntryRow`) shows its *underlying song's* own credit/key this same
way, resolved via `entry.songIndex` into the `songs` array built at the top of
`initSongbookApp` — never anything of the entry's own, since an entry carries no
composer/performer/subtitle/key of its own to begin with (only `transpose`/`capo` overrides
and freeform notes — SPEC.md §6/§7). An unresolved entry (`entry.songIndex === -1`, no matching
song at all) shows neither, for the same reason it has no name link to a song view either.

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

**Page layout.** Each of a song's own sections (`renderSong()`'s own `pages` array — length 1
unless the source has `{new_page}`/`{np}` directives, in which case one A4 page per section:
`buildNormalPrintSongPages`, not a change to `buildSongPrintPage` itself, which still only
ever builds one page from one section) is fitted onto exactly one A4 page via
`fitPrintSongPage` (§12's `fitTextToBox`, against a fixed A4-sized box instead of the
viewport) — not clipped. None of these per-section pages carry a "(continued)" note: unlike
large print's own auto-split continuation (below), a `{new_page}` break is a deliberate,
authored one, and every section starts clean. `.print-page`'s physical A4 sizing (width,
padding) is applied unconditionally, **not** confined to `@media print`, so `fitPrintSongPage`
can measure and fit against the page's real size immediately, before the reader ever asks to
print; a size that only existed once print CSS took effect would be invisible to JS run
beforehand. `@media print` itself only adds `page-break-after`, hides the on-screen
banner/fullscreen button, and zeroes `@page` margins.

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

**Large print.** `#large-print-checkbox` in the print banner — checked, every song gets two
physical pages instead of one, at a font size roughly double what `fitPrintSongPage` would
have found for the same content on a single page. Read directly wherever it matters
(`largePrintCheckbox.checked`, in `showPrintSong`/`showPrintBook`/`showPrintSetlist`) rather
than kept in a separate synced variable — there's only the one checkbox, and its own checked
state is unaffected by `#print-view` being hidden/shown, so there's nothing to restore on
re-entry either (unlike `currentInstrument`, which two different selects need kept in sync).
Changing it while already in print view redraws via `currentPrintRebuild`, the same as
changing the instrument does.

*Building the spread.* `buildLargePrintSongPages(name, rendered, firstPageNumber)` builds
two-page pairs, one pair per section in `rendered.pages` — almost always length 1, but not
when the source has its own `{new_page}`/`{np}` directives (chordprobook's `renderSong`,
which splits on exactly that); normal print mode joins every section into one continuous flow
on one page regardless (`buildSongPrintPage`'s own `body.innerHTML =
rendered.pages.join("\n")`), but large print gives each section its own independent spread,
each with its own font-size fit and its own split point.

Page 1 of a pair is built with the section's full rendered content, the same as a normal
print page; page 2 is built with none of its own (`{ ...sectionRendered, pages: [""] }`).
`fitLargePrintSongPages(page1, page2)` is what moves whatever doesn't fit on page 1 onto page
2 — and, unlike every other fit in this file, can't just reuse `fitTextToBox`: that fits one
box to one height; this has to fit one piece of content across *two* independently-sized
boxes (page 1's own `availableHeight1`, page 2's own `availableHeight2` — usually close but
not identical, since page 2 alone carries a "(continued)" note) and, more importantly, has to
choose *where* to split it.

Two earlier versions of this got the split itself wrong, in different ways. The first cut at
an arbitrary height (the midpoint of a box fit to twice one page's height) — landing mid-line
or mid-chorus, visually chopping a heading or lyric in half across the page break. The second
fixed *where* to cut (walking children to find a clean boundary, below) but still built page 2
as a *second*, separate rendering of the identical markup, relying on a computed clip+negative-
margin to make it show "the other half" — which depends on that second copy reflowing
pixel-for-pixel identically to the first one's independent layout; small divergences between
them chopped text right at the seam regardless of how carefully the boundary was chosen, and
any section whose content didn't fit within the *combined* two-page budget overflowed
invisibly past page 2's own clip, forcing the browser to insert its own extra, untracked
physical page with no page number and no "(continued)" note — breaking the odd/even alignment
(below) for every song after it.

The current version avoids both by moving the actual DOM nodes instead of measuring a height
to clip. `trySplit(fontPx)` walks `.print-song-body-content`'s top-level children (`renderSong()`'s
own `.heading`/`.line`/`blockquote`/`pre`/`img` chunks) and finds the largest prefix that fits
within `availableHeight1` without cutting one in half — a whole `blockquote` (chorus/bridge:
several lines wrapped in one element) moves to page 2 entirely rather than being split
mid-block, which is the case that most obviously exposed a bad cut. It uses each child's own
`offsetTop` (not a running sum of `offsetHeight`, which would silently drift from the real
rendered layout once margins between adjacent siblings collapse) to find that boundary, and
checks that everything after it still fits within `availableHeight2` (`remaining <=
availableHeight2`) before accepting a given font size — the search itself is over font size
exactly like `fitTextToBox` (same `FIT_MIN_FONT_PX`/`FIT_MAX_FONT_PX` bounds), just with this
two-sided `fits` check standing in for `fitTextToBox`'s own single-box comparison. Once the
search settles on a font size and a cut index, the actual children from that index onward are
moved — `page2.printSongBodyContent.appendChild(child)` for each — directly off page 1's own
(real, already-measured) content onto page 2's. Neither page's `.print-song-body` needs an
explicit height or `overflow: hidden` at all: page 1 only ever keeps the children just proven
to fit its own budget, and page 2 only ever receives the ones proven to fit its own — there's
nothing left over on either side to clip, and (short of a single section too long to fit two
pages combined at any font size down to the floor — the same accepted edge case
`fitTextToBox` already has for a single page, not new here) nothing left to silently overflow
onto an untracked extra page either.

Building page 2 by moving nodes rather than duplicating markup and clipping it — and not one
wide multi-column box spanning two sheets, an idea considered and discarded before any of
this was written — avoids the fragility of two independently-laid-out copies needing to agree
pixel-for-pixel, and the unreliability of CSS multi-column fragmentation across physical
printed pages (columns distribute across a page's own overflow height, not sideways across a
page *width* wider than the paper itself, which is what two side-by-side pages would need).
The second page of every pair carries a small "(continued)" note (`buildSongPrintPage`'s own
`continued` parameter) so a page landing on its own — photocopied, separated from its spread —
still reads as the back half of a longer song rather than a different, truncated one; a fresh
`{new_page}` section deliberately does *not* get this treatment on its own first page, since
it's meant to start clean.

> **Test coverage gap:** `trySplit`'s own boundary-walking (never cutting a child element in
> half, and the node move that follows it) isn't exercised by `test-songbook-html.mjs`'s fake
> DOM — its `document.createElement` never populates a real `.children` tree from an
> `.innerHTML` string (this file's own header comment), so every dynamically-built print
> page's `.print-song-body-content.children` is always empty in a test, regardless of what
> was assigned to `.innerHTML`. With no children to walk, there's nothing to move either —
> `test-songbook-html.mjs`'s own large-print tests assert exactly that (both pages'
> `.children` staying empty), with a comment pointing back here rather than re-explaining it.
> Confirming the boundary-walking itself avoids a bad cut, and that nothing overflows onto an
> untracked page, is a real-browser concern, same as this file's other layout caveats (§10,
> §11).

*Facing-page alignment.* `#facing-pages-checkbox` in the print banner, checked by default (the
markup's own `checked` attribute, not JS) — PT: "keep songs on facing pages for double-sided
printing." `alignSongStart(pageNumber, pageCount, keepFacingPages)` decides, for *every* song
in sequence (`showPrintBook`/`showPrintSetlist`'s own running `pageNumber`), whether a blank
filler page has to go immediately in front of it: an even page and the odd page immediately
after it are what a reader actually sees together when a bound book is opened (page 1 is
always alone, on the right); an odd-then-even pair never is, since it straddles two different
spreads instead of forming one. A single-page song is skipped entirely regardless of the
checkbox — there's no spread to protect, so aligning it would just scatter blank pages through
the book for no benefit — and unchecking the box skips every song, including multi-page ones.
When a blank page is needed, `buildBlankPrintPage()` (explicitly marked "This page is
intentionally blank" — the same convention real printed books use, so it doesn't read as a
mistake) is inserted, and the song's own first page moves from `pageNumber` to `pageNumber +
1`.

This has to be a per-song check, not a once-per-book one, because normal print's own per-song
page count varies now — a `{new_page}` song (`buildNormalPrintSongPages`, above) can be any
length, so *any* song along the way, not only the first, can land on an odd start after an
earlier odd-length one (Song A, one page; Song B, two — Song B's own start is what needs
checking, not the book's). Large print doesn't have this per-song variability (every song is
always exactly two pages, or two pages per `{new_page}` section —
`buildLargePrintSongPages`), so in practice `alignSongStart` only ever inserts a blank there
for the first song in the whole book; every later one is already aligned automatically, since
an even page count added to an even start always lands on another even number — but the check
itself doesn't need to know that distinction; it re-verifies before every song regardless.

## 14. Visual design

High contrast: plain black-on-white (white-on-black under `prefers-color-scheme: dark`).
**Red (`--chord`) is reserved exclusively for chord names** — every other control (buttons,
borders, the menu bar, match-status badges) uses black/white rather than a colour of its
own, so red stays a single, unambiguous marker. Chorus/bridge passages and tab blocks are
set off by a border rule, never a background tint — no filled panel sits behind any text
anywhere on the page. Song text is serif; UI chrome (buttons, the menu bar) is a plain sans.

**Not yet built:** a hide-chords toggle, Nashville-number display, or any further style
controls beyond what's listed in §12.

## 15. Metadata entry and cleanup — the `{st:}` cleanup tool

PT's own ChordPro chart collection goes back to around 2015, predating this project's own
`{artist}`/`{subtitle}` split (§5): a lot of charts use `{st: ...}` where the value is
actually a performer or composer credit, not a genuine subtitle. This tool finds those
occurrences and rewrites them under a human's own per-occurrence choice — it never guesses.

**Not a `HOOKS`-based plugin tap.** Every other stage of this plugin runs inside
`runPipeline()`/`processFolder()` (§3), triggered by a build. This tool is a standalone
action wired directly into `main.js`/`index.html` — a `#fixStBtn` button in the app's
folder-scoped `#contextBar`, alongside Show/Edit/Build, enabled whenever a folder is picked
regardless of input mode or whether a crate has ever been built. It runs independently of the
crate-building pipeline entirely.

**Shared, isomorphic core.** `st_directive.js` is pure string-in/string-out logic — no file
I/O — the same isomorphic split `crate.js`'s own header comment describes for a different
reason, and reused as-is by both `scripts/fix-st-directive.mjs` (the original, Node CLI
version of this tool, run by hand against a real chart collection) and
`fix_st_directive_ui.js` (the browser shell below), so the actual `{st:}`-matching and
rewrite rules exist exactly once. It exports:
- `ST_DIRECTIVE_RE` — matches `{st: value}` (whitespace-tolerant, case-insensitive on `st`
  itself), deliberately not matching `{subtitle:}`/`{artist:}` (already-correct directives)
  or `{start_of_chorus:}`/`{stanza:}` (the colon has to immediately follow `st`).
- `findMatches(text)` — every occurrence in one file's text, in document order, as
  `{ value, matchText, index }`.
- `applyChoices(text, choices)` — `choices[i]` is the choice for the *i*-th match
  `findMatches()` would return, in that same order: `"artist"` (default, `{st:}` becomes
  `{artist:}`), `"composer"` (replaces the line with `{composer:}` instead — it was never a
  performer credit), `"both"` (keeps the renamed `{artist:}` line and adds a *second*, new
  `{composer:}` line after it), or `"skip"` (the original `{st:}` line is left untouched).

Both functions defensively reset `ST_DIRECTIVE_RE.lastIndex = 0` before scanning:
`String.prototype.matchAll` on a shared, mutable, global (`/gi`) regex inherits whatever
`lastIndex` the regex object was last left at rather than always starting from 0 — a real
correctness hazard for an exported, reusable regex — even though `String.prototype.replace`
happens to reset it internally regardless.

**The CLI script's own interactive UX is unchanged by sharing this module.** `scripts/fix-
st-directive.mjs` still does its own thing end to end: list every hit numbered, ask which
numbers should *also* get a `{composer:}` line (its `doubleUpNumbers` set becomes a
per-file `choices` array of mostly `"artist"`, `"both"` for the flagged ones), confirm, zip
the affected files, rewrite. `"composer"`-only and `"skip"` are choices the shared module
supports but the CLI's own prompt never offers — nothing about the CLI's UX asked for them.

**The browser UI (`fix_st_directive_ui.js`)** owns the one File System Access API walk this
tool needs, independent of `chordpro_crate.js`'s own (reusing its exported
`DEFAULT_SONG_EXTENSIONS` so both walks agree on what counts as a song file):
- `findStDirectiveHits(dirHandle)` — walks the folder, returning one flat, globally-numbered
  list of hits (`{ number, relativePath, lineNumber, value, matchText }`) across every song
  file, in a stable sorted-file order and each file's own document order.
- `applyStDirectiveFixes(dirHandle, hits, choicesByNumber)` — re-reads each affected file
  fresh off disk (not trusting whatever `findStDirectiveHits()` saw, which may be from
  moments earlier), zips the original text of every affected file — not every file scanned,
  which would bulk out the backup with files that have nothing to do with this cleanup —
  writes that zip to `.chordpro-cleanup-backups/<timestamp>.zip` *inside* the picked folder
  via `writeFileAtPath` (`fs_helpers.js`, which creates intermediate directories as needed),
  then rewrites each affected file in place via `applyChoices`.

**Why the backup stays out of a crate build with no new code.** A dot-prefixed folder is
already invisible to every folder walk in this codebase — `chordpro_crate.js`'s own
`isIgnoredName` and `main.js`'s `walkDirectory` both unconditionally skip anything starting
with `.` — so `.chordpro-cleanup-backups/` needs no entry in `GENERATED_FILENAMES`/
`CONTROL_FILENAMES` (`crate.js`) to stay out of the crate this plugin builds.

**The UI itself**: clicking `#fixStBtn` scans the current folder; if there are no hits, a
one-line "nothing to fix" message goes to the build log instead of opening anything.
Otherwise `#fixStDirectiveModal` lists every hit (file path, line, matched value) each with a
`<select>` — Artist / Composer / Both / Leave as `{st:}` — defaulting to Artist, styled like
the app's other row-based modals (`#collectionLabelsModal`, `#mergeMappingModal`). Applying
reads every row's choice, calls `applyStDirectiveFixes`, and logs a result summary (files
changed, occurrences, backup path) the same way the Build view logs its own results.
