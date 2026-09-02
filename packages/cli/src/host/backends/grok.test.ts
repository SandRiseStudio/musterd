import { describe, expect, it } from 'vitest';
import { buildGrokFreshArgs, buildGrokResumeArgs } from './grok.js';

describe('grok wake argv (ADR 352 §7)', () => {
  it('fresh is -p with --cwd, never --yolo', () => {
    const args = buildGrokFreshArgs('hello from the daemon', '/tmp/ws');
    expect(args).toEqual(['-p', 'hello from the daemon', '--cwd', '/tmp/ws']);
    expect(args.join(' ')).not.toMatch(/yolo|always-approve|bypassPermissions/);
  });

  it('resume is -r <id> plus the same fresh shape', () => {
    expect(buildGrokResumeArgs('line', '01abc', '/tmp/ws')).toEqual([
      '-p',
      'line',
      '-r',
      '01abc',
      '--cwd',
      '/tmp/ws',
    ]);
  });
});
