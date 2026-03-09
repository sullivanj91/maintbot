/**
 * src/main.ts
 *
 * Entry point: node dist/main.js
 *
 * The heart of the Autopilot system. Wires together the session lifecycle
 * (src/session.ts) with a Claude-powered agentic work function.
 *
 * Each session:
 *   1. Builds context (journal, learnings, issues, health findings)
 *   2. Passes that context to Claude as a system prompt
 *   3. Runs an agentic tool-use loop until Claude is done or time expires
 *   4. The existing runSession() machinery commits the journal and learnings
 *
 * Tools exposed to Claude:
 *   read_file       — read a file from the target repo
 *   list_files      — list files in a directory in the target repo
 *   write_file      — write a file, run tests, commit (via sessionCommit)
 *   run_shell       — run a whitelisted shell command in the target repo
 *   file_issue      — file a GitHub Issue (agent → human)
 *   close_issue     — close a GitHub Issue with a summary
 *   propose_learning — propose a new cross-repo learning (queued until end)
 */

import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";

import Anthropic from "@anthropic-ai/sdk";

import { sessionContextFromEnv, logSessionContext, runSession, SessionState } from "./session.js";
import { sessionCommit } from "./commit.js";
import { runHealthChecks, formatHealthFindings, HealthFinding } from "./health.js";
import { appendLearning, qualifiesForLearning, summarizeLearning } from "./learnings.js";
import {
  postPickupComment,
  closeIssueWithSummary,
  fileIssue,
} from "./issues.js";
import { AutopilotIssue, Learning } from "./types.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const MODEL = "claude-opus-4-6";
const MAX_TOKENS = 16384;
const MAX_TURNS = 40;

// ─── Shell command whitelist ──────────────────────────────────────────────────

const SHELL_WHITELIST: RegExp[] = [
  /^npm test(\s|$)/,
  /^npm audit(\s|$)/,
  /^npm install(\s|$)(?!.*--global)/,
  /^npm run (test|lint|build|typecheck)(\s|$)/,
  /^npm outdated(\s|$)/,
  /^pip install(\s|$)/,
  /^pip list(\s|$)/,
  /^go test(\s|$)/,
  /^go build(\s|$)/,
  /^go vet(\s|$)/,
  /^python -m pytest(\s|$)/,
  /^cargo test(\s|$)/,
  /^cargo build(\s|$)/,
];

function isWhitelistedCommand(cmd: string): boolean {
  return SHELL_WHITELIST.some((re) => re.test(cmd.trim()));
}

// ─── Tool Definitions ─────────────────────────────────────────────────────────

const TOOL_DEFINITIONS: Anthropic.Tool[] = [
  {
    name: "read_file",
    description: "Read the contents of a file in the target repository.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description: "Relative path from the repo root, e.g. 'src/utils.ts' or 'package.json'",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "list_files",
    description: "List files and directories inside a directory in the target repository.",
    input_schema: {
      type: "object" as const,
      properties: {
        dir: {
          type: "string",
          description: "Relative directory path from the repo root, e.g. 'src' or '.' for root",
        },
      },
      required: ["dir"],
    },
  },
  {
    name: "write_file",
    description:
      "Write content to a file in the target repository. " +
      "Checks constraints, writes the file, runs the test suite, " +
      "and creates a session-labeled commit if tests pass. " +
      "Returns {ok: true, sha} on success or {ok: false, testOutput} on test failure.",
    input_schema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description: "Relative file path from repo root",
        },
        content: {
          type: "string",
          description: "Full content to write",
        },
        commitMessage: {
          type: "string",
          description: "Short commit message describing the change (without prefix)",
        },
      },
      required: ["path", "content", "commitMessage"],
    },
  },
  {
    name: "run_shell",
    description:
      "Run a whitelisted shell command in the target repo directory. " +
      "Allowed commands: npm test, npm audit, npm install (no --global), " +
      "npm run (test|lint|build|typecheck), npm outdated, " +
      "pip install, pip list, " +
      "go test, go build, go vet, " +
      "python -m pytest, cargo test, cargo build. " +
      "Any other command will be rejected without execution.",
    input_schema: {
      type: "object" as const,
      properties: {
        cmd: {
          type: "string",
          description: "The shell command to run",
        },
      },
      required: ["cmd"],
    },
  },
  {
    name: "file_issue",
    description:
      "File a GitHub Issue in the target repo for human review. " +
      "Use this to escalate work you cannot do autonomously, flag observations, " +
      "or request a human decision. Returns the issue number.",
    input_schema: {
      type: "object" as const,
      properties: {
        title: { type: "string", description: "Issue title" },
        body: { type: "string", description: "Issue body (markdown)" },
        urgent: {
          type: "boolean",
          description: "If true, adds the autopilot-urgent label",
        },
      },
      required: ["title", "body"],
    },
  },
  {
    name: "close_issue",
    description: "Close a GitHub Issue with a summary of work done.",
    input_schema: {
      type: "object" as const,
      properties: {
        number: { type: "number", description: "Issue number to close" },
        summary: { type: "string", description: "Summary of work completed" },
      },
      required: ["number", "summary"],
    },
  },
  {
    name: "propose_learning",
    description:
      "Propose a new cross-repo learning to be appended to LEARNINGS.md. " +
      "Only propose if you have seen this pattern in at least 2 distinct repos. " +
      "The proposal is queued and committed at session end.",
    input_schema: {
      type: "object" as const,
      properties: {
        title: { type: "string", description: "Short learning title" },
        body: {
          type: "string",
          description: "Detailed description of the pattern and how to apply it",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Technology/topic tags for searchability",
        },
        confirmedInRepos: {
          type: "array",
          items: { type: "string" },
          description: "Repo slugs (owner/repo) where this pattern was observed",
        },
      },
      required: ["title", "body", "tags", "confirmedInRepos"],
    },
  },
];

// ─── System Prompt Builder ────────────────────────────────────────────────────

function formatIssueQueue(issues: AutopilotIssue[]): string {
  if (issues.length === 0) return "(no open issues)";
  return issues
    .map(
      (i) =>
        `#${i.number} [${i.labels.join(", ")}]: ${i.title}\n  ${i.body.slice(0, 200).replace(/\n/g, " ")}${i.body.length > 200 ? "…" : ""}`
    )
    .join("\n\n");
}

function buildSystemPrompt(
  state: SessionState,
  healthFindings: HealthFinding[]
): string {
  const learningsSection =
    state.relevantLearnings.length > 0
      ? state.relevantLearnings.map(summarizeLearning).join("\n---\n")
      : "(no relevant learnings)";

  return [
    `You are Autopilot, an AI maintenance agent for the repository: ${state.ctx.repoSlug}`,
    ``,
    `## Your Identity Card (AGENT.md)`,
    state.agentMdContent,
    ``,
    `## Recent Session History (last 10 entries)`,
    state.recentJournalSummary || "(no previous sessions)",
    ``,
    `## Cross-Repo Knowledge (relevant learnings)`,
    learningsSection,
    ``,
    `## Open Issue Queue (${state.issueQueue.length} issues — process up to ${state.config.issues.maxIssuesProcessedPerSession})`,
    formatIssueQueue(state.issueQueue.slice(0, state.config.issues.maxIssuesProcessedPerSession)),
    ``,
    `## Health Findings This Session`,
    formatHealthFindings(healthFindings),
    ``,
    `## Session Configuration`,
    `- Session ID: ${state.sessionId.label}`,
    `- Trigger: ${state.ctx.triggerType}${state.ctx.triggerRef ? `:${state.ctx.triggerRef}` : ""}`,
    `- Max issues to process: ${state.config.issues.maxIssuesProcessedPerSession}`,
    `- Max issues to file: ${state.config.issues.maxIssuesFiledPerSession}`,
    ``,
    `## Instructions`,
    `Work through the issue queue in priority order (urgent first, then by position).`,
    `For each issue you pick up:`,
    `1. Post a pickup comment via close_issue (post it at the end when done)`,
    `2. Use read_file and list_files to understand the codebase`,
    `3. Use write_file to make changes (tests run and commit automatically)`,
    `4. Use run_shell for audit/test commands`,
    `5. Call close_issue when the work is complete`,
    ``,
    `If a health finding is critical, address it even if no issues are in the queue.`,
    `If work requires human judgment or is outside your constraints, use file_issue to escalate.`,
    ``,
    `IMPORTANT: Every action is checked against your constitutional constraints (in ## Autopilot Constraints above).`,
    `If a constraint blocks you, use file_issue to report it to humans. Never bypass constraints.`,
    ``,
    `When you have completed all feasible work, stop calling tools and return a JSON summary:`,
    `{"workDone": [...], "failedAttempts": [...], "observations": [...], "nextSessionHints": [...]}`,
  ].join("\n");
}

// ─── Final Summary Parser ─────────────────────────────────────────────────────

interface FinalSummary {
  workDone: string[];
  failedAttempts: string[];
  observations: string[];
  nextSessionHints: string[];
}

function parseAndApplyFinalSummary(
  content: Anthropic.ContentBlock[],
  state: SessionState
): void {
  const textBlocks = content.filter(
    (b): b is Anthropic.TextBlock => b.type === "text"
  );
  const fullText = textBlocks.map((b) => b.text).join("\n");

  // Extract JSON object from the text (may be wrapped in prose)
  const jsonMatch = fullText.match(/\{[\s\S]*"workDone"[\s\S]*\}/);
  if (!jsonMatch) {
    // No structured summary — just record the text as an observation
    if (fullText.trim()) {
      state.observations.push(`Session summary (unstructured): ${fullText.slice(0, 500)}`);
    }
    return;
  }

  try {
    const summary = JSON.parse(jsonMatch[0]) as FinalSummary;
    if (Array.isArray(summary.workDone)) {
      state.workDone.push(...summary.workDone);
    }
    if (Array.isArray(summary.failedAttempts)) {
      state.failedAttempts.push(...summary.failedAttempts);
    }
    if (Array.isArray(summary.observations)) {
      state.observations.push(...summary.observations);
    }
    if (Array.isArray(summary.nextSessionHints)) {
      state.nextSessionHints.push(...summary.nextSessionHints);
    }
  } catch {
    state.observations.push(`Could not parse final summary JSON: ${fullText.slice(0, 200)}`);
  }
}

// ─── Tool Executor ────────────────────────────────────────────────────────────

interface ToolResult {
  output?: string;
  ok?: boolean;
  error?: string;
  issueNumber?: number;
  sha?: string;
}

async function executeTool(
  name: string,
  input: Record<string, unknown>,
  state: SessionState,
  pendingLearnings: Array<Omit<Learning, "id">>
): Promise<ToolResult> {
  const repoPath = state.ctx.repoPath;

  try {
    switch (name) {
      case "read_file": {
        const filePath = String(input.path ?? "");
        // Prevent directory traversal
        if (filePath.includes("..")) {
          return { error: "Path traversal (..) not allowed" };
        }
        const absPath = path.join(repoPath, filePath);
        if (!fs.existsSync(absPath)) {
          return { error: `File not found: ${filePath}` };
        }
        const content = fs.readFileSync(absPath, "utf8");
        return { output: content.slice(0, 50_000) }; // cap to avoid flooding context
      }

      case "list_files": {
        const dir = String(input.dir ?? ".");
        if (dir.includes("..")) {
          return { error: "Path traversal (..) not allowed" };
        }
        const absDir = path.join(repoPath, dir);
        if (!fs.existsSync(absDir)) {
          return { error: `Directory not found: ${dir}` };
        }
        const entries = fs.readdirSync(absDir, { withFileTypes: true });
        const listing = entries
          .map((e) => `${e.isDirectory() ? "[dir]" : "[file]"} ${e.name}`)
          .join("\n");
        return { output: listing || "(empty directory)" };
      }

      case "write_file": {
        const filePath = String(input.path ?? "");
        const content = String(input.content ?? "");
        const commitMessage = String(input.commitMessage ?? "update file");

        if (filePath.includes("..")) {
          return { error: "Path traversal (..) not allowed" };
        }

        // Check constraints before writing
        const check = state.checkAction({
          description: commitMessage,
          filesTouched: [filePath],
          operationTypes: ["write"],
        });
        if (!check.allowed && check.violation) {
          await state.blockWithIssue({
            rule: check.violation.rule,
            proposedAction: commitMessage,
            filesTouched: [filePath],
          });
          return {
            error: `Blocked by constraint: "${check.violation.rule}". Filed issue for human review.`,
          };
        }

        const absPath = path.join(repoPath, filePath);
        const dir = path.dirname(absPath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }

        // Back up original content for revert
        const originalContent = fs.existsSync(absPath)
          ? fs.readFileSync(absPath, "utf8")
          : null;

        fs.writeFileSync(absPath, content, "utf8");

        // Run tests (detect test runner from package.json / go.mod / etc.)
        const testResult = runTests(repoPath);
        if (!testResult.ok) {
          // Revert on failure
          if (originalContent === null) {
            fs.unlinkSync(absPath);
          } else {
            fs.writeFileSync(absPath, originalContent, "utf8");
          }
          return {
            ok: false,
            error: `Tests failed — change reverted.\n${testResult.output.slice(0, 2000)}`,
          };
        }

        // Commit
        sessionCommit(repoPath, {
          message: commitMessage,
          files: [filePath],
          metadata: {
            sessionId: state.sessionId,
            triggerType: state.ctx.triggerType,
            repoSlug: state.ctx.repoSlug,
            issuesAddressed: state.issuesAddressed,
            issuesFiled: state.issuesFiled,
            learningsConsulted: state.relevantLearnings.map((l) => l.id),
            constraintsChecked: true,
          },
        });

        // Capture commit SHA
        let sha = "";
        try {
          sha = execSync(`git -C "${repoPath}" rev-parse --short HEAD`, {
            encoding: "utf8",
          }).trim();
          state.commitShas.push(sha);
        } catch {
          // non-fatal
        }

        return { ok: true, sha, output: `File written and committed (${sha})` };
      }

      case "run_shell": {
        const cmd = String(input.cmd ?? "");
        if (!isWhitelistedCommand(cmd)) {
          return {
            error: `Command not allowed: "${cmd}". Only whitelisted commands are permitted.`,
          };
        }
        try {
          const output = execSync(cmd, {
            cwd: repoPath,
            timeout: 60_000,
            encoding: "utf8",
            stdio: ["pipe", "pipe", "pipe"],
          });
          return { ok: true, output: output.slice(0, 5000) };
        } catch (err: unknown) {
          const anyErr = err as { stdout?: string; stderr?: string; message?: string };
          const output = [anyErr.stdout, anyErr.stderr, anyErr.message]
            .filter(Boolean)
            .join("\n")
            .slice(0, 3000);
          return { ok: false, output, error: "Command exited non-zero" };
        }
      }

      case "file_issue": {
        if (state.issuesFiled.length >= state.config.issues.maxIssuesFiledPerSession) {
          return {
            error: `Issue filing limit reached (${state.config.issues.maxIssuesFiledPerSession}/session)`,
          };
        }
        const title = String(input.title ?? "Autopilot observation");
        const body = String(input.body ?? "");
        const urgent = Boolean(input.urgent ?? false);
        const labels: Array<"autopilot-filed" | "autopilot-urgent"> = ["autopilot-filed"];
        if (urgent) labels.push("autopilot-urgent");

        const issueNumber = await fileIssue(state.ctx.repoSlug, state.sessionId, {
          title,
          body,
          labels,
        });
        state.issuesFiled.push(issueNumber);
        return { ok: true, issueNumber, output: `Filed issue #${issueNumber}` };
      }

      case "close_issue": {
        const number = Number(input.number ?? 0);
        const summary = String(input.summary ?? "");
        if (!number) {
          return { error: "issue number is required" };
        }
        await postPickupComment(state.ctx.repoSlug, number, state.sessionId);
        await closeIssueWithSummary(
          state.ctx.repoSlug,
          number,
          state.sessionId,
          summary,
          state.commitShas
        );
        state.issuesAddressed.push(number);
        return { ok: true, output: `Closed issue #${number}` };
      }

      case "propose_learning": {
        const title = String(input.title ?? "");
        const body = String(input.body ?? "");
        const tags = Array.isArray(input.tags)
          ? (input.tags as unknown[]).map(String)
          : [];
        const confirmedInRepos = Array.isArray(input.confirmedInRepos)
          ? (input.confirmedInRepos as unknown[]).map(String)
          : [];

        if (!qualifiesForLearning(confirmedInRepos)) {
          return {
            error: `Learning not queued: needs ≥2 confirmed repos, got ${confirmedInRepos.length}`,
          };
        }

        pendingLearnings.push({
          title,
          body,
          tags,
          confirmedInRepos,
          learnedAt: new Date().toISOString().split("T")[0],
          source: `repo:${state.ctx.repoSlug}, session:${state.sessionId.label}`,
        });
        return { ok: true, output: `Learning "${title}" queued for end-of-session commit` };
      }

      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (err) {
    return { error: `Tool error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ─── Test Runner ──────────────────────────────────────────────────────────────

function runTests(repoPath: string): { ok: boolean; output: string } {
  // Detect test runner
  let testCmd: string | null = null;

  if (fs.existsSync(path.join(repoPath, "package.json"))) {
    testCmd = "npm test --if-present";
  } else if (fs.existsSync(path.join(repoPath, "go.mod"))) {
    testCmd = "go test ./...";
  } else if (fs.existsSync(path.join(repoPath, "requirements.txt"))) {
    testCmd = "python -m pytest";
  } else if (fs.existsSync(path.join(repoPath, "Cargo.toml"))) {
    testCmd = "cargo test";
  }

  if (!testCmd) {
    // No test runner detected — treat as passing
    return { ok: true, output: "(no test runner detected — assuming pass)" };
  }

  try {
    const output = execSync(testCmd, {
      cwd: repoPath,
      timeout: 120_000,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { ok: true, output };
  } catch (err: unknown) {
    const anyErr = err as { stdout?: string; stderr?: string; message?: string };
    const output = [anyErr.stdout, anyErr.stderr, anyErr.message]
      .filter(Boolean)
      .join("\n");
    return { ok: false, output };
  }
}

// ─── Agentic Loop ─────────────────────────────────────────────────────────────

async function runAgentLoop(
  state: SessionState,
  healthFindings: HealthFinding[]
): Promise<void> {
  const client = new Anthropic();
  const messages: Anthropic.MessageParam[] = [];
  const pendingLearnings: Array<Omit<Learning, "id">> = [];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: buildSystemPrompt(state, healthFindings),
      tools: TOOL_DEFINITIONS,
      messages,
    });

    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason === "end_turn") {
      parseAndApplyFinalSummary(response.content, state);
      break;
    }

    if (response.stop_reason !== "tool_use") {
      state.observations.push(`Agent loop ended with stop_reason: ${response.stop_reason}`);
      break;
    }

    // Collect all tool_use blocks and execute them
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== "tool_use") continue;

      const result = await executeTool(
        block.name,
        block.input as Record<string, unknown>,
        state,
        pendingLearnings
      );

      toolResults.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: JSON.stringify(result),
      });
    }

    messages.push({ role: "user", content: toolResults });
  }

  // Flush pending learning proposals
  for (const candidate of pendingLearnings) {
    try {
      const l = appendLearning(state.ctx.autopilotRepoPath, candidate);
      state.learningsAppended.push(l.id);
    } catch (err) {
      state.observations.push(
        `Learning "${candidate.title}" not appended: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}

// ─── Entry Point ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const ctx = sessionContextFromEnv();
  logSessionContext(ctx);

  await runSession(ctx, async (state: SessionState) => {
    const healthFindings = await runHealthChecks(
      state.ctx.repoPath,
      state.ctx.repoSlug,
      state.config
    );

    await runAgentLoop(state, healthFindings);
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
