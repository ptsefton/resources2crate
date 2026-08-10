// Re-exports this folder's parsing logic. Everything here is written with
// no dependency on resources2crate's plugin context, hook bus, or RO-Crate
// APIs — see SPEC.md §1 and §8 — so it can move into the standalone npm
// library planned there with minimal change.
export { ChordProSong } from "./ChordProSong.js";
export { parseSetlist, matchEntryToSong } from "./Setlist.js";
