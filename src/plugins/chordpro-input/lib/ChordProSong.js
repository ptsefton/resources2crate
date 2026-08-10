// Ported from chordprosite's Song.js (specifically its Directive class and
// the metadata-extraction portion of initialise()) — see SPEC.md §5. This
// keeps the real directive-parsing pipeline rather than re-deriving a
// simpler line-by-line regex: chordprosite's text-tidying pass is what lets
// it correctly find a directive that isn't alone on its own line or has
// messy spacing around it, and a naive "split on \n, match ^{...}$ per line"
// re-implementation would silently miss those cases.
//
// Left out entirely: format(), formatChord(), chord/text normalisation,
// Transposer, and {instrument}/{define} handling. All of that is
// rendering/chord-diagram logic that belongs to the phase-2 compiler
// described in SPEC.md §1, not to this harvesting plugin — see SPEC.md §2.
//
// One deliberate addition beyond the original: {composer} is read into a
// field. chordprosite's own Song.js recognises the directive (it's listed in
// Directive.directives) but its initialise() switch has no case for it, so
// the value is parsed and then dropped. Everything else below — including
// the accumulate-rather-than-first-wins behaviour of {title}/{subtitle} and
// the {version} suffix on the title — is preserved exactly as chordprosite's
// own class behaves, rather than replaced with a "tidier" rule invented for
// this plugin: the real, exercised parser is more trustworthy than a
// from-scratch guess at what its rules "should" be.

// Trimmed to the directive names this plugin's metadata harvest cares about.
// chordprosite's own Directive.directives list is much longer (start_of_chorus,
// end_of_tab, define, instrument, ...); a line using one of those directives
// simply doesn't match any name here, so it falls through as an unrecognised
// directive — Directive.type stays null, exactly as if the line weren't a
// directive line at all. That's harmless for this class's purposes: the only
// thing done with an unrecognised line is testing it for a chord bracket
// (below), and a directive line never contains one.
const DIRECTIVE_NAMES = {
  t: "title", title: "title",
  st: "subtitle", artist: "subtitle", subtitle: "subtitle",
  key: "key",
  capo: "capo",
  transpose: "transpose", tr: "transpose",
  version: "version",
  composer: "composer",
};

const CHORD_BRACKET_RE = /\[([A-G][#b]?.*?)\]/;

class Directive {
  constructor(line) {
    this.type = null;
    this.value = null;
    const trimmed = line.trim();
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return;
    const match = trimmed.match(/{([^:]+):?(.*)}/);
    if (!match) return;
    let [, name, value] = match;
    name = name.trim().toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(DIRECTIVE_NAMES, name)) return;
    this.type = DIRECTIVE_NAMES[name];
    this.value = value ? value.trim() : "";
  }
}

export class ChordProSong {
  constructor(sourceText) {
    this.title = "";
    this.artist = "";
    this.key = null;
    this.capo = null;
    this.transpose = null;
    this.composer = null;
    this.hasChords = false;
    this._parse(String(sourceText ?? ""));
  }

  _parse(sourceText) {
    // Tidy messy directive markup exactly as Song.js#initialise does: put
    // every "{" on its own line, strip whitespace immediately after a "}",
    // then re-insert exactly one newline after every "}" that doesn't
    // already have one. This copes with a directive followed by lyric text
    // on the same line, or extra/trailing blank lines around a directive.
    // It does not reliably cope with more than one directive packed onto a
    // single line — neither does chordprosite's own class, and it isn't a
    // realistic authoring pattern worth chasing, so this doesn't try. This
    // mutates a local copy only — callers that need the file's literal
    // original text (this plugin does, for schema:text — see SPEC.md §5)
    // must keep their own reference to it; this class never exposes its
    // tidied copy.
    //
    // Line endings are normalised first (CRLF/lone-CR -> LF). Directive's
    // own constructor happens to .trim() each line before matching, which
    // incidentally already strips a trailing "\r" — but lib/Setlist.js's
    // $-anchored regexes had no such trim and silently matched nothing at
    // all against a real CRLF setlist file (a real bug, not a hypothetical
    // one — see that file's own normalisation). Normalising here too means
    // this class doesn't keep working only by accident of where .trim()
    // happens to be called.
    const text = sourceText
      .replace(/\r\n?/g, "\n")
      .replace(/[^^]{/g, "\n{")
      .replace(/}\s+/g, "}")
      .replace(/}(?!\n)/g, "}\n")
      .replace(/\n\n\n+/g, "\n\n");

    for (const line of text.split("\n")) {
      const dir = new Directive(line);
      if (dir.type === null) {
        if (!line.startsWith("#") && CHORD_BRACKET_RE.test(line)) this.hasChords = true;
        continue;
      }
      switch (dir.type) {
        case "title": this.title += dir.value; break;
        case "subtitle": this.artist += dir.value; break;
        case "version": this.title += ` - V${dir.value}`; break;
        case "key": if (!this.key) this.key = dir.value; break;
        case "transpose": if (!this.transpose) this.transpose = dir.value.split(/\s+/)[0]; break;
        case "capo": if (!this.capo) this.capo = parseInt(dir.value, 10); break;
        case "composer": if (!this.composer) this.composer = dir.value; break;
        default: break;
      }
    }
  }
}
