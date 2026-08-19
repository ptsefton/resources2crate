// Integration test for buildCrateFromChordProFolder
// (src/plugins/chordpro-input/chordpro_crate.js), exercised against the real
// chordprosite sample files under this plugin's own samples/ rather than
// synthetic fixtures — see SPEC.md for the design this implements.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildCrateFromChordProFolder } from "./chordpro_crate.js";

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "samples");

/* ---------- an in-memory stand-in for FileSystemDirectoryHandle ---------- */
// Only what chordpro_crate.js's folder walk actually calls: values() for
// directory listing and getFile() on a file handle — no writing, unlike
// docx_crate.js's mock in test-docx-source-documents.mjs, since this plugin
// never writes files of its own (SPEC.md §5, "No file payload").
function toNode(value) {
  if (value instanceof Uint8Array) return { kind: "file", bytes: value };
  const children = new Map();
  for (const [childName, childValue] of Object.entries(value)) children.set(childName, toNode(childValue));
  return { kind: "dir", children };
}

function wrapNode(name, node) {
  if (node.kind === "file") {
    return { kind: "file", name, async getFile() { return new File([node.bytes], name); } };
  }
  return {
    kind: "directory",
    name,
    async *values() {
      for (const [childName, child] of node.children) yield wrapNode(childName, child);
    },
  };
}

function memoryDirHandle(name, tree) {
  return wrapNode(name, toNode(tree));
}

/* ---------- fixture: the real chordprosite sample files, read from disk ---------- */

const SONG_FILENAMES = [
  "AmazingGrace.cho.txt", "gimme_a_u.cho.txt", "i_called_your_name.cho.txt",
  "slot_machine_baby.cho.txt", "ukulele_train.cho.txt", "uni-verse.cho.txt",
];
const SETLIST_FILENAME = "sample.setlist.md";

const tree = {};
for (const name of [...SONG_FILENAMES, SETLIST_FILENAME]) {
  tree[name] = readFileSync(path.join(fixturesDir, name));
}
// A file that shouldn't be picked up at all — neither a recognised song
// extension nor the setlist suffix.
tree["README.md"] = Buffer.from("not a setlist");
// A file nested in a subfolder — subfolders carry no structural meaning in
// this input mode (SPEC.md §4/§9), so this should be found and treated as
// an ordinary song, same as one sitting at the top level.
tree["extra"] = { "another_song.pro": Buffer.from("{title: Another Song}\n{key: A}\n[A]La la") };

const dirHandle = memoryDirHandle("root", tree);

/* ---------- run the build ---------- */

const messages = [];
const result = await buildCrateFromChordProFolder(dirHandle, {}, (msg) => messages.push(msg));

assert.ok(result, "expected a result — the fixture folder is not empty");
assert.equal(result.songCount, SONG_FILENAMES.length + 1); // +1 for extra/another_song.pro
assert.equal(result.setlistCount, 1);
assert.equal(result.unresolvedCount, 0);
assert.equal(result.ambiguousCount, 0);

// .toJSON() (crate.graph is the live, linked proxy — its array:true option
// means every property reads back as an array; .toJSON() is the plain JSON-LD
// shape actually written to ro-crate-metadata.json, and what
// test-docx-source-documents.mjs also asserts against for the same reason).
const graph = result.crate.toJSON()["@graph"];
const byId = new Map(graph.map((entity) => [entity["@id"], entity]));
const byType = (type) => graph.filter((entity) => {
  const types = Array.isArray(entity["@type"]) ? entity["@type"] : [entity["@type"]];
  return types.includes(type);
});

/* ---------- root dataset ---------- */

const rootDataset = byId.get(result.crate.rootDataset["@id"]);
assert.equal(rootDataset.name, "Songbook");
assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(rootDataset.datePublished));
assert.equal(rootDataset.hasPart.length, SONG_FILENAMES.length + 1 + 1); // songs + setlist

/* ---------- README.md was ignored, the nested song was not ---------- */

assert.equal(byId.has("README.md"), false);
const nestedSong = byId.get("extra/another_song.pro");
assert.ok(nestedSong, "a song nested in a subfolder should still be found and built");
assert.equal(nestedSong.name, "Another Song");

/* ---------- Song entities ---------- */
// Both a canonical Song and a setlist-entry proxy are typed MusicComposition
// (SPEC.md §7) — the two are told apart here by specializationOf/
// custom:matchStatus (songbook_html.js's own isCanonicalSong, same check),
// not by @id shape or by whether "text" is present: an entry can carry its
// own `text` too now (its performance note, SPEC.md §6/§7), so that check
// would wrongly count an entry-with-a-note as a canonical song.
// specializationOf alone isn't quite enough either — an unresolved entry
// has none, since there's genuinely nothing for it to specialize — so
// custom:matchStatus (written unconditionally onto every entry, resolved or
// not, and never onto a canonical Song) covers that gap.
const isSetlistEntryProxy = (entity) => "specializationOf" in entity || "custom:matchStatus" in entity;
const musicCompositions = byType("MusicComposition");
const canonicalSongs = musicCompositions.filter((entity) => !isSetlistEntryProxy(entity));
assert.equal(canonicalSongs.length, SONG_FILENAMES.length + 1);

const amazingGrace = byId.get("AmazingGrace.cho.txt");
assert.equal(amazingGrace.name, "Amazing Grace");
assert.equal(amazingGrace.musicalKey, "G");
assert.equal(amazingGrace.text, readFileSync(path.join(fixturesDir, "AmazingGrace.cho.txt"), "utf8"));
assert.equal("composer" in amazingGrace, false); // no {composer} directive in this file
assert.equal("performer" in amazingGrace, false); // no {artist} directive in this file
assert.equal("subtitle" in amazingGrace, false); // no {subtitle}/{st} directive in this file
assert.equal("custom:capo" in amazingGrace, false); // no {capo} directive anywhere in the fixture set

// {st: Peter Sefton} — a *subtitle* directive, not {artist}, so it lands on
// `subtitle`, not `performer` (SPEC.md §5/§7 — the two used to be one
// conflated field, custom:artist).
const iCalledYourName = byId.get("i_called_your_name.cho.txt");
assert.equal(iCalledYourName.subtitle, "Peter Sefton");
assert.equal("performer" in iCalledYourName, false);
assert.equal(iCalledYourName["custom:transpose"], "+7");

/* ---------- Setlist + set + setlist-entry entities (SPEC.md §6) ---------- */

const setlist = byId.get(SETLIST_FILENAME);
assert.ok(setlist);
assert.equal(setlist["@type"], "MusicPlaylist");
assert.equal(setlist.name, "Gig number 1,000");
// Both "#" sets from the sample file (Set 1, Set 2) became their own nested
// MusicPlaylist entities — the top-level setlist's own hasPart points at
// those two, not at the four entries directly (SPEC.md §6).
assert.equal(setlist.hasPart.length, 2);

const set1 = byId.get(setlist.hasPart[0]["@id"]);
const set2 = byId.get(setlist.hasPart[1]["@id"]);
assert.equal(set1["@id"], `${SETLIST_FILENAME}#set-1`);
assert.equal(set1["@type"], "MusicPlaylist");
assert.equal(set1.name, "Set 1");
assert.equal(set2["@id"], `${SETLIST_FILENAME}#set-2`);
assert.equal(set2["@type"], "MusicPlaylist");
assert.equal(set2.name, "Set 2");
// Both sets have their own freeform text between the "#" heading and their
// first entry in this fixture (added specifically to exercise this — SPEC.md
// §6/§6.2) — stored as `text`, like an entry's own note, not `description`
// (a deliberate overload of the property name the canonical Song entity
// uses for something different — its own verbatim ChordPro source).
assert.equal(set1.text, "This is our last gig so make it a good one\n1. No spitting!\n2. Not too much fighting");
assert.equal(set2.text, "Maybe we shouldn't quit?");

assert.equal(set1.hasPart.length, 3); // Slot Machine Baby, Uni, Amazing
assert.equal(set2.hasPart.length, 1); // Baby

const entryIds = [...set1.hasPart, ...set2.hasPart].map((ref) => ref["@id"]);
assert.deepEqual(entryIds, [
  `${SETLIST_FILENAME}#entry-1`, `${SETLIST_FILENAME}#entry-2`,
  `${SETLIST_FILENAME}#entry-3`, `${SETLIST_FILENAME}#entry-4`,
]);

const entries = entryIds.map((id) => byId.get(id));
const [slotMachineEntry, uniEntry, amazingEntry, babyEntry] = entries;

// None of the four entries carry the *song's* own text — only, when they
// have a performance note of their own, their own `text` (SPEC.md §6/§7,
// a deliberate overload of the same property name the canonical Song uses
// for something different: verbatim ChordPro source vs. a Markdown note).
// Which set (if any) an entry belongs to is expressed by which set's own
// hasPart references it (above), not by a property on the entry itself —
// there is no custom:setName any more (SPEC.md §7).
for (const entry of entries) {
  assert.equal(entry["@type"], "MusicComposition");
  assert.equal("custom:setName" in entry, false);
}

assert.equal(slotMachineEntry.name, "Slot Machine Baby");
assert.equal(slotMachineEntry["custom:matchStatus"], "exact");
assert.deepEqual(slotMachineEntry.specializationOf, { "@id": "slot_machine_baby.cho.txt" });
assert.equal(slotMachineEntry.text, "> Play with a lively feel, start with a manic synth solo!\n>> But not **that** lively!");

assert.equal(uniEntry.name, "Uni");
assert.equal(uniEntry["custom:matchStatus"], "fuzzy");
assert.deepEqual(uniEntry.specializationOf, { "@id": "uni-verse.cho.txt" });
assert.equal("text" in uniEntry, false);

assert.equal(amazingEntry.name, "Amazing");
assert.equal(amazingEntry["custom:matchStatus"], "fuzzy");
assert.deepEqual(amazingEntry.specializationOf, { "@id": "AmazingGrace.cho.txt" });
assert.equal(amazingEntry.text, "Make it amazing!");

assert.equal(babyEntry.name, "Baby");
assert.equal(babyEntry["custom:transpose"], "-2");
assert.equal(babyEntry["custom:matchStatus"], "fuzzy");
assert.deepEqual(babyEntry.specializationOf, { "@id": "slot_machine_baby.cho.txt" });
assert.equal(babyEntry.text, "Play slow this time.");

// No entry in this fixture set is ambiguous or unresolved, so none of them
// should carry a matchCandidates property at all.
for (const entry of entries) assert.equal("custom:matchCandidates" in entry, false);

/* ---------- rdf:Property definitions: only for the irreducible custom fields ---------- */

const propertyDefIds = byType("rdf:Property").map((entity) => entity["@id"]);
for (const expected of [
  "arcp://name,custom/terms#transpose", "arcp://name,custom/terms#matchStatus",
]) {
  assert.ok(propertyDefIds.includes(expected), `expected an rdf:Property definition for ${expected}`);
}
// musicalKey/hasPart/specializationOf/description/performer/subtitle are all
// standard schema.org properties (SPEC.md §7) — they must NOT get a custom
// rdf:Property definition even though performer/subtitle are used in this
// very fixture set (iCalledYourName's own {st}, above). custom:artist is
// gone entirely now (the property {artist}/{subtitle} used to share, before
// the split) — no fixture, past or future, should ever mint it again.
// custom:setName is gone too, superseded by the set/sub-playlist hierarchy
// itself (SPEC.md §6/§7) — hasPart already covers what it used to. {capo}/
// {composer} and an ambiguous match simply don't occur anywhere in this
// fixture set, so those stay absent for the more familiar "never used"
// reason.
for (const unexpected of [
  "arcp://name,custom/terms#musicalKey", "arcp://name,custom/terms#hasPart",
  "arcp://name,custom/terms#specializationOf", "arcp://name,custom/terms#description",
  "arcp://name,custom/terms#performer", "arcp://name,custom/terms#subtitle",
  "arcp://name,custom/terms#artist", "arcp://name,custom/terms#setName",
  "arcp://name,custom/terms#capo", "arcp://name,custom/terms#composer", "arcp://name,custom/terms#matchCandidates",
]) {
  assert.equal(propertyDefIds.includes(unexpected), false, `did not expect an rdf:Property definition for ${unexpected}`);
}

/* ---------- progress messages reached ctx.log via onProgress ---------- */

assert.ok(messages.some((m) => m.includes("Found 7 song file(s) and 1 setlist file(s).")));
assert.equal(messages.some((m) => m.includes("Warning")), false);

/* ---------- an empty folder produces no crate at all ---------- */

{
  const emptyResult = await buildCrateFromChordProFolder(memoryDirHandle("empty", {}), {}, () => {});
  assert.equal(emptyResult, null);
}

/* ---------- {capo}/{artist}: not exercised by the main fixture set above ---------- */

{
  // A string, not the number ChordProSong itself parses {capo} into
  // (buildSongEntity, SPEC.md §5) — every other extracted directive on a
  // Song entity is already a plain string (musicalKey/composer/transpose
  // can all hold non-numeric text), and capo's own crate representation
  // follows that convention now too. {artist} — distinct from {subtitle}/
  // {st}, which the main fixture set above already covers via
  // i_called_your_name.cho.txt — becomes `performer`.
  const tree = {
    "capo_and_artist.cho.txt": Buffer.from(
      "{title: Capo Test}\n{artist: The Testers}\n{capo: 2}\n{key: D}\n[D]Some lyrics",
    ),
  };
  const result = await buildCrateFromChordProFolder(memoryDirHandle("root", tree), {}, () => {});
  const graph = result.crate.toJSON()["@graph"];
  const song = graph.find((entity) => entity["@id"] === "capo_and_artist.cho.txt");
  assert.equal(song["custom:capo"], "2");
  assert.equal(typeof song["custom:capo"], "string");
  assert.equal(song.performer, "The Testers");
  assert.equal("subtitle" in song, false);

  const propertyIds = graph
    .filter((entity) => (Array.isArray(entity["@type"]) ? entity["@type"] : [entity["@type"]]).includes("rdf:Property"))
    .map((entity) => entity["@id"]);
  assert.ok(propertyIds.includes("arcp://name,custom/terms#capo"));
  assert.equal(propertyIds.includes("arcp://name,custom/terms#artist"), false); // no such property any more
}

/* ---------- setlist set hierarchy (SPEC.md §6): edge cases beyond the main fixture ---------- */

{
  // A setlist that never uses "#" at all — flat, exactly as every setlist
  // behaved before "#" sets existed as their own entities. No set entities
  // at all, and the top-level setlist's own hasPart points directly at the
  // two entries.
  const tree = {
    "song-a.cho.txt": Buffer.from("{title: Song A}\n[C]La"),
    "song-b.cho.txt": Buffer.from("{title: Song B}\n[D]La"),
    "flat.setlist.md": Buffer.from("## Song A\n## Song B"),
  };
  const result = await buildCrateFromChordProFolder(memoryDirHandle("root", tree), {}, () => {});
  const graph = result.crate.toJSON()["@graph"];
  const byId = new Map(graph.map((e) => [e["@id"], e]));
  const setlist = byId.get("flat.setlist.md");
  assert.equal(setlist.hasPart.length, 2);
  assert.deepEqual(setlist.hasPart.map((r) => r["@id"]), ["flat.setlist.md#entry-1", "flat.setlist.md#entry-2"]);
  const setEntities = graph.filter((e) => String(e["@id"]).includes("#set-"));
  assert.equal(setEntities.length, 0);
}

{
  // A "#" set with freeform text between its own heading and its first
  // entry (chordprobook's own Setlist.js SPEC.md §3.2) becomes that set
  // entity's own `text` — it can be Markdown and songbook_html.js renders
  // it as such (SPEC.md §6.2), so `description` (conventionally a short
  // plain-text summary) isn't the right property for it; no custom
  // rdf:Property is needed either way, since `text` is already standard.
  const tree = {
    "song-a.cho.txt": Buffer.from("{title: Song A}\n[C]La"),
    "notes.setlist.md": Buffer.from("# Set 1\nTune guitars to drop D now.\n## Song A"),
  };
  const result = await buildCrateFromChordProFolder(memoryDirHandle("root", tree), {}, () => {});
  const graph = result.crate.toJSON()["@graph"];
  const byId = new Map(graph.map((e) => [e["@id"], e]));
  const set1 = byId.get("notes.setlist.md#set-1");
  assert.ok(set1, "expected a set-1 entity");
  assert.equal(set1.name, "Set 1");
  assert.equal(set1.text, "Tune guitars to drop D now.");
  assert.equal(set1.hasPart.length, 1);
  assert.equal(set1.hasPart[0]["@id"], "notes.setlist.md#entry-1");
}

{
  // Entries before the first "#" heading stay direct children of the
  // top-level setlist, interleaved in file order with whichever "#" sets
  // follow — not folded into the first set, and not requiring one to exist
  // at all.
  const tree = {
    "song-a.cho.txt": Buffer.from("{title: Song A}\n[C]La"),
    "song-b.cho.txt": Buffer.from("{title: Song B}\n[D]La"),
    "song-c.cho.txt": Buffer.from("{title: Song C}\n[E]La"),
    "mixed.setlist.md": Buffer.from("## Song A\n# Set 1\n## Song B\n## Song C"),
  };
  const result = await buildCrateFromChordProFolder(memoryDirHandle("root", tree), {}, () => {});
  const graph = result.crate.toJSON()["@graph"];
  const byId = new Map(graph.map((e) => [e["@id"], e]));
  const setlist = byId.get("mixed.setlist.md");
  // [entry-1 (Song A, ungrouped), set-1 (Song B, Song C)]
  assert.equal(setlist.hasPart.length, 2);
  assert.equal(setlist.hasPart[0]["@id"], "mixed.setlist.md#entry-1");
  assert.equal(setlist.hasPart[1]["@id"], "mixed.setlist.md#set-1");
  const entryA = byId.get("mixed.setlist.md#entry-1");
  assert.equal(entryA.name, "Song A");
  const set1 = byId.get("mixed.setlist.md#set-1");
  assert.equal(set1.hasPart.length, 2);
  assert.deepEqual(set1.hasPart.map((r) => r["@id"]), ["mixed.setlist.md#entry-2", "mixed.setlist.md#entry-3"]);
}

{
  // Two "#" sets that happen to share a literal name — SPEC.md §6 documents
  // this as a known, accepted simplification: they're only kept apart when
  // something (another set, or the end of the file) actually separates
  // them, since grouping is purely by contiguous runs of matching setName,
  // not by tracking each "#" line's own position. Adjacent-but-distinct
  // "# Encore" blocks would collapse into one set entity here — this test
  // documents that behaviour rather than treating it as a bug.
  const tree = {
    "song-a.cho.txt": Buffer.from("{title: Song A}\n[C]La"),
    "song-b.cho.txt": Buffer.from("{title: Song B}\n[D]La"),
    "song-c.cho.txt": Buffer.from("{title: Song C}\n[E]La"),
    "repeated.setlist.md": Buffer.from("# Set 1\n## Song A\n# Set 2\n## Song B\n# Set 1\n## Song C"),
  };
  const result = await buildCrateFromChordProFolder(memoryDirHandle("root", tree), {}, () => {});
  const graph = result.crate.toJSON()["@graph"];
  const byId = new Map(graph.map((e) => [e["@id"], e]));
  const setlist = byId.get("repeated.setlist.md");
  // Three groups, not two: "Set 1" (Song A) and the later, separate "Set 1"
  // (Song C) are non-adjacent (Set 2 sits between them), so they stay
  // distinct set entities despite sharing a name.
  assert.equal(setlist.hasPart.length, 3);
  const [firstSet1, set2, secondSet1] = setlist.hasPart.map((r) => byId.get(r["@id"]));
  assert.equal(firstSet1.name, "Set 1");
  assert.equal(firstSet1.hasPart.length, 1);
  assert.equal(set2.name, "Set 2");
  assert.equal(secondSet1.name, "Set 1");
  assert.equal(secondSet1.hasPart.length, 1);
  assert.notEqual(firstSet1["@id"], secondSet1["@id"]); // two distinct entities, same name
}

console.log("test-chordpro-crate.mjs: all assertions passed.");
