# batond

> **Coordination observability for agent + human teams.** See the handoff, not just the agents on either side of it — every handoff, wait, and dropped ball.

Existing agent-observability tools see *inside* each agent (its LLM calls, tools, reasoning). batond sees the space *between* agents and humans: handoffs, help requests, blocking waits, ignored messages — the coordination failures that account for most multi-agent breakdowns. It ingests [musterd](https://github.com/SandRiseStudio/musterd) coordination logs natively and plain OpenTelemetry GenAI/agent spans, so it works whether or not you run musterd.

A sibling to musterd — *musterd assembles the team; batond watches the baton between them.*

> This `0.0.0` publish reserves the package name. The tool is in early design and will ship as a later version. Until then, see the project repository.

Licensed MIT.
