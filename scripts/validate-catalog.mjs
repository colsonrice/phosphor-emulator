import { readFile } from "node:fs/promises";

export const allowedCategories = new Set(["rom-hack", "gen1recomp", "gen2recomp"]);
export const allowedPermissions = new Set(["open-license", "author-approved"]);
// AUDIO joined when the survey found music mods with nowhere to file: under
// the old five they landed in "Art & Effects", which is where a player looking
// for a soundtrack would never think to look.
export const allowedTopics = new Set(["GAMEPLAY", "QOL", "UI", "ART", "CONTENT", "AUDIO"]);
export const allowedReviewStatuses = new Set(["permission-needed", "permission-queued", "archive-review"]);
export const allowedExtensions = [".ips", ".ups", ".bps", ".xdelta", ".vcdiff", ".zip", ".tar.gz"];
export const forbiddenExtensions = [".gb", ".gbc", ".gba", ".nds", ".3ds", ".cia"];

export function validateRelease(release, index) {
  const label = release?.id || `record ${index + 1}`;
  const errors = [];
  const requiredStrings = [
    "id", "title", "creator", "version", "releaseDate", "target", "summary",
    "fileUrl", "fileName", "fileSize", "sha256", "homepageUrl", "permissionEvidenceUrl", "license",
    // Consumed by scripts/build-manifest.mjs: `topic` picks the app's shelf.
    "topic",
  ];

  for (const field of requiredStrings) {
    if (typeof release?.[field] !== "string" || !release[field].trim()) {
      errors.push(`${label}: ${field} is required`);
    }
  }

  if (!allowedCategories.has(release?.category)) errors.push(`${label}: unsupported category`);
  if (!Array.isArray(release?.compatibility) || release.compatibility.length === 0) {
    errors.push(`${label}: compatibility must list at least one supported channel`);
  } else {
    if (release.compatibility.some((channel) => !allowedCategories.has(channel))) errors.push(`${label}: compatibility contains an unsupported channel`);
    if (!release.compatibility.includes(release.category)) errors.push(`${label}: compatibility must include the primary category`);
  }
  if (!allowedPermissions.has(release?.permission)) errors.push(`${label}: permission must be verifiable`);
  // An open licence like MIT requires its text to travel with the
  // distribution. Most archives carry it; where one does not, the catalog
  // carries `licenseText` and the app renders it, which satisfies the same
  // requirement. One or the other, never neither.
  if (release?.permission === "open-license"
      && release?.licenseIncluded !== true
      && !(typeof release?.licenseText === "string" && release.licenseText.trim())) {
    errors.push(`${label}: an open-license mod must either include its license in the archive or carry licenseText`);
  }
  if (release?.containsRom !== false) errors.push(`${label}: containsRom must be false`);
  if (!/^[a-f\d]{64}$/i.test(release?.sha256 ?? "")) errors.push(`${label}: sha256 must contain 64 hexadecimal characters`);
  if (!/^https:\/\//.test(release?.permissionEvidenceUrl ?? "")) errors.push(`${label}: permissionEvidenceUrl must use HTTPS`);
  if (!/^https:\/\//.test(release?.fileUrl ?? "")) errors.push(`${label}: fileUrl must use HTTPS`);
  if (!/^https:\/\//.test(release?.homepageUrl ?? "")) errors.push(`${label}: homepageUrl must use HTTPS`);

  const lowerName = (release?.fileName ?? "").toLowerCase();
  if (forbiddenExtensions.some((extension) => lowerName.endsWith(extension))) errors.push(`${label}: commercial ROM file types are forbidden`);
  if (!allowedExtensions.some((extension) => lowerName.endsWith(extension))) errors.push(`${label}: unsupported patch or mod archive type`);
  if (!Array.isArray(release?.images)) errors.push(`${label}: images must be an array (it may be empty)`);
  // `fileSize` is a display string ("6.3 KB"); the app needs exact bytes,
  // because it uses the value as a ceiling on the download.
  if (!Number.isInteger(release?.fileSizeBytes) || release.fileSizeBytes <= 0) {
    errors.push(`${label}: fileSizeBytes must be a positive integer`);
  }
  if (release?.topic && !allowedTopics.has(release.topic)) errors.push(`${label}: unsupported topic`);
  // Only an engine mod has one: it is the id inside the archive's own
  // manifest, which the app hands to its installer so a mod cannot land in
  // another mod's directory. A ROM patch has no such id.
  const isEngineMod = (release?.compatibility ?? []).some((channel) => channel !== "rom-hack");
  if (isEngineMod && (typeof release?.modId !== "string" || !release.modId.trim())) {
    errors.push(`${label}: modId is required for an engine mod`);
  }

  return errors;
}

export async function validateCatalog(path = new URL("../src/data/releases.json", import.meta.url)) {
  const releases = JSON.parse(await readFile(path, "utf8"));
  if (!Array.isArray(releases)) return ["Catalog root must be an array"];

  const errors = releases.flatMap(validateRelease);
  const ids = releases.map((release) => release.id).filter(Boolean);
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
  for (const id of new Set(duplicates)) errors.push(`${id}: duplicate id`);
  return errors;
}

export function validateDiscoveryProject(project, index) {
  const label = project?.id || `discovery record ${index + 1}`;
  const errors = [];
  for (const field of ["id", "title", "creator", "kind", "category", "target", "summary", "homepageUrl", "reviewStatus"]) {
    if (typeof project?.[field] !== "string" || !project[field].trim()) errors.push(`${label}: ${field} is required`);
  }
  if (!allowedCategories.has(project?.category)) errors.push(`${label}: unsupported category`);
  if (!Array.isArray(project?.compatibility) || project.compatibility.length === 0) {
    errors.push(`${label}: compatibility must list at least one supported channel`);
  } else if (project.compatibility.some((channel) => !allowedCategories.has(channel))) {
    errors.push(`${label}: compatibility contains an unsupported channel`);
  }
  if (project?.kind !== "rom-hack" && project?.kind !== "mod") errors.push(`${label}: unsupported project kind`);
  if (project?.kind === "rom-hack" && project?.category !== "rom-hack") errors.push(`${label}: ROM hacks must use the rom-hack category`);
  if (project?.kind === "mod" && project?.category === "rom-hack") errors.push(`${label}: recomp mods must use a recomp category`);
  if (!allowedReviewStatuses.has(project?.reviewStatus)) errors.push(`${label}: unsupported review status`);
  if (!/^https:\/\//.test(project?.homepageUrl ?? "")) errors.push(`${label}: homepageUrl must use HTTPS`);
  if (["fileUrl", "fileName", "sha256"].some((field) => field in (project ?? {}))) {
    errors.push(`${label}: pending projects must not expose downloadable file metadata`);
  }
  return errors;
}

export async function validateProjectIndex(
  projectPath = new URL("../src/data/projects.json", import.meta.url),
  releasePath = new URL("../src/data/releases.json", import.meta.url),
) {
  const projects = JSON.parse(await readFile(projectPath, "utf8"));
  const releases = JSON.parse(await readFile(releasePath, "utf8"));
  if (!Array.isArray(projects)) return ["Discovery index root must be an array"];

  const errors = projects.flatMap(validateDiscoveryProject);
  const ids = [...projects, ...(Array.isArray(releases) ? releases : [])].map((project) => project.id).filter(Boolean);
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
  for (const id of new Set(duplicates)) errors.push(`${id}: duplicate id across the project index`);

  const combined = [...projects, ...(Array.isArray(releases) ? releases.map((release) => ({ ...release, kind: release.category === "rom-hack" ? "rom-hack" : "mod" })) : [])];
  const romHacks = combined.filter((project) => project.kind === "rom-hack").length;
  const mods = combined.filter((project) => project.kind === "mod").length;
  const gen2Mods = combined.filter((project) => project.kind === "mod" && project.compatibility?.includes("gen2recomp")).length;
  if (romHacks < 10 || romHacks > 20) errors.push(`Project index must track 10–20 ROM hacks; found ${romHacks}`);
  if (mods < 30) errors.push(`Project index must track at least 30 recomp mods; found ${mods}`);
  if (gen2Mods < 3) errors.push(`Project index must track at least 3 Gen2Recomp-compatible mods; found ${gen2Mods}`);
  return errors;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const errors = [...await validateCatalog(), ...await validateProjectIndex()];
  if (errors.length) {
    console.error(errors.map((error) => `• ${error}`).join("\n"));
    process.exit(1);
  }
  console.log("Catalog policy check passed.");
}
