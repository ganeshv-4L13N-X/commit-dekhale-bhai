#!/usr/bin/env node
// Lab 5.4 - the only thing that writes.
//
// Mirrors lab5-1-handoff/pipeline.py's split between agents (read-only) and apply() (plain code,
// the only write): review-fix.mjs proposes and verifies a fix, but never touches the working tree.
// This module does exactly one thing - given ONE already-verified {file, old_snippet, new_snippet},
// re-verify it is still an exact, unique match (the PR may have moved since the fix was proposed -
// same staleness rule as pipeline.py's proposal_sha check), write the file, and commit. No model
// call, no `claude` subprocess, no gateway key needed - which is why CI can run this from the
// TRUSTED base branch even while it edits code checked out from the PR.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export class ApplyFixError extends Error {}

/** Apply fix.{file, old_snippet, new_snippet} in `repo`, committing as approver/reason.
    Returns the new commit sha. Throws ApplyFixError if the snippet no longer matches exactly once -
    fail closed rather than guess which occurrence was meant, or edit a file that has since changed. */
export function applyFix(repo, fix, approver, reason) {
  if (!approver || !approver.trim() || !reason || !reason.trim()) {
    throw new ApplyFixError("applying a fix needs a non-empty approver and reason");
  }
  const filePath = path.join(repo, fix.file);
  let text;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch {
    throw new ApplyFixError(`${fix.file}: could not read (moved or deleted since the fix was proposed?)`);
  }
  const count = text.split(fix.old_snippet).length - 1;
  if (count !== 1) {
    throw new ApplyFixError(`${fix.file}: old_snippet occurs ${count} time(s), need exactly 1 ` +
      "(the file changed since this fix was proposed - review again)");
  }
  const updated = text.replace(fix.old_snippet, fix.new_snippet);
  fs.writeFileSync(filePath, updated, "utf8");

  const run = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  run("add", "--", fix.file);
  const message = `Apply agent-proposed fix: ${fix.addresses}\n\n${fix.explanation}\n\n` +
    `Approved-by: ${approver}\nReason: ${reason}`;
  run("commit", "-m", message);
  return run("rev-parse", "HEAD").trim();
}

function parseArgs(argv) {
  const a = { repo: process.cwd(), fix: null, approver: null, reason: null };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const next = () => argv[++i];
    if (flag === "--repo") a.repo = next();
    else if (flag === "--fix") a.fix = next();
    else if (flag === "--approver") a.approver = next();
    else if (flag === "--reason") a.reason = next();
    else throw new Error(`unknown argument: ${flag}`);
  }
  return a;
}

export function main(argv) {
  const args = parseArgs(argv);
  if (!args.fix) throw new Error("--fix <review.json> is required");
  const review = JSON.parse(fs.readFileSync(args.fix, "utf8"));
  const fix = review.fix;
  if (!fix) throw new Error(`${args.fix} has no verified fix to apply`);
  const sha = applyFix(args.repo, fix, args.approver, args.reason);
  console.log(sha);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (e) {
    console.error(`refused: ${e.message}`);
    process.exit(1);
  }
}
