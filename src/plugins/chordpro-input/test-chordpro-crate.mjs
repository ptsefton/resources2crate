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
// (SPEC.md §7) — the two are told apart here by whether "text" is present,
// which is exactly the invariant that distinguishes them (SPEC.md §5/§6:
// the full song text lives exactly once, on the canonical Song).

const musicCompositions = byType("MusicComposition");
const canonicalSongs = musicCompositions.filter((entity) => "text" in entity);
assert.equal(canonicalSongs.length, SONG_FILENAMES.length + 1);

const amazingGrace = byId.get("AmazingGrace.cho.txt");
assert.equal(amazingGrace.name, "Amazing Grace");
assert.equal(amazingGrace.musicalKey, "G");
assert.equal(amazingGrace.text, readFileSync(path.join(fixturesDir, "AmazingGrace.cho.txt"), "utf8"));
assert.equal("composer" in amazingGrace, false); // no {composer} directive in this file
assert.equal("custom:artist" in amazingGrace, false); // no {subtitle}/{artist} directive in this file
assert.equal("custom:capo" in amazingGrace, false); // no {capo} directive anywhere in the fixture set

const iCalledYourName = byId.get("i_called_your_name.cho.txt");
assert.equal(iCalledYourName["custom:artist"], "Peter Sefton");
assert.equal(iCalledYourName["custom:transpose"], "+7");

/* ---------- Setlist + setlist-entry entities ---------- */

const setlist = byId.get(SETLIST_FILENAME);
assert.ok(setlist);
assert.equal(setlist["@type"], "MusicPlaylist");
assert.equal(setlist.name, "Gig number 1,000");
assert.equal(setlist.hasPart.length, 4);

const entryIds = setlist.hasPart.map((ref) => ref["@id"]);
assert.deepEqual(entryIds, [
  `${SETLIST_FILENAME}#entry-1`, `${SETLIST_FILENAME}#entry-2`,
  `${SETLIST_FILENAME}#entry-3`, `${SETLIST_FILENAME}#entry-4`,
]);

const entries = entryIds.map((id) => byId.get(id));
const [slotMachineEntry, uniEntry, amazingEntry, babyEntry] = entries;

// None of the four entries carry the song's own text — only the
// specializationOf reference back to the canonical Song that has it.
for (const entry of entries) {
  assert.equal(entry["@type"], "MusicComposition");
  assert.equal("text" in entry, false);
}

assert.equal(slotMachineEntry.name, "Slot Machine Baby");
assert.equal(slotMachineEntry["custom:matchStatus"], "exact");
assert.deepEqual(slotMachineEntry.specializationOf, { "@id": "slot_machine_baby.cho.txt" });
assert.equal(slotMachineEntry["custom:setName"], "Set 1");
assert.equal(slotMachineEntry.description, "> Play with a lively feel, start with a manic synth solo!\n>> But not **that** lively!");

assert.equal(uniEntry.name, "Uni");
assert.equal(uniEntry["custom:matchStatus"], "fuzzy");
assert.deepEqual(uniEntry.specializationOf, { "@id": "uni-verse.cho.txt" });
assert.equal("description" in uniEntry, false);

assert.equal(amazingEntry.name, "Amazing");
assert.equal(amazingEntry["custom:matchStatus"], "fuzzy");
assert.deepEqual(amazingEntry.specializationOf, { "@id": "AmazingGrace.cho.txt" });
assert.equal(amazingEntry.description, "Make it amazing!");

assert.equal(babyEntry.name, "Baby");
assert.equal(babyEntry["custom:setName"], "Set 2");
assert.equal(babyEntry["custom:transpose"], "-2");
assert.equal(babyEntry["custom:matchStatus"], "fuzzy");
assert.deepEqual(babyEntry.specializationOf, { "@id": "slot_machine_baby.cho.txt" });
assert.equal(babyEntry.description, "Play slow this time.");

// No entry in this fixture set is ambiguous or unresolved, so none of them
// should carry a matchCandidates property at all.
for (const entry of entries) assert.equal("custom:matchCandidates" in entry, false);

/* ---------- rdf:Property definitions: only for the irreducible custom fields ---------- */

const propertyDefIds = byType("rdf:Property").map((entity) => entity["@id"]);
for (const expected of [
  "arcp://name,custom/terms#artist", "arcp://name,custom/terms#transpose",
  "arcp://name,custom/terms#setName", "arcp://name,custom/terms#matchStatus",
]) {
  assert.ok(propertyDefIds.includes(expected), `expected an rdf:Property definition for ${expected}`);
}
// musicalKey/hasPart/specializationOf/description are all standard schema.org
// properties (SPEC.md §7) — they must NOT get a custom rdf:Property definition
// even though they're used throughout this crate; {capo}/{composer} and an
// ambiguous match simply don't occur anywhere in this fixture set, so those
// stay absent for the more familiar "never used" reason.
for (const unexpected of [
  "arcp://name,custom/terms#musicalKey", "arcp://name,custom/terms#hasPart",
  "arcp://name,custom/terms#specializationOf", "arcp://name,custom/terms#description",
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

console.log("test-chordpro-crate.mjs: all assertions passed.");
