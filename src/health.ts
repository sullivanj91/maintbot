/**
 * src/health.ts
 *
 * Health monitoring checks run at the start of every maintenance session.
 * Returns an array of findings that are included in the Claude system prompt
 * so the agent can prioritize and address issues autonomously.
 *
 * Checks:
 *   1. npm audit (if package.json exists) — vulnerability detection
 *   2. npm outdated (if package.json exists) — stale dependency detection
 *   3. pip list --outdated (if requirements.txt exists) — Python stale deps
 *   4. CI flakiness (always) — failure rate from last 20 GitHub Actions runs
 *
 * Each check is wrapped in its own try/catch. A failing check adds an "info"
 * finding with the error message rather than aborting the others.
 */

import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";

import { Octokit } from "@octokit/rest";
import { AutopilotConfig } from "./types.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface HealthFinding {
  severity: "info" | "warning" | "critical";
  check: string;
  description: string;
  /** Structured detail for Claude to reason about */
  detail?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function execSafe(
  cmd: string,
  cwd: string,
  timeoutMs = 30_000
): { stdout: string; failed: boolean } {
  try {
    const stdout = execSync(cmd, {
      cwd,
      timeout: timeoutMs,
      stdio: ["pipe", "pipe", "pipe"],
    }).toString();
    return { stdout, failed: false };
  } catch (err: unknown) {
    // execSync throws when exit code != 0; stderr/stdout still accessible
    const anyErr = err as { stdout?: Buffer | string; stderr?: Buffer | string };
    const stdout =
      anyErr.stdout instanceof Buffer
        ? anyErr.stdout.toString()
        : (anyErr.stdout ?? "");
    return { stdout: String(stdout), failed: true };
  }
}

// ─── Check 1: npm audit ───────────────────────────────────────────────────────

function checkNpmAudit(repoPath: string, findings: HealthFinding[]): void {
  if (!fs.existsSync(path.join(repoPath, "package.json"))) return;

  try {
    // npm audit exits non-zero when vulns are found — use execSafe
    const { stdout } = execSafe("npm audit --json", repoPath);
    if (!stdout.trim()) {
      findings.push({
        severity: "info",
        check: "npm-audit",
        description: "npm audit returned no output",
      });
      return;
    }

    const report = JSON.parse(stdout);
    const vulns = (report.metadata?.vulnerabilities ?? {}) as Record<
      string,
      number
    >;
    const critical = vulns["critical"] ?? 0;
    const high = vulns["high"] ?? 0;
    const moderate = vulns["moderate"] ?? 0;
    const low = vulns["low"] ?? 0;
    const total = critical + high + moderate + low;

    if (total === 0) {
      findings.push({
        severity: "info",
        check: "npm-audit",
        description: "No npm vulnerabilities found",
      });
      return;
    }

    const severity: HealthFinding["severity"] =
      critical > 0 ? "critical" : high > 0 ? "warning" : "info";

    findings.push({
      severity,
      check: "npm-audit",
      description: `${total} npm vulnerabilities: ${critical} critical, ${high} high, ${moderate} moderate, ${low} low`,
      detail: JSON.stringify(vulns),
    });
  } catch (err) {
    findings.push({
      severity: "info",
      check: "npm-audit",
      description: `npm audit check failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

// ─── Check 2: npm outdated ────────────────────────────────────────────────────

function checkNpmOutdated(repoPath: string, findings: HealthFinding[]): void {
  if (!fs.existsSync(path.join(repoPath, "package.json"))) return;

  try {
    // npm outdated exits 1 when packages are outdated
    const { stdout } = execSafe("npm outdated --json", repoPath);
    if (!stdout.trim() || stdout.trim() === "{}") {
      findings.push({
        severity: "info",
        check: "npm-outdated",
        description: "All npm dependencies are up to date",
      });
      return;
    }

    const outdated = JSON.parse(stdout) as Record<
      string,
      { current: string; wanted: string; latest: string; type: string }
    >;

    const packages = Object.entries(outdated);
    const majorUpdates = packages.filter(([, info]) => {
      const currentMajor = parseInt(info.current?.split(".")[0] ?? "0", 10);
      const latestMajor = parseInt(info.latest?.split(".")[0] ?? "0", 10);
      return latestMajor > currentMajor;
    });

    const severity: HealthFinding["severity"] =
      majorUpdates.length > 0 ? "warning" : "info";

    const detail = packages
      .slice(0, 10)
      .map(([name, info]) => `${name}: ${info.current} → ${info.latest}`)
      .join(", ");

    findings.push({
      severity,
      check: "npm-outdated",
      description: `${packages.length} npm packages outdated (${majorUpdates.length} major version behind)`,
      detail,
    });
  } catch (err) {
    findings.push({
      severity: "info",
      check: "npm-outdated",
      description: `npm outdated check failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

// ─── Check 3: pip list --outdated ─────────────────────────────────────────────

function checkPipOutdated(repoPath: string, findings: HealthFinding[]): void {
  if (!fs.existsSync(path.join(repoPath, "requirements.txt"))) return;

  try {
    const { stdout, failed } = execSafe(
      "pip list --outdated --format=json",
      repoPath
    );

    if (failed || !stdout.trim()) {
      findings.push({
        severity: "info",
        check: "pip-outdated",
        description: "pip outdated check could not run (pip not available or failed)",
      });
      return;
    }

    const outdated = JSON.parse(stdout) as Array<{
      name: string;
      version: string;
      latest_version: string;
    }>;

    if (outdated.length === 0) {
      findings.push({
        severity: "info",
        check: "pip-outdated",
        description: "All Python packages are up to date",
      });
      return;
    }

    findings.push({
      severity: outdated.length > 5 ? "warning" : "info",
      check: "pip-outdated",
      description: `${outdated.length} Python packages outdated`,
      detail: outdated
        .slice(0, 10)
        .map((p) => `${p.name} ${p.version} → ${p.latest_version}`)
        .join(", "),
    });
  } catch (err) {
    findings.push({
      severity: "info",
      check: "pip-outdated",
      description: `pip outdated check failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

// ─── Check 4: CI flakiness ────────────────────────────────────────────────────

async function checkCIFlakiness(
  repoSlug: string,
  findings: HealthFinding[]
): Promise<void> {
  try {
    const token = process.env.GITHUB_TOKEN;
    if (!token) {
      findings.push({
        severity: "info",
        check: "ci-flakiness",
        description: "GITHUB_TOKEN not set — skipping CI flakiness check",
      });
      return;
    }

    const octokit = new Octokit({ auth: token });
    const [owner, repo] = repoSlug.split("/");

    const { data } = await octokit.actions.listWorkflowRunsForRepo({
      owner,
      repo,
      per_page: 20,
      status: "completed",
    });

    const runs = data.workflow_runs;
    if (runs.length === 0) {
      findings.push({
        severity: "info",
        check: "ci-flakiness",
        description: "No completed CI runs found",
      });
      return;
    }

    const failures = runs.filter((r) => r.conclusion === "failure").length;
    const rate = failures / runs.length;
    const pct = Math.round(rate * 100);

    const severity: HealthFinding["severity"] =
      rate > 0.3 ? "critical" : rate > 0.15 ? "warning" : "info";

    findings.push({
      severity,
      check: "ci-flakiness",
      description: `CI failure rate: ${pct}% (${failures}/${runs.length} recent runs failed)`,
      detail: `Last ${runs.length} runs analyzed. Failing workflows: ${runs
        .filter((r) => r.conclusion === "failure")
        .map((r) => r.name)
        .slice(0, 5)
        .join(", ")}`,
    });
  } catch (err) {
    findings.push({
      severity: "info",
      check: "ci-flakiness",
      description: `CI flakiness check failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}

// ─── Main Export ──────────────────────────────────────────────────────────────

/**
 * Run all health checks against the target repo. Each check is independent —
 * a failure in one does not affect the others.
 *
 * @param repoPath   Absolute path to the target repo.
 * @param repoSlug   GitHub owner/repo slug (e.g. "acme/my-tool").
 * @param _config    Autopilot config (reserved for future per-check thresholds).
 */
export async function runHealthChecks(
  repoPath: string,
  repoSlug: string,
  _config: AutopilotConfig
): Promise<HealthFinding[]> {
  const findings: HealthFinding[] = [];

  checkNpmAudit(repoPath, findings);
  checkNpmOutdated(repoPath, findings);
  checkPipOutdated(repoPath, findings);
  await checkCIFlakiness(repoSlug, findings);

  return findings;
}

/**
 * Format health findings as a readable string for inclusion in a system prompt.
 */
export function formatHealthFindings(findings: HealthFinding[]): string {
  if (findings.length === 0) return "(no health findings)";

  return findings
    .map((f) => {
      const icon =
        f.severity === "critical" ? "🔴" : f.severity === "warning" ? "🟡" : "🟢";
      const detail = f.detail ? `\n  Detail: ${f.detail}` : "";
      return `${icon} [${f.check}] ${f.description}${detail}`;
    })
    .join("\n");
}
