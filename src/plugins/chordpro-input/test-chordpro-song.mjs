// Unit tests for ChordProSong, now sourced from the chordprobook package
// (see its own SPEC.md §3.1) rather than a local copy — the ported
// metadata-extraction subset of chordprosite's Song.js. Kept here, not just
// in chordprobook's own test suite, as a regression check on the dependency
// from resources2crate's own side: {composer} extraction (an addition),
// {artist} kept separate from {subtitle}/{st} (chordprosite's own class
// conflates all three into one field — another addition), first-wins on
// every directive including {title}/{subtitle}/{artist} (chordprosite's own
// class accumulates those three with `+=` instead), and the {version}
// suffix (kept exactly as chordprosite's own class behaves — it isn't one
// of the properties SPEC.md §5 lists, so it's outside the first-wins rule).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ChordProSong } from "chordprobook";

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "samples");
const readFixture = (name) => readFileSync(path.join(fixturesDir, name), "utf8");

/* ---------- real sample files ---------- */

{
  const song = new ChordProSong(readFixture("AmazingGrace.cho.txt"));
  assert.equal(song.title, "Amazing Grace");
  assert.equal(song.key, "G");
  assert.equal(song.artist, "");
  assert.equal(song.subtitle, "");
  assert.equal(song.capo, null);
  assert.equal(song.transpose, null);
  assert.equal(song.composer, null);
  assert.equal(song.hasChords, true);
}

{
  // {st: Peter Sefton} — a *subtitle* directive, not {artist}, so it lands
  // on .subtitle, leaving .artist unset. Before the artist/subtitle split
  // this fixture's credit line was the one exercising what used to be
  // .artist; it's still the same real file, just read into a different
  // field now.
  const song = new ChordProSong(readFixture("i_called_your_name.cho.txt"));
  assert.equal(song.title, "I Called Your name");
  assert.equal(song.subtitle, "Peter Sefton");
  assert.equal(song.artist, "");
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
  // {artist} is the other deliberate addition beyond chordprosite's own
  // Song.js — kept as its own field, distinct from {subtitle}/{st}, even
  // though the source directive text ("artist") is what chordprosite's own
  // class would have folded into the same field a {subtitle} directive
  // uses. This plugin writes .artist to `performer` and .subtitle to
  // `subtitle` on the Song entity (chordpro_crate.js, SPEC.md §5/§7).
  const song = new ChordProSong("{title: Test Song}\n{artist: The Testers}\n{subtitle: Live at the Test Hall}");
  assert.equal(song.artist, "The Testers");
  assert.equal(song.subtitle, "Live at the Test Hall");
}

{
  // No {title} directive at all — the class itself does not fall back to a
  // filename (that's chordpro_crate.js's job, SPEC.md §5's "Title
  // fallback"); title is simply empty here.
  const song = new ChordProSong("{key: Em}\n[Em]No title here");
  assert.equal(song.title, "");
  assert.equal(song.key, "Em");
}

/* ---------- first-wins (SPEC.md §5) ---------- */

{
  // {title} is first-wins, like every other directive SPEC.md §5 lists —
  // a deliberate change from chordprosite's own `this.title += dir.value`,
  // which would have accumulated this into "FooBar".
  const song = new ChordProSong("{title: Foo}\n{title: Bar}");
  assert.equal(song.title, "Foo");
}

{
  // Same change applies to {artist}/{subtitle} — chordprosite's own class
  // accumulates these too (folded into one field, no less).
  const song = new ChordProSong("{artist: A}\n{artist: B}\n{subtitle: C}\n{subtitle: D}");
  assert.equal(song.artist, "A");
  assert.equal(song.subtitle, "C");
}

{
  // {version} still appends " - VN" unconditionally, on top of whatever
  // title first-wins already settled on — it isn't one of the properties
  // SPEC.md §5 lists, so it keeps its original chordprosite-ported
  // behaviour rather than joining the first-wins rule above.
  const song = new ChordProSong("{title: Foo}\n{version: 2}");
  assert.equal(song.title, "Foo - V2");
}

{
  // key/capo/transpose/composer were already first-wins before {title}/
  // {artist}/{subtitle} joined them above — the guard is a falsy check
  // (`if (!this.key)`), so only a *non-empty* first value locks the field.
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
