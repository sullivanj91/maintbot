/**
 * src/pr-sync.ts
 *
 * Entry point: node dist/pr-sync.js
 *
 * Called when a PR is merged in a managed target repo (via the
 * autopilot-pr-sync.yml workflow). Reads the PR diff, asks Claude to suggest
 * which sections of AGENT.md should be updated, applies those changes, and
 * commits the result.
 *
 * Critical invariant: The "## Autopilot Constraints" section is NEVER touched.
 * Any patch attempting to modify it is rejected and the session aborts.
 *
 * Env vars required:
 *   TARGET_REPO_PATH    — absolute path to the target repo
 *   TARGET_REPO_SLUG    — owner/repo of the target repo
 *   PR_NUMBER           — number of the merged PR
 *   AUTOPILOT_REPO_PATH — absolute path to the Autopilot repo
 *   AUTOPILOT_REPO_SLUG — owner/repo of the Autopilot repo
 *   ANTHROPIC_API_KEY   — Claude API key
 *   GITHUB_TOKEN        — GitHub personal access token
 */

import * as fs from "fs";
import * as path from "path";

import Anthropic from "@anthropic-ai/sdk";
import { Octokit } from "@octokit/rest";

import { makeSessionId, sessionCommit } from "./commit.js";
import {
  readAgentMd,
  extractConstraintsSection,
  verifyConstraintsHash,
  hashConstraintsSection,
} from "./constraints.js";
import { loadConfig } from "./session.js";

// ─── Patch Types ──────────────────────────────────────────────────────────────

interface PatchOp {
  section: string;
  action: "replace" | "append";
  newContent: string;
}

// ─── Fetch PR Diff ────────────────────────────────────────────────────────────

async function fetchPrDiff(
  repoSlug: string,
  prNumber: number
): Promise<string> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN is required");

  const octokit = new Octokit({ auth: token });
  const [owner, repo] = repoSlug.split("/");

  const { data: files } = await octokit.pulls.listFiles({
    owner,
    repo,
    pull_number: prNumber,
    per_page: 50,
  });

  // Collect file diffs, capped to keep within Claude's context window
  const chunks: string[] = [];
  let totalChars = 0;
  const MAX_CHARS = 6000;

  for (const file of files) {
    if (totalChars >= MAX_CHARS) break;
    const patch = file.patch ?? "(binary or no diff)";
    const chunk =
      `### ${file.filename} (+${file.additions}/-${file.deletions})\n` +
      patch.slice(0, 800);
    chunks.push(chunk);
    totalChars += chunk.length;
  }

  return chunks.join("\n\n") || "(no file changes)";
}

// ─── Claude: Generate Patches ─────────────────────────────────────────────────

async function generatePatches(
  agentMdContent: string,
  diffSummary: string,
  prNumber: number
): Promise<PatchOp[]> {
  const client = new Anthropic();

  const prompt = [
    `You are updating AGENT.md after PR #${prNumber} was merged.`,
    ``,
    `## Current AGENT.md`,
    agentMdContent,
    ``,
    `## Merged PR #${prNumber} — Changed Files`,
    diffSummary,
    ``,
    `Your task: identify which sections of AGENT.md need updating based on the PR changes.`,
    `Return a JSON array of patch operations. Each operation has:`,
    `  { "section": "## Section Name", "action": "replace" | "append", "newContent": "..." }`,
    ``,
    `CRITICAL RULES:`,
    `- NEVER include "## Autopilot Constraints" in your output. Do not patch this section under any circumstances.`,
    `- Only update sections genuinely affected by the PR's changes.`,
    `- Use "replace" to replace the entire section content; "append" to add text at the end of a section.`,
    `- If no update is needed, return an empty array: []`,
    `- Return valid JSON only, no prose, no markdown fences.`,
  ].join("\n");

  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 2048,
    messages: [{ role: "user", content: prompt }],
  });

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

  // Extract JSON array from response (handle possible prose wrapping)
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    console.log("Claude returned no JSON array — no patches to apply.");
    return [];
  }

  try {
    return JSON.parse(jsonMatch[0]) as PatchOp[];
  } catch (err) {
    console.warn("Failed to parse Claude's patch output:", text.slice(0, 500));
    return [];
  }
}

// ─── Apply Patches ────────────────────────────────────────────────────────────

function applySinglePatch(content: string, patch: PatchOp): string {
  const lines = content.split("\n");
  const sectionStart = lines.findIndex(
    (l) => l.trim() === patch.section.trim()
  );

  if (sectionStart === -1) {
    console.warn(`Section "${patch.section}" not found in AGENT.md — skipping patch`);
    return content;
  }

  // Find where this section ends (next ## heading or EOF)
  let sectionEnd = lines.length;
  for (let i = sectionStart + 1; i < lines.length; i++) {
    if (lines[i].startsWith("## ")) {
      sectionEnd = i;
      break;
    }
  }

  const before = lines.slice(0, sectionStart + 1); // include header line
  const after = lines.slice(sectionEnd);

  if (patch.action === "replace") {
    return [...before, "", patch.newContent, ""].concat(after).join("\n");
  } else {
    // append: insert new content before the next section
    const sectionContent = lines.slice(sectionStart + 1, sectionEnd);
    return [...before, ...sectionContent, "", patch.newContent, ""]
      .concat(after)
      .join("\n");
  }
}

function applyPatches(agentMd: string, patches: PatchOp[]): string {
  // Safety check: reject any patch targeting ## Autopilot Constraints
  const forbidden = patches.filter((p) =>
    p.section.includes("Autopilot Constraints")
  );
  if (forbidden.length > 0) {
    throw new Error(
      `Claude attempted to patch ## Autopilot Constraints (${forbidden.length} op(s)) — rejected. ` +
        `This section is constitutionally protected.`
    );
  }

  let result = agentMd;
  for (const patch of patches) {
    result = applySinglePatch(result, patch);
  }
  return result;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const required = (name: string): string => {
    const val = process.env[name];
    if (!val) throw new Error(`Required env var ${name} is not set`);
    return val;
  };

  const repoPath = required("TARGET_REPO_PATH");
  const repoSlug = required("TARGET_REPO_SLUG");
  const prNumberStr = required("PR_NUMBER");
  const prNumber = parseInt(prNumberStr, 10);

  if (isNaN(prNumber)) {
    throw new Error(`PR_NUMBER must be a number, got: "${prNumberStr}"`);
  }

  console.log(`\nAutopilot PR Sync — PR #${prNumber} in ${repoSlug}`);
  console.log("=".repeat(60));

  // Load config and current AGENT.md
  const config = loadConfig(repoPath);
  const agentMdContent = readAgentMd(repoPath);

  // Capture constraints section before patching (for post-patch verification)
  const originalConstraintsSection = extractConstraintsSection(agentMdContent);
  if (!originalConstraintsSection) {
    throw new Error("AGENT.md is missing ## Autopilot Constraints — cannot safely apply patches");
  }

  // Verify hash integrity before we start
  verifyConstraintsHash(agentMdContent, config);
  console.log("Constitutional hash verified.");

  // Fetch PR diff
  console.log(`Fetching diff for PR #${prNumber}...`);
  const diffSummary = await fetchPrDiff(repoSlug, prNumber);

  // Ask Claude to generate patches
  console.log("Asking Claude to generate AGENT.md patches...");
  const patches = await generatePatches(agentMdContent, diffSummary, prNumber);

  if (patches.length === 0) {
    console.log("No patches needed — AGENT.md is up to date.");
    return;
  }

  console.log(`Applying ${patches.length} patch(es) to AGENT.md...`);

  // Apply patches (throws if constraints section targeted)
  const updatedContent = applyPatches(agentMdContent, patches);

  // Post-patch verification: constraints section must be byte-for-byte identical
  const updatedConstraintsSection = extractConstraintsSection(updatedContent);
  if (
    !updatedConstraintsSection ||
    updatedConstraintsSection !== originalConstraintsSection
  ) {
    throw new Error(
      "Post-patch verification failed: ## Autopilot Constraints section was modified. Aborting."
    );
  }

  // Verify hash still matches (should always pass given the check above)
  const newHash = hashConstraintsSection(updatedConstraintsSection);
  if (newHash !== config.constitutionalHash) {
    throw new Error(
      `Constitutional hash changed after patching. This should never happen. Aborting.\n` +
        `Original: ${config.constitutionalHash}\nNew: ${newHash}`
    );
  }

  // Write updated AGENT.md
  const agentMdPath = path.join(repoPath, "AGENT.md");
  fs.writeFileSync(agentMdPath, updatedContent, "utf8");
  console.log("AGENT.md updated.");

  // Commit
  const sessionId = makeSessionId();
  sessionCommit(repoPath, {
    message: `docs: update AGENT.md for PR #${prNumber}`,
    files: ["AGENT.md"],
    metadata: {
      sessionId,
      triggerType: "pr-merged",
      repoSlug,
      issuesAddressed: [],
      issuesFiled: [],
      learningsConsulted: [],
      constraintsChecked: true,
    },
  });

  console.log(`\nDone. AGENT.md updated and committed for PR #${prNumber}.`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
