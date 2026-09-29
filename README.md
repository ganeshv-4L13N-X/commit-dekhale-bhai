# "commit-dekhale-bhai" PR review that proposes ONE fix, applied only by a human

## essayist way to run is change any file in demoSite with wrong code and create pr

`review-fix.mjs` is Lab 5.3's `review.py` ported to Node, plus one more step:
if the single most severe finding has a small, local fix, the model may
propose it as an exact search-and-replace snippet. The snippet is never
applied by this script - `apply-fix.mjs` is a separate, tiny, trusted module
that re-verifies the snippet still matches and does the one write, and a
human always chooses **apply as a new commit** or **ignore**.

```
git diff base...head ─▶ secrets scan ─▶ size cap ─▶ file context ─▶ claude -p ─▶ verify findings ─▶ verify fix ─▶ exit code ─▶ [interactive] apply or ignore
                          blockers,      fail closed   masked         no tools,     on a changed line?  addresses a kept
                          no model                                    --json-schema  quotes that line?   finding? matches
                                                                                                           exactly once?
```

| Exit | Meaning | In CI |
|---|---|---|
| 0 | no blocking findings | check passes |
| 2 | at least one verified `blocker` | check fails → merge blocked |
| 1 | could not review (error, budget, diff too big, `is_error`) | check fails — **fail closed** |

The exit code is driven only by finding severity, same as `review.py` - a
proposed fix never changes it, so this stays a drop-in CI gate.

## Why Node has no `sanitized_workspace()`

`review.py` builds a temp copy of the tree with `git archive` + `tarfile`.
Node's standard library has no tar/zip extractor, and this repo's Node labs
are stdlib-only (no `npm install`). Since the model only ever needs the
*changed* files' text - it has no tools to browse further - `review-fix.mjs`
skips the archive step: for each reviewable file it reads the blob directly
with `git show <head>:<path>`, masks it with the same secret patterns, and
drops it if the path matches `DROP_FILES` (`.env*`, `*.pem`,
`credentials*`, ...). No tree is ever written to disk. The `claude`
subprocess still runs with `cwd` set to an empty temp directory as defence
in depth, matching `review.py`.

## Why a fix is a snippet, not a diff

A model-generated unified diff routinely fails to apply after context
drift. A search-and-replace snippet is verified the same way this tool
verifies a finding: it must occur in the file, **exactly once**. `verifyFix`
keeps a proposed fix only if:

1. `fix.file` is a file this PR actually touched (a reviewable file).
2. `fix.old_snippet` occurs exactly once in that file's current blob
   (re-checked via `git show`, never trusted from the model's answer).
3. `fix.addresses` names a finding that survived verification (`verify()`),
   not a dropped one.

Otherwise the fix is dropped and the run falls back to review-only output -
this tool never offers to apply something it hasn't re-checked itself.

## Applying a fix is the only write, and it's a separate file

`apply-fix.mjs` exports `applyFix(repo, fix, approver, reason)`. It has no
model call and needs no gateway key - it re-verifies `old_snippet` is
*still* an exact, unique match (the PR may have moved since the fix was
proposed, the same staleness rule as `lab5-1-handoff/pipeline.py`'s
`proposal_sha` check), writes the file, and commits with the approver and
reason in the message. A decision needs a non-empty approver **and** reason,
enforced in two places (defence in depth): the CLI layer (`decideFix` in
`review-fix.mjs`) and the write layer (`applyFix` itself) — so nothing can
apply a fix by skipping the CLI's prompt.

```bash
node review-fix.mjs --base main --head feat                         # interactive: prompts to apply or ignore
node review-fix.mjs --base main --head feat --ci                    # CI mode: never prompts, never applies
node review-fix.mjs --base main --head feat --yes \
  --approver reviewer1 --reason "clear regression"                  # non-interactive apply
node review-fix.mjs --base main --head feat --no                    # non-interactive ignore
node apply-fix.mjs --fix out/review.json --approver reviewer1 --reason "clear regression"   # apply later, standalone
```

The headless call (see `claudeCmd()`) is identical to `review.py`'s:

```bash
claude -p --output-format json --json-schema "$SCHEMA" --system-prompt "$SYSTEM" \
  --tools "" --permission-mode dontAsk \
  --strict-mcp-config --setting-sources "" --max-turns 12 --max-budget-usd 0.5 < prompt
```

Its environment is the same allowlist as `review.py`: PATH/HOME/LANG (and
the Windows system variables) plus the gateway URL and key.
`GITHUB_TOKEN`, `AIRA_OPS_TOKEN` and anything else in CI never reach it.

**Windows note.** `claude` resolves to a `.cmd` shim there (npm-style).
Node refuses to `spawn`/`spawnSync` a `.cmd` file directly (`EINVAL`), so
`runClaude()` routes that case through `cmd.exe /d /s /c` with
`windowsVerbatimArguments` and its own argument quoting - not `shell: true`,
which re-parses the whole command line as text and would garble an argument
containing quotes (the JSON schema, the system prompt).

## Try it

```bash
node --test test-review-fix.mjs      # every review control, a stub `claude`, no cost
node --test test-apply-fix.mjs       # the write path alone: staleness, missing approver/reason, moved files
```

Against a real branch (needs `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN` -
costs money):

```bash
python3 ../lab5-3-pr-review/demo_prs.py --base day4 --worktree /tmp/d4wt
node review-fix.mjs --repo /tmp/d4wt --base day4 --head demo/apply-retry --out /tmp/rv-fix/apply-retry
```

## CI

`.github/workflows/abhiThikKarkeDetaHu.yml` runs `review-fix.mjs --ci`
alongside Lab 5.3's review (same trust boundary: the base branch's script
reads the PR as data, gets the gateway key, no write token). A maintainer
replies on the PR with `/apply-fix` or `/ignore-fix`; that comment triggers
a second, separate job that checks out the base branch's trusted
`apply-fix.mjs`, re-verifies the fix against the PR's **current** head, and
either pushes a new commit to the PR branch or acknowledges the dismissal.
No job ever runs code *from* the PR - only the base branch's scripts,
treating the PR's file content as data to match against, never as
instructions.

## The suggestion comment is a second, additive UI - not a replacement

When a kept `fix`'s `old_snippet` aligns to whole lines in the file (checked
by `snippetLineSpan`), `comment-fix` also posts a **GitHub-native review
comment** on that diff line/range, with the fix's `new_snippet` inside a
` ```suggestion ` fence. GitHub renders this with its own "Add suggestion to
batch" / "Commit suggestion" button - no slash command needed for that quick
path. This is best-effort and posted via `gh api repos/.../pulls/.../comments`
(the only `gh api` call in this repo; `gh pr comment`/`gh pr review` have no
line-anchored/suggestion support). If the snippet doesn't align to whole
lines, this comment is silently skipped - the plain `review.md` issue comment
and `/apply-fix`/`/ignore-fix` are unaffected either way and remain the only
path that re-verifies against the PR's current head and records an
approver/reason audit trail.
