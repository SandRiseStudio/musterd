import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { textFingerprint } from '@musterd/protocol';

/**
 * Per-session record of subagent ids this session spawned (ADR 442). The filename is sha256-16 of
 * the session id, so the raw id never lands on disk as a path. A missing or corrupt file is empty.
 */
export function recordSubagent(stateDir: string, sessionId: string, agentId: string): void {
  if (!sessionId || !agentId) return;
  const path = ledgerPath(stateDir, sessionId);
  const ids = readIds(path);
  if (ids.includes(agentId)) return;
  ids.push(agentId);
  mkdirSync(dirname(path), { recursive: true });
  const stage = `${path}.tmp-${String(process.pid)}`;
  try {
    writeFileSync(stage, `${JSON.stringify(ids)}\n`);
    renameSync(stage, path);
  } catch (err) {
    rmSync(stage, { force: true });
    throw err;
  }
}

export function isOwnSubagent(stateDir: string, sessionId: string, target: string): boolean {
  if (!sessionId || !target) return false;
  return readIds(ledgerPath(stateDir, sessionId)).includes(target);
}

/**
 * The spawned id off an Agent PostToolUse payload. Measured 2026-09-24 on Claude Code 2.1.281:
 * the tool result is text, not a JSON id field — `agentId: <hex>` plus `SendMessage` `to: '<hex>'`.
 * A JSON `tool_response.agentId` / `agent_id` is accepted too, for a harness that exposes one.
 */
export function spawnedAgentId(raw: string): string | undefined {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof json !== 'object' || json === null) return undefined;
  const o = json as Record<string, unknown>;
  const response = o['tool_response'] ?? o['toolResponse'];
  if (response === undefined) return undefined;
  return idFrom(response);
}

function ledgerPath(stateDir: string, sessionId: string): string {
  return join(stateDir, 'subagents', `${textFingerprint(sessionId)}.json`);
}

function readIds(path: string): string[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === 'string' && id.length > 0);
  } catch {
    return [];
  }
}

function idFrom(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return /agentId:\s*([0-9a-zA-Z_-]+)/.exec(value)?.[1];
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const id = idFrom(item);
      if (id) return id;
    }
    return undefined;
  }
  if (typeof value === 'object' && value !== null) {
    const o = value as Record<string, unknown>;
    for (const key of ['agentId', 'agent_id'] as const) {
      const direct = o[key];
      if (typeof direct === 'string' && direct) return direct;
    }
    for (const child of Object.values(o)) {
      const id = idFrom(child);
      if (id) return id;
    }
  }
  return undefined;
}
