/**
 * src/constraints.ts
 *
 * Constitutional constraint enforcement.
 *
 * The agent NEVER acts on a proposed change without passing it through
 * checkAction() first. If the action violates a constraint from AGENT.md's
 * "## Autopilot Constraints" section, the agent files a GitHub issue and
 * records the block in the journal instead of proceeding.
 *
 * The constitutional_hash in .autopilot.yml detects out-of-band tampering
 * with the constraints section. If the hash mismatches, the session halts.
 */

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import {
  AutopilotConfig,
  ConstraintCheckResult,
  ConstraintViolation,
} from "./types.js";

// ─── Constants ───────────────────────────────────────────────────────────────

const CONSTRAINTS_SECTION_HEADER = "## Autopilot Constraints";

// ─── Parsing ─────────────────────────────────────────────────────────────────

/**
 * Extract the raw text of the "## Autopilot Constraints" section from AGENT.md.
 * Returns null if the section is not found.
 */
export function extractConstraintsSection(agentMdContent: string): string | null {
  const lines = agentMdContent.split("\n");
  const start = lines.findIndex((l) => l.trim() === CONSTRAINTS_SECTION_HEADER);
  if (start === -1) return null;

  const sectionLines: string[] = [lines[start]];
  for (let i = start + 1; i < lines.length; i++) {
    // Stop at the next h2 heading (but not h3+)
    if (lines[i].startsWith("## ") && i !== start) break;
    sectionLines.push(lines[i]);
  }
  return sectionLines.join("\n");
}

/**
 * Parse constraint rules out of the section text.
 * Each line starting with "- " (after stripping comment lines beginning with "#")
 * is treated as one rule.
 */
export function parseConstraintRules(sectionText: string): string[] {
  return sectionText
    .split("\n")
    .filter((l) => l.trimStart().startsWith("- "))
    .map((l) => l.trimStart().slice(2).trim())
    .filter((l) => l.length > 0);
}

// ─── Hashing ─────────────────────────────────────────────────────────────────

/**
 * Compute the SHA-256 hash of the constraints section, stored in .autopilot.yml
 * as constitutional_hash. This detects out-of-band tampering.
 */
export function hashConstraintsSection(sectionText: string): string {
  return "sha256:" + crypto.createHash("sha256").update(sectionText).digest("hex");
}

/**
 * Verify that the current AGENT.md constraints section matches the stored hash.
 * Throws if the hash is missing from config or if there is a mismatch.
 */
export function verifyConstraintsHash(
  agentMdContent: string,
  config: AutopilotConfig
): void {
  const section = extractConstraintsSection(agentMdContent);
  if (!section) {
    throw new Error(
      "AGENT.md is missing the '## Autopilot Constraints' section. " +
        "Cannot proceed without constitutional constraints."
    );
  }

  if (!config.constitutionalHash) {
    throw new Error(
      ".autopilot.yml is missing constitutional_hash. " +
        "Run onboarding to generate it."
    );
  }

  const actual = hashConstraintsSection(section);
  if (actual !== config.constitutionalHash) {
    throw new Error(
      `Constitutional hash mismatch!\n` +
        `  Stored:   ${config.constitutionalHash}\n` +
        `  Computed: ${actual}\n` +
        `The '## Autopilot Constraints' section was modified outside an approved PR. ` +
        `Update constitutional_hash in .autopilot.yml via a human-approved PR.`
    );
  }
}

// ─── Rule Matching ───────────────────────────────────────────────────────────

interface PathConstraint {
  kind: "path-forbidden";
  pattern: string;
  rule: string;
}

interface OperationConstraint {
  kind: "operation-forbidden";
  keyword: string;
  rule: string;
}

type ParsedRule = PathConstraint | OperationConstraint;

const NEVER_MODIFY_RE = /NEVER\s+modify\s+(\S+)/i;
const NEVER_TOUCH_RE = /NEVER\s+(?:touch|edit|change|update)\s+(\S+)/i;

function parseRule(rule: string): ParsedRule | null {
  const modifyMatch = rule.match(NEVER_MODIFY_RE) ?? rule.match(NEVER_TOUCH_RE);
  if (modifyMatch) {
    return { kind: "path-forbidden", pattern: modifyMatch[1], rule };
  }
  // Generic "NEVER <verb>" constraint stored as an operation keyword
  if (rule.toUpperCase().startsWith("NEVER ")) {
    const keyword = rule.slice(6).split(/[\s,;]/)[0].toLowerCase();
    return { kind: "operation-forbidden", keyword, rule };
  }
  return null;
}

function pathMatchesPattern(filePath: string, pattern: string): boolean {
  // Simple prefix / glob matching: strip leading/trailing slashes and compare
  const normalizedPattern = pattern.replace(/^\/+/, "").replace(/\/+$/, "");
  const normalizedPath = filePath.replace(/^\/+/, "");
  return (
    normalizedPath === normalizedPattern ||
    normalizedPath.startsWith(normalizedPattern + "/")
  );
}

// ─── Public API ──────────────────────────────────────────────────────────────

export interface ProposedAction {
  /** Short description of what the agent wants to do */
  description: string;
  /** Files the action would touch (relative paths from repo root) */
  filesTouched: string[];
  /** Operation type keywords, e.g. ["schema-change"], ["api-removal"], ["dependency-upgrade"] */
  operationTypes: string[];
}

/**
 * Check whether a proposed action is permitted by the constitutional constraints.
 *
 * @param action          The action the agent wants to take.
 * @param agentMdContent  Full text of AGENT.md.
 * @param config          Parsed .autopilot.yml.
 * @returns               { allowed: true } or { allowed: false, violation }
 */
export function checkAction(
  action: ProposedAction,
  agentMdContent: string,
  config: AutopilotConfig
): ConstraintCheckResult {
  // First, verify hash integrity (throws if tampered)
  verifyConstraintsHash(agentMdContent, config);

  const section = extractConstraintsSection(agentMdContent)!;
  const rules = parseConstraintRules(section);

  for (const ruleText of rules) {
    const parsed = parseRule(ruleText);
    if (!parsed) continue;

    if (parsed.kind === "path-forbidden") {
      const forbiddenFile = action.filesTouched.find((f) =>
        pathMatchesPattern(f, parsed.pattern)
      );
      if (forbiddenFile) {
        const violation: ConstraintViolation = {
          rule: parsed.rule,
          proposedAction: action.description,
          filesTouched: action.filesTouched,
        };
        return { allowed: false, violation };
      }
    }

    if (parsed.kind === "operation-forbidden") {
      const forbiddenOp = action.operationTypes.find(
        (op) =>
          op.toLowerCase().includes(parsed.keyword) ||
          parsed.keyword.includes(op.toLowerCase())
      );
      if (forbiddenOp) {
        const violation: ConstraintViolation = {
          rule: parsed.rule,
          proposedAction: action.description,
          filesTouched: action.filesTouched,
        };
        return { allowed: false, violation };
      }
    }
  }

  return { allowed: true };
}

/**
 * Read AGENT.md from a repo and extract the constraints section.
 * Useful during onboarding to generate the initial constitutional_hash.
 */
export function readAgentMd(repoPath: string): string {
  const agentMdPath = path.join(repoPath, "AGENT.md");
  if (!fs.existsSync(agentMdPath)) {
    throw new Error(`AGENT.md not found at ${agentMdPath}`);
  }
  return fs.readFileSync(agentMdPath, "utf8");
}

/**
 * Generate the constitutional_hash value to store in .autopilot.yml.
 * Called during onboarding after the human finalises the Autopilot Constraints section.
 */
export function generateConstitutionalHash(repoPath: string): string {
  const agentMdContent = readAgentMd(repoPath);
  const section = extractConstraintsSection(agentMdContent);
  if (!section) {
    throw new Error(
      "AGENT.md is missing '## Autopilot Constraints'. Add it before generating the hash."
    );
  }
  return hashConstraintsSection(section);
}
