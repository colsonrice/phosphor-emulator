import test from "node:test";
import assert from "node:assert/strict";
import { validateCatalog, validateProjectIndex, validateRelease } from "../scripts/validate-catalog.mjs";

const validRelease = {
  id: "sample-patch",
  title: "Sample Patch",
  creator: "Sample Creator",
  version: "1.0.0",
  releaseDate: "2026-08-15",
  category: "rom-hack",
  compatibility: ["rom-hack"],
  target: "Example target",
  summary: "A policy-test fixture that never appears in the public catalog.",
  fileUrl: "https://example.com/sample.bps",
  fileName: "sample.bps",
  fileSize: "1 KB",
  sha256: "a".repeat(64),
  homepageUrl: "https://example.com/project",
  permission: "author-approved",
  license: "MIT",
  licenseIncluded: true,
  permissionEvidenceUrl: "https://example.com/permission",
  containsRom: false,
  images: [],
  fileSizeBytes: 1024,
  topic: "GAMEPLAY",
};

test("the checked-in catalog satisfies policy", async () => {
  assert.deepEqual(await validateCatalog(), []);
  assert.deepEqual(await validateProjectIndex(), []);
});

test("a complete patch record passes", () => {
  assert.deepEqual(validateRelease(validRelease, 0), []);
});

test("ROM images and missing permission are rejected", () => {
  const errors = validateRelease({ ...validRelease, fileName: "game.gbc", permissionEvidenceUrl: "" }, 0);
  assert.ok(errors.some((error) => error.includes("commercial ROM")));
  assert.ok(errors.some((error) => error.includes("permissionEvidenceUrl")));
});
