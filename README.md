# Autopilot

An autonomous AI maintenance agent for internal tools and repos. Autopilot runs on a schedule, processes GitHub Issues, monitors repo health, and keeps documentation in sync — all within strict, human-defined constraints.

---

## What is Autopilot?

Autopilot is a Claude-powered maintenance agent that manages your repositories autonomously so you don't have to. It reads your codebase, processes task requests via GitHub Issues, fixes dependency vulnerabilities, monitors CI health, and updates its own documentation as your code evolves. Every action it takes is audited in an append-only journal, governed by constitutional constraints you define at setup, and bounded by per-session time limits.

The key design principle: **Autopilot does the routine work autonomously, but always escalates judgment calls to humans via GitHub Issues.**

---

## Capabilities

| Phase | Capability | How it works |
|-------|-----------|--------------|
| 1 | **Onboarding** | Interviews you via CLI, generates an `AGENT.md` knowledge file, and installs three GitHub Actions workflows into your repo in minutes |
| 2 | **PR Sync** | After every merged PR, updates `AGENT.md` to reflect new patterns, dependencies, and architecture — so the agent always has current context |
| 3 | **Health Monitoring** | Each session checks for npm/pip vulnerabilities, stale dependencies, and CI flakiness; findings are included in Claude's context |
| 4 | **Issue Processing** | Claude reads open `autopilot-input` issues, uses tools to read and edit files, runs tests, commits fixes, and closes issues with summaries |
| 5 | **Self-Evolution** | Weekly scan of `LEARNINGS.md` proposes new automation capabilities; always opened as a PR, never auto-merged |

---

## Safety Guarantees

- **Constitutional constraints** — A `## Autopilot Constraints` section in `AGENT.md` defines hard rules (e.g., "NEVER modify `src/payments/`"). The SHA-256 hash of this section is stored in `.autopilot.yml`. If anyone edits it without going through a human-approved PR, the next session halts immediately.
- **Append-only journal** — Every session appends an entry to `AUTOPILOT_JOURNAL.md` with what was done, what failed, and hints for the next session. This file is never edited — only appended.
- **Qualification gates** — Cross-repo learnings require confirmation in ≥2 repos before being stored. Self-evolution proposals require ≥3 repos.
- **No self-merging** — Self-evolution PRs are always opened for human review; the agent cannot merge them.
- **Full commit audit trail** — Every commit is labeled `[autopilot/session-TIMESTAMP]` with a structured metadata block listing issues addressed, learnings consulted, and constraints checked.
- **Time-bounded sessions** — Work is capped at `session_time_limit_minutes` (default: 30). The journal always commits even if work is interrupted.
- **Issue filing cap** — At most 3 issues filed per session to prevent spam.

---

## Quick Start: Add Autopilot to Your Repo

### Prerequisites

- This repo cloned and accessible
- `ANTHROPIC_API_KEY` — Claude API key
- `AUTOPILOT_TOKEN` — GitHub PAT with `repo` and `issues` scopes

### Step 1: Install dependencies and build

```bash
npm install
npm run build
```

### Step 2: Run onboarding against your target repo

```bash
TARGET_REPO_PATH=/path/to/your-repo \
TARGET_REPO_SLUG=owner/your-repo \
AUTOPILOT_REPO_PATH=$(pwd) \
AUTOPILOT_REPO_SLUG=owner/maintbot \
ANTHROPIC_API_KEY=sk-ant-... \
GITHUB_TOKEN=ghp_... \
node dist/onboarding.js
```

Autopilot will ask you 5–8 questions about constraints (off-limits paths, CI requirements, test coverage thresholds, etc.) and generate a tailored `AGENT.md`.

**For CI/non-interactive mode**, pre-supply answers as JSON:

```bash
CI_ANSWERS='{"What paths should never be modified?": "db/migrations/, src/payments/"}' \
... node dist/onboarding.js
```

### Step 3: Push the generated commit

```bash
cd /path/to/your-repo
git push origin main
```

This installs three workflows into your repo:
- `.github/workflows/autopilot-session.yml` — scheduled every 8h
- `.github/workflows/autopilot-pr-sync.yml` — triggers on PR merge
- `.github/ISSUE_TEMPLATE/autopilot-request.yml` — issue template for requesting work

### Step 4: Configure secrets and variables in your repo

In your target repo's **Settings → Secrets and variables**:

| Secret/Variable | Where | Value |
|----------------|-------|-------|
| `AUTOPILOT_TOKEN` | Secret | GitHub PAT with repo + issues scope |
| `ANTHROPIC_API_KEY` | Secret | Claude API key |
| `AUTOPILOT_REPO_SLUG` | Variable | `owner/maintbot` (this repo's slug) |

### Step 5: Assign work

Open an issue in your repo with label `autopilot-input`. Autopilot will pick it up in the next session (or immediately if you add `autopilot-urgent`).

```
Title: Fix the broken npm audit vulnerability in lodash
Body:  npm audit reports a high-severity vulnerability in lodash@4.17.15.
       Please upgrade it and run the test suite.
```

---

## How Sessions Work

Every session (scheduled, PR-triggered, or manual) follows this 8-step lifecycle:

1. **Verify constraints** — Hash-check `## Autopilot Constraints` in `AGENT.md`. Halt if tampered.
2. **Load journal** — Read the last 10 `AUTOPILOT_JOURNAL.md` entries for long-term memory.
3. **Load learnings** — Search `LEARNINGS.md` for entries matching this repo's tech tags.
4. **Fetch issue queue** — Get open `autopilot-input` issues, sorted by urgency and engagement.
5. **Run health checks** — npm/pip audit, stale deps, CI flakiness. Results go into Claude's context.
6. **Work** — Claude runs the agentic loop: reads files, writes files, runs tests, files/closes issues.
7. **Commit journal** — Always happens, even if work failed. First commit of the session.
8. **Commit learnings** — If a new cross-repo pattern was discovered and qualifies (≥2 repos).

---

## Configuration (`.autopilot.yml`)

| Key | Default | Description |
|-----|---------|-------------|
| `schedule.frequency` | `"every-8-hours"` | How often scheduled sessions run |
| `schedule.session_time_limit_minutes` | `30` | Max time for the work step per session |
| `issues.max_issues_processed_per_session` | `2` | Max issues Claude works on per session |
| `issues.max_issues_filed_per_session` | `3` | Max issues Claude can file per session |
| `issues.input_label` | `"autopilot-input"` | Label for human-to-agent requests |
| `issues.urgent_label` | `"autopilot-urgent"` | Label that triggers an immediate session |
| `issues.filed_label` | `"autopilot-filed"` | Label on issues filed by the agent |
| `constitutional_hash` | _(set during onboarding)_ | SHA-256 of `## Autopilot Constraints` section |

---

## Architecture

```
src/
├── main.ts                    Entry point — wires session + Claude agentic loop
├── session.ts                 8-step session lifecycle (runSession)
├── health.ts                  Health checks (npm audit, pip, CI flakiness)
├── onboarding.ts              Target repo setup (interview → AGENT.md → install)
├── pr-sync.ts                 AGENT.md update on PR merge
├── commit.ts                  Session-labeled git commit wrapper
├── constraints.ts             Constitutional hash check + action gating
├── learnings.ts               LEARNINGS.md read/search/append
├── issues.ts                  GitHub Issues bidirectional queue
├── types.ts                   Shared TypeScript types
├── self-evolution-scan.ts     Find automation candidates in LEARNINGS.md
└── self-evolution-implement.ts Scaffold automation modules from candidates

templates/
├── AUTOPILOT_JOURNAL.md               Journal header template
├── AGENT_CONSTRAINTS_SECTION.md       Constraints section template for onboarding
├── autopilot.yml                      .autopilot.yml template
└── .github/
    ├── ISSUE_TEMPLATE/
    │   └── autopilot-request.yml      Issue template for requesting work
    └── workflows/
        ├── autopilot-session.yml      Scheduled session workflow (installed in target repos)
        └── autopilot-pr-sync.yml      PR sync workflow (installed in target repos)

.github/workflows/
├── autopilot-session.yml              Autopilot's own session (manages itself)
└── autopilot-self-evolution.yml       Weekly self-evolution proposal loop

AGENT.md          Autopilot's own knowledge file
LEARNINGS.md      Cross-repo knowledge base (append-only, ≥2 repos to qualify)
EVOLUTION_LOG.md  Self-evolution proposal history
```

---

## Contributing

Autopilot manages itself. To propose changes:

1. Open an issue with label `autopilot-input`
2. Or open a PR — Autopilot will update its own `AGENT.md` after merge

The self-evolution loop runs weekly and may open PRs proposing new automation capabilities based on patterns observed across managed repos.
