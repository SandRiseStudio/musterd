import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadSeen, partitionBySeen } from './dedup.ts';
import { emitDigest } from './digest.ts';
import { parseExnFeed, sweepExn } from './fetch.ts';
import type { RadarCandidate, SweepReport } from './types.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const NOW = Date.parse('2026-08-24T12:00:00Z');
const item = (over: Record<string, unknown> = {}) => ({
  id: 'uuid-1',
  title: 'Patterns and problems in multiagent systems',
  url: 'https://www.anthropic.com/research/multiagent-systems',
  description: 'Coordination failures in swarms of agents.',
  audio_summary: 'Ava and Vince argue the result warns against swarm hype.',
  discovered_at: '2026-08-24T16:13:31.392+00:00',
  ...over,
});

describe('parseExnFeed', () => {
  it('maps feed items to exn candidates, folding audio_summary into the abstract', () => {
    const [c] = parseExnFeed({ items: [item()] });
    expect(c).toMatchObject({
      source: 'exn',
      id: 'uuid-1',
      title: 'Patterns and problems in multiagent systems',
      url: 'https://www.anthropic.com/research/multiagent-systems',
      published: '2026-08-24',
    });
    expect(c!.abstract).toContain('Coordination failures');
    expect(c!.abstract).toContain('swarm hype');
  });

  it('normalizes an arXiv-linked row to the arXiv id so cross-source merge can collapse it', () => {
    const [c] = parseExnFeed({
      items: [item({ id: 'uuid-2', url: 'https://arxiv.org/html/2608.21156v1' })],
    });
    expect(c).toMatchObject({ source: 'exn', id: '2608.21156' });
  });

  it('drops malformed rows rather than throwing', () => {
    expect(parseExnFeed({ items: [{ id: 'x' }, 42, null] })).toEqual([]);
    expect(parseExnFeed('not json shape')).toEqual([]);
  });
});

describe('sweepExn', () => {
  const respond = (body: unknown) => async () =>
    new Response(JSON.stringify(body), { status: 200 });

  it('keeps only items inside the window that match the keyword filter', async () => {
    const fetchFn = respond({
      items: [
        item(),
        item({ id: 'uuid-old', discovered_at: '2026-07-01T00:00:00Z' }),
        item({
          id: 'uuid-offtopic',
          title: 'A sourdough starter guide',
          description: 'Bread.',
          audio_summary: 'Bread again.',
        }),
      ],
    });
    const { candidates } = await sweepExn({ sinceDays: 14, fetchFn, now: NOW });
    expect(candidates.map((c) => c.id)).toEqual(['uuid-1']);
  });

  it('degrades to a warning, never a throw, when the feed is down', async () => {
    const fetchFn = async () => new Response('nope', { status: 503 });
    const { candidates, warning } = await sweepExn({ sinceDays: 14, fetchFn, now: NOW });
    expect(candidates).toEqual([]);
    expect(warning).toMatch(/503/);
  });
});

describe('seen ledger with the exn source', () => {
  it('loadSeen defaults exn on a legacy two-key file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'radar-exn-test-'));
    dirs.push(dir);
    const p = join(dir, 'seen.json');
    writeFileSync(p, JSON.stringify({ arxiv: ['a'], hf: [] }));
    expect(loadSeen(p)).toEqual({ arxiv: ['a'], hf: [], exn: [] });
  });

  it('partitionBySeen filters exn candidates against the exn ledger', () => {
    const c: RadarCandidate = {
      source: 'exn',
      id: 'uuid-1',
      title: 't',
      url: 'u',
      published: '2026-08-24',
    };
    const { fresh } = partitionBySeen([c], { arxiv: [], hf: [], exn: ['uuid-1'] });
    expect(fresh).toEqual([]);
  });

  it('emitDigest appends exn ids into a legacy seen.json that lacks the key', () => {
    const dir = mkdtempSync(join(tmpdir(), 'radar-exn-test-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'seen.json'), JSON.stringify({ arxiv: [], hf: [] }));
    const report: SweepReport = {
      generated: '2026-08-24T16:00:00.000Z',
      since_days: 14,
      candidates_fetched: 1,
      already_seen: 0,
      new_count: 1,
      printed: 1,
      truncated: false,
      new: [{ source: 'exn', id: 'uuid-1', title: 't', url: 'u', published: '2026-08-24' }],
      warnings: [],
      triage: {
        prompt_version: 'radar-v1',
        tier1_model: 'm1',
        tier2_model: 'm2',
        relevance_floor: 0.55,
        candidates_in: 1,
        shortlisted: 0,
        shortlist_truncated: false,
        tier1: [],
        surfaced: [],
        tier2: [],
        warnings: [],
      },
    };
    emitDigest(report, dir);
    const seen = JSON.parse(readFileSync(join(dir, 'seen.json'), 'utf8'));
    expect(seen.exn).toEqual(['uuid-1']);
  });
});
