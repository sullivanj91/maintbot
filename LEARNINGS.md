# LEARNINGS.md

Cross-repo knowledge base for the Autopilot maintenance agent.

**Append-only.** Do not edit existing entries. The agent appends new entries at
the end of a session when it discovers a generalizable pattern confirmed in ≥2
distinct repos. Each entry is assigned a sequential LEARN-NNN id.

To search from code: `src/learnings.ts` → `searchLearnings(tags)`
To append from code: `src/learnings.ts` → `appendLearning(entry)`

Qualification gate: A pattern must appear in ≥2 distinct repos before it is
added here. This prevents premature generalization.

---

<!-- Entries are appended below this line by the agent. Do not edit above. -->
