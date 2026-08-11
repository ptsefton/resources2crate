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
// notes/the entry-to-song link/the setlist-to-entry link all reuse standard
// schema.org properties instead (name, musicalKey, composer, description,
// specializationOf, hasPart) — see SPEC.md §7. What's left has no schema.org
// equivalent at all: a capo/transpose value, a free-text artist credit, which
// set/section an entry belongs to, and this plugin's own match-confidence
// bookkeeping.
const PROPERTY_DEFINITIONS = {
  "custom:capo": { "@id": "arcp://name,custom/terms#capo", "@type": "rdf:Property", name: "Capo" },
  "custom:transpose": { "@id": "arcp://name,custom/terms#transpose", "@type": "rdf:Property", name: "Transpose" },
  "custom:artist": { "@id": "arcp://name,custom/terms#artist", "@type": "rdf:Property", name: "Artist" },
  "custom:setName": { "@id": "arcp://name,custom/terms#setName", "@type": "rdf:Property", name: "Set Name" },
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
  // schema.org's `composer` expects a Person/Organization reference; this
  // plugin writes the ChordPro directive's free text directly instead of
  // minting a Person entity for it (SPEC.md §5) — a deliberate, documented
  // simplification, not an oversight.
  if (parsed.composer) entity.composer = parsed.composer;
  if (parsed.artist) entity["custom:artist"] = parsed.artist;
  if (Number.isInteger(parsed.capo)) entity["custom:capo"] = parsed.capo;
  if (parsed.transpose) entity["custom:transpose"] = parsed.transpose;

  return { entity, title };
}

/* ---------- Setlist / setlist-entry entities (SPEC.md §6) ---------- */

function buildSetlistEntities(relativePath, rawText, songs, setlistSuffix) {
  const { title, entries } = parseSetlist(rawText);
  const entryRefs = [];
  const entryEntities = [];
  const matchStatuses = [];

  entries.forEach((entry, index) => {
    const entryId = `${relativePath}#entry-${index + 1}`;
    const match = matchEntryToSong(entry.rawHeading, songs);
    matchStatuses.push(match.matchStatus);

    // A lightweight MusicComposition "proxy" for this one performance slot,
    // linked to the canonical Song it performs via specializationOf rather
    // than duplicating any of that Song's own data — in particular, it never
    // carries schema:text (SPEC.md §6/§7): the full text exists exactly
    // once, on the Song entity itself.
    const entryEntity = {
      "@id": entryId,
      "@type": "MusicComposition",
      name: entry.rawHeading,
      "custom:setName": entry.setName || "",
      "custom:matchStatus": match.matchStatus,
    };
    if (entry.transpose !== undefined) entryEntity["custom:transpose"] = entry.transpose;
    if (Number.isInteger(entry.capo)) entryEntity["custom:capo"] = entry.capo;
    if (entry.notes) entryEntity.description = entry.notes;
    if (match.song) entryEntity.specializationOf = { "@id": match.song.id };
    if (match.candidates.length) entryEntity["custom:matchCandidates"] = match.candidates.map((c) => ({ "@id": c.id }));

    entryEntities.push(entryEntity);
    entryRefs.push({ "@id": entryId });
  });

  const setlistEntity = {
    "@id": relativePath,
    "@type": "MusicPlaylist",
    name: title || titleFromFilename(relativePath, [setlistSuffix]),
  };
  if (entryRefs.length) setlistEntity.hasPart = entryRefs;

  return { setlistEntity, entryEntities, matchStatuses };
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
    const { setlistEntity, entryEntities, matchStatuses } = buildSetlistEntities(relativePath, rawText, songs, setlistSuffix);
    for (const entryEntity of entryEntities) crate.addEntity(entryEntity);
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
