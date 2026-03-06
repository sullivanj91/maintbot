/**
 * src/session.ts
 *
 * Core session lifecycle orchestration.
 *
 * Every Autopilot session — whether triggered by a schedule, a PR merge,
 * an incident, or a manual dispatch — runs through this exact sequence:
 *
 *   1.  Read last 10 AUTOPILOT_JOURNAL.md entries (long-term memory)
 *   2.  Load relevant LEARNINGS.md entries (cross-repo knowledge)
 *   3.  Verify constitutional constraints hash (tamper detection)
 *   4.  Fetch & prioritize open autopilot-input issues (task queue)
 *   5.  Run health checks → write findings into issue queue
 *   6.  Execute bounded work (issues + health findings, time-limited)
 *   7.  Append AUTOPILOT_JOURNAL.md entry and commit it (always first commit)
 *   8.  Update LEARNINGS.md if a new generalizable pattern was discovered
 *
 * Steps 7 and 8 are mandatory and cannot be skipped. If the session is
 * interrupted partway through the work step, the journal entry still records
 * what was attempted.
 *
 * This file exports the runSession() entry point and the lower-level helpers
 * used by the GitHub Actions workflow runner.
 */

import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";

import { makeSessionId, sessionCommit } from "./commit.js";
import { readAgentMd, verifyConstraintsHash, checkAction, ProposedAction } from "./constraints.js";
import {
  readLearnings,
  searchLearnings,
  appendLearning,
  summarizeLearning,
  qualifiesForLearning,
} from "./learnings.js";
import {
  fetchInputQueue,
  postPickupComment,
  closeIssueWithSummary,
  fileIssue,
  fileConstraintViolationIssue,
  ensureLabels,
} from "./issues.js";

import {
  AutopilotConfig,
  AutopilotIssue,
  JournalEntry,
  Learning,
  SessionContext,
  SessionId,
  TriggerType,
} from "./types.js";

// ─── Config Loading ───────────────────────────────────────────────────────────

export function loadConfig(repoPath: string): AutopilotConfig {
  const configPath = path.join(repoPath, ".autopilot.yml");
  if (!fs.existsSync(configPath)) {
    throw new Error(
      `.autopilot.yml not found at ${configPath}. Run onboarding first.`
    );
  }
  return yaml.load(fs.readFileSync(configPath, "utf8")) as AutopilotConfig;
}

// ─── Journal ──────────────────────────────────────────────────────────────────

const JOURNAL_FILE = "AUTOPILOT_JOURNAL.md";
const JOURNAL_ENTRIES_TO_READ = 10;

function journalEntryToMarkdown(entry: JournalEntry): string {
  const workDone =
    entry.workDone.length > 0
      ? entry.workDone.map((l) => `- ${l}`).join("\n")
      : "- (nothing completed this session)";

  const failedAttempts =
    entry.failedAttempts.length > 0
      ? entry.failedAttempts.map((l) => `- ${l}`).join("\n")
      : "- (none)";

  const observations =
    entry.observations.length > 0
      ? entry.observations.map((l) => `- ${l}`).join("\n")
      : "- (none)";

  const hints =
    entry.nextSessionHints.length > 0
      ? entry.nextSessionHints.map((l) => `- ${l}`).join("\n")
      : "- (none)";

  const issuesAddressed =
    entry.issuesAddressed.length > 0
      ? entry.issuesAddressed.map((n) => `#${n}`).join(", ")
      : "none";

  const issuesFiled =
    entry.issuesFiled.length > 0
      ? entry.issuesFiled.map((n) => `#${n}`).join(", ")
      : "none";

  const learningsConsulted =
    entry.learningsConsulted.length > 0
      ? entry.learningsConsulted.join(", ")
      : "none";

  const learningsAppended =
    entry.learningsAppended.length > 0
      ? entry.learningsAppended.join(", ")
      : "none";

  const trigger = entry.triggerRef
    ? `${entry.triggerType}:${entry.triggerRef}`
    : entry.triggerType;

  return [
    `## Session ${entry.sessionId.timestamp} [autopilot/session-${entry.sessionId.label}]`,
    ``,
    `### Trigger`,
    trigger,
    ``,
    `### Work Done`,
    workDone,
    ``,
    `### Failed Attempts`,
    failedAttempts,
    ``,
    `### Observations`,
    observations,
    ``,
    `### Next Session Hints`,
    hints,
    ``,
    `### Metadata`,
    `- Issues addressed: ${issuesAddressed}`,
    `- Issues filed: ${issuesFiled}`,
    `- LEARNINGS.md consulted: ${learningsConsulted}`,
    `- LEARNINGS.md appended: ${learningsAppended}`,
    ``,
    `---`,
    ``,
  ].join("\n");
}

function readRecentJournalEntries(repoPath: string, count: number): string {
  const journalPath = path.join(repoPath, JOURNAL_FILE);
  if (!fs.existsSync(journalPath)) return "(no previous sessions)";

  const content = fs.readFileSync(journalPath, "utf8");
  // Split on session headers and return last N entries
  const entries = content.split(/(?=^## Session )/m).filter((b) => b.trim().length > 0);
  return entries.slice(-count).join("\n");
}

function appendJournalEntry(repoPath: string, entry: JournalEntry): void {
  const journalPath = path.join(repoPath, JOURNAL_FILE);

  let existing = "";
  if (fs.existsSync(journalPath)) {
    existing = fs.readFileSync(journalPath, "utf8");
  } else {
    // Initialize file with header
    existing =
      `# AUTOPILOT_JOURNAL.md\n\n` +
      `Append-only session journal. Each entry records one Autopilot session.\n` +
      `Do not edit existing entries. New entries are always appended.\n\n`;
  }

  const newEntry = journalEntryToMarkdown(entry);
  fs.writeFileSync(journalPath, existing + newEntry);
}

// ─── Session Builder ──────────────────────────────────────────────────────────

/**
 * Mutable session state accumulated throughout a session run.
 * Passed by reference into the work callback.
 */
export interface SessionState {
  sessionId: SessionId;
  recentJournalSummary: string;
  relevantLearnings: Learning[];
  issueQueue: AutopilotIssue[];
  agentMdContent: string;
  config: AutopilotConfig;
  ctx: SessionContext;

  // Accumulated results (work callback fills these in)
  workDone: string[];
  failedAttempts: string[];
  observations: string[];
  nextSessionHints: string[];
  issuesAddressed: number[];
  issuesFiled: number[];
  learningsAppended: string[];
  commitShas: string[];

  // Helper: check an action against constraints before executing
  checkAction: (action: ProposedAction) => ReturnType<typeof checkAction>;

  // Helper: file a constraint-violation issue and record it
  blockWithIssue: (violation: {
    rule: string;
    proposedAction: string;
    filesTouched: string[];
  }) => Promise<void>;
}

// ─── Main Entry Point ─────────────────────────────────────────────────────────

/**
 * Run a complete Autopilot session.
 *
 * @param ctx        Session context (repo paths, slugs, trigger info).
 * @param workFn     Async callback that receives the SessionState and does the
 *                   actual maintenance work. The callback is responsible for
 *                   pushing its changes to state.workDone, state.failedAttempts,
 *                   etc. before returning.
 */
export async function runSession(
  ctx: SessionContext,
  workFn: (state: SessionState) => Promise<void>
): Promise<void> {
  const sessionId = ctx.id;
  const config = loadConfig(ctx.repoPath);
  const agentMdContent = readAgentMd(ctx.repoPath);

  // ── Step 1: Verify constitutional constraints hash ────────────────────────
  // Throws if tampered; session cannot proceed
  verifyConstraintsHash(agentMdContent, config);

  // ── Step 2: Read last 10 journal entries ─────────────────────────────────
  const recentJournalSummary = readRecentJournalEntries(
    ctx.repoPath,
    JOURNAL_ENTRIES_TO_READ
  );

  // ── Step 3: Load relevant LEARNINGS.md entries ───────────────────────────
  const allLearnings = readLearnings(ctx.autopilotRepoPath);
  // Extract language/framework tags from AGENT.md (look for a "## Tags" or
  // "tags:" line; fall back to empty if not found)
  const tagsMatch = agentMdContent.match(/^(?:tags|Tags):\s*(.+)$/m);
  const repoTags = tagsMatch
    ? tagsMatch[1].split(",").map((t) => t.trim())
    : [];
  const relevantLearnings = searchLearnings(allLearnings, repoTags);

  // ── Step 4: Fetch & prioritize open autopilot-input issues ───────────────
  const issueQueue = await fetchInputQueue(ctx.repoSlug, config);

  // ── Step 5: Build session state ───────────────────────────────────────────
  const state: SessionState = {
    sessionId,
    recentJournalSummary,
    relevantLearnings,
    issueQueue,
    agentMdContent,
    config,
    ctx,
    workDone: [],
    failedAttempts: [],
    observations: [],
    nextSessionHints: [],
    issuesAddressed: [],
    issuesFiled: [],
    learningsAppended: [],
    commitShas: [],

    checkAction: (action) => checkAction(action, agentMdContent, config),

    blockWithIssue: async (violation) => {
      const issueNumber = await fileConstraintViolationIssue(
        ctx.repoSlug,
        sessionId,
        config,
        violation
      );
      state.issuesFiled.push(issueNumber);
      state.observations.push(
        `Blocked: "${violation.proposedAction}" — violates rule: "${violation.rule}". Filed #${issueNumber}.`
      );
    },
  };

  // ── Step 6: Run the work callback (bounded by session time limit) ─────────
  const timeLimitMs = config.schedule.sessionTimeLimitMinutes * 60 * 1000;
  try {
    await Promise.race([
      workFn(state),
      new Promise<void>((_, reject) =>
        setTimeout(
          () => reject(new Error(`Session time limit reached (${config.schedule.sessionTimeLimitMinutes} min)`)),
          timeLimitMs
        )
      ),
    ]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    state.failedAttempts.push(`Session interrupted: ${msg}`);
    state.nextSessionHints.push(`Investigate session interruption: ${msg}`);
  }

  // ── Step 7: Append journal entry and commit (always — even if work failed) ─
  const journalEntry: JournalEntry = {
    sessionId,
    triggerType: ctx.triggerType,
    triggerRef: ctx.triggerRef,
    workDone: state.workDone,
    failedAttempts: state.failedAttempts,
    observations: state.observations,
    nextSessionHints: state.nextSessionHints,
    issuesFiled: state.issuesFiled,
    issuesAddressed: state.issuesAddressed,
    learningsConsulted: relevantLearnings.map((l) => l.id),
    learningsAppended: state.learningsAppended,
  };

  appendJournalEntry(ctx.repoPath, journalEntry);

  sessionCommit(ctx.repoPath, {
    message: "journal: append session entry",
    files: [JOURNAL_FILE],
    metadata: {
      sessionId,
      triggerType: ctx.triggerType,
      repoSlug: ctx.repoSlug,
      issuesAddressed: state.issuesAddressed,
      issuesFiled: state.issuesFiled,
      learningsConsulted: relevantLearnings.map((l) => l.id),
      constraintsChecked: true,
    },
  });

  // ── Step 8: Update LEARNINGS.md if a new pattern was discovered ────────────
  // (The workFn is responsible for calling appendLearning() on the Autopilot
  //  repo and pushing the new LEARN-NNN id into state.learningsAppended.
  //  This step commits whatever was appended.)
  const learningsPath = path.join(ctx.autopilotRepoPath, "LEARNINGS.md");
  if (state.learningsAppended.length > 0 && fs.existsSync(learningsPath)) {
    sessionCommit(ctx.autopilotRepoPath, {
      message: `meta: update LEARNINGS.md (${state.learningsAppended.join(", ")})`,
      files: ["LEARNINGS.md"],
      metadata: {
        sessionId,
        triggerType: ctx.triggerType,
        repoSlug: ctx.repoSlug,
        issuesAddressed: [],
        issuesFiled: [],
        learningsConsulted: relevantLearnings.map((l) => l.id),
        constraintsChecked: true,
      },
    });
  }
}

// ─── Convenience: Session Context Factory ─────────────────────────────────────

/**
 * Build a SessionContext from environment variables set by the GitHub Actions
 * workflow (autopilot-session.yml).
 */
export function sessionContextFromEnv(): SessionContext {
  const required = (name: string): string => {
    const val = process.env[name];
    if (!val) throw new Error(`Required environment variable ${name} is not set`);
    return val;
  };

  const triggerType = (process.env.TRIGGER_TYPE ?? "scheduled") as TriggerType;

  return {
    id: makeSessionId(),
    triggerType,
    triggerRef: process.env.TRIGGER_REF,
    repoPath: required("TARGET_REPO_PATH"),
    repoSlug: required("TARGET_REPO_SLUG"),
    autopilotRepoPath: required("AUTOPILOT_REPO_PATH"),
    autopilotRepoSlug: required("AUTOPILOT_REPO_SLUG"),
  };
}

// ─── Convenience: Print Session Context for Debugging ────────────────────────

export function logSessionContext(ctx: SessionContext): void {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`AUTOPILOT SESSION ${ctx.id.timestamp}`);
  console.log(`${"=".repeat(60)}`);
  console.log(`Trigger:        ${ctx.triggerType}${ctx.triggerRef ? `:${ctx.triggerRef}` : ""}`);
  console.log(`Target repo:    ${ctx.repoSlug} (${ctx.repoPath})`);
  console.log(`Autopilot repo: ${ctx.autopilotRepoSlug} (${ctx.autopilotRepoPath})`);
  console.log(`Session label:  autopilot/session-${ctx.id.label}`);
  console.log(`${"=".repeat(60)}\n`);
}
