# Lab 5.4 — PR-fix agent runbook

Operational reference for running `review-fix.mjs`/`apply-fix.mjs` by hand or
watching them run in CI. Design and code-level detail lives in `README.md` —
this file is "what do I do when," not "how is it built."

## What it does, in one line

Reviews a PR diff with `claude -p`, proposes at most one verified fix, and
lets a human apply it as a new commit or ignore it — locally via an
interactive prompt, in CI via a `/apply-fix` / `/ignore-fix` PR comment.

```
git diff → secrets scan → size cap → file context → claude -p → verify findings
         → verify fix → exit code → [interactive] apply or ignore
```

| Exit | Meaning |
|---|---|
| 0 | no blocking findings |
| 2 | at least one verified blocker |
| 1 | could not review (error, budget, diff too big) — **fail closed** |

## Running it by hand

```bash
node review-fix.mjs --base main --head my-branch                 # interactive: prompts apply/ignore
node review-fix.mjs --base main --head my-branch --dry-run        # writes out/prompt.txt, no model call, no cost
node review-fix.mjs --base main --head my-branch --ci             # never prompts, never applies (what CI runs)
node review-fix.mjs --base main --head my-branch --yes \
  --approver <you> --reason "clear regression"                    # non-interactive apply
node review-fix.mjs --base main --head my-branch --no             # non-interactive ignore
node apply-fix.mjs --fix out/review.json --approver <you> --reason "..."   # apply a stored proposal later
```

Outputs land in `--out` (default `out/`): `review.json` (machine-readable,
includes `fix` and `fix_decision`), `review.md` (human-readable, what CI
posts as a PR comment). Both are gitignored — never commit them.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` | — (required) | gateway; missing either fails before any subprocess runs |
| `LAB_MODEL` | `claude-sonnet` | model name passed to `claude -p --model` |
| `REVIEW_BUDGET_USD` | `0.5` | ceiling passed to **both** the script's own `BudgetGuard.check()` and the CLI's `--max-budget-usd` — override with `--budget` |
| `REVIEW_MAX_DIFF_BYTES` | `60000` | diff size cap; over this, exit 1 before the model is called |
| `REVIEW_MAX_CONTEXT_BYTES` | `60000` | per-file context cap sent to the model |
| `GITHUB_STEP_SUMMARY` | — | if set (CI sets this automatically), `review.md` is also appended there |

Never set these in the repo or a commit — they belong in your own `.env` or
`~/.claude/settings.json`, never checked into source control.

## Cost and budget

- Check spend directly against your gateway/provider dashboard or key usage
  page — there's no bundled cost-report tool in this repo.
- A `review-fix.mjs` run costs at most `REVIEW_BUDGET_USD` (default $0.50),
  enforced at two layers: `BudgetGuard.check()` refuses **before** the
  `claude` subprocess is even spawned if the budget is non-positive, and the
  CLI's own `--max-budget-usd` bounds spend inside the subprocess.
- `--dry-run` never calls the model — use it to sanity-check the diff/prompt
  for $0.
- If a run reports cost near the ceiling, check the trace (`traces/lab5-4-*.jsonl`,
  `claude.headless` event, `budget` field) before raising `REVIEW_BUDGET_USD` —
  raising the ceiling silently is how a bug turns into a bill.

## Applying or ignoring a proposed fix

**Locally (interactive):** the script prints the finding and the proposed
`old_snippet`/`new_snippet`, then prompts `[1] Apply as a new commit  [2]
Ignore`. Applying with no answer at the prompt asks for an approver and
reason inline; both are required — enforced again inside `apply-fix.mjs`
itself, so nothing can apply a fix by skipping this prompt.

**In CI:** a maintainer replies on the PR:
- `/apply-fix` — re-verifies the fix against the PR's **current** head (not
  the head it was proposed against) and pushes a new commit if it still
  matches exactly once. If the PR moved since the proposal, it fails closed
  with "no fix proposal found for the PR's current head" — ask for a fresh
  review (push an empty commit or re-run the workflow) rather than trying to
  force it.
- `/ignore-fix` — acknowledges, no code changes.
- Only `OWNER`/`MEMBER`/`COLLABORATOR` comments are honored; anyone else's
  comment is silently ignored (check the run log for `::warning::... is not
  a trusted association` if a comment seemed to do nothing).

## CI (`.github/workflows/abhiThikKarkeDetaHu.yml`)

| Job | Trigger | What it needs | What it can do |
|---|---|---|---|
| `changes` | `pull_request` | — | decides if Day 4 files changed |
| `propose-fix` | `pull_request`, same-repo only | gateway secrets | runs `review-fix.mjs --ci`, uploads `pr-fix` artifact — **no write token** |
| `comment-fix` | after `propose-fix` | `pull-requests: write` | posts `review.md` — never checks out PR code |
| `apply-fix-command` | `issue_comment` on a PR | `contents: write`, `pull-requests: write` | runs trusted `apply-fix.mjs` against the PR's current head, pushes |

Trust shape: `propose-fix`/`apply-fix-command` always run `review-fix.mjs`/
`apply-fix.mjs` **from the base branch**, never from the PR — the PR's file
content is data to match against, never code that runs. Fork PRs get no
gateway secret and `apply-fix-command`'s push fails closed (`GITHUB_TOKEN`
can't push to a fork) — a maintainer applies the fix from a trusted local
checkout instead.

This is currently the only review/fix workflow in this repo — there's no
separate `gate` job elsewhere to coordinate with. If you add another PR-review
workflow later, decide explicitly which job (or both) should be a required
status check on the protected branch.

## Troubleshooting

| Symptom | Likely cause | What to do |
|---|---|---|
| `claude exited ... with no JSON result` | `claude` not on PATH, or (Windows) the `.cmd` shim spawn issue | confirm `claude --version` works in the same shell; the `.cmd` `EINVAL` case is already handled by `spawnClaude()` — if it recurs, check `process.platform`/PATH resolution in `findClaude()` |
| Exit 1, message names "budget" and no model output | `--budget`/`REVIEW_BUDGET_USD` is `0` or negative, or the CLI's own ceiling was hit mid-run | check `REVIEW_BUDGET_USD`/`--budget`; this is fail-closed working as intended, not a bug |
| `no fix proposal found for the PR's current head` on `/apply-fix` | PR moved (new commits) since the last `propose-fix` run | re-trigger `propose-fix` (push a commit or re-run the workflow), then retry `/apply-fix` |
| `old_snippet occurs N time(s), need exactly 1` | the file changed since the fix was proposed, or the snippet was never unique | re-run the review; a stale or ambiguous fix is refused, not guessed |
| `/apply-fix` comment does nothing, no error visible on the PR | commenter isn't `OWNER`/`MEMBER`/`COLLABORATOR`, or the comment isn't on a PR | check the workflow run log for the `::warning::` from the gate step |
| Diff rejected as "too large for automated review" | diff exceeds `REVIEW_MAX_DIFF_BYTES` (60 KB default) | split the PR, or raise `REVIEW_MAX_DIFF_BYTES` deliberately (it's a cost/context guard, not a hard limit) |
| A secret shows up masked as `[REDACTED]` in `review.md`/`prompt.txt` | working as intended — `SECRET_PATTERNS` masked it before it reached the model | if it's a false positive, treat as a lab bug to report, not something to bypass |

## What NOT to do

- Don't commit anything under `out/` or `traces/` — both are gitignored and
  can contain prompt/file content.
- Don't raise `REVIEW_BUDGET_USD` to make a budget error go away without
  checking the trace first — see "Cost and budget" above.
- Don't apply a fix without an approver and reason by editing `review.json`
  directly — `apply-fix.mjs` re-verifies the snippet against the live file
  regardless, so a hand-edited proposal is still subject to the same
  staleness check, but skipping the CLI/CI approval path skips the audit
  trail this lab is teaching.
- Don't "fix" the `.cmd`-spawn handling in `runClaude()`/`spawnClaude()` back
  to `shell: true` — it would garble the JSON schema/system prompt arguments
  (see README.md's Windows note).
