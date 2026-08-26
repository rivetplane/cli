import assert from "node:assert/strict";
import test from "node:test";
import { redactLogValue, sanitizeLaunchCommand } from "./launch-command.js";

test("sanitizes launch commands and removes session selectors, prompts, credentials, and unsafe modes", () => {
  assert.deepEqual(sanitizeLaunchCommand(["claude", "--model", "sonnet", "--permission-mode=plan", "--resume", "session-1", "fix secret bug", "API_KEY=value", "--dangerously-skip-permissions", "--cwd", "/repo"]), ["claude", "--model", "sonnet", "--permission-mode=plan", "--cwd", "/repo"]);
});

test("redacts structured secrets from logs", () => {
  const value = redactLogValue({ authorization: "Bearer abc123", api_key: "sk-test", safe: "yes" });
  assert.equal(value.includes("abc123"), false); assert.equal(value.includes("sk-test"), false); assert.equal(value.includes("yes"), true);
});
