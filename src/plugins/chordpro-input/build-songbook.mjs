#!/usr/bin/env node
// Standalone CLI: builds songbook.html (and, as a byproduct,
// ro-crate-metadata.json) for one folder of ChordPro songs/setlists, with no
// browser and no resources2crate app UI involved. See SPEC.md's "Songbook
// HTML output" section.
//
// Deliberately self-contained within this plugin's own folder — every import
// below is either a relative path inside chordpro-input/, a Node builtin, or
// chordprobook (the npm package this plugin already depends on regardless).
// Nothing here reaches into resources2crate's own src/crate.js, src/
// fs_helpers.js, or the HOOKS/plugin-bus machinery those use — this plugin is
// meant to eventually move into its own repo (SPEC.md's own note on that),
// and this script should keep working unchanged, against a plain npm
// dependency on chordprobook, the day that happens.
//
// Usage:
//   node src/plugins/chordpro-input/build-songbook.mjs <folder>
//   npm run build:songbook -- <folder>
import fs from "node:fs";
import path from "node:path";
import { buildCrateFromChordProFolder } from "./chordpro_crate.js";
import { renderSongbookHtml } from "./songbook_html.js";

const CRATE_FILE = "ro-crate-metadata.json";
const OUTPUT_FILE = "songbook.html";

// buildCrateFromChordProFolder expects a File System Access API-shaped
// directory handle (an async `values()` iterator yielding {kind, name,
// getFile()|values()}) — the same interface `main.js`'s own
// `showDirectoryPicker()` result provides in a browser. This is a read-only
// stand-in over plain Node `fs`, mirroring the shape exactly rather than
// changing buildCrateFromChordProFolder itself to accept two different kinds
// of input.
function wrapDirRead(realPath, name) {
  return {
    kind: "directory",
    name,
    async *values() {
      for (const entry of fs.readdirSync(realPath, { withFileTypes: true })) {
        const childPath = path.join(realPath, entry.name);
        if (entry.isDirectory()) yield wrapDirRead(childPath, entry.name);
        else if (entry.isFile()) yield wrapFileRead(childPath, entry.name);
      }
    },
  };
}

function wrapFileRead(realPath, name) {
  return { kind: "file", name, async getFile() { return new File([fs.readFileSync(realPath)], name); } };
}

async function main() {
  const folderArg = process.argv[2];
  if (!folderArg) {
    console.error("Usage: node src/plugins/chordpro-input/build-songbook.mjs <folder>");
    process.exitCode = 1;
    return;
  }
  const root = path.resolve(folderArg);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    console.error(`Not a folder: ${root}`);
    process.exitCode = 1;
    return;
  }

  const result = await buildCrateFromChordProFolder(wrapDirRead(root, path.basename(root)), {}, (msg) => console.log(msg));
  if (!result) {
    console.error(`No song or setlist files found under ${root} — nothing to build.`);
    process.exitCode = 1;
    return;
  }
  const { crate, songCount, setlistCount, unresolvedCount, ambiguousCount } = result;

  // crate.getJson() is the same plain graph object the browser app's own
  // ro-crate-json-output plugin serializes (src/crate.js's crateToJsonString
  // is a one-line JSON.stringify(crate.getJson(), null, 2) wrapper — not
  // imported here, for exactly the self-containment reason in this file's
  // own header comment) and the same shape renderSongbookHtml itself expects
  // (it's what ends up read back out of ro-crate-metadata.json in a real
  // app build — see songbook_html.js's own OUTPUT_WRITE hook).
  const crateJson = crate.getJson();
  fs.writeFileSync(path.join(root, CRATE_FILE), JSON.stringify(crateJson, null, 2));
  fs.writeFileSync(path.join(root, OUTPUT_FILE), renderSongbookHtml(crateJson));

  console.log(
    `Wrote ${CRATE_FILE} and ${OUTPUT_FILE} to ${root} ` +
      `(${songCount} song(s), ${setlistCount} setlist(s)` +
      (unresolvedCount ? `, ${unresolvedCount} unresolved setlist entr${unresolvedCount === 1 ? "y" : "ies"}` : "") +
      (ambiguousCount ? `, ${ambiguousCount} ambiguous setlist entr${ambiguousCount === 1 ? "y" : "ies"}` : "") +
      ").",
  );
}

await main();
