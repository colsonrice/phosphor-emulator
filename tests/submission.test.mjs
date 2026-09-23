import test from "node:test";
import assert from "node:assert/strict";
import { parseIssueForm } from "../scripts/approve-submission.mjs";

test("issue-form markdown is parsed into review fields", () => {
  const fields = parseIssueForm(`### Project title

Example Mod

### Version

1.2.3

### Optional image provenance

_No response_`);

  assert.equal(fields["Project title"], "Example Mod");
  assert.equal(fields.Version, "1.2.3");
  assert.equal(fields["Optional image provenance"], "");
});

// The one real submission this repository has ever received, and the two
// reasons it was never answered.
//
// campavao filed #1 on 27 Aug 2026 with everything right: MIT, a SHA-256, no
// ROM, a release URL. They did not use the issue template -- they copied its
// field names by hand into a plain issue -- so the body is `Label: value` on
// one line instead of GitHub's `### Label` heading and blank line, and the
// title is the mod's name rather than "[Release] ...".
//
// The workflow gated on that title prefix and skipped, twice, including on
// their follow-up comment asking what else was needed. And had it fired, this
// parser would have found no fields and thrown. Two independent failures, both
// of them the form working for machines and not for the person filling it in.
test("a submission written by hand, one field per line, parses", () => {
  const body = [
    "# Phosphor Index submission",
    "",
    "Project title: Kanto Battle Royale",
    "Creator / team: @campavao",
    "Version: v0.35.0",
    "Release date (YYYY-MM-DD): 2026-08-27",
    "Summary: Battle across Kanto in a battle royale! Offline mode supported.",
    "Project homepage: https://github.com/campavao/kanto-battle-royale",
    "Permission type: open license",
    "License / approval name: MIT",
    "Contains a commercial ROM: no",
  ].join("\n");

  const fields = parseIssueForm(body);
  assert.equal(fields["Project title"], "Kanto Battle Royale");
  assert.equal(fields["Version"], "v0.35.0");
  // Stored under the CANONICAL name, which is what approve-submission reads:
  // "License / approval name" and "Project homepage" are what the person
  // wrote, not what the rest of the file asks for.
  assert.equal(fields["License or approval name"], "MIT");
  assert.equal(fields["Contains a commercial ROM"], "no");
  // A colon inside the value must survive: a URL is mostly colons.
  assert.equal(fields["Canonical project page"], "https://github.com/campavao/kanto-battle-royale");
});

test("the template's own heading format still parses, and wins on a conflict", () => {
  const body = [
    "### Project title",
    "",
    "Heading Wins",
    "",
    "### Version",
    "",
    "1.0.0",
  ].join("\n");
  const fields = parseIssueForm(body);
  assert.equal(fields["Project title"], "Heading Wins");
  assert.equal(fields["Version"], "1.0.0");
});

test("prose is not a field, so an ordinary issue parses to nothing", () => {
  // The guard that keeps the looser format from turning every bug report into
  // a submission: a line is a field only if its label is one this form asks
  // for. "Steps to reproduce: it crashes" is not a submission.
  const fields = parseIssueForm([
    "Hi! The app crashes when I do this:",
    "Steps: open the workshop",
    "Expected: no crash",
  ].join("\n"));
  assert.deepEqual(fields, {});
});
