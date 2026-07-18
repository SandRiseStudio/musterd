import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseToolCall, repoRelativePath } from './gate.js';

/**
 * Unit coverage for the gate hook's payload parse (ADR 150). The end-to-end adjudication is covered by
 * the server's gate-http test; here we pin the lenient extraction of a Claude Code PreToolUse payload —
 * the thing that decides what (if anything) the matcher sees, and that a malformed payload yields null
 * (→ the caller allows, fail-open).
 */
describe('parseToolCall (ADR 150 PreToolUse payload)', () => {
  it('extracts a Bash command', () => {
    const call = parseToolCall(
      JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'gh pr merge 320' } }),
    );
    expect(call).toEqual({ tool: 'Bash', command: 'gh pr merge 320' });
  });

  it('extracts an Edit/Write file path', () => {
    expect(
      parseToolCall(JSON.stringify({ tool_name: 'Write', tool_input: { file_path: 'src/x.ts' } })),
    ).toEqual({ tool: 'Write', path: 'src/x.ts' });
  });

  it('extracts a NotebookEdit notebook path', () => {
    expect(
      parseToolCall(
        JSON.stringify({ tool_name: 'NotebookEdit', tool_input: { notebook_path: 'n.ipynb' } }),
      ),
    ).toEqual({ tool: 'NotebookEdit', path: 'n.ipynb' });
  });

  it('a tool with neither path nor command yields a call that matches nothing', () => {
    expect(parseToolCall(JSON.stringify({ tool_name: 'Read', tool_input: {} }))).toEqual({
      tool: 'Read',
    });
  });

  it('null on malformed / non-object / missing tool_name (→ caller allows, fail-open)', () => {
    expect(parseToolCall('not json')).toBeNull();
    expect(parseToolCall('[]')).toBeNull();
    expect(parseToolCall('42')).toBeNull();
    expect(parseToolCall(JSON.stringify({ tool_input: { command: 'x' } }))).toBeNull();
    expect(parseToolCall('')).toBeNull();
  });
});

describe('repoRelativePath (ADR 150) — compare paths against repo-relative lane globs', () => {
  it('relativizes an absolute path under cwd', () => {
    const abs = join(process.cwd(), 'packages/server/src/x.ts');
    expect(repoRelativePath(abs)).toBe('packages/server/src/x.ts');
  });

  it('leaves an already-relative path untouched', () => {
    expect(repoRelativePath('src/tariff.ts')).toBe('src/tariff.ts');
  });

  it('leaves an absolute path OUTSIDE cwd as-is (a leading .. → correctly ungated)', () => {
    expect(repoRelativePath('/etc/passwd')).toBe('/etc/passwd');
  });
});
