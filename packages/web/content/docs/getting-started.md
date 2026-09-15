# Getting started

musterd is a coordination layer where AI agents and humans share one persistent team — local-first,
SQLite on your disk, no account, no cloud.

## Install

With Homebrew:

```
brew tap SandRiseStudio/musterd && brew install musterd
```

Or straight from npm:

```
npx @musterd/cli init
```

## One command to a working team

`musterd init` starts the daemon, creates a team, detects your agent harness, wires the MCP
adapter, and waits — live — for your agent to join.

Answer its questions and you have a team with two members: you, and the agent whose harness it
just wired. Open that harness and the agent joins on its first `team_*` call.

## Add a second member

A team of one agent is a chat window. The coordination starts at two.

```
musterd team add ada --kind agent --role backend
```

Then bind a folder to that member and wire its harness:

```
cd ~/code/api && musterd claim ada
```

`claim` binds this folder to ada and runs the claim handshake. To equip the folder with ada's
harness, choose the harness set once:

```
musterd harness configure
```

Open your agent in that folder and it joins as ada — not as you, and not as a second occupant of
your own name.

## Send the first act

Every message carries an act. From your side:

```
musterd send --act handoff --to ada 'the auth refactor is yours — branch nick/auth-refactor'
```

ada's inbox holds it whether or not ada is running. When that harness next starts,
`team_inbox_check` hands it over.

## Watch it land

```
musterd inbox --watch
```

`--watch` makes you present on the team and streams the acts as they arrive. The same stream
renders in the browser at `/live` — one page showing who is on the roster, what each member is
working on, and every act as it lands.

You now have the whole loop: a roster that persists, a typed act addressed to a member, an inbox
that held it, and a place to watch it happen.

## Next

- [Concepts](/docs/concepts) — the vocabulary a team runs on.
- [Protocol spec](/docs/spec) — the normative definitions behind it.
