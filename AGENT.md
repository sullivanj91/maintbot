# AGENT.md — Autopilot Repo

Tags: typescript, node, github-actions, maintenance-agent

## Purpose

Autopilot is an AI-powered maintenance agent for orphaned internal tools. It:

1. Generates AGENT.md knowledge layers for target repos (onboarding engine)
2. Monitors PR merges and updates AGENT.md accordingly (PR sync hook)
3. Runs scheduled sessions to perform proactive maintenance (session runner)
4. Maintains a cross-repo knowledge base (LEARNINGS.md)
5. Proposes capability improvements to itself weekly (self-evolution loop)

## Architecture

```
src/
  types.ts        — shared TypeScript types
  commit.ts       — session-labeled git commit wrapper (all git ops go here)
  constraints.ts  — constitutional constraint enforcement
  learnings.ts    — LEARNINGS.md read / search / append
  issues.ts       — GitHub Issues bidirectional task queue
  session.ts      — core session lifecycle orchestration

LEARNINGS.md      — cross-repo knowledge base (append-only)
EVOLUTION_LOG.md  — capability changelog (append-only)

templates/
  AUTOPILOT_JOURNAL.md                     — installed in every managed repo
  autopilot.yml                            — .autopilot.yml template
  AGENT_CONSTRAINTS_SECTION.md            — Autopilot Constraints template
  .github/workflows/autopilot-session.yml — installed in every managed repo
  .github/ISSUE_TEMPLATE/autopilot-request.yml

.github/workflows/
  autopilot-session.yml        — Autopilot's own scheduled session
  autopilot-self-evolution.yml — weekly self-evolution session
```

## Key Invariants

- **All git operations go through `src/commit.ts`.** The `[autopilot/session-<timestamp>]` prefix is enforced there. Never call git directly.
- **Every action goes through `src/constraints.ts` before execution.** Constraint violations file a GitHub Issue and halt.
- **Journal commit is always first; LEARNINGS.md commit is always last** within a session's commit sequence.
- **Self-evolution never self-merges.** Always opens a human-reviewed PR.
- **LEARNINGS.md entries require ≥2 repos.** EVOLUTION_LOG.md candidates require ≥3 repos.

## Development

```bash
npm install
npm run build
npm test
```

## Autopilot Constraints

<!-- IMMUTABLE — requires a human-approved PR to modify. -->

- NEVER modify src/session.ts's journal step (step 7) or learnings step (step 8); these are mandatory
- NEVER self-merge a self-evolution PR to main; always require human review
- NEVER bypass the constitutional hash check in src/constraints.ts
- NEVER call git directly; always use src/commit.ts
- All auto-commits require a passing test suite
- Do not file more than 3 issues per session
- Maximum 1 self-evolution proposal per weekly session
