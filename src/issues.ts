/**
 * src/issues.ts
 *
 * GitHub Issues as bidirectional task queue.
 *
 * Human → Agent:  Humans file issues labelled "autopilot-input".
 *                 Agent reads and prioritizes at session start.
 *                 Agent comments when picking up; closes with summary when done.
 *
 * Agent → Human:  Agent files issues labelled "autopilot-filed" for:
 *                   - Constraint violations (cannot do autonomously)
 *                   - Observations deferred to a future session
 *                   - Items needing a human decision
 *
 * Priority order: autopilot-urgent label → reaction count → comment count → age (oldest first)
 */

import { Octokit } from "@octokit/rest";
import { AutopilotConfig, AutopilotIssue, FileIssueOptions, SessionId } from "./types.js";

// ─── Client ──────────────────────────────────────────────────────────────────

function getOctokit(): Octokit {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error("GITHUB_TOKEN environment variable is required");
  }
  return new Octokit({ auth: token });
}

function parseSlug(repoSlug: string): { owner: string; repo: string } {
  const [owner, repo] = repoSlug.split("/");
  if (!owner || !repo) {
    throw new Error(`Invalid repo slug: "${repoSlug}". Expected "owner/repo".`);
  }
  return { owner, repo };
}

// ─── Ensure Labels Exist ─────────────────────────────────────────────────────

const LABEL_COLORS: Record<string, string> = {
  "autopilot-input": "0075ca",
  "autopilot-filed": "e4e669",
  "autopilot-urgent": "d93f0b",
};

/**
 * Create the required Autopilot labels in a repo if they don't already exist.
 * Called by the onboarding engine.
 */
export async function ensureLabels(
  repoSlug: string,
  config: AutopilotConfig
): Promise<void> {
  const octokit = getOctokit();
  const { owner, repo } = parseSlug(repoSlug);

  const labelsToEnsure = [
    config.issues.inputLabel,
    config.issues.filedLabel,
    config.issues.urgentLabel,
  ];

  let existingLabels: string[] = [];
  try {
    const { data } = await octokit.issues.listLabelsForRepo({
      owner,
      repo,
      per_page: 100,
    });
    existingLabels = data.map((l) => l.name);
  } catch (_) {
    // Ignore — repo may be new
  }

  for (const label of labelsToEnsure) {
    if (!existingLabels.includes(label)) {
      await octokit.issues.createLabel({
        owner,
        repo,
        name: label,
        color: LABEL_COLORS[label] ?? "cccccc",
        description: `Autopilot: ${label}`,
      });
    }
  }
}

// ─── Read & Prioritize ───────────────────────────────────────────────────────

/**
 * Fetch all open issues labelled "autopilot-input" and return them sorted
 * by priority: urgent label first, then by reactions + comments (engagement),
 * then by age (oldest first).
 */
export async function fetchInputQueue(
  repoSlug: string,
  config: AutopilotConfig
): Promise<AutopilotIssue[]> {
  const octokit = getOctokit();
  const { owner, repo } = parseSlug(repoSlug);

  const { data } = await octokit.issues.listForRepo({
    owner,
    repo,
    state: "open",
    labels: config.issues.inputLabel,
    per_page: 50,
    sort: "created",
    direction: "asc",
  });

  const issues: AutopilotIssue[] = data.map((issue) => ({
    number: issue.number,
    title: issue.title,
    body: issue.body ?? "",
    labels: issue.labels.map((l) => (typeof l === "string" ? l : l.name ?? "")),
    reactions: issue.reactions?.total_count ?? 0,
    comments: issue.comments,
    createdAt: issue.created_at,
  }));

  // Sort: urgent first, then engagement, then age
  return issues.sort((a, b) => {
    const aUrgent = a.labels.includes(config.issues.urgentLabel) ? 1 : 0;
    const bUrgent = b.labels.includes(config.issues.urgentLabel) ? 1 : 0;
    if (aUrgent !== bUrgent) return bUrgent - aUrgent;

    const aEngagement = a.reactions + a.comments;
    const bEngagement = b.reactions + b.comments;
    if (aEngagement !== bEngagement) return bEngagement - aEngagement;

    // Oldest first (ascending creation date)
    return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
  });
}

// ─── Pickup Comment ───────────────────────────────────────────────────────────

/**
 * Post a comment on an issue when the agent picks it up at session start.
 */
export async function postPickupComment(
  repoSlug: string,
  issueNumber: number,
  sessionId: SessionId
): Promise<void> {
  const octokit = getOctokit();
  const { owner, repo } = parseSlug(repoSlug);

  await octokit.issues.createComment({
    owner,
    repo,
    issue_number: issueNumber,
    body:
      `**Autopilot session ${sessionId.timestamp}:** Picking this up. ` +
      `Will update or close by end of session.\n\n` +
      `_Session label: \`autopilot/session-${sessionId.label}\`_`,
  });
}

// ─── Close With Summary ──────────────────────────────────────────────────────

/**
 * Post a closing comment summarising work done and close the issue.
 */
export async function closeIssueWithSummary(
  repoSlug: string,
  issueNumber: number,
  sessionId: SessionId,
  summary: string,
  commitShas: string[]
): Promise<void> {
  const octokit = getOctokit();
  const { owner, repo } = parseSlug(repoSlug);

  const commitsBlock =
    commitShas.length > 0
      ? `\n\n**Relevant commits:** ${commitShas.join(", ")}`
      : "";

  await octokit.issues.createComment({
    owner,
    repo,
    issue_number: issueNumber,
    body:
      `**Autopilot session ${sessionId.timestamp} — resolved.**\n\n` +
      `${summary}${commitsBlock}\n\n` +
      `_Journal entry: \`AUTOPILOT_JOURNAL.md#session-${sessionId.label}\`_`,
  });

  await octokit.issues.update({
    owner,
    repo,
    issue_number: issueNumber,
    state: "closed",
  });
}

// ─── File Issue (Agent → Human) ──────────────────────────────────────────────

/**
 * File a new issue on behalf of the agent.
 * Prepends a standard "Filed by Autopilot" header to the body.
 */
export async function fileIssue(
  repoSlug: string,
  sessionId: SessionId,
  options: FileIssueOptions
): Promise<number> {
  const octokit = getOctokit();
  const { owner, repo } = parseSlug(repoSlug);

  const header =
    `**Filed by:** Autopilot session ${sessionId.timestamp}\n` +
    `**Session label:** \`autopilot/session-${sessionId.label}\`\n` +
    `_This is not urgent unless labelled \`autopilot-urgent\` by a human._\n\n---\n\n`;

  const { data } = await octokit.issues.create({
    owner,
    repo,
    title: options.title,
    body: header + options.body,
    labels: options.labels as string[],
  });

  return data.number;
}

/**
 * File a constraint-violation issue — used when the agent detects that a
 * requested action would breach AGENT.md's Autopilot Constraints.
 */
export async function fileConstraintViolationIssue(
  repoSlug: string,
  sessionId: SessionId,
  config: AutopilotConfig,
  violation: { rule: string; proposedAction: string; filesTouched: string[] }
): Promise<number> {
  return fileIssue(repoSlug, sessionId, {
    title: `[Autopilot blocked] Constitutional constraint prevented action`,
    body:
      `## Blocked Action\n\n` +
      `${violation.proposedAction}\n\n` +
      `## Violated Rule\n\n` +
      `> ${violation.rule}\n\n` +
      `## Files That Would Have Been Touched\n\n` +
      violation.filesTouched.map((f) => `- \`${f}\``).join("\n") +
      `\n\n## What To Do\n\n` +
      `If this action should be allowed, update the \`## Autopilot Constraints\` ` +
      `section in \`AGENT.md\` via a human-approved PR and update ` +
      `\`constitutional_hash\` in \`.autopilot.yml\`.`,
    labels: [config.issues.filedLabel as "autopilot-filed"],
  });
}
