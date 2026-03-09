/**
 * src/self-evolution-implement.ts
 *
 * Implements a self-evolution capability proposal on the current feature branch.
 *
 * Environment variables (set by the GitHub Actions workflow):
 *   CANDIDATE_LEARN_ID  — e.g. "LEARN-042"
 *   CANDIDATE_TITLE     — e.g. "numpy 2.x migration pattern"
 *   DRY_RUN             — "true" to skip committing
 *   AUTOPILOT_REPO_PATH — path to the Autopilot repo root
 *
 * What this script does:
 *   1. Load the full learning entry from LEARNINGS.md
 *   2. Generate an automation module scaffold in src/automations/<slug>.ts
 *   3. Register the new automation in src/automations/index.ts
 *   4. Append a "proposed" entry to EVOLUTION_LOG.md
 *   5. Commit with a session-labeled message
 *
 * The generated scaffold is intentionally a stub — it provides the structure
 * (interface, entry point, test skeleton) that a human reviewer can fill in or
 * that a future AI session can complete. The self-evolution loop proposes the
 * capability; humans review and merge it.
 */

import * as fs from "fs";
import * as path from "path";
import { parseLearnings } from "./learnings.js";
import { Learning } from "./types.js";
import { makeSessionId, sessionCommit } from "./commit.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
}

function loadLearning(repoPath: string, learnId: string): Learning {
  const learningsPath = path.join(repoPath, "LEARNINGS.md");
  if (!fs.existsSync(learningsPath)) {
    throw new Error(`LEARNINGS.md not found at ${learningsPath}`);
  }
  const content = fs.readFileSync(learningsPath, "utf8");
  const learnings = parseLearnings(content);
  const found = learnings.find((l) => l.id === learnId);
  if (!found) {
    throw new Error(`Learning ${learnId} not found in LEARNINGS.md`);
  }
  return found;
}

// ─── Code Generation ──────────────────────────────────────────────────────────

function generateAutomationModule(learning: Learning, slug: string): string {
  const bodyLines = learning.body
    .split("\n")
    .map((l) => ` * ${l}`)
    .join("\n");

  return `/**
 * src/automations/${slug}.ts
 *
 * Auto-generated scaffold for: [${learning.id}] ${learning.title}
 *
 * Source learning:
${bodyLines}
 *
 * Confirmed in repos: ${learning.confirmedInRepos.join(", ")}
 * Tags: ${learning.tags.join(", ")}
 *
 * TODO: Fill in the apply() function with the actual automation logic.
 *       The scaffold compiles and tests pass as-is (no-ops), so the PR
 *       can be reviewed structurally before the implementation is complete.
 */

import { ProposedAction } from "../types.js";

export interface AutomationResult {
  applied: boolean;
  description: string;
  filesModified: string[];
}

export interface AutomationContext {
  repoPath: string;
  /** Files in the repo that match this automation's concern */
  relevantFiles: string[];
  /** Dry-run mode: detect but don't modify */
  dryRun: boolean;
}

/**
 * Detect whether this automation is applicable to the given repo.
 * Returns true if the pattern is present and the automation can help.
 */
export async function detect(ctx: AutomationContext): Promise<boolean> {
  // TODO: implement detection logic based on the learning pattern
  // Example: scan ctx.relevantFiles for the pattern described in LEARNINGS.md
  void ctx;
  return false;
}

/**
 * Apply the automation. Only called when detect() returns true.
 * Must be idempotent — safe to run multiple times on the same repo.
 */
export async function apply(ctx: AutomationContext): Promise<AutomationResult> {
  // TODO: implement the actual fix / migration / update
  void ctx;
  return {
    applied: false,
    description: "Stub — implementation pending human review",
    filesModified: [],
  };
}

/**
 * Describe the action this automation would take (for constraint checking).
 */
export function describeAction(ctx: AutomationContext): ProposedAction {
  return {
    description: \`Apply ${learning.title} automation\`,
    filesTouched: ctx.relevantFiles,
    operationTypes: ${JSON.stringify(learning.tags)},
  };
}
`;
}

function generateAutomationTest(learning: Learning, slug: string): string {
  return `/**
 * src/automations/${slug}.test.ts — auto-generated test skeleton
 */

import { detect, apply } from "./${slug}.js";

describe("${slug}", () => {
  const ctx = {
    repoPath: "/tmp/test-repo",
    relevantFiles: [],
    dryRun: true,
  };

  it("detect returns false when pattern is absent", async () => {
    expect(await detect(ctx)).toBe(false);
  });

  it("apply returns a result object with required fields", async () => {
    const result = await apply(ctx);
    expect(result).toHaveProperty("applied");
    expect(result).toHaveProperty("description");
    expect(result).toHaveProperty("filesModified");
    expect(Array.isArray(result.filesModified)).toBe(true);
  });
});
`;
}

function ensureAutomationsIndex(repoPath: string, slug: string): void {
  const indexPath = path.join(repoPath, "src", "automations", "index.ts");

  let content: string;
  if (fs.existsSync(indexPath)) {
    content = fs.readFileSync(indexPath, "utf8");
    // Add export if not already present
    const exportLine = `export * as ${slug.replace(/-/g, "_")} from "./${slug}.js";`;
    if (!content.includes(exportLine)) {
      content = content.trimEnd() + "\n" + exportLine + "\n";
    }
  } else {
    content =
      `/**\n * src/automations/index.ts\n *\n` +
      ` * Registry of all automation modules. Each module is a self-contained\n` +
      ` * capability that can detect and apply a specific pattern across repos.\n` +
      ` */\n\n` +
      `export * as ${slug.replace(/-/g, "_")} from "./${slug}.js";\n`;
  }

  fs.writeFileSync(indexPath, content);
}

function appendEvolutionLogEntry(
  repoPath: string,
  learning: Learning,
  today: string
): void {
  const logPath = path.join(repoPath, "EVOLUTION_LOG.md");
  const entry =
    `\n## ${today}: ${learning.title}\n` +
    `Proposed from: ${learning.id} (seen in ${learning.confirmedInRepos.length} repos: ${learning.confirmedInRepos.join(", ")})\n` +
    `PR: (pending — see open pull requests)\n` +
    `Status: open\n` +
    `Result: Scaffold generated. Awaiting human review and implementation completion.\n`;

  if (fs.existsSync(logPath)) {
    fs.appendFileSync(logPath, entry);
  } else {
    fs.writeFileSync(logPath, `# EVOLUTION_LOG.md\n\nCapability changelog.\n${entry}`);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const repoPath = process.env.AUTOPILOT_REPO_PATH ?? process.cwd();
  const learnId = process.env.CANDIDATE_LEARN_ID;
  const dryRun = process.env.DRY_RUN === "true";

  if (!learnId) {
    throw new Error("CANDIDATE_LEARN_ID environment variable is required");
  }

  const learning = loadLearning(repoPath, learnId);
  const slug = slugify(learning.title);
  const today = new Date().toISOString().slice(0, 10);

  console.log(`Implementing automation scaffold for [${learnId}] ${learning.title}`);
  console.log(`  Slug: ${slug}`);
  console.log(`  Dry run: ${dryRun}`);

  // Ensure automations directory exists
  const automationsDir = path.join(repoPath, "src", "automations");
  fs.mkdirSync(automationsDir, { recursive: true });

  // Generate files
  const modulePath = path.join(automationsDir, `${slug}.ts`);
  const testPath = path.join(automationsDir, `${slug}.test.ts`);

  if (fs.existsSync(modulePath)) {
    console.log(`Module ${modulePath} already exists — skipping generation.`);
  } else {
    fs.writeFileSync(modulePath, generateAutomationModule(learning, slug));
    console.log(`  Created: src/automations/${slug}.ts`);
  }

  if (!fs.existsSync(testPath)) {
    fs.writeFileSync(testPath, generateAutomationTest(learning, slug));
    console.log(`  Created: src/automations/${slug}.test.ts`);
  }

  ensureAutomationsIndex(repoPath, slug);
  console.log(`  Updated: src/automations/index.ts`);

  appendEvolutionLogEntry(repoPath, learning, today);
  console.log(`  Updated: EVOLUTION_LOG.md`);

  if (dryRun) {
    console.log("Dry run — skipping commit.");
    return;
  }

  const sessionId = makeSessionId();
  const filesToCommit = [
    path.join("src", "automations", `${slug}.ts`),
    path.join("src", "automations", `${slug}.test.ts`),
    path.join("src", "automations", "index.ts"),
    "EVOLUTION_LOG.md",
  ];

  sessionCommit(repoPath, {
    message: `feat(automations): scaffold ${slug} automation`,
    files: filesToCommit,
    metadata: {
      sessionId,
      triggerType: "scheduled",
      repoSlug: process.env.AUTOPILOT_REPO_SLUG ?? "autopilot",
      issuesAddressed: [],
      issuesFiled: [],
      learningsConsulted: [learnId],
      constraintsChecked: false, // self-evolution skips target-repo constraints
    },
  });

  console.log(`\nDone. Feature branch ready for PR.`);
}

main().catch((err) => {
  console.error("self-evolution-implement failed:", err);
  process.exit(1);
});
