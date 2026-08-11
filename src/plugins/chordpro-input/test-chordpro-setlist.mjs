// Unit tests for parseSetlist and matchEntryToSong, now sourced from the
// chordprobook package (see its own SPEC.md §3.2) rather than a local copy
// — see this plugin's SPEC.md §6/§6.1 for the design.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseSetlist, matchEntryToSong } from "chordprobook";

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "samples");
const readFixture = (name) => readFileSync(path.join(fixturesDir, name), "utf8");

/* ---------- parseSetlist: grammar ---------- */

{
  const { title } = parseSetlist("{Title: Gig number 1,000}\n\n# Set 1\n\n## Amazing");
  assert.equal(title, "Gig number 1,000");
}

{
  // No title directive at all.
  const { title } = parseSetlist("# Set 1\n\n## Amazing");
  assert.equal(title, null);
}

{
  // Only the first non-blank line is ever considered for the title
  // directive — a later line that happens to look like one is just text.
  const { title, entries } = parseSetlist("\n\n{Title: Real Title}\n## {Title: Not a title}");
  assert.equal(title, "Real Title");
  assert.equal(entries.length, 1);
  // parseEntryHeading discards everything from the first "{" onward.
  assert.equal(entries[0].rawHeading, "");
}

{
  const { entries } = parseSetlist("# Set A\n## Song One\n# Set B\n## Song Two");
  assert.equal(entries.length, 2);
  assert.equal(entries[0].setName, "Set A");
  assert.equal(entries[0].rawHeading, "Song One");
  assert.equal(entries[1].setName, "Set B");
  assert.equal(entries[1].rawHeading, "Song Two");
}

{
  // An entry with no preceding "#" heading at all has an empty set name,
  // not a crash or a null.
  const { entries } = parseSetlist("## Song One");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].setName, "");
}

{
  const { entries } = parseSetlist("## Baby {transpose: -2}");
  assert.equal(entries[0].rawHeading, "Baby");
  assert.equal(entries[0].transpose, "-2");
  assert.equal(entries[0].capo, undefined);
}

{
  const { entries } = parseSetlist("## Louie {capo: 3}");
  assert.equal(entries[0].rawHeading, "Louie");
  assert.equal(entries[0].capo, 3);
  assert.equal(entries[0].transpose, undefined);
}

/* ---------- parseSetlist: CRLF line endings ---------- */

{
  // Regression test for a real bug: a CRLF-authored setlist file (found
  // against a real Windows-authored/synced setlist, not a hypothetical)
  // left a trailing "\r" on every line. headingLevel()'s $-anchored regex
  // can't match a line with a trailing "\r" ("." never matches a line
  // terminator in JS regex), so every single heading silently failed to
  // parse — the file produced a title but zero entries, and the setlist
  // it built had no hasPart at all rather than an error pointing at why.
  const crlf = "{Title: Ready to perform}\r\n\r\n## Harvest Moon\r\n\r\n## Royals\r\n";
  const { title, entries } = parseSetlist(crlf);
  assert.equal(title, "Ready to perform");
  assert.equal(entries.length, 2);
  assert.equal(entries[0].rawHeading, "Harvest Moon");
  assert.equal(entries[1].rawHeading, "Royals");
}

{
  // The same bug, but for an inline override and a note — both also sit on
  // lines that would have carried a trailing "\r".
  const crlf = "## Wildflowers {key: G}\r\n> Careful with this one\r\n";
  const { entries } = parseSetlist(crlf);
  assert.equal(entries[0].rawHeading, "Wildflowers");
  assert.equal(entries[0].notes, "> Careful with this one");
}

/* ---------- parseSetlist: notes ---------- */

{
  // Notes are any non-blank, non-heading line(s) up to the next heading,
  // concatenated with "\n" — blockquote markers are kept verbatim, not
  // stripped or required (SPEC.md §6): chordprosite's own sample mixes
  // blockquote-styled notes under one entry with a plain paragraph under
  // another, with no apparent difference in intent.
  const { entries } = parseSetlist(
    "## Song One\n\n> Play with a lively feel!\n>> But not **that** lively!\n\n## Song Two\nPlain note, no blockquote."
  );
  assert.equal(entries[0].notes, "> Play with a lively feel!\n>> But not **that** lively!");
  assert.equal(entries[1].notes, "Plain note, no blockquote.");
}

{
  // An entry with nothing following it before the next heading has no
  // notes property at all — not an empty string.
  const { entries } = parseSetlist("## Song One\n## Song Two\nSome note.");
  assert.equal(entries[0].notes, undefined);
  assert.equal(entries[1].notes, "Some note.");
}

{
  // Text between a "#" set heading and the next entry attaches to nothing —
  // it doesn't leak backwards onto the previous set's last entry.
  const { entries } = parseSetlist("## Song One\n# Set 2\nStray text, no entry yet.\n## Song Two");
  assert.equal(entries[0].notes, undefined);
  assert.equal(entries[1].notes, undefined);
}

/* ---------- matchEntryToSong ---------- */

const songs = [
  { id: "a.cho", title: "Amazing Grace" },
  { id: "b.cho", title: "Slot Machine Baby" },
  { id: "c.cho", title: "Universe" },
];

{
  const result = matchEntryToSong("Amazing Grace", songs);
  assert.equal(result.matchStatus, "exact");
  assert.equal(result.song.id, "a.cho");
  assert.deepEqual(result.candidates, []);
}

{
  // Case-insensitive exact match.
  const result = matchEntryToSong("amazing grace", songs);
  assert.equal(result.matchStatus, "exact");
  assert.equal(result.song.id, "a.cho");
}

{
  // No exact match, but a unique fuzzy (word-joined-by-.*?) match.
  const result = matchEntryToSong("Amazing", songs);
  assert.equal(result.matchStatus, "fuzzy");
  assert.equal(result.song.id, "a.cho");
}

{
  // Nothing matches at all.
  const result = matchEntryToSong("Nonexistent Song", songs);
  assert.equal(result.matchStatus, "unresolved");
  assert.equal(result.song, null);
  assert.deepEqual(result.candidates, []);
}

{
  // An empty entry name (e.g. from a heading that was pure directive
  // markup) is unresolved without attempting to match at all.
  const result = matchEntryToSong("", songs);
  assert.equal(result.matchStatus, "unresolved");
}

{
  // Two songs whose titles both contain "Song" — ambiguous fuzzy match.
  // Resolves to the first candidate (in `songs` order) but records every
  // candidate, so the ambiguity is inspectable in the crate itself rather
  // than only in a build-log warning.
  const ambiguousSongs = [
    { id: "x.cho", title: "First Song" },
    { id: "y.cho", title: "Second Song" },
  ];
  const result = matchEntryToSong("Song", ambiguousSongs);
  assert.equal(result.matchStatus, "ambiguous");
  assert.equal(result.song.id, "x.cho");
  assert.deepEqual(result.candidates.map((s) => s.id), ["x.cho", "y.cho"]);
}

{
  // Two songs with the literal same title — ambiguous at the exact-match
  // step, never even reaching the fuzzy step.
  const duplicateTitleSongs = [
    { id: "x.cho", title: "Amazing Grace" },
    { id: "y.cho", title: "Amazing Grace" },
  ];
  const result = matchEntryToSong("Amazing Grace", duplicateTitleSongs);
  assert.equal(result.matchStatus, "ambiguous");
  assert.equal(result.candidates.length, 2);
}

{
  // An entry name containing regex metacharacters that don't form a valid
  // pattern is a real "no match" outcome, not a thrown error.
  const result = matchEntryToSong("Song (unclosed [bracket", songs);
  assert.equal(result.matchStatus, "unresolved");
}

/* ---------- end to end against the real sample setlist + real songs ---------- */

{
  const { ChordProSong } = await import("chordprobook");
  const songFiles = [
    "AmazingGrace.cho.txt", "gimme_a_u.cho.txt", "i_called_your_name.cho.txt",
    "slot_machine_baby.cho.txt", "ukulele_train.cho.txt", "uni-verse.cho.txt",
  ];
  const realSongs = songFiles.map((name) => {
    const parsed = new ChordProSong(readFixture(name));
    return { id: name, title: parsed.title };
  });
  assert.deepEqual(realSongs.map((s) => s.title), [
    "Amazing Grace", "Gimme a U", "I Called Your name", "Slot Machine Baby", "Ukulele Train", "Universe",
  ]);

  const { title, entries } = parseSetlist(readFixture("sample.setlist.md"));
  assert.equal(title, "Gig number 1,000");
  assert.equal(entries.length, 4);

  const [slotMachine, uni, amazing, baby] = entries;

  assert.equal(slotMachine.setName, "Set 1");
  assert.equal(slotMachine.rawHeading, "Slot Machine Baby");
  const slotMachineMatch = matchEntryToSong(slotMachine.rawHeading, realSongs);
  assert.equal(slotMachineMatch.matchStatus, "exact");
  assert.equal(slotMachineMatch.song.id, "slot_machine_baby.cho.txt");
  assert.equal(slotMachine.notes, "> Play with a lively feel, start with a manic synth solo!\n>> But not **that** lively!");

  assert.equal(uni.rawHeading, "Uni");
  const uniMatch = matchEntryToSong(uni.rawHeading, realSongs);
  assert.equal(uniMatch.matchStatus, "fuzzy");
  assert.equal(uniMatch.song.id, "uni-verse.cho.txt");
  assert.equal(uni.notes, undefined);

  assert.equal(amazing.rawHeading, "Amazing");
  const amazingMatch = matchEntryToSong(amazing.rawHeading, realSongs);
  assert.equal(amazingMatch.matchStatus, "fuzzy");
  assert.equal(amazingMatch.song.id, "AmazingGrace.cho.txt");
  assert.equal(amazing.notes, "Make it amazing!");

  assert.equal(baby.setName, "Set 2");
  assert.equal(baby.rawHeading, "Baby");
  assert.equal(baby.transpose, "-2");
  const babyMatch = matchEntryToSong(baby.rawHeading, realSongs);
  // Fuzzy-matches "Slot Machine Baby" again — the same song performed in a
  // different set with a per-instance transpose override (SPEC.md §6).
  assert.equal(babyMatch.matchStatus, "fuzzy");
  assert.equal(babyMatch.song.id, "slot_machine_baby.cho.txt");
  assert.equal(baby.notes, "Play slow this time.");
}

console.log("test-chordpro-setlist.mjs: all assertions passed.");
