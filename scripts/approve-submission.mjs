import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const catalogPath = new URL("../src/data/releases.json", import.meta.url);
const maxArchiveBytes = 50 * 1024 * 1024;
const forbiddenExtensions = [".gb", ".gbc", ".gba", ".nds", ".3ds", ".cia"];

/// The fields this form asks for, and the names a person actually types.
///
/// **Why aliases exist at all.** The only public submission this repository
/// has ever received, #1 on 27 Aug 2026, was written BY HAND: the creator
/// copied the shape of the form into a plain issue rather than opening the
/// template, one `Label: value` per line, with their own wording -- "Creator /
/// team" for "Creator or team", "Summary" for "Release summary", "Project
/// homepage" for "Canonical project page". Every value was right. It parsed to
/// nothing, and nobody was told.
///
/// A parser that only accepts the exact labels of the exact template is a
/// parser that works for the people who did not need help. The canonical name
/// on the left is what the rest of this file asks for; everything on the right
/// is a spelling somebody plausibly types for it.
const FIELD_ALIASES = {
  "Project title": ["project", "title", "mod name", "name"],
  "Version": ["release version"],
  "Creator or team": ["creator", "creator / team", "creator/team", "author", "team", "by"],
  "Primary category": ["category"],
  "Compatible catalog channels": ["compatible channels", "channels", "compatibility"],
  "Target game or recomp runtime": ["target game / recomp", "target game", "target", "recomp", "runtime"],
  "Release summary": ["summary", "description"],
  "Release date": ["release date (yyyy-mm-dd)", "date"],
  "Canonical project page": ["project homepage", "homepage", "project page", "project url", "repository"],
  "Exact release-file URL": ["release file url", "release-file url", "file url", "download url", "release url"],
  "Public redistribution-permission URL": [
    "public redistribution permission url", "permission url", "redistribution permission url",
    "permission evidence url",
  ],
  "Permission type": ["permission"],
  "License or approval name": ["license / approval name", "license/approval name", "license", "licence", "approval name"],
  "SHA-256": ["sha256", "sha-256 of the release file", "checksum"],
  "Contains a commercial ROM": ["contains a rom", "contains rom", "includes a rom"],
  "Optional image source and permission URL": ["image source", "image url", "optional image source"],
  "Notes": ["note", "anything else"],
};

/// Lowercased, stripped to letters and digits, so punctuation and spacing
/// stop mattering: "Creator / team", "creator/team" and "Creator Or Team" are
/// one key. Deliberately NOT fuzzy beyond that -- an unrecognised label is
/// ignored rather than guessed at, which is what keeps an ordinary bug report
/// ("Steps: open the workshop") from parsing as a submission.
const normalise = (label) => label.toLowerCase().replace(/[^a-z0-9]+/g, "");

const CANONICAL_BY_KEY = (() => {
  const byKey = {};
  for (const [canonical, aliases] of Object.entries(FIELD_ALIASES)) {
    byKey[normalise(canonical)] = canonical;
    for (const alias of aliases) byKey[normalise(alias)] = canonical;
  }
  return byKey;
})();

export function parseIssueForm(body) {
  const fields = {};
  // `known` is the difference between the two shapes, and it is the whole
  // safety of the looser one. A `### Label` heading is unambiguously a field,
  // so it is kept whatever it is called -- the template can grow a question
  // without this file hearing about it. A `Label: value` line is ambiguous
  // prose, so it counts only when the label is one this form actually asks
  // for; otherwise "Steps: open the workshop" in a bug report is a
  // submission.
  const set = (label, raw, { known }) => {
    const canonical = CANONICAL_BY_KEY[normalise(label)] ?? (known ? null : label.trim());
    if (!canonical) return;
    const value = raw.trim();
    // First writing wins, so the template's headings beat a stray line further
    // down that happens to normalise to the same field.
    if (fields[canonical] !== undefined) return;
    fields[canonical] = value === "_No response_" ? "" : value;
  };

  // The template's shape first: `### Label`, a blank line, then the value.
  const headingPattern = /^### (.+)\n\n([\s\S]*?)(?=\n\n### |$)/gm;
  for (const match of body.matchAll(headingPattern)) set(match[1], match[2], { known: false });

  // Then one field per line, which is what a person writes unaided. The value
  // keeps every colon after the first, because a URL is mostly colons.
  for (const line of body.split("\n")) {
    const at = line.indexOf(":");
    if (at <= 0) continue;
    set(line.slice(0, at).replace(/^[-*#\s]+/, ""), line.slice(at + 1), { known: true });
  }
  return fields;
}

function requireField(fields, label) {
  const value = fields[label]?.trim();
  if (!value) throw new Error(`Submission is missing “${label}”.`);
  return value;
}

function httpsUrl(value, label) {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error(`${label} must use HTTPS.`);
  return url.toString();
}

function slugify(value) {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 70);
}

function categoryFrom(value) {
  if (value.includes("ROM-hack")) return "rom-hack";
  if (value.includes("Gen 1")) return "gen1recomp";
  if (value.includes("Gen 2")) return "gen2recomp";
  throw new Error("Submission category is not supported.");
}

function compatibilityFrom(value, primary) {
  const compatibility = [];
  if (/ROM.?hack/i.test(value)) compatibility.push("rom-hack");
  if (/Gen 1/i.test(value)) compatibility.push("gen1recomp");
  if (/Gen 2/i.test(value)) compatibility.push("gen2recomp");
  if (!compatibility.includes(primary)) compatibility.push(primary);
  return compatibility;
}

function humanFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function downloadArchive(fileUrl, expectedSha256) {
  const response = await fetch(fileUrl, { redirect: "follow" });
  if (!response.ok) throw new Error(`Release file returned HTTP ${response.status}.`);
  const announcedSize = Number(response.headers.get("content-length") || 0);
  if (announcedSize > maxArchiveBytes) throw new Error("Release file exceeds the 50 MB review limit.");

  if (!response.body) throw new Error("Release file returned an empty response body.");
  const reader = response.body.getReader();
  const chunks = [];
  let receivedBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    receivedBytes += value.byteLength;
    if (receivedBytes > maxArchiveBytes) {
      await reader.cancel();
      throw new Error("Release file exceeds the 50 MB review limit.");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(receivedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const actualSha256 = createHash("sha256").update(bytes).digest("hex");
  if (actualSha256 !== expectedSha256.toLowerCase()) {
    throw new Error(`SHA-256 mismatch. Expected ${expectedSha256}; downloaded ${actualSha256}.`);
  }
  return { bytes, actualSha256 };
}

async function inspectZip(bytes, fileName, requireLicense) {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "phosphor-review-"));
  const archivePath = join(temporaryDirectory, basename(fileName));
  try {
    await writeFile(archivePath, bytes);
    const names = execFileSync("unzip", ["-Z1", archivePath], {
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    }).split(/\r?\n/).filter(Boolean);
    const forbidden = names.find((name) => forbiddenExtensions.some((extension) => name.toLowerCase().endsWith(extension)));
    if (forbidden) throw new Error(`Archive contains forbidden ROM-like file: ${forbidden}`);
    if (requireLicense && !names.some((name) => /(^|[\\/])(license|copying)(\.[^\\/]*)?$/i.test(name))) {
      throw new Error("Open-license archive does not include a LICENSE or COPYING file.");
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export async function approveSubmission(body, issueUrl = "") {
  const fields = parseIssueForm(body);
  const title = requireField(fields, "Project title");
  const version = requireField(fields, "Version");
  const creator = requireField(fields, "Creator or team");
  const category = categoryFrom(requireField(fields, "Primary category"));
  const compatibility = compatibilityFrom(requireField(fields, "Compatible catalog channels"), category);
  const target = requireField(fields, "Target game or recomp runtime");
  const summary = requireField(fields, "Release summary");
  const releaseDate = requireField(fields, "Release date");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(releaseDate)) throw new Error("Release date must use YYYY-MM-DD.");

  const homepageUrl = httpsUrl(requireField(fields, "Canonical project page"), "Canonical project page");
  const fileUrl = httpsUrl(requireField(fields, "Exact release-file URL"), "Release-file URL");
  const permissionEvidenceUrl = httpsUrl(requireField(fields, "Public redistribution-permission URL"), "Permission URL");
  const permissionChoice = requireField(fields, "Permission type");
  const permission = permissionChoice.includes("Open license") ? "open-license" : "author-approved";
  const license = requireField(fields, "License or approval name");
  const submittedSha256 = requireField(fields, "SHA-256").toLowerCase();
  if (!/^[a-f\d]{64}$/.test(submittedSha256)) throw new Error("SHA-256 must contain 64 hexadecimal characters.");

  const fileName = decodeURIComponent(new URL(fileUrl).pathname.split("/").pop() || "");
  if (!fileName.toLowerCase().endsWith(".zip")) throw new Error("Automated approval currently accepts ZIP mod archives only.");
  const { bytes, actualSha256 } = await downloadArchive(fileUrl, submittedSha256);
  await inspectZip(bytes, fileName, permission === "open-license");

  const releases = JSON.parse(await readFile(catalogPath, "utf8"));
  const id = slugify(title);
  if (!id) throw new Error("Project title cannot produce a valid catalog ID.");
  if (releases.some((release) => release.id === id)) throw new Error(`Catalog ID “${id}” already exists; update it manually instead.`);
  if (releases.some((release) => release.fileUrl === fileUrl)) throw new Error("This exact release file is already cataloged.");

  releases.push({
    id,
    title,
    creator,
    version,
    releaseDate,
    category,
    compatibility,
    target,
    summary,
    fileUrl,
    fileName,
    fileSize: humanFileSize(bytes.byteLength),
    sha256: actualSha256,
    homepageUrl,
    permission,
    license,
    licenseIncluded: permission === "open-license",
    permissionEvidenceUrl,
    containsRom: false,
    images: [],
    reviewSourceUrl: issueUrl,
  });
  releases.sort((a, b) => b.releaseDate.localeCompare(a.releaseDate) || a.title.localeCompare(b.title));
  await writeFile(catalogPath, `${JSON.stringify(releases, null, 2)}\n`);
  return releases.find((release) => release.id === id);
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const body = process.env.ISSUE_BODY;
  if (!body) throw new Error("ISSUE_BODY is required.");
  const approved = await approveSubmission(body, process.env.ISSUE_URL || "");
  console.log(`Approved ${approved.title} ${approved.version}.`);
}
