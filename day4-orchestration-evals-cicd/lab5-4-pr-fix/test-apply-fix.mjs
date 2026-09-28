// Lab 5.4 tests - apply-fix.mjs alone: the only thing that writes, so its
// staleness/authorization checks get their own suite (no model, no review-fix.mjs).
//
//     node --test test-apply-fix.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { applyFix, ApplyFixError } from "./apply-fix.mjs";

const GIT_ENV = {
  ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
};

function setup(fileContent) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "test-apply-fix-"));
  fs.mkdirSync(path.join(tmp, "svc"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "svc", "apply.py"), fileContent, "utf8");
  const run = (...a) => execFileSync("git", a, { cwd: tmp, env: GIT_ENV });
  run("init", "-q", "-b", "main");
  run("add", "-A");
  run("commit", "-qm", "base");
  return tmp;
}

function teardown(tmp) {
  fs.rmSync(tmp, { recursive: true, force: true });
}

const FIX = {
  file: "svc/apply.py", addresses: "Approval check replaced by status check",
  old_snippet: 'if store.run(rid)["status"] == "approved":\n        pass',
  new_snippet: 'if not a or a["decision"] != "approve":\n        raise GateError("no approval on record")',
  explanation: "Restores the approval-record check.",
};

test("an exact, unique match applies and commits", () => {
  const tmp = setup('    a = store.approval(rid)\n    if store.run(rid)["status"] == "approved":\n        pass\n');
  try {
    const before = execFileSync("git", ["rev-parse", "HEAD"], { cwd: tmp, encoding: "utf8" }).trim();
    const sha = applyFix(tmp, FIX, "reviewer1", "clear regression");
    assert.equal(sha, execFileSync("git", ["rev-parse", "HEAD"], { cwd: tmp, encoding: "utf8" }).trim());
    assert.notEqual(sha, before);
    const text = fs.readFileSync(path.join(tmp, "svc", "apply.py"), "utf8");
    assert.match(text, /raise GateError/);
    assert.doesNotMatch(text, /== "approved"/);
    const msg = execFileSync("git", ["log", "-1", "--format=%B"], { cwd: tmp, encoding: "utf8" });
    assert.match(msg, /Approved-by: reviewer1/);
    assert.match(msg, /Reason: clear regression/);
  } finally { teardown(tmp); }
});

test("a snippet with zero occurrences is refused, nothing is written", () => {
  const tmp = setup('    a = store.approval(rid)\n    if not a:\n        raise GateError("x")\n');
  try {
    const before = fs.readFileSync(path.join(tmp, "svc", "apply.py"), "utf8");
    const beforeSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: tmp, encoding: "utf8" }).trim();
    assert.throws(() => applyFix(tmp, FIX, "reviewer1", "clear regression"),
      (e) => e instanceof ApplyFixError && /occurs 0 time/.test(e.message));
    assert.equal(fs.readFileSync(path.join(tmp, "svc", "apply.py"), "utf8"), before, "file was modified");
    assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: tmp, encoding: "utf8" }).trim(), beforeSha,
      "a commit was made");
  } finally { teardown(tmp); }
});

test("a snippet with multiple occurrences is refused rather than guessing", () => {
  const dup = 'if store.run(rid)["status"] == "approved":\n        pass\n' +
    'if store.run(rid)["status"] == "approved":\n        pass\n';
  const tmp = setup(dup);
  try {
    const beforeSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: tmp, encoding: "utf8" }).trim();
    assert.throws(() => applyFix(tmp, FIX, "reviewer1", "clear regression"),
      (e) => e instanceof ApplyFixError && /occurs 2 time/.test(e.message));
    assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: tmp, encoding: "utf8" }).trim(), beforeSha);
  } finally { teardown(tmp); }
});

test("a missing approver refuses to apply", () => {
  const tmp = setup('if store.run(rid)["status"] == "approved":\n        pass\n');
  try {
    assert.throws(() => applyFix(tmp, FIX, "", "clear regression"),
      (e) => e instanceof ApplyFixError && /approver and reason/.test(e.message));
    assert.throws(() => applyFix(tmp, FIX, "   ", "clear regression"),
      (e) => e instanceof ApplyFixError && /approver and reason/.test(e.message));
  } finally { teardown(tmp); }
});

test("a missing reason refuses to apply", () => {
  const tmp = setup('if store.run(rid)["status"] == "approved":\n        pass\n');
  try {
    assert.throws(() => applyFix(tmp, FIX, "reviewer1", ""),
      (e) => e instanceof ApplyFixError && /approver and reason/.test(e.message));
    assert.throws(() => applyFix(tmp, FIX, "reviewer1", null),
      (e) => e instanceof ApplyFixError && /approver and reason/.test(e.message));
  } finally { teardown(tmp); }
});

test("a moved or deleted file is refused, not crashed on", () => {
  const tmp = setup('if store.run(rid)["status"] == "approved":\n        pass\n');
  try {
    fs.rmSync(path.join(tmp, "svc", "apply.py"));
    assert.throws(() => applyFix(tmp, FIX, "reviewer1", "clear regression"),
      (e) => e instanceof ApplyFixError && /could not read/.test(e.message));
  } finally { teardown(tmp); }
});