// Unit tests for crate_index.js — the dependency-free (no `ro-crate`
// library) index this plugin's songbook HTML output builds over a plain
// ro-crate-metadata.json-shaped object. See that file's own header and
// SPEC.md's "Songbook HTML output" section.
import assert from "node:assert/strict";
import { toArray, firstValue, buildCrateIndex, resolveRef, entitiesOfType } from "./crate_index.js";

/* ---------- toArray ---------- */

{
  assert.deepEqual(toArray(undefined), []);
  assert.deepEqual(toArray(null), []);
  assert.deepEqual(toArray("G"), ["G"]);
  assert.deepEqual(toArray(["G", "MusicComposition"]), ["G", "MusicComposition"]);
}

/* ---------- firstValue ---------- */

{
  assert.equal(firstValue({ name: "Amazing Grace" }, "name"), "Amazing Grace");
  assert.equal(firstValue({ name: ["Amazing Grace"] }, "name"), "Amazing Grace");
  assert.equal(firstValue({}, "name"), undefined);
  assert.equal(firstValue({}, "name", "fallback"), "fallback");
}

/* ---------- buildCrateIndex ---------- */

const graph = [
  { "@id": "./", "@type": "Dataset", name: "Songbook", hasPart: [{ "@id": "AmazingGrace.cho.txt" }] },
  { "@id": "AmazingGrace.cho.txt", "@type": "MusicComposition", name: "Amazing Grace", text: "..." },
  { "@id": "sample.setlist.md", "@type": "MusicPlaylist", name: "Gig", hasPart: [{ "@id": "sample.setlist.md#entry-1" }] },
  { "@id": "sample.setlist.md#entry-1", "@type": "MusicComposition", name: "Amazing Grace", specializationOf: { "@id": "AmazingGrace.cho.txt" } },
  { "@type": "rdf:Property", name: "orphan, no @id" }, // must be skipped, not crash
];

const index = buildCrateIndex({ "@graph": graph });

{
  assert.equal(index.byId.size, 4); // the @id-less entity is excluded
  assert.equal(index.byId.get("AmazingGrace.cho.txt").name, "Amazing Grace");
}

{
  const compositions = entitiesOfType(index, "MusicComposition");
  assert.equal(compositions.length, 2); // both the canonical song and the setlist-entry proxy
  assert.equal(entitiesOfType(index, "NoSuchType").length, 0);
}

{
  // A multi-typed entity appears under each of its types.
  const multiTyped = buildCrateIndex({
    "@graph": [{ "@id": "x", "@type": ["MusicComposition", "CreativeWork"], name: "X" }],
  });
  assert.equal(entitiesOfType(multiTyped, "MusicComposition").length, 1);
  assert.equal(entitiesOfType(multiTyped, "CreativeWork").length, 1);
}

{
  // Missing/malformed @graph doesn't throw.
  assert.deepEqual(buildCrateIndex({}).graph, []);
  assert.deepEqual(buildCrateIndex(null).graph, []);
}

/* ---------- resolveRef ---------- */

{
  const entry = index.byId.get("sample.setlist.md#entry-1");
  const song = resolveRef(index, entry.specializationOf);
  assert.equal(song.name, "Amazing Grace");
  assert.equal(song["@id"], "AmazingGrace.cho.txt");
}

{
  assert.equal(resolveRef(index, "AmazingGrace.cho.txt"), index.byId.get("AmazingGrace.cho.txt")); // bare id string
  assert.equal(resolveRef(index, { "@id": "no-such-id" }), null);
  assert.equal(resolveRef(index, null), null);
  assert.equal(resolveRef(index, {}), null); // a ref with no @id at all
}

console.log("test-crate-index.mjs: all assertions passed.");
