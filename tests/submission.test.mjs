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
