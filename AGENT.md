# AGENT.md — Autopilot Repo

Tags: typescript, node, github-actions, maintenance-agent, jest, simple-git, octokit

## Purpose

Autopilot is a Claude-powered autonomous maintenance agent for internal tools and repositories. It onboards new repos by generating `AGENT.md` knowledge files, keeps documentation in sync after every merged PR, runs scheduled health-check and issue-processing sessions, maintains a cross-repo knowledge base (`LEARNINGS.md`), and proposes capability improvements to itself on a weekly cadence. Autopilot manages this repo — its own codebase — to ensure its session runner, constraint enforcement, and self-evolution machinery stay healthy, tested, and well-documented.

## Tech Stack

- **Language:** TypeScript 5.3, compiled with `tsc`, targeting Node.js
- **Runtime:** Node.js 20+
- **Testing:** Jest 29 with `ts-jest` preset, all tests co-located as `*.test.ts`
- **Git automation:** `simple-git` 3.x — all git operations wrapped through `src/commit.ts`
- **GitHub API:** `@octokit/rest` 20.x — issue read/write, PR creation, workflow dispatch
- **AI backbone:** `@anthropic-ai/sdk` 0.39 — Claude tool-use for issue processing and self-evolution
- **Config parsing:** `js-yaml` 4.x — reads `.autopilot.yml` per-repo configuration
- **Integrity:** Node built-in `crypto` — SHA-256 hashing for constitutional constraint verification
- **Linting:** ESLint over `src/**/*.ts`

## Key Invariants

- **All git operations go through `src/commit.ts`.** The `[autopilot/session-<timestamp>]` commit prefix is enforced there. Never shell out to git or use `simple-git` directly from any other module.
- **Every mutating action passes through `src/constraints.ts` before execution.** If a constraint is violated, the agent files a GitHub Issue and halts the session immediately.
- **Constitutional hash integrity:** The SHA-256 hash of the `## Autopilot Constraints` section is stored in `.autopilot.yml` as `constitutional_hash`. At session start, `src/constraints.ts` recomputes the hash and compares. Any mismatch (i.e., an unapproved edit) causes an immediate halt — no work is performed.
- **Session commit ordering:** Within every session's commit sequence, the journal append commit is always first and the `LEARNINGS.md` append commit is always last. This guarantees an audit trail even if the session is interrupted mid-flight.
- **Self-evolution never self-merges.** `src/self-evolution-scan.ts` and `src/self-evolution-implement.ts` always open a PR targeting `main`; the agent has no path to merge it.
- **Append-only files:** `LEARNINGS.md`, `EVOLUTION_LOG.md`, and `AUTOPILOT_JOURNAL.md` (in managed repos) are strictly append-only. Existing content in these files must never be edited, reordered, or deleted.
- **Qualification gates:** A learning must be confirmed in ≥2 repos before being appended to `LEARNINGS.md`. A self-evolution candidate must be confirmed in ≥3 repos before being written to `EVOLUTION_LOG.md`.
- **Secrets are accessed via GitHub Actions secrets at runtime.** The agent may read `GITHUB_TOKEN` and `ANTHROPIC_API_KEY` from the environment but must never log, print, echo, or persist their values in any file, commit message, issue body, or journal entry.
- **`src/session.ts` step 7 (journal) and step 8 (learnings) are structurally mandatory.** These steps must not be removed, reordered, or made conditional.
- **Entry point:** `src/main.ts` is the CLI/Actions entry point; `src/session.ts` orchestrates the core lifecycle. `src/onboarding.ts` handles interactive repo onboarding. `src/pr-sync.ts` handles the post-merge AGENT.md update hook.

## Autopilot Constraints

<!-- IMMUTABLE — requires a human-approved PR to modify.
     The agent cannot update this section autonomously.
     The SHA-256 hash of this section is stored in .autopilot.yml as
     constitutional_hash. If the hash mismatches, the agent halts.          -->

- NEVER modify `src/session.ts`'s journal step (step 7) or learnings step (step 8); these are mandatory session lifecycle anchors
- NEVER self-merge a self-evolution PR to `main`; always open it for human review
- NEVER bypass the constitutional hash check in `src/constraints.ts`
- NEVER call git directly; always use `src/commit.ts`
- NEVER log, print, persist, or include in any commit message or issue body the values of `GITHUB_TOKEN`, `ANTHROPIC_API_KEY`, or any other secret
- NEVER modify secret-management configuration (e.g., GitHub Actions secrets settings)
- NEVER edit or reorder existing content in `LEARNINGS.md`, `EVOLUTION_LOG.md`, or `AUTOPILOT_JOURNAL.md`; only append new entries
- All auto-commits require a passing test suite (`npm test` exits 0); never bypass CI
- If test coverage drops below 30%, halt and file an issue
- Do not file more than 3 issues per session
- Maximum 1 self-evolution proposal per weekly session
- Maximum 1 dependency upgrade per session