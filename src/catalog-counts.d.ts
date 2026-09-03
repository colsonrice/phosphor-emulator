/// Catalog totals, injected by `vite.config.ts` at build time.
///
/// The landing page used to hardcode them and drifted badly: it read
/// "30 RECOMP MODS" and a headline total of 45 while the library page — which
/// derives its numbers from the same JSON — showed 289 and 304. The data files
/// are 339 kB together, so the home bundle cannot simply import them to count;
/// these are computed in the Vite config and substituted as literals, costing
/// the bundle three numbers and no bytes of JSON.
declare const __ROM_HACK_COUNT__: number;
declare const __MOD_COUNT__: number;
declare const __PROJECT_COUNT__: number;
