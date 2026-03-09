/**
 * src/onboarding.ts
 *
 * Entry point: node dist/onboarding.js
 *
 * Sets up a target repository for Autopilot management. Runs two Claude API
 * calls to generate an AGENT.md via a structured interview, then installs
 * all required template files, creates GitHub labels, and commits everything.
 *
 * Modes:
 *   Interactive (default): Prints interview questions to stdout, reads answers
 *                          from stdin one line at a time.
 *   CI mode:               Set CI_ANSWERS={"Q": "A"} JSON env var to skip stdin.
 *
 * Env vars required:
 *   TARGET_REPO_PATH     — absolute path to the target repo
 *   TARGET_REPO_SLUG     — owner/repo of the target repo
 *   AUTOPILOT_REPO_PATH  — absolute path to the Autopilot repo
 *   AUTOPILOT_REPO_SLUG  — owner/repo of the Autopilot repo
 *   ANTHROPIC_API_KEY    — Claude API key
 *   GITHUB_TOKEN         — GitHub personal access token
 *   CI_ANSWERS           — (optional) JSON map of question → answer for CI mode
 */

import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import * as yaml from "js-yaml";

import Anthropic from "@anthropic-ai/sdk";

import { makeSessionId, sessionCommit } from "./commit.js";
import {
  generateConstitutionalHash,
} from "./constraints.js";
import { ensureLabels } from "./issues.js";
import { AutopilotConfig } from "./types.js";

// ─── Repo Snapshot ────────────────────────────────────────────────────────────

/**
 * Read key files from the target repo to build an analysis snapshot
 * for Claude's interview question generation.
 */
function readRepoSnapshot(repoPath: string): string {
  const sections: string[] = [];

  const tryRead = (
    filePath: string,
    label: string,
    maxChars = 3000
  ): void => {
    const absPath = path.join(repoPath, filePath);
    if (!fs.existsSync(absPath)) return;
    const content = fs.readFileSync(absPath, "utf8").slice(0, maxChars);
    sections.push(`### ${label}\n\`\`\`\n${content}\n\`\`\``);
  };

  tryRead("package.json", "package.json", 2000);
  tryRead("requirements.txt", "requirements.txt", 1000);
  tryRead("go.mod", "go.mod", 1000);
  tryRead("Cargo.toml", "Cargo.toml", 1000);
  tryRead("README.md", "README.md", 3000);

  // Existing AGENT.md (for re-onboarding)
  tryRead("AGENT.md", "Existing AGENT.md", 3000);

  // Top-level directory listing
  try {
    const entries = fs.readdirSync(repoPath, { withFileTypes: true });
    const listing = entries
      .map((e) => `${e.isDirectory() ? "[dir]" : "[file]"} ${e.name}`)
      .join("\n");
    sections.push(`### Top-level files\n${listing}`);
  } catch {
    // ignore
  }

  // src/ or lib/ listing
  for (const srcDir of ["src", "lib", "app"]) {
    const absDir = path.join(repoPath, srcDir);
    if (fs.existsSync(absDir)) {
      try {
        const entries = fs.readdirSync(absDir, { withFileTypes: true });
        const listing = entries
          .slice(0, 30)
          .map((e) => `${e.isDirectory() ? "[dir]" : "[file]"} ${e.name}`)
          .join("\n");
        sections.push(`### ${srcDir}/ contents\n${listing}`);
      } catch {
        // ignore
      }
      break;
    }
  }

  return sections.join("\n\n");
}

// ─── Interview Question Generation ───────────────────────────────────────────

async function generateInterviewQuestions(snapshot: string): Promise<string[]> {
  const client = new Anthropic();

  const response = await client.messages.create({
    model: "claude-opus-4-6",
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: [
          `You are setting up an AI maintenance agent for the following repository.`,
          ``,
          `## Repository Snapshot`,
          snapshot,
          ``,
          `Generate 5-8 specific interview questions to elicit the constraints and`,
          `off-limits areas that the agent must never touch autonomously.`,
          `Focus on: deployment pipelines, secrets and credentials, schema migrations,`,
          `public API endpoints, test coverage thresholds, release processes,`,
          `and any domain-specific invariants unique to this codebase.`,
          ``,
          `Return a numbered list only — no preamble, no explanation.`,
        ].join("\n"),
      },
    ],
  });

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");

  // Parse numbered list into individual questions
  const questions = text
    .split(/\n(?=\d+[.)]\s)/)
    .map((q) => q.replace(/^\d+[.)]\s*/, "").trim())
    .filter((q) => q.length > 10);

  return questions.length > 0
    ? questions
    : ["What files or paths should the agent never modify autonomously?",
       "Are there any deployment or release processes that require human approval?",
       "What is the minimum acceptable test coverage percentage?",
       "Are there public APIs or database schemas that should never be changed without review?",
       "What secrets management approach does this repo use?"];
}

// ─── Answer Collection ────────────────────────────────────────────────────────

async function collectAnswers(
  questions: string[]
): Promise<Record<string, string>> {
  // CI mode: parse pre-supplied answers
  const ciAnswersJson = process.env.CI_ANSWERS;
  if (ciAnswersJson) {
    try {
      const answers = JSON.parse(ciAnswersJson) as Record<string, string>;
      console.log("CI mode: using pre-supplied answers.");
      return answers;
    } catch (err) {
      throw new Error(`CI_ANSWERS is not valid JSON: ${err}`);
    }
  }

  // Interactive mode
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const readLine = (prompt: string): Promise<string> =>
    new Promise((resolve) => rl.question(prompt, resolve));

  console.log("\n" + "=".repeat(60));
  console.log("AUTOPILOT ONBOARDING INTERVIEW");
  console.log("=".repeat(60));
  console.log(
    "Answer the following questions to configure the agent's constraints."
  );
  console.log("Press Enter to accept the default for any question.\n");

  const answers: Record<string, string> = {};
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const answer = await readLine(`${i + 1}. ${q}\n> `);
    answers[q] = answer.trim();
  }

  rl.close();
  return answers;
}

// ─── AGENT.md Generation ─────────────────────────────────────────────────────

async function generateAgentMd(
  snapshot: string,
  questions: string[],
  answers: Record<string, string>,
  constraintsTemplate: string
): Promise<string> {
  const client = new Anthropic();

  const qaSection = questions
    .map((q, i) => `Q${i + 1}: ${q}\nA: ${answers[q] ?? "(no answer)"}`)
    .join("\n\n");

  const response = await client.messages.create({
    model: "claude-opus-4-6",
    max_tokens: 4096,
    messages: [
      {
        role: "user",
        content: [
          `You are generating AGENT.md for an AI maintenance agent.`,
          ``,
          `## Repository Snapshot`,
          snapshot,
          ``,
          `## Interview Q&A`,
          qaSection,
          ``,
          `## Constraints Section Template`,
          constraintsTemplate,
          ``,
          `Generate a complete AGENT.md with exactly these sections in order:`,
          ``,
          `1. Tags: (comma-separated tech stack tags for LEARNINGS.md matching, e.g. "typescript, node, express")`,
          ``,
          `2. ## Purpose`,
          `   One paragraph describing what this repo does and why Autopilot is managing it.`,
          ``,
          `3. ## Tech Stack`,
          `   Bullet list of languages, frameworks, and key dependencies.`,
          ``,
          `4. ## Key Invariants`,
          `   Architectural rules Claude must know: data flow, naming conventions,`,
          `   important patterns, things that look odd but are intentional.`,
          ``,
          `5. ## Autopilot Constraints`,
          `   Use the template above. Replace every <placeholder> with specific values`,
          `   derived from the interview answers. Keep the comment block at the top.`,
          `   Every constraint must start with "- ".`,
          `   Include all rules the operator needs enforced — be specific, not generic.`,
          ``,
          `Output only the AGENT.md content — no preamble, no explanation.`,
        ].join("\n"),
      },
    ],
  });

  return response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}

// ─── Template Installation ────────────────────────────────────────────────────

function installTemplate(
  sourceDir: string,
  sourceRelPath: string,
  targetDir: string,
  targetRelPath: string,
  overwrite = false
): void {
  const sourcePath = path.join(sourceDir, sourceRelPath);
  const targetPath = path.join(targetDir, targetRelPath);

  if (!fs.existsSync(sourcePath)) {
    console.warn(`Template not found: ${sourceRelPath} — skipping`);
    return;
  }

  if (!overwrite && fs.existsSync(targetPath)) {
    console.log(`  Already exists: ${targetRelPath} — skipping`);
    return;
  }

  const targetParent = path.dirname(targetPath);
  if (!fs.existsSync(targetParent)) {
    fs.mkdirSync(targetParent, { recursive: true });
  }

  fs.copyFileSync(sourcePath, targetPath);
  console.log(`  Installed: ${targetRelPath}`);
}

// ─── Config Generation ────────────────────────────────────────────────────────

function generateConfig(
  autopilotRepoPath: string,
  constitutionalHash: string,
  autopilotRepoSlug: string
): string {
  const templatePath = path.join(autopilotRepoPath, "templates/autopilot.yml");
  let config = fs.readFileSync(templatePath, "utf8");

  // Inject constitutional_hash
  config = config.replace(
    /constitutional_hash:\s*""\s*#.*$/m,
    `constitutional_hash: "${constitutionalHash}"`
  );

  // Inject Autopilot repo slug into comment
  config = config.replace(
    "https://github.com/<AUTOPILOT_REPO_SLUG>",
    `https://github.com/${autopilotRepoSlug}`
  );

  return config;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const required = (name: string): string => {
    const val = process.env[name];
    if (!val) throw new Error(`Required env var ${name} is not set`);
    return val;
  };

  const targetRepoPath = required("TARGET_REPO_PATH");
  const targetRepoSlug = required("TARGET_REPO_SLUG");
  const autopilotRepoPath = required("AUTOPILOT_REPO_PATH");
  const autopilotRepoSlug = required("AUTOPILOT_REPO_SLUG");

  console.log("\n" + "=".repeat(60));
  console.log(`AUTOPILOT ONBOARDING — ${targetRepoSlug}`);
  console.log("=".repeat(60));

  // Step 1: Read repo snapshot
  console.log("\nStep 1: Reading repository snapshot...");
  const snapshot = readRepoSnapshot(targetRepoPath);

  // Step 2: Generate interview questions
  console.log("Step 2: Generating interview questions via Claude...");
  const questions = await generateInterviewQuestions(snapshot);
  console.log(`  Generated ${questions.length} questions.`);

  // Step 3: Collect answers
  const answers = await collectAnswers(questions);

  // Step 4: Generate AGENT.md
  console.log("\nStep 4: Generating AGENT.md via Claude...");
  const constraintsTemplatePath = path.join(
    autopilotRepoPath,
    "templates/AGENT_CONSTRAINTS_SECTION.md"
  );
  const constraintsTemplate = fs.readFileSync(constraintsTemplatePath, "utf8");
  const agentMdContent = await generateAgentMd(
    snapshot,
    questions,
    answers,
    constraintsTemplate
  );

  // Write AGENT.md to target repo
  const agentMdPath = path.join(targetRepoPath, "AGENT.md");
  fs.writeFileSync(agentMdPath, agentMdContent, "utf8");
  console.log("  AGENT.md written.");

  // Step 5: Compute constitutional hash
  console.log("Step 5: Computing constitutional hash...");
  const constitutionalHash = generateConstitutionalHash(targetRepoPath);
  console.log(`  Hash: ${constitutionalHash}`);

  // Step 6: Write .autopilot.yml
  console.log("Step 6: Writing .autopilot.yml...");
  const configContent = generateConfig(
    autopilotRepoPath,
    constitutionalHash,
    autopilotRepoSlug
  );
  fs.writeFileSync(
    path.join(targetRepoPath, ".autopilot.yml"),
    configContent,
    "utf8"
  );
  console.log("  .autopilot.yml written.");

  // Step 7: Install template files
  console.log("Step 7: Installing template files...");
  const templateDir = path.join(autopilotRepoPath, "templates");
  const filesToInstall = [
    {
      src: "AUTOPILOT_JOURNAL.md",
      dst: "AUTOPILOT_JOURNAL.md",
    },
    {
      src: ".github/workflows/autopilot-session.yml",
      dst: ".github/workflows/autopilot-session.yml",
    },
    {
      src: ".github/workflows/autopilot-pr-sync.yml",
      dst: ".github/workflows/autopilot-pr-sync.yml",
    },
    {
      src: ".github/ISSUE_TEMPLATE/autopilot-request.yml",
      dst: ".github/ISSUE_TEMPLATE/autopilot-request.yml",
    },
  ];
  for (const { src, dst } of filesToInstall) {
    installTemplate(templateDir, src, targetRepoPath, dst);
  }

  // Step 8: Ensure GitHub labels
  console.log("Step 8: Ensuring GitHub labels...");
  const config = yaml.load(configContent) as AutopilotConfig;
  await ensureLabels(targetRepoSlug, config);
  console.log("  Labels created/verified.");

  // Step 9: Commit
  console.log("Step 9: Committing onboarding changes...");
  const sessionId = makeSessionId();
  const installedFiles = [
    "AGENT.md",
    ".autopilot.yml",
    ...filesToInstall
      .map((f) => f.dst)
      .filter((dst) =>
        fs.existsSync(path.join(targetRepoPath, dst))
      ),
  ];

  sessionCommit(targetRepoPath, {
    message: "chore: autopilot onboarding",
    files: installedFiles,
    metadata: {
      sessionId,
      triggerType: "manual",
      repoSlug: targetRepoSlug,
      issuesAddressed: [],
      issuesFiled: [],
      learningsConsulted: [],
      constraintsChecked: true,
    },
  });

  console.log("\n" + "=".repeat(60));
  console.log("ONBOARDING COMPLETE");
  console.log("=".repeat(60));
  console.log(`\nAutopilot is now configured for ${targetRepoSlug}.`);
  console.log("\nNext steps:");
  console.log("  1. Review AGENT.md and adjust constraints if needed");
  console.log("  2. Push this commit to the target repo");
  console.log("  3. Set AUTOPILOT_TOKEN and ANTHROPIC_API_KEY secrets in the target repo");
  console.log("  4. Set AUTOPILOT_REPO_SLUG variable in the target repo");
  console.log("  5. Open an issue with label 'autopilot-input' to assign work");
  console.log("");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
