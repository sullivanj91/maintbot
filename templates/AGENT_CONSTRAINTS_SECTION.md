## Autopilot Constraints

<!-- IMMUTABLE — requires a human-approved PR to modify.
     The agent cannot update this section autonomously.
     The SHA-256 hash of this section is stored in .autopilot.yml as
     constitutional_hash. If the hash mismatches, the agent halts.          -->

<!-- Fill in during onboarding by answering the interview questions. -->

- NEVER modify <off-limits path> autonomously; always file an issue
- NEVER perform schema migrations without a human-approved migration plan
- NEVER remove a public API endpoint; always file an issue for human review
- NEVER rotate secrets autonomously; always file an issue
- Maximum 1 dependency upgrade per session
- All auto-commits require a passing CI run; never bypass CI
- If test coverage drops below <threshold>%, halt and file an issue
- Do not file more than 3 issues per session
