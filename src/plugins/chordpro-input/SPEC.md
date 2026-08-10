# `chordpro-input` — design spec

**Status:** draft, not yet implemented. No code exists at this path yet. This document
defines the plan the implementation should follow.

**Location:** this document is colocated with the plugin code (`src/plugins/chordpro-input/`)
so that the folder can later be moved into its own repository together with its
specification. It currently assumes it is being read from within a `resources2crate`
checkout and links to `../../../ARCHITECTURE.md` for shared context. Before extraction to
a standalone repository, any context from that file that this document still depends on
should be restated here rather than left as an external link.

---

## 1. Purpose

This plugin converts a folder of song charts and setlists into an RO-Crate: one entity per
song, carrying its full ChordPro text and extracted metadata (title, key, capo, transpose,
artist), and one entity per setlist, carrying its ordered song entries and any performance
notes. The plugin's responsibility is limited to harvesting and structuring this data; it
does not render or otherwise process it.

This is the first of two planned components of a redo of
[chordprosite](https://github.com/ptsefton/chordprosite), a songbook compiler that
currently reads a folder of ChordPro files into an ad-hoc in-memory structure and renders
HTML in a single script. This plugin replaces that ad-hoc structure with an RO-Crate. The
second component — compiling a crate produced by this plugin into a standalone songbook
site, covering chordprosite's HTML/CSS rendering, chord-diagram graphics, transposition,
and printable pages — is a separate, later piece of work. It is out of scope for this
document: not designed, not scheduled, and not a consideration in decisions made about
this plugin's data model.

As part of the same redo, the intention is to extract chordprosite's song- and
setlist-handling logic into a standalone npm library, which will also take on chord-diagram
generation and other logic required by the second component described above. Work in this
repository should anticipate that extraction: the metadata-parsing code this plugin needs
(reading title, key, capo, transpose, and related fields from ChordPro and setlist text)
should be organised as a self-contained module within this plugin's folder, structured as
classes derived from chordprosite's existing `Song.js` and `Songs.js`, and written without
any dependency on resources2crate's plugin context or RO-Crate APIs. Organising the code
this way allows that module to be moved into the future standalone library with minimal
modification when the extraction takes place. See §8 for the resulting file layout.

## 2. Scope

**In scope:**
- Discover song files (ChordPro format) and setlist files (Markdown) in a picked folder.
- Parse each song's ChordPro metadata directives (title, key, capo, transpose, artist,
  composer) and capture its full raw text.
- Parse each setlist's Markdown structure (title, set groupings, ordered song entries,
  per-entry overrides, freeform notes) and resolve each entry to a song.
- Produce entities for both, using a small custom vocabulary, added to the crate the rest
  of the resources2crate pipeline already knows how to validate and write out as JSON,
  xlsx, and HTML preview.

**Out of scope.** The following are permanent boundaries of this plugin's responsibility,
not items deferred to a later revision of this plugin:
- Rendering songs or setlists to HTML/PDF, transposing chords, or drawing chord-diagram
  graphics. These are chordprosite's responsibility today and will be the second
  component's responsibility once built.
- Chord diagrams of any kind: neither the bundled default instrument fret data
  (`chord_data/*.cho` in chordprosite, distributed under a GPL notice inherited from
  Chordii, which would raise a licensing question requiring explicit resolution before any
  such data is bundled into a published crate) nor inline `{define:}` overrides added by a
  song's author. When a song file contains `{define:}` lines, they are retained as part of
  that song's raw text and are not given any special parsing.
- Editing songs or setlists, or writing back to the source folder.
- Any music-theory logic: transposition, Nashville numbering, or capo-shape calculation.
  Capo, transpose, and key values are harvested as opaque values and not interpreted.

## 3. Fit with resources2crate's plugin architecture

This is an **input-mode plugin** (`INPUT_PLUGINS`, keyed by `inputMode: "chordpro"`), the
same category as `docx-input`. See [ARCHITECTURE.md §4.5](../../../ARCHITECTURE.md) and
`src/plugins/docx-input/index.js` for the pattern this follows. Input modes are mutually
exclusive: exactly one runs per build, so a chordpro build does not also run the generic
file scan or the docx parser over the same folder.

The following consequences of that choice are noted explicitly, since they are not
apparent from the `docx-input` example alone:

- **No `analyzeFiles`.** As with `docx-input`, and unlike `generic-input`, this plugin
  performs its own folder walk inside `buildCrate(ctx)` rather than producing a flat
  `ctx.filesWithMeta` list for other hook handlers to annotate. Consequently `FILES_ANALYZE`
  does not fire for a chordpro build, so `austlang`'s language-by-filename lookup, which
  taps that hook, does not run. This is the correct outcome: subject-language
  identification by filename is not an applicable operation on a songbook folder.
- **`crate:built`, `crate:validate`, and `output:write` taps continue to run.** `merge`,
  `validate-crate`, and the JSON/xlsx/HTML output plugins all operate on `ctx.crate` once
  it exists, independent of which input plugin built it. None of them is specific to
  `generic-input`, so a chordpro-mode build still produces JSON/xlsx/HTML output and
  profile validation without any additional work.
- **`src/main.js` requires a corresponding edit.** Registering a plugin in `INPUT_PLUGINS`
  does not, by itself, add it to the user interface: the `inputMode` select in
  `CORE_SETTINGS_SCHEMA` (`src/main.js`, near line 50) is a fixed list of `{value, label}`
  pairs, not one derived from the plugin registry. Adding chordpro mode requires adding an
  entry to that list. This is the one respect in which the plugin is not fully
  self-contained within its own folder, and should be recorded both in the pull request
  that introduces this plugin and, separately, at the point this folder is extracted into
  its own repository, since moving the folder alone would not reproduce this integration
  point. A possible improvement — giving `INPUT_PLUGINS` entries a `label` field and having
  `main.js` construct the select from the registry rather than a parallel hardcoded list —
  is noted here as a candidate follow-up, outside this plugin's own scope.
- **No MASP profile currently selects `inputMode: "chordpro"`.** Per
  [ARCHITECTURE.md §5.4](../../../ARCHITECTURE.md), a profile's `buildOptions.inputMode`
  pre-selects and locks the mode. Without a profile naming it, chordpro mode remains
  reachable but is not the default for any profile; this is adequate during development,
  where the mode can be selected manually in Settings, but a dedicated "songbook" profile
  is a prerequisite for a build usable by an end user without that manual step. Authoring
  such a profile is out of scope for this plugin and is noted here as a dependency for
  whoever undertakes it.

## 4. File discovery

The picked folder is scanned recursively; subfolders carry no structural meaning in this
data model (see the open question in §9 on whether top-level folders should be treated as
grouping entities, analogous to `docx-input`'s one-collection-per-top-level-folder
convention). Each file is classified by extension:

| Extension (default) | Treated as |
|---|---|
| `.pro`, `.cho`, `.cho.txt` | Song (ChordPro) |
| `.setlist.md` | Setlist (Markdown) |
| anything else | ignored |

Both lists are **configurable** via `optionSchema` (comma-separated or array input;
matching is case-insensitive; a leading `.` is implied if omitted):

```js
optionSchema: {
  key: "chordproSongExtensions",
  label: "Song file extensions",
  default: [".pro", ".cho", ".cho.txt"],
  hint: "Files with these extensions are parsed as ChordPro song charts.",
},
// A second option for the setlist filename suffix is lower priority, since most
// authors are unlikely to need to change ".setlist.md"; whether it needs to be
// exposed in the user interface at all, rather than defined as a constant, is
// left as an implementation decision.
```

Dotfiles and common editor/OS artifacts (`.DS_Store`, `~$*`, etc.) are skipped, consistent
with the convention `docx-input` already applies.

## 5. Parsing a song file

Only the **metadata-extraction subset** of chordprosite's `Song.js` `initialise()` method
should be ported — not `format()`, not `Transposer`, and not chord-highlighting or HTML
markup generation. That logic belongs to the second component described in §1, which will
need it against a richer in-memory `Song` object. Importing it here would introduce
rendering-related concerns into a plugin whose responsibility is limited to data
harvesting, and would couple this plugin's data shape to assumptions made by that rendering
code.

**Fields extracted**, from ChordPro's `{directive: value}` lines:

| Directive(s) | Extracted as | First-wins or accumulate? |
|---|---|---|
| `{title}` / `{t}` | `name` | **First wins** (see note below) |
| `{subtitle}` / `{artist}` / `{st}` | `custom:artist` | First wins |
| `{key}` | `musicalKey` | First wins |
| `{capo}` | `custom:capo` (integer) | First wins |
| `{transpose}` / `{tr}` | `custom:transpose` | First wins |
| `{composer}` | `composer` | First wins |
| everything else | retained as part of raw text, not extracted | — |

`musicalKey` and `composer` are standard schema.org properties of `MusicComposition` — see
§7 for the full reasoning on which fields reuse schema.org vocabulary and which stay
custom. `artist`/`capo`/`transpose` have no schema.org equivalent and stay custom regardless
of what type the entity carrying them has.

**Divergence from chordprosite's `Song.js`.** The original accumulates `{title}` and
`{subtitle}` across multiple occurrences (`this.title += dir.value`) and appends
`{version: N}` as `" - VN"` onto the title, while every other directive is first-wins.
This inconsistency appears to be an artifact of incremental development rather than a
deliberate authoring convention: nothing in the ChordPro format specification anticipates
multiple `{title}` directives within a single file. This plugin instead applies
**first-wins uniformly to every metadata directive** and does not special-case
`{version}`. Should a real song library be found to depend on the original's concatenation
behaviour, this decision should be revisited against that evidence rather than in
advance of it. (The `{composer}` directive is extracted here although chordprosite's own
`Song.js` recognises it as a directive without reading it into a field; this is an
addition made by this plugin, not a requirement for compatibility with chordprosite.)

**Raw text.** The file's original text, unmodified — not stripped of its title directive
as chordprosite's `buildDataStructure` does when producing its cleaned `content` field — is
stored verbatim as `schema:text` on the Song entity. `schema:text` is reused rather than
defining a custom property, since it corresponds exactly to schema.org's own purpose for
that property. **The Song entity is the only place this text is ever written.** §6
introduces a second `MusicComposition` entity per setlist entry (a proxy for "this song, as
performed in this slot"); that entity deliberately never carries `schema:text` — a setlist
naming the same song ten times must not write that song's full text ten times over. Anyone
who needs the text follows the entry's `specializationOf` reference back to the one Song
entity that holds it.

**No file payload.** The plugin does **not** copy the source `.pro`/`.cho` file into the
crate's own file tree in the way `generic-input` copies files into a payload alongside
`File` entities. A Song entity carries its content as data (`schema:text`), and the crate
does not depend on the original bytes being present alongside it to be self-sufficient.
This is a narrower crate shape than `generic-input` produces, deliberately; it is recorded
as an open question in §9, in case archival fidelity — retaining the literal original file
bytes, not only their parsed text — is later found to matter.

**Song identity.** `@id` is the file's path relative to the picked folder, the same
convention `buildFileMetadata` already uses in `src/crate.js`. This makes ids stable,
human-legible, and collision-free by construction: two distinct relative paths cannot
collide, and two files sharing the same title can and should coexist as distinct Song
entities.

**Title fallback.** A file with no `{title}` directive falls back to its filename, minus
extension, mirroring chordprosite's own fallback (`song.title || filePath...`) rather than
introducing a different rule.

## 6. Parsing a setlist file

Setlist files are Markdown with a specific dialect layered on top, not arbitrary Markdown.
The grammar below is based on chordprosite's `Songs.js#processPlaylist` and the sample at
`chordprosite/samples/sample.setlist.md`:

```
{Title: Gig number 1,000}      <- optional, first non-blank line only, using the
                                   same {directive: value} syntax as ChordPro itself
                                   (not YAML frontmatter). Falls back to filename.

# Set 1                        <- a set/section heading (H1). Informational
                                   grouping only in this data model — see below.

## Slot Machine Baby           <- a setlist entry (H2): the heading text is
                                   matched against known song titles (§6.1)

> Play with a lively feel...   <- performance notes: any non-blank,
>> But not **that** lively!       non-heading line(s) immediately following
                                   an entry, up to the next heading,
                                   concatenated verbatim (raw Markdown,
                                   ">>"/emphasis syntax and all) into that
                                   entry's description. Blockquote ("> ")
                                   markup is not required — see below.

## Baby {transpose: -2}        <- inline {directive: value} after the title
                                   text overrides that entry's transpose/capo
                                   for this performance, independent of the
                                   matched song's own values
```

**Notes do not require blockquote markup.** A note is any non-blank, non-heading line
following an entry, up to the next heading, regardless of whether it happens to start with
`>`. This was decided against the real sample file rather than in the abstract: it mixes
blockquote-styled notes under one entry (`> Play with a lively feel...`) with a plain
paragraph under another (`Play slow this time.`), with nothing suggesting the two carry
different meaning — and chordprosite's own `processPlaylist` does not treat either specially
today (it reads only `##` lines; every other line, blockquote or not, is currently just
ignored). Requiring `>` would have silently dropped the plain-paragraph note in that same
file, which is a worse outcome than accepting both.

**Each entry is its own `MusicComposition` — a proxy for one performance slot, not a
generic wrapper.** Rather than inventing a `SetlistEntry` type to sit between a `Setlist`
and the `Song` it names, every entry is itself typed `MusicComposition`, exactly like the
canonical Song entities §5 describes — see §7 for the full reasoning. It is linked back to
the canonical Song it performs via `specializationOf` (a standard schema.org `CreativeWork`
property: "a work that this work is a special case of"), and it never carries `schema:text`
— see §5's "Raw text" for why that matters: the same song named in three setlists must not
write its lyrics/chords three more times.

**Sets are not modelled as their own entities.** Each entry carries the text of the
nearest preceding `#` heading as a plain string (`custom:setName`). A harvesting crate does
not require a separate `Set` entity to record which set an entry belongs to; a string
property is sufficient, and — like `matchStatus`/`matchCandidates` below — nothing in
schema.org's vocabulary fits "which section of a running order this belongs to" regardless.
If the second component described in §1 later requires richer set-level structure (for
example, notes scoped to an entire set, or per-set ordering metadata), that would be grounds
to introduce a `Set` entity at that point, based on an established requirement rather than
in anticipation of one.

**Entry-level overrides.** `{transpose: N}` / `{tr: N}` and `{capo: N}` found inline on a
`##` line are captured as `custom:transpose` / `custom:capo` directly on the entry, distinct
from, and taking precedence over, the matched Song's own values. This is necessary because
the same song can appear in two setlists performed in two different keys — the entry's
values describe *this performance*, the Song's own values (linked via `specializationOf`)
describe the song in general. This mirrors chordprosite's own per-instance override
behaviour in `processPlaylist`.

### 6.1 Matching an entry to a song

The matching algorithm is ported directly from chordprosite's existing behaviour
(`Songs.js#processPlaylist`) rather than redesigned, since the immediate objective is a
working harvester rather than an improved matcher; improving the matching algorithm is a
separate piece of work with its own tradeoffs to evaluate on its own terms.

1. Strip any trailing `{...}` directive text and surrounding whitespace from the heading
   to obtain the bare entry name (e.g. `"Baby {transpose: -2}"` becomes `"Baby"`).
2. Attempt an **exact** match against a song's title (case-insensitive).
3. If no exact match is found, construct a regular expression from the entry name by
   joining its words with `.*?` (chordprosite's `songName.replace(/\s+/g, '.*?')`) and test
   it case-insensitively against every song title. This is intentionally permissive —
   `"Amazing"` matches `"Amazing Grace"`, `"Baby"` matches `"Slot Machine Baby"` — matching
   chordprosite's existing behaviour by design, not by oversight.
4. **Zero matches:** the entry is retained with no `specializationOf` reference. It is
   legitimate data — an entry the setlist's author included — and belongs in the crate
   even when unresolved. It is marked `custom:matchStatus: "unresolved"`.
5. **Exactly one match:** the entry is linked to that song via `specializationOf`, with
   `custom:matchStatus` set to `"exact"` or `"fuzzy"` depending on which step produced the
   match.
6. **Multiple matches:** chordprosite's own behaviour is to use the first match, which, by
   its own `Songs.js` logic, is not guaranteed to be the song the setlist's author
   intended — only the one that happens to appear earliest in the scanned file list. This
   plugin retains that resolution (first match wins, so an entry's structure does not
   depend on which stage performs the resolution) but, unlike chordprosite, records the
   ambiguity as data: `custom:matchStatus: "ambiguous"`, together with
   `custom:matchCandidates` listing every candidate's `@id`, in addition to
   `specializationOf` referencing the one selected. A build-log warning (`ctx.log(...,
   "warn")`) is also emitted, but recording the ambiguity in the crate itself ensures it
   remains inspectable after the build, in the data, rather than only in a log that may not
   be retained. This allows anyone examining the crate later to identify which entries
   require a manual decision, without needing to re-run a build.

`matchStatus` is a plain string enum present on every entry, not only on entries that
failed to resolve, so that a count of entries by resolution outcome can be obtained
directly from the graph rather than recomputed.

## 7. Entity shapes

**Revised from this document's first draft.** The first version of this section minted a
small custom vocabulary — `custom:Song`, `custom:Setlist`, `custom:SetlistEntry` — on the
premise that schema.org had no fit for a song's own data. That premise was wrong in two
specific, checkable ways: schema.org's `MusicComposition` already defines a `musicalKey`
property and a `composer` property, and `MusicPlaylist` (plus the generic `hasPart`/
`specializationOf` from `CreativeWork`) covers a setlist and its ordered entries without
inventing anything. What follows reuses standard vocabulary everywhere a real fit exists,
and keeps `rdf:Property`-documented custom terms only for the handful of fields that
genuinely have none — the same discipline `austlang` already establishes in this codebase
(`LANGUAGE_PROPERTY_DEFINITIONS` in `src/plugins/austlang/index.js`) for its own fields.

**No custom type is minted at all.** Both a Song and a setlist entry are typed
`MusicComposition` — see §5 and §6 for why an entry is a lightweight `MusicComposition`
"proxy" for a specific performance slot rather than some other shape. A Setlist is typed
`MusicPlaylist`. Nothing in this plugin's graph carries a `custom:`-prefixed `@type`.

```jsonc
{
  "@id": "AmazingGrace.cho.txt",
  "@type": "MusicComposition",
  "name": "Amazing Grace",
  "text": "{title: Amazing Grace}\n{key: G}\n\nA-[G]maz-ing [G7]Grace, ...",
  "musicalKey": "G"
  // composer / custom:artist / custom:capo / custom:transpose are omitted
  // entirely when the source file had no matching directive — never written as
  // null or empty, following the "nothing added unconditionally" convention
  // crate.js's fileProperties handling already applies (ARCHITECTURE.md §6.1).
  // composer, when present, is schema.org's own property — see §5's note on
  // why it's written as a bare string rather than a Person/Organization ref.
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
    // The order of this array is significant (performance order). This is
    // documented rather than enforced by JSON-LD itself; @list semantics were
    // considered and rejected as unnecessary for an array read only by this
    // application.
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
  // No "text" here — see §5/§6: the full song text lives exactly once, on the
  // Song entity `specializationOf` points at.
}
```

`#entry-N`-style hash ids follow `crate.js`'s existing convention of using structural hash
ids internally and rewriting them to `arcp://` form on export (ARCHITECTURE.md §6.1); this
plugin should use that existing mechanism rather than introduce a parallel one.

**Which fields reuse schema.org vocabulary, and which stay custom:**

| Field | Property used | Standard or custom? |
|---|---|---|
| a song's title / an entry's raw heading text | `name` | standard (`Thing`) |
| a song's full source text | `text` | standard (`CreativeWork`) |
| a song's key | `musicalKey` | standard (`MusicComposition`) |
| a song's composer credit | `composer` | standard (`MusicComposition`) — written as a bare string, see §5 |
| a setlist's ordered entries | `hasPart` | standard (`CreativeWork`) |
| an entry's link back to the song it performs | `specializationOf` | standard (`CreativeWork`) |
| an entry's performance notes | `description` | standard (`Thing`) |
| a song's or entry's performer/attribution credit | `custom:artist` | custom — free text, no schema.org property fits |
| a song's or entry's capo position | `custom:capo` | custom — no schema.org equivalent at all |
| a song's or entry's transpose value | `custom:transpose` | custom — no schema.org equivalent at all |
| which set/section an entry belongs to | `custom:setName` | custom — no schema.org equivalent at all |
| this plugin's confidence in an entry's song match | `custom:matchStatus` | custom — specific to this plugin's own harvesting process, not a property of the music itself |
| every candidate when a match was ambiguous | `custom:matchCandidates` | custom — same reasoning as `matchStatus` |

The last two — `matchStatus` and `matchCandidates` — are the one place where "no schema.org
fit" is closer to structural than incidental: they describe *this plugin's own confidence*
in a piece of derived data, not a fact about a song or a performance, so no amount of
vocabulary reuse would make them disappear.

`rdf:Property` definitions to add, each only when at least one entity in the build actually
uses it — the same "only when it's actually present" discipline `austlang` follows, rather
than adding definitions unconditionally:

| `@id` | `name` | Used on |
|---|---|---|
| `arcp://name,custom/terms#capo` | Capo | a Song or an entry (both `MusicComposition`) |
| `arcp://name,custom/terms#transpose` | Transpose | a Song or an entry |
| `arcp://name,custom/terms#artist` | Artist | a Song |
| `arcp://name,custom/terms#setName` | Set Name | an entry |
| `arcp://name,custom/terms#matchStatus` | Match Status | an entry |
| `arcp://name,custom/terms#matchCandidates` | Match Candidates | an entry |

(`name`, `text`, `musicalKey`, `composer`, `hasPart`, `specializationOf`, and `description`
are all standard schema.org properties defined by every profile's base context; no
definition entity is needed for any of them.)

## 8. Plugin file layout

```
src/plugins/chordpro-input/
  SPEC.md                     this document
  index.js                    plugin registration: name, inputMode: "chordpro",
                               buildCrate(ctx) — resources2crate-specific glue only;
                               no ChordPro/Markdown parsing logic of its own
  chordpro_crate.js            folder walk and RO-Crate entity assembly; calls into
                               lib/ for all parsing, and has no ChordPro/Markdown
                               parsing logic of its own either
  lib/
    ChordProSong.js            a class derived from chordprosite's Song.js, reduced to
                               metadata parsing (title, key, capo, transpose, artist,
                               composer) with no formatting or transposition logic
    Setlist.js                 setlist parsing and the matching algorithm from §6.1,
                               adapted from chordprosite's Songs.js — as two pure
                               functions rather than a class, since the song list a
                               setlist matches against isn't state a Setlist owns
    index.js                   re-exports the above
  samples/                     the real chordprosite sample files (chordprosite's own
                               samples/, minus its build artifacts) used as test
                               fixtures below, not synthetic ones
  test-chordpro-song.mjs       unit tests for lib/ChordProSong.js
  test-chordpro-setlist.mjs    unit tests for lib/Setlist.js, including ambiguous/
                               unresolved matches and an end-to-end pass against
                               samples/
  test-chordpro-crate.mjs      integration test for chordpro_crate.js against samples/
```

Tests are colocated with the plugin's own code, alongside `lib/`, rather than living
under the top-level `tests/` folder the rest of this repo otherwise uses — consistent with
§1's extraction goal: the whole folder, tests and fixtures included, should be everything
this plugin needs. `scripts/run-tests.mjs` discovers `test-*.mjs` recursively for exactly
this reason, running each with its own directory as `cwd`.

`lib/` is written with no dependency on resources2crate's plugin context, hook bus, or
RO-Crate APIs — it takes text in and returns plain data out. This is what makes it
possible, per §1, to move `lib/` into the future standalone npm library largely unchanged;
`chordpro_crate.js` and `index.js` are the resources2crate-specific layer that remains
behind and adapts `lib/`'s output into crate entities.

Parsing logic in `lib/` is dynamically imported from `buildCrate` rather than imported at
the top of `index.js`, so it stays out of the main application bundle until a chordpro
build actually runs — the same discipline `docx-input` and `austlang` already follow for
their own heavier dependencies.

A `docs/chordpro-authoring.md` file, parallel to `docs/docx-authoring.md`, should be added
once there is settled behaviour to document for the person writing song and setlist files:
the setlist dialect in §6, the fuzzy-matching behaviour and its ambiguity handling in §6.1,
and the configurable extensions in §4. Per ARCHITECTURE.md §4.7, this plugin makes real
requests of its content authors and should therefore have such a document.

## 9. Open questions / decisions still needed

Resolved during the writing of this spec, recorded here for reference rather than for
reconsideration:

- **Chord diagrams are deferred entirely** and are not parsed in any form (§2).
- **Setlist matching is ported as-is from chordprosite** (exact match, then fuzzy regex,
  then first-match-wins), with ambiguity recorded as data rather than resolved silently
  (§6.1).
- **The vocabulary reuses schema.org wherever a real fit exists** — `MusicComposition` for
  both a Song and a setlist entry, `MusicPlaylist` for a Setlist, `musicalKey`/`composer`/
  `hasPart`/`specializationOf`/`description` as the relevant properties — and mints custom
  properties only for the handful of fields with no schema.org equivalent at all (§7).
  Superseded revision: an earlier draft of this section instead minted `custom:Song`/
  `custom:Setlist`/`custom:SetlistEntry` types, on the mistaken premise that schema.org had
  no fit for a song's own data.

Still open:

1. **Whether a top-level folder should carry meaning** — for example, becoming a grouping
   entity, as `generic-input` and `docx-input` both treat top-level folders as structural —
   or whether the folder structure should remain unrepresented regardless of how the user
   organises files on disk. Chordprosite's own `samples/` folder is flat, which is the
   assumption made in §4. This should be revisited if real song libraries are found to be
   organised into artist or genre subfolders that should be represented as structure in
   the crate.
2. **No original-file payload** (§5): the crate stores parsed text as data, not the
   original file bytes. This is adequate for the stated goal of harvesting data, but
   whether archival fidelity — retaining byte-identical originals, which would support
   re-export or comparison against a future re-harvest — is also required should be decided
   explicitly rather than left as a side effect of this choice.
3. **First-wins applied uniformly to all metadata directives** (§5) diverges from
   chordprosite's accumulate-title/subtitle behaviour. The risk is considered low, but if a
   real song library is found to depend on that concatenation behaviour, this plugin will
   visibly truncate affected titles to their first occurrence. This should be checked
   against whatever song files are used for testing before the decision is treated as
   final.
4. **Duplicate or near-duplicate song titles.** Chordprosite's own duplicate-detection
   logic in `crate.js#buildFileMetadata`, based on normalised filenames, is not currently
   connected to this plugin's matching logic or entity model: two songs titled "Amazing
   Grace" originating from different files simply coexist as unrelated entities. This is
   worth addressing only if it is found to matter for real song libraries; it is not
   required before an initial version of this plugin can be used.
5. **No MASP profile exists for `inputMode: "chordpro"`** (§3). This is a prerequisite for
   an end-to-end build that does not require manual configuration in Settings, but
   authoring such a profile is not part of this plugin's own scope.
