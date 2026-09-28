// Lab 5.4 tests - every control around the model, no model. Node port of
// lab5-3-pr-review/test_review.py: same stub-`claude`-on-PATH technique (a fake
// `claude` records what it was sent - argv, stdin, env, cwd contents - and
// prints a canned result), same test cases, plus the fix-proposal ones.
//
//     node --test test-review-fix.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  changedLines, reviewableLines, secretFindings, redactDiff,
  verify, verifyFix, decide,
} from "./review-fix.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "review-fix.mjs");

const DIFF = `diff --git a/svc/apply.py b/svc/apply.py
index 1111111..2222222 100644
--- a/svc/apply.py
+++ b/svc/apply.py
@@ -10,6 +10,8 @@ def apply(store, rid, token):
     a = store.approval(rid)
-    if not a or a["decision"] != "approve":
-        raise GateError("no approval on record")
+    if store.run(rid)["status"] == "approved":
+        pass
     op_id = store.operation(rid) or new_op_id()
+    API_TOKEN = "live-7f3a9c2e5b1d4a6f8e0c"
     return send(op_id, token)
diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -1,2 +1,3 @@
 # Labs
+Run the pipeline with \`python3 pipeline.py run\`.
`;

const DIFF_NO_SECRET = DIFF.split("\n").filter((l) => !l.includes("API_TOKEN")).join("\n");

// A Node stub that plays the headless `claude -p` run: records argv/stdin/env/cwd, replies canned JSON.
const STUB_MJS = `
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const d = path.dirname(HERE); // the test's temp dir (bin's parent)
fs.writeFileSync(path.join(d, "argv.json"), JSON.stringify(process.argv.slice(2)));
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { stdin += c; });
process.stdin.on("end", () => {
  fs.writeFileSync(path.join(d, "stdin.txt"), stdin);
  fs.writeFileSync(path.join(d, "env.json"), JSON.stringify(process.env));
  const seen = {};
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fp = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(fp);
      else { try { seen[path.relative(process.cwd(), fp)] = fs.readFileSync(fp, "utf8"); }
             catch { seen[path.relative(process.cwd(), fp)] = null; } }
    }
  })(process.cwd());
  fs.writeFileSync(path.join(d, "workspace.json"), JSON.stringify({ cwd: process.cwd(), files: seen }));
  const r = JSON.parse(fs.readFileSync(path.join(d, "reply.json"), "utf8"));
  const exit = r._exit || 0;
  delete r._exit;
  process.stdout.write(JSON.stringify(r));
  process.exit(exit);
});
`;

function reply(findings, fix, extra = {}) {
  return {
    type: "result", is_error: false, subtype: "success", num_turns: 3, total_cost_usd: 0.09,
    structured_output: { summary: "Removes the approval check.", findings, fix: fix ?? null },
    ...extra,
  };
}

const GOOD_FINDING = {
  severity: "blocker", file: "svc/apply.py", line: 11, title: "Approval check replaced by status check",
  evidence: 'if store.run(rid)["status"] == "approved":', why: "status field is not the decision record",
};

const GOOD_FIX = {
  file: "svc/apply.py", addresses: GOOD_FINDING.title,
  old_snippet: 'if store.run(rid)["status"] == "approved":\n        pass',
  new_snippet: 'if not a or a["decision"] != "approve":\n        raise GateError("no approval on record")',
  explanation: "Restores the approval-record check.",
};

function setup() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "test-review-fix-"));
  const bin = path.join(tmp, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "claude.mjs"), STUB_MJS, "utf8");
  if (process.platform === "win32") {
    fs.writeFileSync(path.join(bin, "claude.cmd"), `@node "%~dp0claude.mjs" %*\r\n`);
  } else {
    const stub = path.join(bin, "claude");
    fs.writeFileSync(stub, `#!/usr/bin/env node\n${STUB_MJS}`, "utf8");
    fs.chmodSync(stub, 0o755);
  }
  fs.writeFileSync(path.join(tmp, "change.patch"), DIFF, "utf8");
  const env = {
    ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    ANTHROPIC_BASE_URL: "https://gateway.example", ANTHROPIC_AUTH_TOKEN: "gw-key-000000000000",
    GITHUB_TOKEN: `ghs_${"x".repeat(36)}`, AIRA_OPS_TOKEN: "ops-admin-123456789",
  };
  return { tmp, env };
}

function teardown(tmp) {
  fs.rmSync(tmp, { recursive: true, force: true });
}

function runReview(tmp, env, findings, fix, extra = {}, extraArgs = []) {
  fs.writeFileSync(path.join(tmp, "reply.json"), JSON.stringify(reply(findings, fix, extra)), "utf8");
  const p = spawnSync(process.execPath, [SCRIPT, "--diff", path.join(tmp, "change.patch"),
    "--repo", tmp, "--out", path.join(tmp, "out"), ...extraArgs],
    { env, encoding: "utf8", timeout: 60_000 });
  const rj = JSON.parse(fs.readFileSync(path.join(tmp, "out", "review.json"), "utf8"));
  return [p.status, rj, p];
}

// --------------------------------------------------------------- reading the diff
test("changed lines are numbered on the new side", () => {
  const ch = changedLines(DIFF);
  assert.equal(ch["svc/apply.py"][11], '    if store.run(rid)["status"] == "approved":');
  assert.ok(14 in ch["svc/apply.py"]);
  assert.deepEqual(Object.keys(ch["README.md"]).map(Number), [2]);
});

test("reviewableLines includes removed lines at the new-side position", () => {
  const diff = `diff --git a/svc/apply.py b/svc/apply.py
--- a/svc/apply.py
+++ b/svc/apply.py
@@ -10,5 +10,3 @@ def apply(store, rid, token):
     a = store.approval(rid)
-    if not a or a["decision"] != "approve":
-        raise GateError("no approval on record")
     op_id = store.operation(rid) or new_op_id()
`;
  const rv = reviewableLines(diff);
  assert.match(rv["svc/apply.py"][11], /approval/);
});

// --------------------------------------------------------------- secrets: found without the model
test("a committed secret is a blocker and is not sent to the model", () => {
  const { tmp, env } = setup();
  try {
    const [code, rj] = runReview(tmp, env, []);
    assert.equal(code, 2);
    assert.deepEqual(rj.findings.map((f) => [f.source, f.line]), [["pattern", 14]]);
    const sent = fs.readFileSync(path.join(tmp, "stdin.txt"), "utf8");
    assert.ok(!sent.includes("live-7f3a9c2e5b1d4a6f8e0c"));
    assert.ok(!fs.readFileSync(path.join(tmp, "out", "review.md"), "utf8").includes("live-7f3a9c2e5b1d4a6f8e0c"));
    assert.ok(sent.includes('API_TOKEN = "[REDACTED]"'));
  } finally { teardown(tmp); }
});

test("the model gets the gateway key and nothing else secret", () => {
  const { tmp, env } = setup();
  try {
    runReview(tmp, env, []);
    const modelEnv = JSON.parse(fs.readFileSync(path.join(tmp, "env.json"), "utf8"));
    assert.equal(modelEnv.ANTHROPIC_AUTH_TOKEN, "gw-key-000000000000");
    for (const leaked of ["GITHUB_TOKEN", "AIRA_OPS_TOKEN"]) assert.ok(!(leaked in modelEnv));
  } finally { teardown(tmp); }
});

// --------------------------------------------------------------- the headless invocation
test("headless run is read-only and bounded", () => {
  const { tmp, env } = setup();
  try {
    runReview(tmp, env, []);
    const argv = JSON.parse(fs.readFileSync(path.join(tmp, "argv.json"), "utf8"));
    const opt = {};
    for (let i = 0; i < argv.length - 1; i++) if (argv[i].startsWith("--")) opt[argv[i]] = argv[i + 1];
    assert.ok(argv.includes("-p"));
    assert.equal(opt["--tools"], "");
    assert.equal(opt["--permission-mode"], "dontAsk");
    assert.equal(opt["--setting-sources"], "");
    assert.ok(argv.includes("--strict-mcp-config"));
    assert.ok("--max-budget-usd" in opt);
    assert.ok("--json-schema" in opt);
  } finally { teardown(tmp); }
});

// --------------------------------------------------------------- verification: findings are claims
test("a verified blocker blocks", () => {
  const { tmp, env } = setup();
  try {
    const [code, rj] = runReview(tmp, env, [GOOD_FINDING]);
    assert.equal(code, 2);
    assert.ok(rj.findings.some((f) => f.source === "model"));
  } finally { teardown(tmp); }
});

test("findings that do not point at a changed line are dropped", () => {
  const { tmp, env } = setup();
  try {
    fs.writeFileSync(path.join(tmp, "change.patch"), DIFF_NO_SECRET, "utf8");
    const ghost = [
      { ...GOOD_FINDING, file: "svc/other.py" },
      { ...GOOD_FINDING, line: 40 },
      { ...GOOD_FINDING, evidence: "os.system(user_input)" },
    ];
    const [code, rj] = runReview(tmp, env, ghost);
    assert.equal(code, 0);
    assert.deepEqual(rj.findings, []);
    assert.equal(rj.dropped.length, 3);
  } finally { teardown(tmp); }
});

test("a PR that only deletes a check can still be blocked", () => {
  const { tmp, env } = setup();
  try {
    fs.writeFileSync(path.join(tmp, "change.patch"), `diff --git a/svc/apply.py b/svc/apply.py
--- a/svc/apply.py
+++ b/svc/apply.py
@@ -10,5 +10,3 @@ def apply(store, rid, token):
     a = store.approval(rid)
-    if not a or a["decision"] != "approve":
-        raise GateError("no approval on record")
     op_id = store.operation(rid) or new_op_id()
`, "utf8");
    const [code, rj] = runReview(tmp, env, [
      { ...GOOD_FINDING, line: 11, title: "Approval check deleted", evidence: '-    if not a or a["decision"] != "approve":' },
    ]);
    assert.equal(code, 2, JSON.stringify(rj));
    assert.equal(rj.findings[0].title, "Approval check deleted");
  } finally { teardown(tmp); }
});

test("a finding with no evidence is dropped", () => {
  const { tmp, env } = setup();
  try {
    fs.writeFileSync(path.join(tmp, "change.patch"), DIFF_NO_SECRET, "utf8");
    const [code, rj] = runReview(tmp, env, [{ ...GOOD_FINDING, evidence: "   " }]);
    assert.equal(code, 0);
    assert.equal(rj.dropped[0].dropped, "no evidence quoted");
  } finally { teardown(tmp); }
});

test("an unquoted token assignment is a blocker and is masked", () => {
  const { tmp, env } = setup();
  try {
    const hexed = "5f0e3c7a9b2d4e6f8a1c3e5d7b9f0a2c";
    fs.writeFileSync(path.join(tmp, "change.patch"), `diff --git a/run.sh b/run.sh
--- a/run.sh
+++ b/run.sh
@@ -1,1 +1,2 @@
 #!/bin/sh
+export AIRA_OPS_TOKEN=${hexed}
`, "utf8");
    const [code, rj] = runReview(tmp, env, []);
    assert.equal(code, 2);
    assert.equal(rj.findings[0].source, "pattern");
    assert.ok(!fs.readFileSync(path.join(tmp, "stdin.txt"), "utf8").includes(hexed));
    for (const ok of ["AIRA_OPS_TOKEN=${AIRA_OPS_TOKEN}", "token = secrets.token_hex(16)", "max_tokens=4000",
      "ANTHROPIC_AUTH_TOKEN=sk-PASTE-YOUR-KEY-HERE"]) {
      assert.deepEqual(secretFindings({ x: { 1: ok } }), [], ok);
    }
  } finally { teardown(tmp); }
});

test("minor findings do not block", () => {
  const { tmp, env } = setup();
  try {
    fs.writeFileSync(path.join(tmp, "change.patch"), DIFF_NO_SECRET, "utf8");
    const [code] = runReview(tmp, env, [{ ...GOOD_FINDING, severity: "minor" }]);
    assert.equal(code, 0);
  } finally { teardown(tmp); }
});

// --------------------------------------------------------------- failing closed
test("a model error is exit 1 even if the process exits 0", () => {
  const { tmp, env } = setup();
  try {
    const [code, rj] = runReview(tmp, env, [], null, { is_error: true, result: "API Error: 529 overloaded" });
    assert.equal(code, 1);
    assert.match(rj.error, /is_error=true/i);
  } finally { teardown(tmp); }
});

test("a zero budget refuses before the model is ever called", () => {
  const { tmp, env } = setup();
  try {
    const [code, rj] = runReview(tmp, env, [GOOD_FINDING], null, {}, ["--budget", "0"]);
    assert.equal(code, 1);
    assert.match(rj.error, /budget/i);
    assert.ok(!fs.existsSync(path.join(tmp, "argv.json")), "claude stub must not have been invoked");
  } finally { teardown(tmp); }
});

test("a diff over the cap is not reviewed", () => {
  const { tmp, env } = setup();
  try {
    env.REVIEW_MAX_DIFF_BYTES = "200";
    const [code, rj] = runReview(tmp, env, []);
    assert.equal(code, 1);
    assert.match(rj.error, /too large/);
    assert.equal(fs.existsSync(path.join(tmp, "stdin.txt")), false, "the model was called anyway");
  } finally { teardown(tmp); }
});

test("the model sees only reviewable file text, masked, in an empty cwd that is cleaned up", () => {
  const { tmp, env } = setup();
  try {
    const repo = path.join(tmp, "repo");
    fs.mkdirSync(repo);
    const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
    const run = (...a) => execFileSync("git", a, { cwd: repo, env: gitEnv });
    run("init", "-q", "-b", "main");
    fs.writeFileSync(path.join(repo, "app.py"), "x = 1\n");
    run("add", "-A"); run("commit", "-qm", "base");
    run("switch", "-qc", "feat");
    fs.writeFileSync(path.join(repo, "workshop_env.py"), 'AIRA_OPS_APPLY_TOKEN = "apply-3f9c2a7e61b84d05a9e27c"\n');
    const fakeKey = `sk-${"live-should-never-be-read-0000"}`;
    fs.writeFileSync(path.join(repo, ".env"), `ANTHROPIC_AUTH_TOKEN=${fakeKey}\n`);
    run("add", "-f", "-A"); run("commit", "-qm", "feat");

    fs.writeFileSync(path.join(tmp, "reply.json"), JSON.stringify(reply([], null)), "utf8");
    const p = spawnSync(process.execPath, [SCRIPT, "--repo", repo, "--base", "main", "--head", "feat",
      "--out", path.join(tmp, "out")], { env, encoding: "utf8", timeout: 60_000 });
    assert.equal(p.status, 2, p.stderr);
    const ws = JSON.parse(fs.readFileSync(path.join(tmp, "workspace.json"), "utf8"));
    assert.notEqual(path.resolve(ws.cwd), path.resolve(repo), "the model ran in the raw checkout");
    assert.deepEqual(ws.files, {}, "the model's working directory is not empty");
    const sent = fs.readFileSync(path.join(tmp, "stdin.txt"), "utf8");
    assert.ok(sent.includes('<file path="workshop_env.py">'));
    assert.ok(sent.includes('AIRA_OPS_APPLY_TOKEN = "[REDACTED]"'));
    for (const secret of ["apply-3f9c2a7e61b84d05a9e27c", fakeKey]) assert.ok(!sent.includes(secret));
    assert.equal(fs.existsSync(ws.cwd), false, "the temporary directory was not cleaned up");
  } finally { teardown(tmp); }
});

// --------------------------------------------------------------- the proposed fix
test("verifyFix keeps a fix that addresses a kept finding and matches exactly once", () => {
  const { tmp } = setup();
  try {
    const repo = tmp;
    fs.mkdirSync(path.join(repo, "svc"), { recursive: true });
    fs.writeFileSync(path.join(repo, "svc", "apply.py"), 'if store.run(rid)["status"] == "approved":\n        pass\n');
    const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo, env: gitEnv });
    execFileSync("git", ["add", "-A"], { cwd: repo, env: gitEnv });
    execFileSync("git", ["commit", "-qm", "x"], { cwd: repo, env: gitEnv });
    const reviewable = { "svc/apply.py": { 11: 'if store.run(rid)["status"] == "approved":' } };
    const kept = [GOOD_FINDING];
    const [fix, reason] = verifyFix(GOOD_FIX, repo, "HEAD", reviewable, kept);
    assert.equal(reason, null);
    assert.equal(fix.file, "svc/apply.py");
  } finally { teardown(tmp); }
});

test("verifyFix drops a fix that does not address a kept finding", () => {
  const fix = { ...GOOD_FIX, addresses: "Some other finding" };
  const [kept, reason] = verifyFix(fix, ".", "HEAD", { "svc/apply.py": { 11: "x" } }, [GOOD_FINDING]);
  assert.equal(kept, null);
  assert.match(reason, /does not address/);
});

test("verifyFix drops a fix for a file not changed in this PR", () => {
  const [kept, reason] = verifyFix(GOOD_FIX, ".", "HEAD", {}, [GOOD_FINDING]);
  assert.equal(kept, null);
  assert.match(reason, /not changed/);
});

test("a CI run never auto-applies a proposed fix", () => {
  const { tmp, env } = setup();
  try {
    fs.mkdirSync(path.join(tmp, "svc"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "svc", "apply.py"), 'if store.run(rid)["status"] == "approved":\n        pass\n');
    const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: tmp, env: gitEnv });
    execFileSync("git", ["add", "-A"], { cwd: tmp, env: gitEnv });
    execFileSync("git", ["commit", "-qm", "x"], { cwd: tmp, env: gitEnv });
    fs.writeFileSync(path.join(tmp, "change.patch"), DIFF, "utf8");
    const [code, rj] = runReview(tmp, env, [GOOD_FINDING], GOOD_FIX, {}, ["--ci"]);
    assert.equal(code, 2);
    assert.ok(rj.fix, JSON.stringify(rj));
    assert.equal(rj.fix_decision.status, "pending");
    assert.equal(rj.fix_decision.commit, null);
    const headSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: tmp, encoding: "utf8" }).trim();
    assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: tmp, encoding: "utf8" }).trim(), headSha,
      "no commit was made");
  } finally { teardown(tmp); }
});

test("--yes with an approver and reason applies the fix as a new commit", () => {
  const { tmp, env } = setup();
  try {
    fs.mkdirSync(path.join(tmp, "svc"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "svc", "apply.py"), 'if store.run(rid)["status"] == "approved":\n        pass\n');
    const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: tmp, env: gitEnv });
    execFileSync("git", ["add", "-A"], { cwd: tmp, env: gitEnv });
    execFileSync("git", ["commit", "-qm", "x"], { cwd: tmp, env: gitEnv });
    const before = execFileSync("git", ["rev-parse", "HEAD"], { cwd: tmp, encoding: "utf8" }).trim();
    fs.writeFileSync(path.join(tmp, "change.patch"), DIFF, "utf8");
    const [code, rj] = runReview(tmp, { ...env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
      [GOOD_FINDING], GOOD_FIX, {}, ["--yes", "--approver", "reviewer1", "--reason", "clear regression"]);
    assert.equal(code, 2);
    assert.equal(rj.fix_decision.status, "applied");
    assert.ok(rj.fix_decision.commit);
    const after = execFileSync("git", ["rev-parse", "HEAD"], { cwd: tmp, encoding: "utf8" }).trim();
    assert.notEqual(after, before);
    const applied = fs.readFileSync(path.join(tmp, "svc", "apply.py"), "utf8");
    assert.match(applied, /raise GateError/);
  } finally { teardown(tmp); }
});

test("--yes without an approver or reason refuses to apply", () => {
  const { tmp, env } = setup();
  try {
    fs.mkdirSync(path.join(tmp, "svc"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "svc", "apply.py"), 'if store.run(rid)["status"] == "approved":\n        pass\n');
    const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: tmp, env: gitEnv });
    execFileSync("git", ["add", "-A"], { cwd: tmp, env: gitEnv });
    execFileSync("git", ["commit", "-qm", "x"], { cwd: tmp, env: gitEnv });
    fs.writeFileSync(path.join(tmp, "change.patch"), DIFF, "utf8");
    const [, rj] = runReview(tmp, env, [GOOD_FINDING], GOOD_FIX, {}, ["--yes"]);
    assert.equal(rj.fix_decision.status, "pending");
    assert.equal(rj.fix_decision.commit, null);
  } finally { teardown(tmp); }
});

// --------------------------------------------------------------- pure-function unit tests
test("decide is driven only by severity", () => {
  assert.equal(decide([]), 0);
  assert.equal(decide([{ severity: "major" }]), 0);
  assert.equal(decide([{ severity: "blocker" }]), 2);
});

test("verify drops evidence that does not match the changed lines", () => {
  const changed = { "a.py": { 5: "x = 1" } };
  const [ok, why] = verify({ file: "a.py", line: 5, evidence: "totally different" }, changed);
  assert.equal(ok, false);
  assert.match(why, /does not match/);
});

test("redactDiff masks secrets but keeps the rest of the diff readable", () => {
  const out = redactDiff(DIFF);
  assert.ok(!out.includes("live-7f3a9c2e5b1d4a6f8e0c"));
  assert.ok(out.includes("API_TOKEN"));
});