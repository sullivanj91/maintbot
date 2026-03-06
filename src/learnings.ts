/**
 * src/learnings.ts
 *
 * Cross-repo knowledge base: LEARNINGS.md read / search / append.
 *
 * LEARNINGS.md lives in the Autopilot repo itself (not per-target-repo).
 * It is append-only. The agent never edits existing entries.
 *
 * Entry format (human and machine readable):
 *
 *   ## [LEARN-042] numpy 2.x migration pattern
 *   Learned: 2026-02-18 | Source: repo:data-pipeline, session:20260218-0800
 *   Tags: python, numpy, migration
 *   Repos: data-pipeline, ml-trainer
 *
 *   <body text>
 *
 *   ---
 *
 * Qualification gate: a learning is only appended if the pattern appeared in
 * at least MIN_REPO_COUNT distinct repos (configurable, default 2).
 */

import * as fs from "fs";
import * as path from "path";
import { Learning } from "./types.js";

// ─── Constants ───────────────────────────────────────────────────────────────

export const LEARNINGS_FILE = "LEARNINGS.md";
const ENTRY_SEPARATOR = "\n---\n";
const ENTRY_HEADER_RE = /^## \[(LEARN-\d+)\] (.+)$/m;
const MIN_REPO_COUNT = 2;

// ─── ID Generation ───────────────────────────────────────────────────────────

/**
 * Parse all existing LEARN-NNN ids and return the next one.
 */
export function nextLearningId(content: string): string {
  const ids: number[] = [];
  const re = /\[LEARN-(\d+)\]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    ids.push(parseInt(match[1], 10));
  }
  const next = ids.length === 0 ? 1 : Math.max(...ids) + 1;
  return `LEARN-${String(next).padStart(3, "0")}`;
}

// ─── Serialization ───────────────────────────────────────────────────────────

function serializeLearning(learning: Learning): string {
  const tagsLine = `Tags: ${learning.tags.join(", ")}`;
  const reposLine =
    learning.confirmedInRepos.length > 0
      ? `Repos: ${learning.confirmedInRepos.join(", ")}`
      : "";
  const header = [
    `## [${learning.id}] ${learning.title}`,
    `Learned: ${learning.learnedAt} | Source: ${learning.source}`,
    tagsLine,
    reposLine,
  ]
    .filter((l) => l.length > 0)
    .join("\n");
  return `${header}\n\n${learning.body}`;
}

function deserializeLearning(block: string): Learning | null {
  const lines = block.split("\n");
  const headerMatch = lines[0]?.match(/^## \[(LEARN-\d+)\] (.+)$/);
  if (!headerMatch) return null;

  const id = headerMatch[1];
  const title = headerMatch[2];

  const learnedLine = lines[1] ?? "";
  const learnedMatch = learnedLine.match(/^Learned: ([^|]+) \| Source: (.+)$/);
  const learnedAt = learnedMatch?.[1].trim() ?? "";
  const source = learnedMatch?.[2].trim() ?? "";

  const tagsLine = lines.find((l) => l.startsWith("Tags: ")) ?? "";
  const tags = tagsLine
    .replace("Tags: ", "")
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  const reposLine = lines.find((l) => l.startsWith("Repos: ")) ?? "";
  const confirmedInRepos = reposLine
    ? reposLine
        .replace("Repos: ", "")
        .split(",")
        .map((r) => r.trim())
        .filter((r) => r.length > 0)
    : [];

  // Body starts after the header block (first blank line)
  const bodyStart = lines.findIndex((l, i) => i > 2 && l.trim() === "") + 1;
  const body = lines.slice(bodyStart).join("\n").trim();

  return { id, title, learnedAt, source, tags, confirmedInRepos, body };
}

// ─── Parsing ─────────────────────────────────────────────────────────────────

/**
 * Parse all Learning entries from a LEARNINGS.md string.
 */
export function parseLearnings(content: string): Learning[] {
  // Split on section headers (## [LEARN-NNN])
  const blocks = content
    .split(/(?=^## \[LEARN-)/m)
    .map((b) => b.replace(/\n---\n?$/, "").trim())
    .filter((b) => b.startsWith("## [LEARN-"));

  return blocks.map(deserializeLearning).filter((l): l is Learning => l !== null);
}

// ─── Read ─────────────────────────────────────────────────────────────────────

/**
 * Read and parse LEARNINGS.md from the Autopilot repo.
 */
export function readLearnings(autopilotRepoPath: string): Learning[] {
  const filePath = path.join(autopilotRepoPath, LEARNINGS_FILE);
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, "utf8");
  return parseLearnings(content);
}

// ─── Search ──────────────────────────────────────────────────────────────────

/**
 * Search learnings by tags. Returns learnings that share at least one tag
 * with the query, sorted by number of matching tags (descending).
 *
 * @param learnings  All parsed learnings.
 * @param tags       Tags relevant to the current session's repo.
 * @param limit      Maximum results to return (default 10).
 */
export function searchLearnings(
  learnings: Learning[],
  tags: string[],
  limit = 10
): Learning[] {
  const lowerTags = tags.map((t) => t.toLowerCase());

  const scored = learnings
    .map((l) => {
      const matchCount = l.tags.filter((t) =>
        lowerTags.includes(t.toLowerCase())
      ).length;
      return { learning: l, score: matchCount };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, limit).map(({ learning }) => learning);
}

// ─── Append ──────────────────────────────────────────────────────────────────

/**
 * Append a new learning to LEARNINGS.md.
 *
 * Qualification gate: throws if confirmedInRepos.length < MIN_REPO_COUNT.
 * The agent must have seen the pattern in at least 2 distinct repos.
 */
export function appendLearning(
  autopilotRepoPath: string,
  learning: Omit<Learning, "id">
): Learning {
  if (learning.confirmedInRepos.length < MIN_REPO_COUNT) {
    throw new Error(
      `Qualification gate: pattern must appear in ≥${MIN_REPO_COUNT} repos ` +
        `before being added to LEARNINGS.md. ` +
        `Currently confirmed in: ${learning.confirmedInRepos.join(", ") || "none"}.`
    );
  }

  const filePath = path.join(autopilotRepoPath, LEARNINGS_FILE);
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";

  // Check for near-duplicates by title similarity (simple keyword overlap)
  const existingLearnings = parseLearnings(existing);
  const titleWords = learning.title.toLowerCase().split(/\s+/);
  const duplicate = existingLearnings.find((l) => {
    const existingWords = l.title.toLowerCase().split(/\s+/);
    const overlap = titleWords.filter((w) => existingWords.includes(w)).length;
    return overlap >= Math.floor(titleWords.length * 0.6);
  });
  if (duplicate) {
    throw new Error(
      `Near-duplicate detected: "${learning.title}" is similar to existing ` +
        `entry "${duplicate.title}" (${duplicate.id}). ` +
        `Update the existing entry instead of creating a new one.`
    );
  }

  const id = nextLearningId(existing);
  const newLearning: Learning = { id, ...learning };
  const serialized = serializeLearning(newLearning);

  const separator = existing.endsWith("\n") ? "\n" : "\n\n";
  fs.appendFileSync(filePath, `${separator}${serialized}${ENTRY_SEPARATOR}`);

  return newLearning;
}

/**
 * Suggest whether a learning should be appended based on how many repos
 * confirmed a pattern. Returns true if the qualification gate would pass.
 */
export function qualifiesForLearning(confirmedInRepos: string[]): boolean {
  return confirmedInRepos.length >= MIN_REPO_COUNT;
}

/**
 * Format a Learning entry as a human-readable summary (for including in
 * session context when priming the agent before starting work).
 */
export function summarizeLearning(l: Learning): string {
  return `[${l.id}] ${l.title}\nSource: ${l.source} | Tags: ${l.tags.join(", ")}\n${l.body.slice(0, 300)}${l.body.length > 300 ? "…" : ""}`;
}
