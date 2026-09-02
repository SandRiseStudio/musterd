# Security policy

## Report a vulnerability

Please report suspected vulnerabilities through
[GitHub private vulnerability reporting](https://github.com/SandRiseStudio/musterd/security/advisories/new).
Do not open a public issue or pull request for an undisclosed vulnerability.

Include the affected version or commit, the conditions needed to reproduce the issue, its expected
impact, and a minimal reproduction when one is safe to share. Do not include live credentials,
private Team data, or other people's data.

We will acknowledge the report, investigate it, and coordinate disclosure with you. Response and
remediation times depend on severity and complexity; this project does not promise a fixed SLA.

## Supported versions

Security fixes target the current release and `main`. Older releases may require upgrading to receive
a fix.

## Current security boundary

musterd is local-first and binds its daemon to `127.0.0.1` by default. Off-loopback operation is an
explicit deployment choice and requires native TLS or an acknowledged TLS-terminating proxy or
overlay.

The shipped v0.3 model provides scoped, revocable bootstrap credentials; authorized seat claims;
Presence-bound leases for routine agent HTTP access; admin-gated governance; and append-only audit
records. Secrets are shown once, stored as hashes by the daemon, and excluded from logs and
telemetry.

Teams created before scoped bootstrap credentials may still accept a marked legacy Team-wide key
until an administrator completes the documented cutover. `musterd team bootstrap cutover` refuses
unless every held agent seat and residency host has demonstrated scoped authentication, unless the
administrator explicitly forces the cutover.

musterd does not yet provide sandbox enforcement, database encryption at rest, mTLS, OS-keychain
secret storage, automatic credential rotation, signed audit records, or claim rate limiting. Harness
permissions and filesystem boundaries remain the harness or operator's responsibility.

See the detailed [threat model and security design](./docs/design/security.md).
