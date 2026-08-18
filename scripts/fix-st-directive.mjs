// Cleanup utility for ChordPro chart files written before this project's own
// artist/subtitle split (chordpro-input's SPEC.md §5): PT's own charts going
// back to around 2015 often use {st: ...} (subtitle) as a stand-in for
// {artist: ...} — and sometimes for {composer: ...} instead — a habit that
// predates {artist}/{subtitle} being distinct directives at all. This is a
// one-off, human-supervised migration, not something the chordpro-input
// plugin itself does automatically: that plugin never writes back to the
// source folder at all (SPEC.md §2, "out of scope, permanent"), and this
// script deliberately lives outside it, run by hand, once, against a real
// chart collection.
//
// What it does, in order:
//   1. Finds every {st: ...} occurrence under a folder (recursively).
//   2. Prints all of them for review, numbered.
//   3. Asks which numbers, if any, are actually a composer credit rather
//      than an artist one — those get a *second*, new {composer: ...}
//      directive added alongside the renamed {artist: ...} line, rather
//      than replacing it (PT can be credited as both on the same chart).
//   4. Asks for a final go-ahead.
//   5. Zips up the original, unmodified content of every file about to be
//      touched, then rewrites {st:} to {artist:} in place (and inserts the
//      extra {composer:} line for whichever hits were flagged in step 3).
//
// Nothing is written to disk before the final confirmation in step 4, and
// the backup zip is written before any rewrite in step 5 — from the exact
// text already read into memory in step 1, not a re-read that could in
// principle see something step 5 has since changed.
//
// Usage:
//   node scripts/fix-st-directive.mjs <folder>
//   npm run fix:st-directive -- <folder>

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import JSZip from "jszip";
import { DEFAULT_SONG_EXTENSIONS } from "../src/plugins/chordpro-input/chordpro_crate.js";
import { findMatches, applyChoices } from "../src/plugins/chordpro-input/st_directive.js";

function isIgnoredName(name) {
  return name.startsWith(".") || name.startsWith("~$");
}

function matchesAnySuffix(name, suffixes) {
  const lower = name.toLowerCase();
  return suffixes.some((suffix) => lower.endsWith(suffix));
}

function findSongFiles(dir, suffixes, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (isIgnoredName(entry.name)) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) findSongFiles(fullPath, suffixes, found);
    else if (entry.isFile() && matchesAnySuffix(entry.name, suffixes)) found.push(fullPath);
  }
  return found;
}

// One flat, globally-numbered list, built via the shared findMatches() over
// each file's *whole* text — the actual rewrite (rewriteFile, below) uses
// the shared applyChoices() over that same whole-file text with a choices
// array built in the same scan order, so a given hit's number here is
// guaranteed to refer to the same occurrence there.
function findHits(files, fileContents) {
  const hits = [];
  for (const filePath of files) {
    const text = fs.readFileSync(filePath, "utf8");
    fileContents.set(filePath, text);
    for (const match of findMatches(text)) {
      const lineNumber = text.slice(0, match.index).split("\n").length;
      hits.push({ number: hits.length + 1, filePath, value: match.value, lineNumber, matchText: match.matchText });
    }
  }
  return hits;
}

function rewriteFile(text, fileHits, doubleUpNumbers) {
  const choices = fileHits.map((hit) => (doubleUpNumbers.has(hit.number) ? "both" : "artist"));
  return applyChoices(text, choices);
}

function parseNumberList(answer) {
  return new Set(
    answer
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map(Number)
      .filter((n) => Number.isInteger(n)),
  );
}

async function main() {
  const folderArg = process.argv[2];
  if (!folderArg) {
    console.error("Usage: node scripts/fix-st-directive.mjs <folder>");
    process.exitCode = 1;
    return;
  }
  const root = path.resolve(folderArg);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    console.error(`Not a folder: ${root}`);
    process.exitCode = 1;
    return;
  }

  const files = findSongFiles(root, DEFAULT_SONG_EXTENSIONS).sort();
  const fileContents = new Map(); // filePath -> original text, read exactly once
  const hits = findHits(files, fileContents);

  if (hits.length === 0) {
    console.log(`No {st:} directives found under ${root} (scanned ${files.length} song file(s)).`);
    return;
  }

  const affectedFiles = new Set(hits.map((h) => h.filePath));
  const affectedFileCount = affectedFiles.size;
  console.log(`Found ${hits.length} {st:} occurrence(s) across ${affectedFileCount} file(s):\n`);
  for (const hit of hits) {
    console.log(`  [${hit.number}] ${path.relative(root, hit.filePath)}:${hit.lineNumber}  ${hit.matchText}`);
  }
  console.log("\nDefault action for all of the above: rename {st:} to {artist:}.");

  // Pulling lines from the interface's own async iterator, rather than two
  // separate rl.question() calls — Node's readline has a known race when a
  // *second* question() is issued against non-interactive (piped/
  // redirected) input: all buffered lines can be consumed internally
  // before that second call attaches its own listener, silently losing the
  // answer (harmless from a real terminal, where a human can't physically
  // type ahead of the prompt appearing, but a real problem for anything
  // scripted — including this script's own tests). The async iterator
  // reads one line at a time on demand instead, with no such race.
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const lines = rl[Symbol.asyncIterator]();
  async function ask(prompt) {
    process.stdout.write(prompt);
    const { value, done } = await lines.next();
    return done ? "" : value;
  }

  let doubleUpNumbers;
  try {
    const doubleUpAnswer = await ask(
      "\nAny of these actually credit a composer, not a performer? Enter their numbers to ALSO add\n" +
        "a {composer:} directive alongside the renamed {artist:} line (space/comma-separated),\n" +
        "or press Enter for none: ",
    );
    doubleUpNumbers = parseNumberList(doubleUpAnswer);
    for (const n of doubleUpNumbers) {
      if (!hits.some((h) => h.number === n)) console.log(`  (ignoring ${n} — not a hit number above)`);
    }

    console.log(
      `\n${hits.length} occurrence(s) will become {artist:}; ${doubleUpNumbers.size} of those will ALSO gain a new {composer:} line.`,
    );
    const confirmAnswer = await ask(
      `This will back up ${affectedFileCount} file(s) to a zip, then rewrite them in place. Proceed? [y/N] `,
    );
    if (!/^y(es)?$/i.test(confirmAnswer.trim())) {
      console.log("Aborted — no changes made.");
      return;
    }
  } finally {
    rl.close();
  }

  // Only the files that actually have a hit — not every song file findHits()
  // happened to read along the way, most of which have nothing to do with
  // this cleanup and would just bulk out the backup pointlessly. Backed up
  // from the text already read into fileContents during findHits() above,
  // not a fresh read — that's exactly what was on disk when this script
  // started, and nothing since then has touched it.
  const zip = new JSZip();
  for (const filePath of affectedFiles) zip.file(path.relative(root, filePath), fileContents.get(filePath));
  const backupName = `st-to-artist-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.zip`;
  const backupPath = path.join(root, backupName);
  fs.writeFileSync(backupPath, await zip.generateAsync({ type: "nodebuffer" }));
  console.log(`Backed up ${affectedFileCount} file(s) to ${backupPath}`);

  let filesChanged = 0;
  for (const filePath of affectedFiles) {
    const original = fileContents.get(filePath);
    const fileHits = hits.filter((h) => h.filePath === filePath);
    const rewritten = rewriteFile(original, fileHits, doubleUpNumbers);
    if (rewritten !== original) {
      fs.writeFileSync(filePath, rewritten);
      filesChanged += 1;
    }
  }

  console.log(`Rewrote {st:} -> {artist:} in ${filesChanged} file(s) (${hits.length} occurrence(s)).`);
}

await main();
