/**
 * src/commit.ts
 *
 * Wraps all git operations and enforces the session-labeled commit format:
 *
 *   [autopilot/session-20260305-1400] fix: upgrade numpy 1.24 → 2.0.0
 *
 *   Session trigger: scheduled
 *   Repo: owner/data-pipeline
 *   Issues addressed: #82, #85
 *   Issues filed: #88
 *   LEARNINGS.md consulted: LEARN-012, LEARN-042
 *   Constitutional constraints checked: yes
 *   Journal entry: AUTOPILOT_JOURNAL.md#session-20260305-1400
 *
 * The agent NEVER calls git directly. All git operations go through this module
 * so the invariant cannot be accidentally skipped.
 */

import { execSync } from "child_process";
import { CommitMetadata, CommitOptions, SessionId } from "./types.js";

/**
 * Build a SessionId from the current UTC time.
 */
export function makeSessionId(): SessionId {
  const now = new Date();
  const timestamp = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  const label = [
    now.getUTCFullYear(),
    String(now.getUTCMonth() + 1).padStart(2, "0"),
    String(now.getUTCDate()).padStart(2, "0"),
    "-",
    String(now.getUTCHours()).padStart(2, "0"),
    String(now.getUTCMinutes()).padStart(2, "0"),
  ].join("");
  return { timestamp, label };
}

/**
 * Build the commit prefix from a SessionId.
 * e.g. "[autopilot/session-20260305-1400]"
 */
export function commitPrefix(sessionId: SessionId): string {
  return `[autopilot/session-${sessionId.label}]`;
}

/**
 * Build the structured metadata block appended to every agent commit body.
 */
function buildMetadataBlock(metadata: CommitMetadata): string {
  const {
    sessionId,
    triggerType,
    repoSlug,
    issuesAddressed,
    issuesFiled,
    learningsConsulted,
    constraintsChecked,
  } = metadata;

  const issuesAddressedStr =
    issuesAddressed.length > 0
      ? issuesAddressed.map((n) => `#${n}`).join(", ")
      : "none";
  const issuesFiledStr =
    issuesFiled.length > 0
      ? issuesFiled.map((n) => `#${n}`).join(", ")
      : "none";
  const learningsStr =
    learningsConsulted.length > 0 ? learningsConsulted.join(", ") : "none";

  return [
    `Session trigger: ${triggerType}`,
    `Repo: ${repoSlug}`,
    `Issues addressed: ${issuesAddressedStr}`,
    `Issues filed: ${issuesFiledStr}`,
    `LEARNINGS.md consulted: ${learningsStr}`,
    `Constitutional constraints checked: ${constraintsChecked ? "yes" : "no"}`,
    `Journal entry: AUTOPILOT_JOURNAL.md#session-${sessionId.label}`,
  ].join("\n");
}

/**
 * Stage the given files and create a session-labeled commit.
 *
 * @param repoPath  Absolute path to the git repo root.
 * @param options   Commit message (short description), files to stage, and metadata.
 * @throws          If git operations fail.
 */
export function sessionCommit(repoPath: string, options: CommitOptions): void {
  const { message, files, metadata } = options;
  const prefix = commitPrefix(metadata.sessionId);
  const fullMessage = `${prefix} ${message}\n\n${buildMetadataBlock(metadata)}`;

  // Stage only the explicitly listed files (never git add -A to avoid accidental secrets)
  if (files.length === 0) {
    throw new Error("sessionCommit: files array must not be empty");
  }
  const quotedFiles = files.map((f) => `"${f}"`).join(" ");
  execSync(`git -C "${repoPath}" add ${quotedFiles}`, { stdio: "inherit" });

  // Write commit message via stdin to avoid shell-escaping issues with special chars
  execSync(`git -C "${repoPath}" commit -F -`, {
    input: fullMessage,
    stdio: ["pipe", "inherit", "inherit"],
  });
}

/**
 * Return a summary of all session commits in a repo for auditing.
 * Equivalent to: git log --grep="autopilot/session" --oneline
 */
export function listSessionCommits(repoPath: string): string[] {
  const out = execSync(
    `git -C "${repoPath}" log --grep="autopilot/session" --oneline`,
    { encoding: "utf8" }
  );
  return out
    .trim()
    .split("\n")
    .filter((l) => l.length > 0);
}
