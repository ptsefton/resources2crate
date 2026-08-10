// Unit tests for ChordProSong (src/plugins/chordpro-input/lib/ChordProSong.js)
// — the ported metadata-extraction subset of chordprosite's Song.js. See
// SPEC.md §5 for the design and the deliberate divergences/additions this
// exercises: {composer} extraction (an addition), and the preserved
// accumulate-rather-than-first-wins behaviour of {title}/{subtitle} plus the
// {version} suffix (kept exactly as chordprosite's own class behaves).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ChordProSong } from "./lib/ChordProSong.js";

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "samples");
const readFixture = (name) => readFileSync(path.join(fixturesDir, name), "utf8");

/* ---------- real sample files ---------- */

{
  const song = new ChordProSong(readFixture("AmazingGrace.cho.txt"));
  assert.equal(song.title, "Amazing Grace");
  assert.equal(song.key, "G");
  assert.equal(song.artist, "");
  assert.equal(song.capo, null);
  assert.equal(song.transpose, null);
  assert.equal(song.composer, null);
  assert.equal(song.hasChords, true);
}

{
  const song = new ChordProSong(readFixture("i_called_your_name.cho.txt"));
  assert.equal(song.title, "I Called Your name");
  assert.equal(song.artist, "Peter Sefton");
  assert.equal(song.key, "C");
  assert.equal(song.transpose, "+7");
  assert.equal(song.capo, null);
  assert.equal(song.hasChords, true);
}

{
  // {transpose: -3 -1 -2} — only the first whitespace-separated token is
  // kept, matching chordprosite's own `transposeValues[0]` behaviour.
  const song = new ChordProSong(readFixture("uni-verse.cho.txt"));
  assert.equal(song.title, "Universe");
  assert.equal(song.transpose, "-3");
}

/* ---------- directives this plugin adds/relies on that no sample file exercises ---------- */

{
  const song = new ChordProSong("{title: Test Song}\n{capo: 3}\n{key: D}\n[D]Some [A]lyrics");
  assert.equal(song.capo, 3);
  assert.equal(typeof song.capo, "number");
}

{
  // {composer} is a deliberate addition beyond chordprosite's own Song.js,
  // which recognises the directive but never reads it into a field.
  const song = new ChordProSong("{title: Test Song}\n{composer: Jane Doe}");
  assert.equal(song.composer, "Jane Doe");
}

{
  // No {title} directive at all — the class itself does not fall back to a
  // filename (that's chordpro_crate.js's job, SPEC.md §5's "Title
  // fallback"); title is simply empty here.
  const song = new ChordProSong("{key: Em}\n[Em]No title here");
  assert.equal(song.title, "");
  assert.equal(song.key, "Em");
}

/* ---------- preserved quirks (deliberately not "fixed" — see SPEC.md §5) ---------- */

{
  // {title} accumulates across multiple occurrences with no separator —
  // preserved exactly as chordprosite's own `this.title += dir.value` does,
  // rather than replaced with a cleaner-looking rule invented for this
  // plugin.
  const song = new ChordProSong("{title: Foo}\n{title: Bar}");
  assert.equal(song.title, "FooBar");
}

{
  // {version} appends " - VN" onto whatever title has been accumulated so far.
  const song = new ChordProSong("{title: Foo}\n{version: 2}");
  assert.equal(song.title, "Foo - V2");
}

{
  // key/capo/transpose/composer are each first-wins in practice: chordprosite's
  // own guard is a falsy check (`if (!this.key)`), so only a *non-empty*
  // first value locks the field.
  const song = new ChordProSong("{key: G}\n{key: D}");
  assert.equal(song.key, "G");
}

/* ---------- CRLF line endings ---------- */

{
  // Companion to the CRLF regression test in test-chordpro-setlist.mjs — a
  // real CRLF-authored setlist file broke parseSetlist entirely because one
  // of its regexes wasn't trimming a trailing "\r". This class happens to
  // survive CRLF input already, via .trim() inside Directive's own
  // constructor, but is normalised up front too now rather than continuing
  // to rely on that as an accident of where .trim() is called.
  const song = new ChordProSong("{title: Ready to perform}\r\n{key: G}\r\n[G]Some lyric\r\n");
  assert.equal(song.title, "Ready to perform");
  assert.equal(song.key, "G");
  assert.equal(song.hasChords, true);
}

/* ---------- messy directive formatting (the reason to port the real tidy pass) ---------- */

{
  // A directive with trailing whitespace before the newline, and a blank
  // line before the next directive — both cleaned up by the tidy pass
  // before the directive scan runs. Multiple directives packed onto a
  // single line are out of scope: chordprosite's own class doesn't reliably
  // handle that either, and it isn't a realistic authoring pattern worth
  // chasing (see the comment on ChordProSong's tidy pass).
  const song = new ChordProSong("{title: Squashed}   \n\n\n{key: A}");
  assert.equal(song.title, "Squashed");
  assert.equal(song.key, "A");
}

{
  // Directive immediately followed by lyric text on the same line, with no
  // separating whitespace at all.
  const song = new ChordProSong("{key: E}[E]Straight into the lyric");
  assert.equal(song.key, "E");
  assert.equal(song.hasChords, true);
}

/* ---------- unrecognised directives don't break metadata parsing ---------- */

{
  // {start_of_chorus}/{comment} aren't in this plugin's trimmed directive
  // set (SPEC.md's DIRECTIVE_NAMES comment) — they fall through as
  // unrecognised lines rather than crashing or being mistaken for a chord line.
  const song = new ChordProSong("{title: Chorus test}\n{c: Chorus}\n{soc}\n[C]La la la\n{eoc}");
  assert.equal(song.title, "Chorus test");
  assert.equal(song.hasChords, true);
}

console.log("test-chordpro-song.mjs: all assertions passed.");
