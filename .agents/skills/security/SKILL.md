---
name: security
description: Use when threat-modeling musterd, running authorized security scans, validating findings, proposing or implementing remediations, preparing security-posture evidence, or planning offensive testing.
---

# Security

Own musterd's application-security evidence without turning investigation into disclosure or authority. A Role is responsibility, not permission to touch infrastructure, production, or another Member's Workspace.

## Start from an attributable baseline

- Read `AGENTS.md`, `docs/design/security.md` when present, and the relevant architecture before scanning.
- Confirm identity, Role, clean Workspace state, current `origin/main` SHA, plugin version, and model.
- Use a dedicated, pre-authorized high-stakes audit Lane; claiming it is authorization to scan its stated scope. If no such Lane exists, obtain Nick's blocking approval before opening or running a whole-repository scan. Keep audit work separate from remediation and public-posture Lanes.
- Threat-model before scanning. Record the SHA, model, plugin version, included surfaces, exclusions, coverage gaps, and validation status. Zero findings is not a security guarantee.
- Use the default model for triage and ordinary diff review. Use `gpt-5.6-sol` with `xhigh` for whole-repository or deep scans and consequential validation.

## Keep findings private

Store manifests, candidates, traces, PoCs, and reports in the Codex Security temporary scan directory, never in tracked files. Read-only fan-out may inspect and write temporary scan artifacts; subagents never edit, claim, build, or commit repository work.

Validate non-destructively with the least evidence needed. Never put exploit details in public issues, branch names, commits, PR text, CI logs, Team-visible Lane fields, or Team-wide Acts. For a credible significant finding, send Nick a directed non-exploit summary: affected surface, severity, confidence, impact, and containment need. Obtain an approved private channel before transferring reproduction steps or raw evidence.

## Remediate one accepted finding at a time

Do not fix inside the audit Lane. After Nick reviews and accepts a finding, open and claim one private remediation Lane from fresh `origin/main`. Make the smallest bounded change in your own seat, follow ADR gates, add regression coverage, run the prescribed repository gates, and revalidate consequential fixes with `gpt-5.6-sol` at `xhigh`. Coordinate disclosure timing with Nick before publishing anything that reveals the weakness.

Submit a read-only audit Lane for counterpart acceptance without PR/SHA evidence. Remediation Lanes follow the normal landed-PR attestation flow.

Leave public-posture work unclaimed until every baseline finding is fixed, accepted, or explicitly deferred by Nick.

## Offensive testing requires a new authorization

Active testing always requires a separate high-stakes Lane and a blocking approval ask to Nick naming targets, ports, time window, allowed and excluded techniques, resource ceilings, data policy, stop conditions, and artifact retention. Silence means hold.

Use Strix only against disposable, isolated local staging with synthetic credentials and data. Never target production, the shared daemon at `localhost:4849`, another Member's Workspace, unrelated local services, or external infrastructure. Stop on scope escape, instability, or unexpected real data. Keep PoCs private and retest accepted fixes. Shannon is an approved fallback only when Strix is unsuitable and Nick authorizes it. Keep both ephemeral; adding either to runtime or CI requires an ADR.

Route shared-daemon, staging-infrastructure, and service-lifecycle work to the platform Role.
