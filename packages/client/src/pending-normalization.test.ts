import assert from "node:assert/strict";
import test from "node:test";
import { normalizeApprovalInput } from "./pending-normalization.js";

test("extracts command and description from a native approval payload", () => {
  assert.deepEqual(normalizeApprovalInput({ command: "open https://example.com", description: "Open Example.com?" }), {
    summary: '{"command":"open https://example.com","description":"Open Example.com?"}',
    command: "open https://example.com",
    description: "Open Example.com?",
  });
});

test("supports Codex cmd and command arrays without inventing a description", () => {
  assert.equal(normalizeApprovalInput({ cmd: "npm test" }).command, "npm test");
  assert.equal(normalizeApprovalInput({ command: ["git", "status"] }).command, "git status");
  assert.equal(normalizeApprovalInput("Already readable").summary, "Already readable");
});
