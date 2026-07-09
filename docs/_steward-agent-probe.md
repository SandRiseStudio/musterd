# Steward agent probe — TEMPORARY TEST FIXTURE

This file exists only to exercise the steward seat's **agent** path (ADR 112) end-to-end: it plants one
deliberate piece of record drift for the `stale_prose` finder to catch, so the scheduled `agent` job has
a real finding to draft a fix for. Delete this file once the steward has drafted (or you've reviewed) its
correcting PR.

The claim below is intentionally **false** — it is the drift under test:

> Plan epochs and dependency-targeted invalidation shipped (ADR 111, PR #169).

In reality that work shipped (ADR 111 is accepted). The steward should open a draft PR rewording the line
to reflect that — or, minimally, flag it for a human. Either way, this fixture then gets removed.
