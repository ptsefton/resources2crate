// Generates ro-crate-preview.html — resolves a template/config/css bundle
// (repo folder → uploaded file → local folder, in that precedence) and
// renders either a multipage or single-page preview. Owns the whole
// template-resolution helper cluster that used to live inline in main.js;
// only the shared GitHub-fetch primitives (also used for the profile list
// and template-repo folder dropdown) and generic FSA read/write helpers are
// imported from neutral modules rather than duplicated here.
import { HOOKS } from "../hooks.js";
import { crateToPreviewHtml, crateToMultiPageHtml } from "../../crate.js";
import { writeFile, writeFileAtPath, readJsonFromFolder, readFileTextFromDirectory, verifyPermission, fileExists } from "../../fs_helpers.js";
import { bustCacheUrl, buildGitHubTreeUrl, fetchGitHubTextFile, listGitHubFolder } from "../../github.js";
import { resolveProfileGroups } from "./layout.js";
import { OUTPUT_FILE as SONGBOOK_FILE } from "../chordpro-input/songbook_html.js";

const HTML_FILE = "ro-crate-preview.html";
const MULTIPAGE_DIR = "ro-crate-preview_html";
const TEMPLATE_REPO_OWNER = "benfoley";
const TEMPLATE_REPO_NAME = "rocss-template-repo";
const TEMPLATE_REPO_REF = "main";

// Applies the collectionLabelsBuilder option's name/order overrides directly
// to the shared crate object, for this HTML render only. Safe because this
// hook runs after ro-crate-json-output/ro-crate-xlsx-output (see
// src/plugins/index.js's registration order) — by the time this mutates
// `crate`, both metadata files have already been written from the
// unmodified names/order, so ro-crate-metadata.json/.xlsx never see this
// override, only the generated HTML does.
function applyCollectionLabelOverrides(crate, options) {
  const labels = options.collectionLabels;
  const order = options.collectionOrder;
  if (!labels && !order) return;

  const graph = crate.getJson()["@graph"] || [];
  const collectionNameToId = new Map();
  for (const entity of graph) {
    const types = Array.isArray(entity["@type"]) ? entity["@type"] : [entity["@type"]];
    const isCollection = types.includes("RepositoryCollection");
    const isSourceGroup = types.includes("custom:SourceDocumentGroup");
    if (!isCollection && !isSourceGroup) continue;
    const folderName = entity.name;
    if (isCollection) collectionNameToId.set(folderName, entity["@id"]);
    if (labels && labels[folderName]) {
      const live = crate.getEntity(entity["@id"]);
      if (live) live.name = labels[folderName];
    }
  }

  if (order) {
    const derivedContent = crate.getEntity("#derivedContent");
    if (derivedContent && Array.isArray(derivedContent.hasPart)) {
      const parts = derivedContent.hasPart;
      const idOrder = order.map((folderName) => collectionNameToId.get(folderName)).filter(Boolean);
      parts.sort((a, b) => {
        const ia = idOrder.indexOf(a["@id"]);
        const ib = idOrder.indexOf(b["@id"]);
        if (ia === -1 && ib === -1) return 0;
        if (ia === -1) return 1;
        if (ib === -1) return -1;
        return ia - ib;
      });
    }
  }
}

// A chordpro-mode build never runs the ro-crate-static-site machinery below
// (see the OUTPUT_WRITE guard that calls this) — that machinery renders
// generic tabular/document crates, not a song/setlist one, and
// songbook_html.js's own songbook.html is this mode's real, purpose-built
// preview. This is a deliberately blank redirect to it, not an omitted file:
// main.js's "Show" step still expects an HTML_FILE to open (whichever of
// JSON/HTML/xlsx exists first), and the app's own preview popup navigates
// between crate-generated pages by posting a message to window.opener (see
// main.js's PREVIEW_NAV_SCRIPT/openPageInPreview/handlePreviewMessage)
// rather than a normal relative-URL page load — which wouldn't resolve
// against the blob: URL that popup's current page actually has. Posting
// that same message directly, on load, is what hands this page off to
// songbook.html immediately inside that popup, with no click needed. Opened
// on its own (a real file:// URL, no app/opener involved — e.g. someone
// double-clicking it in Finder), it falls back to a plain relative redirect
// instead, since window.opener is then null.
function buildChordproRedirectHtml(targetFile) {
  return `<!doctype html>
<html>
<head><meta charset="utf-8" /><title>Redirecting to ${targetFile}…</title></head>
<body>
<script>
if (window.opener) {
  window.opener.postMessage({ source: "r2c-preview", page: ${JSON.stringify(targetFile)} }, "*");
} else {
  window.location.replace(${JSON.stringify(targetFile)});
}
</script>
</body>
</html>
`;
}

function formatDurationMs(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "0.00s";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(ms >= 10000 ? 1 : 2)}s`;
}

function pickPreferredFile(files, ext, hints = []) {
  const byExt = files.filter((f) => f && f.type === "file" && typeof f.name === "string" && f.name.toLowerCase().endsWith(ext));
  if (!byExt.length) return null;
  for (const h of hints) {
    const found = byExt.find((f) => f.name.toLowerCase().includes(h));
    if (found) return found;
  }
  return byExt[0];
}

function preferredUploadedFile(uploadedFiles, ext, hints = []) {
  if (!uploadedFiles) return null;
  const uniqueFiles = [];
  const seen = new Set();
  uploadedFiles.forEach((file) => {
    if (!file || seen.has(file)) return;
    seen.add(file);
    uniqueFiles.push(file);
  });
  return pickPreferredFile(uniqueFiles, ext, hints);
}

function getNestedValue(obj, path) {
  let cur = obj;
  for (const key of path.split(".")) {
    if (!cur || typeof cur !== "object") return null;
    cur = cur[key];
  }
  return cur;
}

function pickConfigString(cfg, paths) {
  for (const p of paths) {
    const v = getNestedValue(cfg, p);
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

function isLikelyInlineTemplate(text) {
  return /<[a-z!/][^>]*>/i.test(text);
}

function isLikelyInlineCss(text) {
  return /[{;}]/.test(text) && /\s/.test(text);
}

function isAbsolutePathSpec(value) {
  return /^\//.test(value) || /^[A-Za-z]:[\\/]/.test(value) || /^~\//.test(value);
}

function pathTailCandidates(value) {
  const rel = String(value || "").replace(/^~\//, "").replace(/^[A-Za-z]:[\\/]/, "").replace(/^\/+/, "").replace(/\\/g, "/");
  const parts = rel.split("/").filter(Boolean);
  const out = [];
  for (let i = 0; i < parts.length; i++) out.push(parts.slice(i).join("/"));
  return out;
}

function hasUploadedMatch(uploadedFiles, spec) {
  if (!uploadedFiles) return false;
  const rel = String(spec || "").replace(/^\.\//, "").replace(/^~\//, "").replace(/^[A-Za-z]:[\\/]/, "").replace(/^\/+/, "").replace(/\\/g, "/");
  const base = rel.split("/").pop();
  return !!(uploadedFiles.get(rel) || uploadedFiles.get(base));
}

// The Build panel's "Home page" and "Site domain" fields are per-crate
// choices, so when set they override whatever the template itself shipped
// for homePageId/domain — those are typically a placeholder value or
// another project's (see benfoley/rocss-template-repo#3). Left blank, the
// template's own config is untouched, so a template with sensible values of
// its own still works with neither field filled in. `cfg` may be null (no
// template/config resolved at all), in which case there is nothing to
// override and null is returned unchanged.
export function applyHomePageAndDomainOverrides(cfg, options) {
  if (!cfg) return cfg;
  const overrides = {};
  if (options?.homePageId) overrides.homePageId = options.homePageId;
  if (options?.domain) overrides.domain = options.domain;
  return Object.keys(overrides).length ? { ...cfg, ...overrides } : cfg;
}

// Every template a multipage config points at: the root's, plus one per
// entity type. renderMultiPage looks these up by the exact string the config
// used (crateLite.pages[*].template and config.root.template), so they double
// as the keys of the pageTemplates map — see collectPageTemplates.
export function multipageTemplateRefs(cfg) {
  if (!cfg || cfg.multipage === false) return [];
  const refs = [];
  const rootRef = pickConfigString(cfg, ["root:template", "root.template"]);
  if (rootRef) refs.push(rootRef);
  for (const typeCfg of Object.values(cfg.types || {})) {
    const ref = typeCfg && typeof typeCfg === "object" ? typeCfg.template : null;
    if (typeof ref === "string" && ref.trim()) refs.push(ref.trim());
  }
  return [...new Set(refs)];
}

// Resolve each of those refs into template text, keyed by the ref itself.
// Keying by what the config actually wrote — rather than by where the file was
// found — is what lets a config keep working whatever path style it uses: the
// repo bundle's "templates/root-template.html", or the repo-root-relative
// paths a config copied from a CLI checkout carries.
//
// Returns null when the config isn't multipage, so callers can distinguish
// "no multipage wanted" from "multipage wanted but nothing resolved".
export async function collectPageTemplates(cfg, opts = {}) {
  const refs = multipageTemplateRefs(cfg);
  if (!refs.length) return null;

  const pageTemplates = {};
  for (const ref of refs) {
    const resolved = await resolveTemplateAsset(ref, "template", opts);
    if (resolved.text === null || resolved.text === undefined) {
      throw new Error(`Could not resolve template "${ref}" referenced by the config.`);
    }
    pageTemplates[ref] = resolved.text;
  }
  return pageTemplates;
}

function needsLocalTemplateFolder(cfg, uploadedFiles) {
  const refs = [
    pickConfigString(cfg, ["root:template", "root.template", "template", "templateFile", "templatePath", "templateUrl", "files.template", "paths.template", "assets.template"]),
    pickConfigString(cfg, ["style", "css", "styleFile", "stylePath", "styleUrl", "cssFile", "cssPath", "cssUrl", "files.style", "files.css", "paths.style", "paths.css", "assets.style", "assets.css"]),
    // Per-type templates count too: a multipage bundle whose root template was
    // uploaded but whose type templates weren't still needs the folder, and
    // without this the build would fail late instead of asking for it.
    ...multipageTemplateRefs(cfg),
  ].filter(Boolean);
  for (const v of refs) {
    if (/^https?:\/\//i.test(v)) continue;
    if (isLikelyInlineTemplate(v) || isLikelyInlineCss(v)) continue;
    if (hasUploadedMatch(uploadedFiles, v)) continue;
    return true;
  }
  return false;
}

// Local-template-folder access is separate from the picked crate folder
// (dirHandle) — the user grants it once via showDirectoryPicker, cached
// here for the rest of the session.
let uploadedConfigDirHandle = null;
export function resetUploadedConfigDirHandle() {
  uploadedConfigDirHandle = null;
}

async function ensureUploadedConfigDirectoryHandle() {
  if (uploadedConfigDirHandle) {
    const ok = await verifyPermission(uploadedConfigDirHandle, false);
    if (ok) return uploadedConfigDirHandle;
    uploadedConfigDirHandle = null;
  }
  try {
    const picked = await window.showDirectoryPicker({ mode: "read" });
    const ok = await verifyPermission(picked, false);
    if (!ok) throw new Error("Permission to read the config folder was denied.");
    uploadedConfigDirHandle = picked;
    return uploadedConfigDirHandle;
  } catch (e) {
    if (e && e.name === "AbortError") throw new Error("Config folder selection was cancelled.");
    throw e;
  }
}

async function resolveTemplateAsset(spec, kind, { dirHandle = null, baseRawUrl = "", uploadedFiles = null } = {}) {
  const val = String(spec || "").trim();
  if (!val) return { text: kind === "css" ? "" : null, source: "none" };

  if (kind === "template" && isLikelyInlineTemplate(val)) return { text: val, source: "inline config" };
  if (kind === "css" && isLikelyInlineCss(val)) return { text: val, source: "inline config" };

  if (/^https?:\/\//i.test(val)) {
    const res = await fetch(bustCacheUrl(val), { cache: "no-store" });
    if (!res.ok) throw new Error(`Could not download ${kind} from URL (${res.status} ${res.statusText}).`);
    return { text: await res.text(), source: `url (${val})` };
  }

  if (baseRawUrl) {
    const url = new URL(val.replace(/^\.\//, ""), baseRawUrl).toString();
    const res = await fetch(bustCacheUrl(url), { cache: "no-store" });
    if (!res.ok) throw new Error(`Could not download ${kind} from config path "${val}" (${res.status} ${res.statusText}).`);
    return { text: await res.text(), source: `url (${url})` };
  }

  if (uploadedFiles) {
    const rel = val.replace(/^\.\//, "").replace(/^~\//, "").replace(/^[A-Za-z]:[\\/]/, "").replace(/^\/+/, "").replace(/\\/g, "/");
    const base = rel.split("/").pop();
    const uploaded = uploadedFiles.get(rel) || uploadedFiles.get(base);
    if (uploaded) return { text: await uploaded.text(), source: `upload (${rel})` };
  }

  if (dirHandle) {
    if (isAbsolutePathSpec(val)) {
      for (const candidate of pathTailCandidates(val)) {
        const text = await readFileTextFromDirectory(dirHandle, candidate);
        if (text !== null) return { text, source: `folder (${candidate})` };
      }
    } else {
      const rel = val.replace(/^\.\//, "");
      const text = await readFileTextFromDirectory(dirHandle, rel);
      if (text !== null) return { text, source: `folder (${rel})` };
      // The picked folder is the config's own folder, but the path may be
      // written relative to somewhere further up — a config copied out of a
      // CLI checkout says "test_data/birds/templates/x.html" for a file that
      // sits at "templates/x.html" here. Try successively shorter tails
      // rather than failing on a path that only has the wrong prefix.
      for (const candidate of pathTailCandidates(rel).slice(1)) {
        const tailText = await readFileTextFromDirectory(dirHandle, candidate);
        if (tailText !== null) return { text: tailText, source: `folder (${candidate})` };
      }
    }
  }

  throw new Error(`Could not resolve ${kind} from config value "${val}".`);
}

async function resolveTemplateBundleFromConfig(cfg, opts = {}) {
  const templateRef = pickConfigString(cfg, [
    "root:template", "root.template",
    "template", "templateFile", "templatePath", "templateUrl",
    "files.template", "paths.template", "assets.template",
  ]);
  const styleRef = pickConfigString(cfg, [
    "style", "css", "styleFile", "stylePath", "styleUrl", "cssFile", "cssPath", "cssUrl",
    "files.style", "files.css", "paths.style", "paths.css", "assets.style", "assets.css",
  ]);

  let templateResolved = templateRef ? await resolveTemplateAsset(templateRef, "template", opts) : { text: null, source: "none" };
  let styleResolved = styleRef ? await resolveTemplateAsset(styleRef, "css", opts) : { text: "", source: "none" };

  if (!templateRef && opts.uploadedFiles) {
    const uploadedTemplate = preferredUploadedFile(opts.uploadedFiles, ".html", ["template", "preview"]);
    if (uploadedTemplate) {
      templateResolved = {
        text: await uploadedTemplate.text(),
        source: `upload (${uploadedTemplate.name})`,
      };
    }
  }

  if (!styleRef && opts.uploadedFiles) {
    const uploadedStyle = preferredUploadedFile(opts.uploadedFiles, ".css", ["style", "preview"]);
    if (uploadedStyle) {
      styleResolved = {
        text: await uploadedStyle.text(),
        source: `upload (${uploadedStyle.name})`,
      };
    }
  }

  return {
    template: templateResolved.text,
    css: styleResolved.text || "",
    templateSrc: templateResolved.source,
    cssSrc: styleResolved.source,
  };
}

async function fetchTemplateBundle(owner, repo, ref, folderPath) {
  const safeFolder = String(folderPath || "").replace(/^\/+|\/+$/g, "");
  if (!safeFolder) throw new Error("No template folder selected.");

  const entries = await listGitHubFolder(owner, repo, ref, safeFolder);

  const files = entries
    .filter((e) => e && e.type === "file" && typeof e.name === "string")
    .map((e) => ({
      name: e.name,
      path: e.path || `${safeFolder}/${e.name}`,
      downloadUrl: typeof e.download_url === "string" ? e.download_url : "",
      type: "file",
    }));

  const templateFile = pickPreferredFile(files, ".html", ["template", "tabular", "preview", "index"]);
  const configFile = pickPreferredFile(files, ".json", ["config", "preview"]);
  const styleFile = pickPreferredFile(files, ".css", ["style", "preview", "default"]);

  const template = templateFile
    ? await fetchGitHubTextFile(owner, repo, ref, templateFile.path, templateFile.downloadUrl)
    : null;
  const configText = configFile
    ? await fetchGitHubTextFile(owner, repo, ref, configFile.path, configFile.downloadUrl)
    : null;
  const css = styleFile
    ? await fetchGitHubTextFile(owner, repo, ref, styleFile.path, styleFile.downloadUrl)
    : "";

  let config = null;
  if (configText !== null) {
    try { config = JSON.parse(configText); }
    catch (e) { throw new Error(`Template config ${configFile.name} is not valid JSON: ${e.message}`); }
  }

  // Multipage bundles (see rocss-template-repo's README) keep their per-role
  // templates in a templates/ subfolder, referenced from config.json as
  // e.g. "templates/root-template.html" — a path relative to this folder.
  // Fetch every .html file there, keyed by that same relative path, so
  // crateToMultiPageHtml's pageTemplates lookup can resolve them directly.
  const pageTemplates = {};
  const templatesSubfolder = entries.find((e) => e && e.type === "dir" && e.name === "templates");
  if (templatesSubfolder) {
    const subEntries = await listGitHubFolder(owner, repo, ref, `${safeFolder}/templates`);
    const subHtmlFiles = subEntries.filter((e) => e && e.type === "file" && /\.html?$/i.test(e.name || ""));
    for (const entry of subHtmlFiles) {
      const text = await fetchGitHubTextFile(owner, repo, ref, entry.path, entry.download_url || "");
      pageTemplates[`templates/${entry.name}`] = text;
    }
  }

  return {
    template,
    config,
    css,
    pageTemplates,
    files: {
      template: templateFile ? templateFile.name : null,
      config: configFile ? configFile.name : null,
      style: styleFile ? styleFile.name : null,
    },
    source: buildGitHubTreeUrl(owner, repo, ref, safeFolder),
  };
}

export const plugin = {
  name: "ro-crate-html-output",
  optionSchema: {
    key: "makeHtml", label: "Generate ro-crate-preview.html", default: true,
    children: [
      { key: "collectionLabelsBuilder", type: "collectionLabelsBuilder", label: "Set menu names and order…",
        hint: "Optional, for Structured Word documents mode. Drag rows to reorder. Map each top-level collection folder to a friendlier label shown in the site's navigation menu and cards (e.g. AnmWeb1_HOME → Home) — the raw folder name is used for anything left blank. Affects only this generated HTML, not ro-crate-metadata.json/.xlsx." },
      { key: "templateRepoFolder", type: "select", label: "Template from rocss-template-repo",
        placeholder: "Loading folders…", hint: "Optional. Select one folder from the template repo." },
      { key: "homePageId", type: "select", label: "Home page",
        placeholder: "No home page — show the collection index",
        hint: "Optional. Pick one of your top-level folders to use as the landing page, instead of the index of collections. Populated from the folder you picked." },
      { key: "domain", type: "text", label: "Site domain",
        placeholder: "https://example.org/my-site",
        hint: "Optional. The hostname this site will be published under, used to build absolute preview-card (Open Graph) image and link URLs. Leave blank to skip those tags." },
      { key: "styledPreview", label: "Upload template files", default: false,
        hint: "Off = the library's plain preview.", children: [
        { key: "configFile", type: "file", label: "Config (JSON)", accept: ".json,.css,.html,application/json,text/css,text/html",
          hint: "Required. If config uses relative paths, use \"Choose folder\" (or drag the whole folder in) to keep subfolders intact — picking loose files individually flattens them and can break relative paths." },
      ] },
    ],
  },
  hooks: {
    [HOOKS.OUTPUT_WRITE]: async (ctx) => {
      const { dirHandle, options, crate, log } = ctx;
      const previewStartMs = Date.now();
      let assetResolveMs = 0;
      let renderMs = 0;
      let pageWriteMs = 0;
      if (!options.makeHtml) return;
      if (!(options.overwrite || !(await fileExists(dirHandle, HTML_FILE)))) {
        log(`${HTML_FILE} exists and overwrite is off — skipped.`, "warn");
        return;
      }
      if (options.inputMode === "chordpro") {
        const html = buildChordproRedirectHtml(SONGBOOK_FILE);
        await writeFile(dirHandle, HTML_FILE, html);
        log(`${HTML_FILE}: chordpro mode — wrote a redirect to ${SONGBOOK_FILE} instead of a static-site preview.`, "ok");
        ctx.buildHtml = html;
        ctx.lastHtmlTemplate = null;
        return;
      }
      try {
        applyCollectionLabelOverrides(crate, options);
        // resolveTerm() (used below to place profile-declared property
        // names) needs the context resolved first — crateToPreviewHtml/
        // crateToMultiPageHtml also call this themselves, but only after
        // the layout has already been computed; safe/idempotent to call twice.
        await crate.resolveContext();
        const profilePropertyGroups = ctx.selectedProfileData?.workflow?.propertyGroups;
        const layout = resolveProfileGroups(crate, profilePropertyGroups);
        if (layout.length) {
          log(`Preview: profile layout applied (${layout.length} group(s): ${layout.map((g) => g.name).join(", ")}).`, "muted");
        }

        let html;
        const selectedFolder = (options.templateRepoFolder || "").trim();
        const repoSelected = !!selectedFolder;
        let pageTemplates = null;
        let pageTemplatesSrc = "none";
        if (options.styledPreview || repoSelected) {
          // Precedence for template/config/style: repo folder → uploaded file → local folder.
          let template = null, templateSrc = "none";
          let cfg = null, cfgSrc = "none";
          let css = "", cssSrc = "none";
          const assetResolveStartMs = Date.now();

          if (repoSelected) {
            const remote = await fetchTemplateBundle(TEMPLATE_REPO_OWNER, TEMPLATE_REPO_NAME, TEMPLATE_REPO_REF, selectedFolder);
            template = remote.template;
            cfg = remote.config;
            css = remote.css;
            if (remote.pageTemplates && Object.keys(remote.pageTemplates).length > 0) {
              pageTemplates = remote.pageTemplates;
              pageTemplatesSrc = `repo (${selectedFolder})`;
            }
            const base = `repo (${selectedFolder})`;
            templateSrc = remote.files.template ? `${base}/${remote.files.template}` : `${base}; no template found`;
            cfgSrc = remote.files.config ? `${base}/${remote.files.config}` : "none";
            cssSrc = remote.files.style ? `${base}/${remote.files.style}` : "none";
          }

          if (options.styledPreview && options.configUpload) {
            const cfgText = await options.configUpload.file.text();
            try { cfg = JSON.parse(cfgText); }
            catch (e) { throw new Error(`uploaded config "${options.configUpload.name}" is not valid JSON: ${e.message}`); }
            cfgSrc = `uploaded (${options.configUpload.name})`;
          } else if (!repoSelected) {
            const folderCfg = await readJsonFromFolder(dirHandle, "preview-config.json");
            if (folderCfg) { cfg = folderCfg; cfgSrc = "preview-config.json from folder"; }
          }

          if (options.styledPreview && cfg) {
            const uploadedFiles = options.configUpload?.siblingFiles || null;
            let configDirHandle = null;
            if (needsLocalTemplateFolder(cfg, uploadedFiles)) {
              configDirHandle = await ensureUploadedConfigDirectoryHandle();
            }
            const assetOpts = { uploadedFiles, dirHandle: configDirHandle };
            const resolved = await resolveTemplateBundleFromConfig(cfg, assetOpts);
            if (resolved.template) { template = resolved.template; templateSrc = resolved.templateSrc; }
            if (resolved.css) { css = resolved.css; cssSrc = resolved.cssSrc; }

            // A local config gets its own template map, resolved from the same
            // uploaded files or picked folder. Without this the repo bundle was
            // the only way to build multipage, which made developing a
            // multipage template locally impossible — the build silently fell
            // through to a single page whose entity links pointed at pages it
            // never wrote.
            const localPageTemplates = await collectPageTemplates(cfg, assetOpts);
            if (localPageTemplates) {
              pageTemplates = localPageTemplates;
              pageTemplatesSrc = configDirHandle ? "picked folder" : "uploaded files";
            }
          }
          assetResolveMs = Date.now() - assetResolveStartMs;
          // A template's own config.json-declared propertyGroups (the most
          // specific, deliberate customization) still wins over the
          // profile's — the profile only fills in when the template didn't
          // set its own.
          const cfgHasOwnGroups = !!(cfg && Array.isArray(cfg.propertyGroups) && cfg.propertyGroups.length);
          const baseCfg = cfg && !cfgHasOwnGroups ? { ...cfg, propertyGroups: layout } : cfg;
          const effectiveCfg = applyHomePageAndDomainOverrides(baseCfg, options);

          // The repo's templates are keyed to the repo's own config, so they
          // can't be paired with a config from somewhere else — but an
          // uploaded config that brought its own templates has just replaced
          // pageTemplates with a matching set, and that pairing is fine.
          const uploadedConfigWithRepoTemplates =
            !!options.configUpload && pageTemplatesSrc.startsWith("repo (");
          if (uploadedConfigWithRepoTemplates && cfg && cfg.multipage !== false) {
            log(`Uploaded config asks for a multipage build but brought no templates, and the ${selectedFolder} repo folder's templates belong to its own config — falling back to a single page. Upload the templates alongside the config, or clear the repo folder.`, "warn");
          }

          if (pageTemplates && !uploadedConfigWithRepoTemplates && cfg && cfg.multipage !== false) {
            log(`Preview: multipage · templates ${pageTemplatesSrc} · config ${cfgSrc}.`, "muted");
            const multipageRenderStartMs = Date.now();
            const templateCount = Object.keys(pageTemplates).length;
            log(`Preview: rendering multipage site (${templateCount} template file(s))…`, "muted");
            const multi = await crateToMultiPageHtml(crate, { config: effectiveCfg, css, pageTemplates });
            const renderDoneMs = Date.now();
            renderMs = renderDoneMs - multipageRenderStartMs;
            log(`Preview: rendered root + ${multi.pages.length} page(s) in ${formatDurationMs(renderDoneMs - multipageRenderStartMs)}. Writing pages…`, "muted");

            const writeStartMs = Date.now();
            // A stale page from a previous build (e.g. one belonging to a
            // collection that no longer exists) would otherwise never get
            // cleaned up, since pages are written by path rather than the
            // whole directory being regenerated — wipe it first so the
            // folder always reflects exactly this build's output.
            try {
              await dirHandle.removeEntry(MULTIPAGE_DIR, { recursive: true });
            } catch {
              // no pre-existing ro-crate-preview_html/ to remove — fine.
            }
            const totalPages = multi.pages.length;
            const progressStep = totalPages >= 50 ? 25 : totalPages >= 10 ? 10 : 0;
            for (let i = 0; i < multi.pages.length; i += 1) {
              const page = multi.pages[i];
              await writeFileAtPath(dirHandle, page.path, page.html);
              const written = i + 1;
              if (progressStep && (written % progressStep === 0 || written === totalPages)) {
                log(`Preview: wrote ${written}/${totalPages} page file(s)…`, "muted");
              }
            }
            pageWriteMs = Date.now() - writeStartMs;
            log(`Wrote ${multi.pages.length} page(s) under ro-crate-preview_html/ in ${formatDurationMs(Date.now() - writeStartMs)}.`, "ok");
            html = multi.rootHtml;
            ctx.lastHtmlTemplate = null;
          } else if (template) {
            log(`Preview: styled tabular · template ${templateSrc} · config ${cfgSrc} · style ${cssSrc}.`, "muted");
            const styledRenderStartMs = Date.now();
            html = await crateToPreviewHtml(crate, { template, config: effectiveCfg, css });
            renderMs = Date.now() - styledRenderStartMs;
            ctx.lastHtmlTemplate = { template, config: effectiveCfg, css, source: templateSrc };
          } else {
            log("Preview: plain (library default template; no custom template file provided).", "muted");
            const plainRenderStartMs = Date.now();
            html = await crateToPreviewHtml(crate, { layouts: { default: layout } });
            renderMs = Date.now() - plainRenderStartMs;
            ctx.lastHtmlTemplate = null;
          }
        } else {
          log("Preview: plain (library default template).", "muted");
          const plainRenderStartMs = Date.now();
          html = await crateToPreviewHtml(crate, { layouts: { default: layout } });
          renderMs = Date.now() - plainRenderStartMs;
          ctx.lastHtmlTemplate = null;
        }
        await writeFile(dirHandle, HTML_FILE, html);
        log(`Wrote ${HTML_FILE}.`, "ok");
        const totalPreviewMs = Date.now() - previewStartMs;
        log(
          `Preview summary: total ${formatDurationMs(totalPreviewMs)} (assets ${formatDurationMs(assetResolveMs)}, render ${formatDurationMs(renderMs)}, page writes ${formatDurationMs(pageWriteMs)}).`,
          "muted"
        );
        ctx.buildHtml = html;
      } catch (e) {
        log(`HTML preview failed: ${e.message}`, "err");
      }
    },
  },
};
