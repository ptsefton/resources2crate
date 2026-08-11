// Generates src/plugins/chordpro-input/generated/chordprobook_browser_bundle.js
// — a flat, import/export-free concatenation of the specific chordprobook
// modules the embedded songbook page's client-side app needs
// (chords/Transposer.js, chords/ChordDiagram.js, ChordProSong.js, Song.js),
// exported as a plain string constant, plus two data constants precomputed
// here rather than parsed client-side (see below). That's what makes the
// module bundle importable identically under Vite (the real browser bundle)
// and under plain Node (this repo's own tests) — a `?raw` import, the more
// obvious alternative, only works under Vite; see SPEC.md's "Songbook HTML
// output" section for the rest of the reasoning, including why the embedded
// script is classic (non-module) in the first place.
//
// Run this whenever chordprobook's own source, instruments.yaml, or
// chord_data changes:
//   node scripts/bundle-chordprobook-for-browser.mjs
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as yaml from "yaml";
import { parseChordDataText } from "chordprobook/src/chords/loadChordData.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const chordprobookSrc = path.join(root, "node_modules", "chordprobook", "src");
const outputDir = path.join(root, "src", "plugins", "chordpro-input", "generated");
const outputFile = path.join(outputDir, "chordprobook_browser_bundle.js");

// Order matters: ChordDiagram.js and Song.js's own source both reference
// Transposer (as a bare global, once stripped of its import), so Transposer
// must be defined first in the concatenated output.
const FILES = ["chords/Transposer.js", "chords/ChordDiagram.js", "ChordProSong.js", "Song.js"];

// Transforms one file's ES module source into a top-level
//   var { PublicName, ... } = (function () { <module body> return { PublicName, ... }; })();
//
// Wrapping the whole body in a closure — not just stripping "export"/
// "import" keywords in place — matters: ChordProSong.js and Song.js each
// declare their own private `DIRECTIVE_NAMES` const and `Directive` class
// (deliberately: chordprobook's own SPEC.md §3.3 explains why those two
// modules don't share that code). As separate ES modules those never
// collide; concatenated as bare top-level declarations in one classic
// script, `const DIRECTIVE_NAMES` from the second file redeclaring the
// first's is a real SyntaxError — this was caught by actually running the
// generated bundle, not by inspection. Each file's own closure keeps its
// private declarations scoped to itself either way, exported or not.
function transformModule(source, filename) {
  const exportedNames = new Set();

  // Trailing named-export form: export { A, B };  (chords/Transposer.js's
  // own style, ported from chordprosite unchanged).
  source = source.replace(/^export\s*\{([^}]*)\}\s*;?\s*$/gm, (_match, names) => {
    for (const name of names.split(",").map((n) => n.trim()).filter(Boolean)) exportedNames.add(name);
    return "";
  });

  // Inline declaration-attached export form: export class|function|const NAME
  // (ChordProSong.js's and Song.js's own style).
  source = source.replace(/^export\s+(class|function|const|let|var)\s+([A-Za-z0-9_$]+)/gm, (_match, kind, name) => {
    exportedNames.add(name);
    return `${kind} ${name}`;
  });

  // Import lines are simply removed: the bundle's own concatenation order
  // (see FILES above) supplies whatever a later module needs from an
  // earlier one, as a bare identifier in the shared outer scope.
  source = source.replace(/^import\s+.*?from\s+['"].*?['"];?\s*$/gm, "");

  // A sanity net, not a silent pass-through: if this file still says
  // "export" after the two rewrites above, this generator doesn't know how
  // to handle that file's syntax and needs updating — better to fail loudly
  // here than to ship a bundle that throws a SyntaxError in the browser.
  const remaining = source.match(/^\s*export\b.*$/m);
  if (remaining) {
    throw new Error(`bundle-chordprobook-for-browser: unhandled "export" syntax in ${filename}: "${remaining[0].trim()}"`);
  }
  if (exportedNames.size === 0) {
    throw new Error(`bundle-chordprobook-for-browser: no exports found in ${filename} — nothing to bundle`);
  }

  const names = [...exportedNames].join(", ");
  return `var { ${names} } = (function () {\n${source}\nreturn { ${names} };\n})();`;
}

const parts = FILES.map((relativePath) => {
  const source = readFileSync(path.join(chordprobookSrc, relativePath), "utf8");
  return `/* ---- chordprobook/src/${relativePath} ---- */\n${transformModule(source, relativePath)}`;
});

mkdirSync(outputDir, { recursive: true });
const bundleSource = parts.join("\n\n");

// Instrument list and chord-shape data are parsed here, at generation time,
// rather than shipped as raw YAML/.cho text for the browser to parse itself.
// Instruments.js's own loadFromYamlText() takes a YAML-parsing library as a
// parameter precisely because it doesn't want to assume one is available
// (see that file's own header) — true in a browser specifically, where
// pulling in a whole YAML parser just to read a handful of static instrument
// records isn't worth it when Node already has one, at build time, for
// free. Same reasoning for chord_data/*.cho: parseChordDataText() is pure
// text-in-plain-data-out and could run client-side, but there is no reason
// to ship the parsing step (or the raw text) when the parsed result is
// exactly as static and can be embedded directly instead.
const instrumentsYamlPath = path.join(chordprobookSrc, "chords", "instruments.yaml");
const instrumentsData = yaml.parse(readFileSync(instrumentsYamlPath, "utf8")).map((instrument) => ({
  name: instrument.name,
  tuning: instrument.tuning,
  transpose: instrument.transpose,
  chordDefinitionData: instrument.chord_definitions,
}));

const chordDataDir = path.join(chordprobookSrc, "chords", "chord_data");
const chordData = {};
for (const filename of readdirSync(chordDataDir)) {
  if (!filename.endsWith(".cho")) continue;
  chordData[filename] = parseChordDataText(readFileSync(path.join(chordDataDir, filename), "utf8"));
}

writeFileSync(
  outputFile,
  "// GENERATED FILE — do not edit by hand.\n" +
  "// Produced by scripts/bundle-chordprobook-for-browser.mjs from the chordprobook\n" +
  "// package's own source (module bundle), instruments.yaml (instrument list), and\n" +
  "// chord_data/*.cho (chord-shape data). Re-run that script after changing any of them.\n" +
  `export const CHORDPROBOOK_BROWSER_BUNDLE = ${JSON.stringify(bundleSource)};\n` +
  `export const CHORDPROBOOK_INSTRUMENTS_DATA = ${JSON.stringify(instrumentsData)};\n` +
  `export const CHORDPROBOOK_CHORD_DATA = ${JSON.stringify(chordData)};\n`
);

console.log(`Wrote ${path.relative(root, outputFile)} (${FILES.length} module(s), ${bundleSource.length} chars).`);
