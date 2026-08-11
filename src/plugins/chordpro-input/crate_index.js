// A minimal, dependency-free index over a plain RO-Crate JSON-LD graph — the
// shape `ro-crate-metadata.json` is written in (see SPEC.md's new "Songbook
// HTML output" section). Deliberately does not use the `ro-crate` library:
// this is meant to be reusable later by a standalone site-compiler that
// only ever has the written JSON file to work from, not a live crate
// object, and to stay independent of that library's own licence.
//
// "Safe" processing means tolerant of the two shapes a JSON-LD value can
// take (a bare value, or an array of them) without assuming either one —
// toArray() below normalises that; nothing else in this file assumes a
// property is a scalar or that it is an array.

// Normalises a JSON-LD property value (or @type) to an array. undefined/null
// becomes an empty array, a bare value becomes a one-element array, an
// existing array is returned as-is.
export function toArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

// The first element of a (possibly bare, possibly array-valued) property, or
// `fallback` if the property is absent.
export function firstValue(entity, property, fallback = undefined) {
  const values = toArray(entity?.[property]);
  return values.length ? values[0] : fallback;
}

// Builds { byId, byType, graph } from a parsed ro-crate-metadata.json-shaped
// object. byId maps "@id" -> entity. byType maps a single @type string ->
// array of entities carrying that type (an entity with more than one @type
// appears under each of them). Entities with no "@id" are skipped — not
// valid RO-Crate data, and not something either index could key on.
export function buildCrateIndex(crateJson) {
  const graph = Array.isArray(crateJson?.["@graph"]) ? crateJson["@graph"] : [];
  const byId = new Map();
  const byType = new Map();

  for (const entity of graph) {
    if (!entity || typeof entity !== "object" || !entity["@id"]) continue;
    byId.set(entity["@id"], entity);
    for (const type of toArray(entity["@type"])) {
      if (!byType.has(type)) byType.set(type, []);
      byType.get(type).push(entity);
    }
  }

  return { byId, byType, graph };
}

// Resolves a JSON-LD reference (a { "@id": "..." } object, or a bare id
// string) to the entity it points at, or null if there isn't one in this
// index. Safe against a reference whose target was never harvested.
export function resolveRef(index, ref) {
  if (!ref) return null;
  const id = typeof ref === "string" ? ref : ref["@id"];
  if (!id) return null;
  return index.byId.get(id) || null;
}

// All entities carrying `type`, or an empty array if none do.
export function entitiesOfType(index, type) {
  return index.byType.get(type) || [];
}
