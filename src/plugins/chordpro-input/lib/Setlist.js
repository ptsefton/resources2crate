// Parses the setlist Markdown dialect (SPEC.md §6) and matches each entry to
// a song (SPEC.md §6.1). Pure functions — text/data in, plain data out, no
// filesystem access and no RO-Crate APIs — rather than a ported class: a
// Setlist doesn't own the song library it matches against, so threading that
// list through as a plain argument reads more clearly than modelling it as
// instance state.
//
// The matching algorithm is adapted from chordprosite's
// Songs.js#processPlaylist — see SPEC.md §6.1 for the full rationale. It
// differs from that original in one respect: chordprosite goes straight to
// the fuzzy regex and takes whatever `.find()` returns first, with no
// separate exact-match step. This module tries an exact title match first,
// only falling back to the fuzzy regex when no exact match exists, and
// reports an ambiguous outcome as data (matchStatus / candidates) rather
// than resolving it silently.

function parseTitleLine(lines) {
  for (const line of lines) {
    if (!line.trim()) continue;
    // Only the first non-blank line is ever considered a title directive —
    // matches chordprosite's own playlistLines[0] check. ChordPro's
    // {directive: value} syntax, not YAML frontmatter.
    const match = line.trim().match(/^\{t(?:itle)?:\s*(.*)\}$/i);
    return match ? match[1].trim() : null;
  }
  return null;
}

function headingLevel(line) {
  const match = line.match(/^(#{1,6})\s+(.*)$/);
  return match ? { level: match[1].length, text: match[2].trim() } : null;
}

// Mirrors chordprosite's Songs.js#processPlaylist: pull {transpose:}/{tr:}
// and {capo:} out of the raw heading with their own regexes, then discard
// everything from the first "{" onward to get the bare entry name. Any
// other curly-brace content on the line is simply discarded along with it,
// exactly as the original does — not parsed further, not preserved.
function parseEntryHeading(headingText) {
  const trMatch = headingText.match(/\{tr[a-z]*:\s*(.*?)\}/i);
  const capoMatch = headingText.match(/\{capo:\s*(\d+)\}/i);
  const rawHeading = headingText.replace(/\{.*/, "").trim();
  const entry = { rawHeading };
  if (trMatch) entry.transpose = trMatch[1].trim();
  if (capoMatch) entry.capo = parseInt(capoMatch[1], 10);
  return entry;
}

// Parses a setlist file's text into its title and ordered entries.
//
// "Notes" are any non-blank, non-heading line(s) following an entry, up to
// the next heading (or end of file), concatenated verbatim with "\n". This
// deliberately does not require blockquote ("> ") syntax: chordprosite's own
// sample setlist mixes blockquote-styled notes ("> Play with a lively
// feel...") under one entry with a plain paragraph ("Play slow this time.")
// under another, with no difference in intent between them — so both are
// captured the same way, markdown markers and all, left for a future
// renderer to interpret rather than stripped or required here.
export function parseSetlist(text) {
  // Normalise CRLF and old-Mac lone-CR line endings before splitting.
  // headingLevel()'s $-anchored regex can't match a line with a trailing
  // "\r" — "." never matches a line terminator in JS regex — so a CRLF file
  // (real-world setlists authored on Windows, or synced through a tool that
  // writes CRLF) previously failed to recognise a single heading, silently
  // producing zero entries for the whole file rather than an error.
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  const title = parseTitleLine(lines);

  const entries = [];
  let currentSetName = "";
  let currentEntry = null;
  let noteLines = [];

  const flushNotes = () => {
    if (currentEntry && noteLines.length) currentEntry.notes = noteLines.join("\n");
    noteLines = [];
  };

  for (const line of lines) {
    const heading = headingLevel(line);
    if (heading) {
      flushNotes();
      if (heading.level === 1) {
        currentSetName = heading.text;
        currentEntry = null; // a new set boundary — stray text after this and before the next entry attaches to nothing
      } else {
        const entry = parseEntryHeading(heading.text);
        entry.setName = currentSetName;
        entries.push(entry);
        currentEntry = entry;
      }
      continue;
    }
    if (currentEntry && line.trim()) noteLines.push(line.trim());
  }
  flushNotes();

  return { title, entries };
}

// Resolves one setlist entry's raw heading text to a song, from `songs`
// (an array of { id, title }). See SPEC.md §6.1 for the step-by-step
// rationale; summarised:
//   1. exact title match (case-insensitive)
//   2. a "join the words with .*?" fuzzy regex, case-insensitive
//   3. zero matches -> unresolved; one match -> resolved; more than one ->
//      ambiguous, resolved to the first candidate but with every candidate
//      recorded so the ambiguity is inspectable in the crate itself
export function matchEntryToSong(rawHeading, songs) {
  const name = String(rawHeading ?? "").trim();
  if (!name) return { matchStatus: "unresolved", song: null, candidates: [] };

  const exact = songs.filter((song) => song.title.toLowerCase() === name.toLowerCase());
  if (exact.length === 1) return { matchStatus: "exact", song: exact[0], candidates: [] };
  if (exact.length > 1) return { matchStatus: "ambiguous", song: exact[0], candidates: exact };

  let pattern;
  try {
    pattern = new RegExp(name.replace(/\s+/g, ".*?"), "i");
  } catch {
    // An entry name containing regex metacharacters that don't form a valid
    // pattern (e.g. an unmatched bracket) can't be fuzzy-matched at all —
    // that's a real "no match" outcome, not a crash.
    return { matchStatus: "unresolved", song: null, candidates: [] };
  }

  const fuzzy = songs.filter((song) => pattern.test(song.title));
  if (fuzzy.length === 0) return { matchStatus: "unresolved", song: null, candidates: [] };
  if (fuzzy.length === 1) return { matchStatus: "fuzzy", song: fuzzy[0], candidates: [] };
  return { matchStatus: "ambiguous", song: fuzzy[0], candidates: fuzzy };
}
