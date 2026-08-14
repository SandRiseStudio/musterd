import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findBinding, saveBinding } from './binding.js';
import {
  CURSOR_CAPTURE_LIVE_MS,
  enumerateCursorSessions,
  reconcileCursorCapture,
  resetCursorScan,
  type CursorSessionFile,
} from './cursorCapture.js';

const boot = {
  server: 'http://s1',
  team: 'lab',
  surface: 'cursor' as const,
  claim: { mode: 'seat' as const, name: 'Ui' },
};

function enumStub(files: CursorSessionFile[] | undefined) {
  return () => files;
}

describe('reconcileCursorCapture (ADR 270)', () => {
  let ws: string;
  let livePath: string;

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), 'adr270-ws-'));
    livePath = join(ws, '365e3420.txt');
    writeFileSync(livePath, 'cursor-agent session\n');
  });
  afterEach(() => {
    rmSync(ws, { recursive: true, force: true });
  });

  it('heals an unended Cursor slot to the newest live CLI transcript and DROPS the leftover model', () => {
    const startedAt = Date.now() - 3_600_000;
    saveBinding(ws, {
      ...boot,
      session: {
        harness: 'cursor',
        id: 'a3fb8a1c-desktop',
        transcript_path: join(ws, 'desktop.jsonl'),
        started_at: startedAt,
      },
      model_observed: { model: 'grok-4.6', harness: 'cursor', observed_at: startedAt },
    });

    expect(
      reconcileCursorCapture(
        ws,
        enumStub([{ id: '365e3420-cli', path: livePath, mtime: Date.now(), bytes: 20 }]),
      ),
    ).toBe(true);

    const after = findBinding(ws, {});
    expect(after?.session).toMatchObject({
      harness: 'cursor',
      id: '365e3420-cli',
      transcript_path: livePath,
    });
    expect(after?.model_observed).toBeUndefined();
  });

  it('keeps the observation when the slot already names the newest live id', () => {
    const startedAt = Date.now() - 60_000;
    const observation = { model: 'grok-4.6', harness: 'cursor' as const, observed_at: startedAt };
    saveBinding(ws, {
      ...boot,
      session: {
        harness: 'cursor',
        id: '365e3420-cli',
        transcript_path: livePath,
        started_at: startedAt,
      },
      model_observed: observation,
    });

    expect(
      reconcileCursorCapture(
        ws,
        enumStub([{ id: '365e3420-cli', path: livePath, mtime: Date.now(), bytes: 20 }]),
      ),
    ).toBe(false);

    expect(findBinding(ws, {})?.model_observed).toEqual(observation);
  });

  it('does not hop to a quieter sibling when the slot already names the newest live id', () => {
    const startedAt = Date.now() - 60_000;
    saveBinding(ws, {
      ...boot,
      session: {
        harness: 'cursor',
        id: 'cli-now',
        transcript_path: livePath,
        started_at: startedAt,
      },
      model_observed: { model: 'grok-4.6', harness: 'cursor', observed_at: startedAt },
    });
    const desktop = join(ws, 'desktop.jsonl');
    writeFileSync(desktop, '{}\n');

    expect(
      reconcileCursorCapture(
        ws,
        enumStub([
          { id: 'cli-now', path: livePath, mtime: Date.now(), bytes: 20 },
          { id: 'desktop', path: desktop, mtime: Date.now() - 60_000, bytes: 4 },
        ]),
      ),
    ).toBe(false);

    expect(findBinding(ws, {})?.session?.id).toBe('cli-now');
    expect(findBinding(ws, {})?.model_observed?.model).toBe('grok-4.6');
  });

  it('never steals a claude-code slot, even when a live Cursor transcript exists', () => {
    const startedAt = Date.now() - 60_000;
    saveBinding(ws, {
      ...boot,
      surface: 'claude-code',
      session: {
        harness: 'claude-code',
        id: 'claude-live',
        transcript_path: join(ws, 'claude.jsonl'),
        started_at: startedAt,
      },
      model_observed: { model: 'claude-opus-5', harness: 'claude-code', observed_at: startedAt },
    });

    expect(
      reconcileCursorCapture(
        ws,
        enumStub([{ id: '365e3420-cli', path: livePath, mtime: Date.now(), bytes: 20 }]),
      ),
    ).toBe(false);

    const after = findBinding(ws, {});
    expect(after?.session?.id).toBe('claude-live');
    expect(after?.model_observed?.model).toBe('claude-opus-5');
  });

  it('is a no-op when enumeration cannot tell (undefined, not [])', () => {
    const startedAt = Date.now() - 60_000;
    saveBinding(ws, {
      ...boot,
      session: {
        harness: 'cursor',
        id: 'desktop',
        transcript_path: join(ws, 'desktop.jsonl'),
        started_at: startedAt,
      },
      model_observed: { model: 'grok-4.6', harness: 'cursor', observed_at: startedAt },
    });

    expect(reconcileCursorCapture(ws, enumStub(undefined))).toBe(false);
    expect(findBinding(ws, {})?.model_observed?.model).toBe('grok-4.6');
  });

  it('does not heal to a transcript quieter than CURSOR_CAPTURE_LIVE_MS', () => {
    const startedAt = Date.now() - 60_000;
    saveBinding(ws, {
      ...boot,
      session: {
        harness: 'cursor',
        id: 'desktop',
        transcript_path: join(ws, 'desktop.jsonl'),
        started_at: startedAt,
      },
      model_observed: { model: 'grok-4.6', harness: 'cursor', observed_at: startedAt },
    });

    expect(
      reconcileCursorCapture(
        ws,
        enumStub([
          {
            id: 'old-cli',
            path: livePath,
            mtime: Date.now() - CURSOR_CAPTURE_LIVE_MS - 1,
            bytes: 20,
          },
        ]),
      ),
    ).toBe(false);
    expect(findBinding(ws, {})?.session?.id).toBe('desktop');
  });

  it('writes a Cursor slot when none exists and a live .txt does', () => {
    saveBinding(ws, {
      ...boot,
      model_observed: { model: 'grok-4.6', harness: 'cursor', observed_at: 1 },
    });

    expect(
      reconcileCursorCapture(
        ws,
        enumStub([{ id: '365e3420-cli', path: livePath, mtime: Date.now(), bytes: 20 }]),
      ),
    ).toBe(true);

    const after = findBinding(ws, {});
    expect(after?.session?.id).toBe('365e3420-cli');
    expect(after?.model_observed).toBeUndefined();
  });

  it('never throws on a bare/unbound folder', () => {
    const bare = mkdtempSync(join(tmpdir(), 'adr270-bare-'));
    expect(() => reconcileCursorCapture(bare)).not.toThrow();
    expect(reconcileCursorCapture(bare)).toBe(false);
    rmSync(bare, { recursive: true, force: true });
  });
});

describe('enumerateCursorSessions (ADR 270 copy of ADR 265 attribution)', () => {
  let home: string;
  let ws: string;

  const workspace = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'adr270-enum-ws-'));
    mkdirSync(join(dir, '.musterd'), { recursive: true });
    writeFileSync(join(dir, '.musterd', 'binding.json'), '{}');
    return dir;
  };

  const project = (
    dirName: string,
    opts: {
      workspacePath?: string;
      sessions?: { id: string; kind: 'jsonl' | 'txt'; ageMin?: number }[];
    } = {},
  ): void => {
    const root = join(home, '.cursor', 'projects', dirName);
    mkdirSync(join(root, 'agent-transcripts'), { recursive: true });
    if (opts.workspacePath) {
      writeFileSync(
        join(root, '.workspace-trusted'),
        JSON.stringify({ workspacePath: opts.workspacePath }) + '\n',
      );
    }
    for (const s of opts.sessions ?? []) {
      const p =
        s.kind === 'txt'
          ? join(root, 'agent-transcripts', `${s.id}.txt`)
          : join(root, 'agent-transcripts', s.id, `${s.id}.jsonl`);
      mkdirSync(join(p, '..'), { recursive: true });
      writeFileSync(p, s.kind === 'txt' ? 'user:\nhello\n' : '{"role":"user"}\n');
      const t = new Date(Date.now() - (s.ageMin ?? 0) * 60_000);
      utimesSync(p, t, t);
    }
  };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'adr270-enum-home-'));
    ws = workspace();
    resetCursorScan();
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
    resetCursorScan();
  });

  it('returns undefined when the Cursor projects tree is unavailable', () => {
    expect(enumerateCursorSessions(ws, join(home, 'nope'))).toBeUndefined();
  });

  it('attributes by .workspace-trusted workspacePath, not the folder name', () => {
    project('totally-unrelated-name', {
      workspacePath: ws,
      sessions: [{ id: 'cli-session', kind: 'txt' }],
    });
    expect(enumerateCursorSessions(ws, home)?.map((f) => f.id)).toEqual(['cli-session']);
  });

  it('sees both a desktop jsonl and a CLI txt in the same project', () => {
    project('slug-is-not-evidence', {
      workspacePath: ws,
      sessions: [
        { id: 'desktop', kind: 'jsonl', ageMin: 60 },
        { id: 'cli', kind: 'txt', ageMin: 1 },
      ],
    });
    expect(enumerateCursorSessions(ws, home)?.map((f) => f.id)).toEqual(['cli', 'desktop']);
  });

  it('leaves a project with no .workspace-trusted unattributed rather than slug-decoding', () => {
    project('Users-nick-agents-wanderer', {
      sessions: [{ id: 'orphan', kind: 'txt' }],
    });
    expect(enumerateCursorSessions(ws, home)).toEqual([]);
  });
});
