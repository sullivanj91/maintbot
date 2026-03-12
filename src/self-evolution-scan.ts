/**
 * src/self-evolution-scan.ts
 *
 * Scans LEARNINGS.md for automation candidates and EVOLUTION_LOG.md to filter
 * out already-proposed or rejected ideas. Outputs GitHub Actions step outputs:
 *
 *   candidate_learn_id    e.g. "LEARN-042"
 *   candidate_title       e.g. "numpy 2.x migration pattern"
 *   candidate_description e.g. "Auto-apply np.bool → np.bool_ when numpy 2.x detected"
 *
 * Qualification gate: pattern must appear in ≥ MIN_REPOS_FOR_CANDIDATE distinct
 * repos (read from .autopilot.yml self_evolution.min_repos_for_candidate, default 3).
 *
 * Outputs nothing (empty strings) when no qualifying candidate is found.
 */

import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import { parseLearnings } from "./learnings.js";
import { Learning } from "./types.js";

// ─── Config ───────────────────────────────────────────────────────────────────

interface SelfEvolutionConfig {
  minReposForCandidate?: number;
}

interface AutopilotConfigWithEvolution {
  selfEvolution?: SelfEvolutionConfig;
}

function loadMinRepos(repoPath: string): number {
  const configPath = path.join(repoPath, ".autopilot.yml");
  if (!fs.existsSync(configPath)) return 3;
  const cfg = yaml.load(
    fs.readFileSync(configPath, "utf8")
  ) as AutopilotConfigWithEvolution;
  return cfg?.selfEvolution?.minReposForCandidate ?? 3;
}

// ─── Already-Proposed Filter ─────────────────────────────────────────────────

/**
 * Parse EVOLUTION_LOG.md to collect LEARN-NNN ids that have already been
 * proposed (regardless of outcome). We skip these so the self-evolution loop
 * doesn't keep re-proposing the same ideas.
 */
function alreadyProposedIds(repoPath: string): Set<string> {
  const logPath = path.join(repoPath, "EVOLUTION_LOG.md");
  if (!fs.existsSync(logPath)) return new Set();

  const content = fs.readFileSync(logPath, "utf8");
  const ids = new Set<string>();
  const re = /Proposed from:\s*(LEARN-\d+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    ids.add(match[1]);
  }
  return ids;
}

// ─── GitHub Actions Output ────────────────────────────────────────────────────

function setOutput(name: string, value: string): void {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    // Multiline-safe: use heredoc syntax
    const delimiter = `EOF_${name.toUpperCase()}`;
    fs.appendFileSync(outputFile, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
  } else {
    // Local dev: just print
    console.log(`::set-output name=${name}::${value}`);
  }
}

function clearOutputs(): void {
  setOutput("candidate_learn_id", "");
  setOutput("candidate_title", "");
  setOutput("candidate_description", "");
}

// ─── Candidate Selection ──────────────────────────────────────────────────────

/**
 * Build a short, actionable description of the automation opportunity from a
 * learning entry. This becomes the self-evolution PR description.
 */
function describeCandidate(learning: Learning): string {
  const repos = learning.confirmedInRepos.join(", ");
  const bodySnippet = learning.body.slice(0, 200).replace(/\n/g, " ").trim();
  return (
    `Automate "${learning.title}" — confirmed in repos: ${repos}. ` +
    `Pattern summary: ${bodySnippet}${learning.body.length > 200 ? "…" : ""}`
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const repoPath = process.env.AUTOPILOT_REPO_PATH ?? process.cwd();
  const minRepos = loadMinRepos(repoPath);
  const proposed = alreadyProposedIds(repoPath);

  const learningsPath = path.join(repoPath, "LEARNINGS.md");
  if (!fs.existsSync(learningsPath)) {
    console.log("LEARNINGS.md not found — no candidates.");
    clearOutputs();
    return;
  }

  const content = fs.readFileSync(learningsPath, "utf8");
  const learnings = parseLearnings(content);

  // Filter: enough repos, not already proposed
  const candidates = learnings.filter(
    (l) =>
      l.confirmedInRepos.length >= minRepos && !proposed.has(l.id)
  );

  if (candidates.length === 0) {
    console.log(
      `No qualifying candidates found.\n` +
        `  Total learnings: ${learnings.length}\n` +
        `  Min repos required: ${minRepos}\n` +
        `  Already proposed: ${proposed.size}`
    );
    clearOutputs();
    return;
  }

  // Pick the one with the most confirmed repos (most battle-tested)
  candidates.sort((a, b) => b.confirmedInRepos.length - a.confirmedInRepos.length);
  const best = candidates[0];

  console.log(
    `Found candidate: [${best.id}] ${best.title}\n` +
      `  Confirmed in ${best.confirmedInRepos.length} repos: ${best.confirmedInRepos.join(", ")}\n` +
      `  Tags: ${best.tags.join(", ")}`
  );

  setOutput("candidate_learn_id", best.id);
  setOutput("candidate_title", best.title);
  setOutput("candidate_description", describeCandidate(best));
}

main().catch((err) => {
  console.error("self-evolution-scan failed:", err);
  process.exit(1);
});
