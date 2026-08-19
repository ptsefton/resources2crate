// Builds an RO-Crate from a folder of ChordPro song files and Markdown
// setlists, entirely in the browser via the File System Access API. See
// SPEC.md for the design this implements — in particular §4 (file
// discovery), §5 (Song entities), §6 (Setlist/setlist-entry entities), and §7
// (the entity shapes and rdf:Property definitions below mirror that section
// exactly).
//
// Analogous in role to docx-input's docx_crate.js: this file owns the
// folder walk and RO-Crate entity assembly. All ChordPro/Markdown parsing
// itself lives in the chordprobook package (see SPEC.md §1/§8) and is not
// duplicated here.

import { ROCrate } from "ro-crate";
import { GENERATED_FILENAMES, CONTROL_FILENAMES } from "../../crate.js";
import { ChordProSong, parseSetlist, matchEntryToSong } from "chordprobook";

export const DEFAULT_SONG_EXTENSIONS = [".pro", ".cho", ".cho.txt"];
export const DEFAULT_SETLIST_SUFFIX = ".setlist.md";

// rdf:Property definitions for the custom fields this plugin writes (SPEC.md
// §7) — added once, and only for whichever of these keys actually appear
// somewhere in the finished graph (see addUsedPropertyDefinitions), the same
// "only when it's actually there" discipline the austlang plugin follows for
// its own custom fields. This list is deliberately short: title/key/composer/
// performer/subtitle/a note's own text/the entry-to-song link/the
// setlist-to-entry link/which set an entry belongs to all reuse standard
// schema.org properties instead (name, musicalKey, composer, performer,
// subtitle, text, specializationOf, hasPart — the last two also being what
// expresses a set's own membership in its setlist, and an entry's in its
// set, structurally, rather than as a flat string property — SPEC.md §7).
// What's left has no schema.org equivalent at all: a capo/transpose value,
// and this plugin's own match-confidence bookkeeping.
const PROPERTY_DEFINITIONS = {
  "custom:capo": { "@id": "arcp://name,custom/terms#capo", "@type": "rdf:Property", name: "Capo" },
  "custom:transpose": { "@id": "arcp://name,custom/terms#transpose", "@type": "rdf:Property", name: "Transpose" },
  "custom:matchStatus": { "@id": "arcp://name,custom/terms#matchStatus", "@type": "rdf:Property", name: "Match Status" },
  "custom:matchCandidates": { "@id": "arcp://name,custom/terms#matchCandidates", "@type": "rdf:Property", name: "Match Candidates" },
};

/* ---------- directory walking (FileSystemDirectoryHandle) ---------- */

function isIgnoredName(name) {
  return name.startsWith(".") || name.startsWith("~$") || GENERATED_FILENAMES.has(name) || CONTROL_FILENAMES.has(name);
}

// Recursively finds every file under `dirHandle`, returning
// { handle, relativePath } where relativePath is "/"-joined and relative to
// `dirHandle` itself. Subfolders carry no structural meaning in this input
// mode (SPEC.md §4/§9) — every matching file anywhere in the tree becomes a
// Song or Setlist regardless of which folder it's in.
async function findFiles(dirHandle, prefix = "") {
  const found = [];
  for await (const entry of dirHandle.values()) {
    if (isIgnoredName(entry.name)) continue;
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.kind === "directory") found.push(...(await findFiles(entry, relativePath)));
    else if (entry.kind === "file") found.push({ handle: entry, relativePath });
  }
  return found;
}

function matchesAnySuffix(name, suffixes) {
  const lower = name.toLowerCase();
  return suffixes.some((suffix) => lower.endsWith(suffix));
}

function titleFromFilename(relativePath, knownSuffixes) {
  const baseName = relativePath.split("/").pop();
  const lower = baseName.toLowerCase();
  const matched = knownSuffixes.find((suffix) => lower.endsWith(suffix));
  return matched ? baseName.slice(0, baseName.length - matched.length) : baseName;
}

/* ---------- Song entities (SPEC.md §5) ---------- */

// The canonical entity for one song file: the *only* place its full text
// lives (schema:text) — every setlist entry that performs this song points
// back here rather than carrying its own copy (see buildSetlistEntities).
function buildSongEntity(relativePath, rawText, songExtensions) {
  const parsed = new ChordProSong(rawText);
  const title = parsed.title || titleFromFilename(relativePath, songExtensions);

  const entity = { "@id": relativePath, "@type": "MusicComposition", name: title, text: rawText };
  if (parsed.key) entity.musicalKey = parsed.key;
  // schema.org's `composer`/`performer` both expect a Person/Organization
  // reference; this plugin writes the ChordPro directive's free text
  // directly instead of minting a Person entity for either (SPEC.md §5) —
  // a deliberate, documented simplification, not an oversight.
  if (parsed.composer) entity.composer = parsed.composer;
  if (parsed.artist) entity.performer = parsed.artist;
  if (parsed.subtitle) entity.subtitle = parsed.subtitle;
  // A string, not the number ChordProSong itself parses {capo} into
  // (SPEC.md §5) — every other extracted directive here is a plain string
  // already (musicalKey/composer/transpose can all hold non-numeric text,
  // e.g. a transpose target like "Em"), and capo's own crate representation
  // follows that same convention rather than being the one property with a
  // real JS number for a value. This is scoped to the Song entity's own
  // {capo} only — a setlist entry's own capo override (SPEC.md §6, from a
  // completely different parser, Setlist.js) is unaffected and stays a
  // number (see buildSetlistEntities, below).
  if (Number.isInteger(parsed.capo)) entity["custom:capo"] = String(parsed.capo);
  if (parsed.transpose) entity["custom:transpose"] = parsed.transpose;

  return { entity, title };
}

/* ---------- Setlist / setlist-entry entities (SPEC.md §6) ---------- */

// Groups entries into sets (SPEC.md §6) by consecutive runs sharing the
// same (non-empty) entry.setName — an entry with no set at all (setName
// "", from a setlist that never uses "#", or one that hasn't reached its
// first "#" heading yet) is not part of any group and stays a direct child
// of the top-level setlist itself, exactly as every setlist behaved before
// "#" sets existed as their own entities at all. Two "#" sections that
// happen to share a literal name are only treated as one group when
// they're directly adjacent (nothing else could tell them apart from a
// flat list of entries alone without also threading Setlist.js's own line
// position through); a real setlist repeating a set name for two genuinely
// separate sections is an edge case this plugin doesn't try to disambiguate
// further. Returns an array of either `{ kind: "entry", entry, index }` or
// `{ kind: "set", setName, entries: [{ entry, index }, ...] }`, in file
// order.
function groupEntriesIntoSets(entries) {
  const groups = [];
  let i = 0;
  while (i < entries.length) {
    const { setName } = entries[i];
    if (!setName) {
      groups.push({ kind: "entry", entry: entries[i], index: i });
      i += 1;
      continue;
    }
    const members = [];
    while (i < entries.length && entries[i].setName === setName) {
      members.push({ entry: entries[i], index: i });
      i += 1;
    }
    groups.push({ kind: "set", setName, entries: members });
  }
  return groups;
}

function buildSetlistEntities(relativePath, rawText, songs, setlistSuffix) {
  const { title, entries, setNotes } = parseSetlist(rawText);
  const entryEntities = [];
  const entryRefsByIndex = [];
  const matchStatuses = [];

  entries.forEach((entry, index) => {
    const entryId = `${relativePath}#entry-${index + 1}`;
    const match = matchEntryToSong(entry.rawHeading, songs);
    matchStatuses.push(match.matchStatus);

    // A lightweight MusicComposition "proxy" for this one performance slot,
    // linked to the canonical Song it performs via specializationOf rather
    // than duplicating any of that Song's own data. Which set (if any) this
    // entry belongs to is expressed structurally now, via which
    // MusicPlaylist's own hasPart references it (below) — not as a property
    // on the entry itself (superseded custom:setName, SPEC.md §6/§7).
    const entryEntity = {
      "@id": entryId,
      "@type": "MusicComposition",
      name: entry.rawHeading,
      "custom:matchStatus": match.matchStatus,
    };
    if (entry.transpose !== undefined) entryEntity["custom:transpose"] = entry.transpose;
    // A number here, not the string a Song entity's own {capo} becomes
    // (buildSongEntity, above) — this comes from Setlist.js's own inline
    // `{capo: N}` override parsing (SPEC.md §6), a different parser with no
    // string-everywhere convention of its own to match, and this value is
    // only ever read back as a number (songbook_html.js's own entriesById).
    if (Number.isInteger(entry.capo)) entryEntity["custom:capo"] = entry.capo;
    // `text`, not `description`: a performance note can itself be Markdown
    // (chordprosite's own sample setlist already mixed blockquote syntax
    // with **bold** — SPEC.md §6), and songbook_html.js renders it as such
    // (SPEC.md §6.2) — `description` is conventionally a short plain-text
    // summary, not markup meant for rendering. This is a deliberate
    // overload of the same property name the canonical Song entity uses for
    // its own, differently-meant, verbatim ChordPro source (SPEC.md §5/§7)
    // — an entry is always distinguishable from a canonical Song by @id
    // shape regardless (an entry's own always contains "#entry-"), not by
    // whether `text` happens to be present, which is what makes reusing the
    // name safe here.
    if (entry.notes) entryEntity.text = entry.notes;
    if (match.song) entryEntity.specializationOf = { "@id": match.song.id };
    if (match.candidates.length) entryEntity["custom:matchCandidates"] = match.candidates.map((c) => ({ "@id": c.id }));

    entryEntities.push(entryEntity);
    entryRefsByIndex.push({ "@id": entryId });
  });

  // One nested MusicPlaylist per "#" set (SPEC.md §6), each with its own
  // hasPart pointing at that set's own entries — the top-level setlist's own
  // hasPart then points at a mix of these set entities and any setName-less
  // entries, in original file order. A setlist that never uses "#" at all
  // produces zero set entities and an unchanged, flat top-level hasPart —
  // this is a strict superset of the old behaviour, not a replacement for
  // it in the common case. @id numbering is this loop's own 1-based count of
  // sets actually built, not tied to anything Setlist.js itself tracks.
  const setEntities = [];
  const topLevelRefs = [];
  let setNumber = 0;
  for (const group of groupEntriesIntoSets(entries)) {
    if (group.kind === "entry") {
      topLevelRefs.push(entryRefsByIndex[group.index]);
      continue;
    }
    setNumber += 1;
    const setId = `${relativePath}#set-${setNumber}`;
    const setEntity = {
      "@id": setId,
      "@type": "MusicPlaylist",
      name: group.setName,
      hasPart: group.entries.map(({ index }) => entryRefsByIndex[index]),
    };
    // Freeform text between the "#" heading and this set's own first entry
    // (e.g. "Tune guitars to drop D now") — `text`, not `description`, for
    // the same reason as an entry's own note above: it can be Markdown, and
    // is rendered as such (SPEC.md §6.2).
    if (setNotes[group.setName]) setEntity.text = setNotes[group.setName];
    setEntities.push(setEntity);
    topLevelRefs.push({ "@id": setId });
  }

  const setlistEntity = {
    "@id": relativePath,
    "@type": "MusicPlaylist",
    name: title || titleFromFilename(relativePath, [setlistSuffix]),
  };
  if (topLevelRefs.length) setlistEntity.hasPart = topLevelRefs;

  return { setlistEntity, setEntities, entryEntities, matchStatuses };
}

/* ---------- rdf:Property definitions (SPEC.md §7) ---------- */

function addUsedPropertyDefinitions(crate) {
  const used = new Set();
  for (const entity of crate.graph) {
    for (const key of Object.keys(entity)) {
      if (PROPERTY_DEFINITIONS[key]) used.add(key);
    }
  }
  for (const key of used) crate.addEntity(PROPERTY_DEFINITIONS[key]);
}

/* ---------- root dataset ---------- */

// Deliberately minimal — just enough for a valid, describable root dataset.
// docx-input's validateAndNormalizeConfig also handles creators and a
// metadata licence; nothing in this plugin's scope (SPEC.md §2) currently
// needs that, so it isn't ported speculatively. Add it the same way docx-
// input does if a real build turns out to need it.
function applyRootDataset(crate, config) {
  const rootDataset = (config && typeof config.rootDataset === "object" && config.rootDataset) || {};

  crate.rootDataset.name =
    (typeof rootDataset.name === "string" && rootDataset.name.trim()) || "Songbook";
  crate.rootDataset.description =
    (typeof rootDataset.description === "string" && rootDataset.description.trim())
    || "RO-Crate generated from ChordPro song and setlist files.";

  const declaredDate = typeof rootDataset.datePublished === "string" ? rootDataset.datePublished.trim() : "";
  crate.rootDataset.datePublished = /^\d{4}-\d{2}-\d{2}$/.test(declaredDate)
    ? declaredDate
    : new Date().toISOString().split("T")[0];
}

/* ---------- top-level orchestration ---------- */

// Builds an RO-Crate from `rootHandle` (a FileSystemDirectoryHandle scanned
// recursively for song and setlist files — SPEC.md §4). `config` is the raw
// rootDataset config, same shape docx-input's buildCrateFromDocxFolder
// takes. `onProgress(message)` receives human-readable progress/warning
// lines, mirroring docx-input's own convention (severity is conveyed by the
// message text — a "Warning:" prefix — not by a separate argument).
// `opts.songExtensions` / `opts.setlistSuffix` override the defaults
// (SPEC.md §4's configurable extensions).
//
// Returns { crate, songCount, setlistCount, unresolvedCount, ambiguousCount },
// or null if the folder contains no matching song or setlist files at all.
export async function buildCrateFromChordProFolder(rootHandle, config, onProgress = () => {}, opts = {}) {
  const songExtensions = (opts.songExtensions?.length ? opts.songExtensions : DEFAULT_SONG_EXTENSIONS)
    .map((ext) => ext.toLowerCase());
  const setlistSuffix = (opts.setlistSuffix || DEFAULT_SETLIST_SUFFIX).toLowerCase();

  const allFiles = await findFiles(rootHandle);
  const songFiles = [];
  const setlistFiles = [];
  for (const file of allFiles) {
    if (matchesAnySuffix(file.relativePath, [setlistSuffix])) setlistFiles.push(file);
    else if (matchesAnySuffix(file.relativePath, songExtensions)) songFiles.push(file);
  }

  if (songFiles.length === 0 && setlistFiles.length === 0) return null;

  songFiles.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  setlistFiles.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

  const crate = new ROCrate({ array: true, link: true });
  crate.addContext({ custom: "arcp://name,custom/terms#" });
  applyRootDataset(crate, config);

  onProgress(`Found ${songFiles.length} song file(s) and ${setlistFiles.length} setlist file(s).`);

  const songs = []; // { id, title } — the list setlist-entry matching (§6.1) resolves against
  const rootHasPart = [];

  for (const { handle, relativePath } of songFiles) {
    const rawText = await (await handle.getFile()).text();
    const { entity, title } = buildSongEntity(relativePath, rawText, songExtensions);
    crate.addEntity(entity);
    songs.push({ id: relativePath, title });
    rootHasPart.push({ "@id": relativePath });
    onProgress(`  Song: ${relativePath} (${title})`);
  }

  let unresolvedCount = 0;
  let ambiguousCount = 0;

  for (const { handle, relativePath } of setlistFiles) {
    const rawText = await (await handle.getFile()).text();
    const { setlistEntity, setEntities, entryEntities, matchStatuses } = buildSetlistEntities(relativePath, rawText, songs, setlistSuffix);
    for (const entryEntity of entryEntities) crate.addEntity(entryEntity);
    for (const setEntity of setEntities) crate.addEntity(setEntity);
    crate.addEntity(setlistEntity);
    rootHasPart.push({ "@id": relativePath });

    for (const status of matchStatuses) {
      if (status === "unresolved") unresolvedCount += 1;
      if (status === "ambiguous") ambiguousCount += 1;
    }
    onProgress(`  Setlist: ${relativePath} (${entryEntities.length} entr${entryEntities.length === 1 ? "y" : "ies"})`);
  }

  if (unresolvedCount > 0) {
    onProgress(`  Warning: ${unresolvedCount} setlist entr${unresolvedCount === 1 ? "y" : "ies"} could not be matched to a song.`);
  }
  if (ambiguousCount > 0) {
    onProgress(`  Warning: ${ambiguousCount} setlist entr${ambiguousCount === 1 ? "y" : "ies"} matched more than one song — ` +
      "the first match was used; see custom:matchCandidates on that entry.");
  }

  crate.rootDataset.hasPart = rootHasPart;
  addUsedPropertyDefinitions(crate);

  return { crate, songCount: songFiles.length, setlistCount: setlistFiles.length, unresolvedCount, ambiguousCount };
}
