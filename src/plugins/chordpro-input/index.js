// ChordPro song/setlist input mode — see SPEC.md for the full design.
// Registered as an input-mode plugin (INPUT_PLUGINS, keyed by inputMode) —
// unlike the additive hook-tapping plugins in src/plugins/index.js's
// PLUGINS array, input-mode plugins are mutually exclusive: exactly one
// runs per build, dispatched by pipeline.js on ctx.options.inputMode.
//
// No analyzeFiles, unlike generic-input: this plugin does its own folder
// walk inside buildCrate (SPEC.md §3) rather than producing a flat
// ctx.filesWithMeta list for other taps to annotate.
//
// chordpro_crate.js is dynamically imported here (rather than statically, at
// the top of this file) so it — and the ro-crate library it pulls in — stay
// out of the main bundle until a chordpro build actually runs, the same
// discipline docx-input and austlang both already follow for their own
// heavier dependencies.
export const plugin = {
  name: "chordpro-input",
  inputMode: "chordpro",
  async buildCrate(ctx) {
    ctx.log("Parsing ChordPro songs and setlists…", "info");
    const { buildCrateFromChordProFolder } = await import("./chordpro_crate.js");

    const result = await buildCrateFromChordProFolder(ctx.dirHandle, ctx.config, (msg) => ctx.log(msg, "muted"));
    if (!result) {
      throw new Error(
        "No ChordPro song files (.pro/.cho/.cho.txt) or setlist files (.setlist.md) were found in this folder."
      );
    }

    ctx.crate = result.crate;
    ctx.sourceCount = result.songCount;
    ctx.log(`Built crate: ${result.songCount} song(s), ${result.setlistCount} setlist(s).`, "ok");
  },
};
