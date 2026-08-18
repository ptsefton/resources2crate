// A chordpro-mode build's real preview is songbook_html.js's own
// songbook.html (SPEC.md's "Songbook HTML output" section), not the generic
// ro-crate-static-site rendering ro-crate-html-output/index.js otherwise
// produces for every other input mode. For chordpro mode, that plugin's
// OUTPUT_WRITE hook is expected to skip its usual rendering entirely and
// write a small redirect page to ro-crate-preview.html instead — see
// chordpro-input/SPEC.md §15 and this hook's own inline comments.
import assert from "node:assert/strict";
import { plugin as htmlOutputPlugin } from "../src/plugins/ro-crate-html-output/index.js";
import { HOOKS } from "../src/plugins/hooks.js";

function notFoundError() {
  const e = new Error("not found");
  e.name = "NotFoundError";
  return e;
}

// Minimal fake FileSystemDirectoryHandle: only getFileHandle (with
// {create}) and a writable stream, which is all writeFile/fileExists
// (fs_helpers.js) ever call.
function memoryDirHandle(files = new Map()) {
  return {
    async getFileHandle(name, { create = false } = {}) {
      if (!files.has(name)) {
        if (!create) throw notFoundError();
        files.set(name, new Uint8Array());
      }
      return {
        async getFile() { return new File([files.get(name)], name); },
        async createWritable() {
          return {
            async write(contents) {
              files.set(name, typeof contents === "string" ? new TextEncoder().encode(contents) : contents);
            },
            async close() {},
          };
        },
      };
    },
    readText(name) {
      const bytes = files.get(name);
      return bytes ? new TextDecoder().decode(bytes) : undefined;
    },
  };
}

{
  const dirHandle = memoryDirHandle();
  const logs = [];
  // ctx.crate is deliberately null: the static-site rendering path this
  // hook would otherwise take calls crate.resolveContext() almost
  // immediately, so if the chordpro guard ever stopped short-circuiting,
  // this would throw (caught, logged as "HTML preview failed", no file
  // written) rather than silently rendering something — the assertions
  // below would then fail on a missing/empty file, not pass for the wrong
  // reason.
  const ctx = {
    dirHandle,
    options: { makeHtml: true, overwrite: true, inputMode: "chordpro" },
    crate: null,
    log: (msg, level) => logs.push(`[${level}] ${msg}`),
  };

  await htmlOutputPlugin.hooks[HOOKS.OUTPUT_WRITE](ctx);

  const html = dirHandle.readText("ro-crate-preview.html");
  assert.ok(html, "ro-crate-preview.html should still be written for a chordpro build");
  assert.match(html, /songbook\.html/);
  // Posts the same message main.js's own PREVIEW_NAV_SCRIPT sends on a
  // click-through — this is what lets the app's popup preview hand off to
  // songbook.html without a relative-URL navigation, which wouldn't resolve
  // against the popup's blob: URL at all.
  assert.match(html, /window\.opener/);
  assert.match(html, /postMessage/);
  // Falls back to a plain redirect when opened with no opener at all (e.g.
  // a real file:// URL, not inside the app's own preview popup).
  assert.match(html, /location\.replace/);
  assert.equal(ctx.buildHtml, html);
  assert.equal(ctx.lastHtmlTemplate, null);
  assert.ok(logs.some((l) => l.includes("chordpro mode")), "should log that it took the chordpro redirect path");
}

// The "Generate ro-crate-preview.html" toggle and the overwrite guard both
// still apply before the chordpro check even runs — unrelated to chordpro
// mode specifically, but worth confirming this new branch didn't move
// either check.
{
  const dirHandle = memoryDirHandle();
  const ctx = {
    dirHandle,
    options: { makeHtml: false, overwrite: true, inputMode: "chordpro" },
    crate: null,
    log: () => {},
  };
  await htmlOutputPlugin.hooks[HOOKS.OUTPUT_WRITE](ctx);
  assert.equal(dirHandle.readText("ro-crate-preview.html"), undefined, "makeHtml: false should skip writing anything, chordpro or not");
}

console.log("test-chordpro-preview-redirect.mjs: all assertions passed.");
