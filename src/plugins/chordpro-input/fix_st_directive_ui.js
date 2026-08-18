// Browser-only shell around the {st:} cleanup tool's shared, isomorphic core
// (st_directive.js) — this file owns the FileSystemDirectoryHandle walk and
// the actual write-back; the regex/rewrite rules themselves live in
// st_directive.js so this file and the CLI script (scripts/fix-st-directive.mjs)
// never duplicate them. See SPEC.md's "Metadata entry and cleanup" section.
//
// This is a standalone, main.js-wired action, not a HOOKS-based plugin tap
// (hooks.js) — it runs independently of runPipeline()/processFolder()
// entirely, against whatever folder is already picked in the app.

import JSZip from "jszip";
import { GENERATED_FILENAMES, CONTROL_FILENAMES } from "../../crate.js";
import { writeFileAtPath } from "../../fs_helpers.js";
import { DEFAULT_SONG_EXTENSIONS } from "./chordpro_crate.js";
import { findMatches, applyChoices } from "./st_directive.js";

function isIgnoredName(name) {
  return name.startsWith(".") || name.startsWith("~$") || GENERATED_FILENAMES.has(name) || CONTROL_FILENAMES.has(name);
}

function matchesAnySuffix(name, suffixes) {
  const lower = name.toLowerCase();
  return suffixes.some((suffix) => lower.endsWith(suffix));
}

async function findSongFiles(dirHandle, prefix = "") {
  const found = [];
  for await (const entry of dirHandle.values()) {
    if (isIgnoredName(entry.name)) continue;
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.kind === "directory") found.push(...(await findSongFiles(entry, relativePath)));
    else if (entry.kind === "file" && matchesAnySuffix(entry.name, DEFAULT_SONG_EXTENSIONS)) {
      found.push({ handle: entry, relativePath });
    }
  }
  return found;
}

async function getFileHandleAtPath(dirHandle, relativePath) {
  const parts = relativePath.split("/").filter(Boolean);
  const filename = parts.pop();
  let dir = dirHandle;
  for (const part of parts) dir = await dir.getDirectoryHandle(part, { create: false });
  return dir.getFileHandle(filename, { create: false });
}

// One flat, globally-numbered list across every song file in the folder, in
// a stable (sorted) file order and the same in-file order findMatches()
// returns — applyStDirectiveFixes() relies on that same numbering to match a
// UI choice back to the right occurrence.
export async function findStDirectiveHits(dirHandle) {
  const files = (await findSongFiles(dirHandle)).sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  const hits = [];
  for (const { relativePath, handle } of files) {
    const text = await (await handle.getFile()).text();
    for (const match of findMatches(text)) {
      const lineNumber = text.slice(0, match.index).split("\n").length;
      hits.push({ number: hits.length + 1, relativePath, lineNumber, value: match.value, matchText: match.matchText });
    }
  }
  return hits;
}

// choicesByNumber maps a hit's `number` (from findStDirectiveHits) to
// "artist" | "composer" | "both" | "skip". Re-reads each affected file fresh
// off disk rather than trusting whatever findStDirectiveHits() saw — the UI
// may be showing a hit list from moments earlier — so the backup zip and the
// rewrite both reflect what's actually there right now.
export async function applyStDirectiveFixes(dirHandle, hits, choicesByNumber) {
  const hitsByFile = new Map();
  for (const hit of hits) {
    if (!hitsByFile.has(hit.relativePath)) hitsByFile.set(hit.relativePath, []);
    hitsByFile.get(hit.relativePath).push(hit);
  }

  const zip = new JSZip();
  let filesChanged = 0;
  let occurrences = 0;
  for (const [relativePath, fileHits] of hitsByFile) {
    fileHits.sort((a, b) => a.number - b.number);
    const fh = await getFileHandleAtPath(dirHandle, relativePath);
    const original = await (await fh.getFile()).text();
    zip.file(relativePath, original);
    const choices = fileHits.map((hit) => choicesByNumber[hit.number] || "artist");
    const rewritten = applyChoices(original, choices);
    if (rewritten !== original) {
      const w = await fh.createWritable();
      await w.write(rewritten);
      await w.close();
      filesChanged += 1;
      occurrences += fileHits.length;
    }
  }

  // A dot-prefixed folder inside the picked folder — already invisible to
  // every folder walk in this codebase (isIgnoredName above, and the
  // equivalents in main.js/chordpro_crate.js), so the backup stays out of a
  // crate build with no new ignore-list entry needed.
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `.chordpro-cleanup-backups/${timestamp}.zip`;
  const backupBytes = await zip.generateAsync({ type: "arraybuffer" });
  await writeFileAtPath(dirHandle, backupPath, backupBytes);

  return { filesChanged, occurrences, backupPath };
}
