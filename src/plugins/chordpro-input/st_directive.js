// Pure, isomorphic logic for the {st:} cleanup tool (SPEC.md's "Metadata
// entry and cleanup" stage) — no file I/O of any kind, so it's usable from
// both the Node CLI script (scripts/fix-st-directive.mjs) and the browser
// UI (fix_st_directive_ui.js) without either one duplicating the regex or
// the rewrite rules. Same isomorphic split as crate.js's own header comment
// describes for a different reason: one implementation, two I/O shells.
//
// PT's own ChordPro charts going back to around 2015 often use {st: ...}
// (subtitle) as a stand-in for {artist: ...} — and sometimes for
// {composer: ...} instead — a habit that predates {artist}/{subtitle} being
// distinct directives at all (SPEC.md §5). This finds those occurrences and
// rewrites them under a human's own per-occurrence choice, never
// automatically guessing which one a given credit actually is.

// {st:...} specifically — not {subtitle:...} (a distinct directive under
// the current split, and not what this is for) and not
// {start_of_chorus:}/{stanza:}/etc: the colon has to follow "st" immediately
// (only whitespace allowed between), which none of those satisfy.
// Case-insensitive on "st" itself, since ChordPro directive names
// conventionally are; the rewrite below always emits lowercase
// "artist"/"composer" regardless of the original's own casing, since
// that's the one form the real parser (chordprobook's ChordProSong.js) ever
// produces from its own name.trim().toLowerCase() — there's no meaningful
// "St" vs "st" vs "ST" to preserve on the way out.
export const ST_DIRECTIVE_RE = /\{(\s*)st(\s*):([^}]*)\}/gi;

// One entry per {st:} occurrence in `text`, in the order they appear —
// applyChoices() (below) relies on that same order to match each match up
// with the choice a caller made for it, so the two functions have to agree
// on "which occurrence is which" without either of them needing to say so
// explicitly.
//
// ST_DIRECTIVE_RE is a shared, mutable, exported module-level object —
// String.prototype.matchAll() starts from its *current* lastIndex (copying
// it onto an internal clone, per spec), not always from 0, so if anything
// else ever calls .test()/.exec() directly on this same regex (which does
// mutate lastIndex and, unlike .replace(), never resets it), a later call
// here could silently skip the start of the next string. Resetting it
// first makes this function correct regardless of what state the shared
// regex was left in.
export function findMatches(text) {
  ST_DIRECTIVE_RE.lastIndex = 0;
  return Array.from(text.matchAll(ST_DIRECTIVE_RE)).map((m) => ({
    value: m[3].trim(),
    matchText: m[0],
    index: m.index,
  }));
}

// choices[i] is what to do with the i-th match findMatches(text) would
// return, in that same order — missing entries (a shorter array, or an
// unrecognised value) default to "artist". The four choices:
//   "artist"   (default) — {st: X} becomes {artist: X}.
//   "composer" — {st: X} becomes {composer: X} instead — it was never a
//                performer credit, whatever the file's original author
//                thought {st:} meant.
//   "both"     — {st: X} becomes {artist: X}, with a *second*, new
//                {composer: X} line added right after it — some old charts
//                genuinely credit the same person as both.
//   "skip"     — the original {st: X} line is left completely untouched.
export function applyChoices(text, choices) {
  // .replace() on a global regex always resets lastIndex to 0 internally
  // before it starts, regardless of prior state, so this isn't needed for
  // correctness here the way it is in findMatches() above — but resetting it
  // anyway keeps both functions defensive against the same shared-mutable-
  // regex hazard, rather than one relying on a spec detail of .replace() that
  // a future refactor (e.g. to matchAll) could silently break.
  ST_DIRECTIVE_RE.lastIndex = 0;
  let i = -1;
  return text.replace(ST_DIRECTIVE_RE, (full, ws1, ws2, value) => {
    i += 1;
    const choice = choices[i] || "artist";
    if (choice === "skip") return full;
    const artistLine = `{${ws1}artist${ws2}:${value}}`;
    if (choice === "composer") return `{composer:${value}}`;
    if (choice === "both") return `${artistLine}\n{composer:${value}}`;
    return artistLine;
  });
}
