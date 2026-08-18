// Unit tests for the {st:} cleanup tool's shared, isomorphic core
// (st_directive.js) — see SPEC.md's "Metadata entry and cleanup" section.
// The file-I/O shells around this (scripts/fix-st-directive.mjs's Node fs
// calls, fix_st_directive_ui.js's File System Access API calls) aren't
// exercised here; this only covers the pure matching/rewrite logic both of
// them share.
import assert from "node:assert/strict";
import { ST_DIRECTIVE_RE, findMatches, applyChoices } from "./st_directive.js";

/* ---------- findMatches ---------- */

{
  const text = "{title: Song}\n{st: Peter Sefton}\n{key: G}\n[G]Hello";
  const matches = findMatches(text);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].value, "Peter Sefton");
  assert.equal(matches[0].matchText, "{st: Peter Sefton}");
  assert.equal(text.slice(matches[0].index, matches[0].index + matches[0].matchText.length), matches[0].matchText);
}

{
  // {ST:} — case-insensitive on the directive name itself.
  const matches = findMatches("{ST: Jane Doe}");
  assert.equal(matches.length, 1);
  assert.equal(matches[0].value, "Jane Doe");
}

{
  // Not {subtitle:}/{artist:} — those are already the properties this tool
  // exists to move *into*, not something it should ever touch again.
  const matches = findMatches("{subtitle: Leave me alone}\n{artist: Me too}");
  assert.equal(matches.length, 0);
}

{
  // Not {start_of_chorus:}/{stanza:} — "st" has to be immediately (only
  // whitespace) followed by the colon, which neither of these satisfies.
  const matches = findMatches("{start_of_chorus: x}\n{stanza: y}");
  assert.equal(matches.length, 0);
}

{
  // Multiple hits across a file, in document order.
  const text = "{st: First}\n[C]line\n{st: Second}";
  const matches = findMatches(text);
  assert.equal(matches.length, 2);
  assert.equal(matches[0].value, "First");
  assert.equal(matches[1].value, "Second");
}

/* ---------- applyChoices: the four choices ---------- */

{
  // Default (no choices array entry at all) — every occurrence becomes {artist:}.
  const text = "{st: Peter Sefton}";
  assert.equal(applyChoices(text, []), "{artist: Peter Sefton}");
}

{
  const text = "{st: Peter Sefton}";
  assert.equal(applyChoices(text, ["artist"]), "{artist: Peter Sefton}");
}

{
  // "composer" *replaces* the line — it was never a performer credit.
  const text = "{st: Traditional}";
  assert.equal(applyChoices(text, ["composer"]), "{composer: Traditional}");
}

{
  // "both" keeps the renamed {artist:} line and adds a *second*, new
  // {composer:} line right after it — not a replacement.
  const text = "{st: Richard Thompson}";
  assert.equal(applyChoices(text, ["both"]), "{artist: Richard Thompson}\n{composer: Richard Thompson}");
}

{
  // "skip" leaves the original line completely untouched.
  const text = "{st: Not sure what this is}";
  assert.equal(applyChoices(text, ["skip"]), "{st: Not sure what this is}");
}

/* ---------- applyChoices: whitespace/casing preservation ---------- */

{
  // Internal whitespace around "st"/the colon is preserved verbatim on the
  // artist line — only the directive *name* itself changes.
  const text = "{ st  : Spaced Out}";
  assert.equal(applyChoices(text, ["artist"]), "{ artist  : Spaced Out}");
}

{
  // Original casing ("ST") is not preserved — the rewrite always emits
  // lowercase "artist"/"composer", matching the one form the real parser
  // (ChordProSong.js's own name.trim().toLowerCase()) ever produces.
  const text = "{ST:Mark Seymour}";
  assert.equal(applyChoices(text, ["artist"]), "{artist:Mark Seymour}");
}

/* ---------- applyChoices: multiple occurrences, independent choices ---------- */

{
  const text = "{st: First}\n{title: Middle}\n{st: Second}\n{st: Third}";
  const rewritten = applyChoices(text, ["artist", "composer", "both"]);
  assert.equal(
    rewritten,
    "{artist: First}\n{title: Middle}\n{composer: Second}\n{artist: Third}\n{composer: Third}",
  );
}

{
  // Fewer choices than matches — the tail defaults to "artist", same as an
  // entirely missing entry for any one match.
  const text = "{st: First}\n{st: Second}";
  assert.equal(applyChoices(text, ["skip"]), "{st: First}\n{artist: Second}");
}

/* ---------- ST_DIRECTIVE_RE itself is exported and reusable ---------- */

{
  assert.equal(ST_DIRECTIVE_RE.global, true);
  assert.equal(ST_DIRECTIVE_RE.ignoreCase, true);
  // ST_DIRECTIVE_RE is shared and mutable — matchAll() actually inherits
  // whatever lastIndex a regex was left at (it does NOT always start from 0),
  // so leaving stale state here could silently make findMatches() miss a
  // match. This only passes because findMatches() defensively resets
  // lastIndex to 0 itself before scanning.
  ST_DIRECTIVE_RE.lastIndex = 5;
  assert.equal(findMatches("{st: Still found}").length, 1);
}

console.log("test-st-directive.mjs: all assertions passed.");
