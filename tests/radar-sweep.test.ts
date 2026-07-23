import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadSeen, mergeCandidates, partitionBySeen } from '../scripts/radar/dedup.ts';
import {
  buildArxivSearchQuery,
  matchesKeywordFilter,
  normalizeArxivId,
  parseArxivAtom,
  parseHfDailyPapers,
  truncateDescription,
} from '../scripts/radar/fetch.ts';
import { forbiddenWritePaths, parseArgs, runSweep } from '../scripts/radar/sweep.ts';
import type { RadarCandidate, SeenLedger } from '../scripts/radar/types.ts';

const SAMPLE_ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/2503.13657v1</id>
    <updated>2025-03-17T00:00:00Z</updated>
    <published>2025-03-17T00:00:00Z</published>
    <title>MAST: Multi-Agent System Taxonomy</title>
    <summary>
      We present a taxonomy of multi-agent failure modes for human-agent collaboration.
    </summary>
    <category term="cs.MA" scheme="http://arxiv.org/schemas/atom"/>
    <category term="cs.AI" scheme="http://arxiv.org/schemas/atom"/>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/2412.15701v5</id>
    <published>2024-12-20T00:00:00Z</published>
    <title>Collaborative Gym</title>
    <summary>A framework for human-agent collaboration evaluation.</summary>
    <category term="cs.HC"/>
  </entry>
</feed>`;

const SAMPLE_HF = [
  {
    paper: {
      id: '2503.13657',
      title: 'MAST on Hugging Face',
      summary: 'multi-agent failure taxonomy mirrored on HF Papers',
      publishedAt: '2025-03-17T12:00:00.000Z',
    },
  },
  {
    paper: {
      id: '9999.00001',
      title: 'Unrelated Vision Paper',
      summary: 'image classification on ImageNet',
      publishedAt: '2025-03-18T12:00:00.000Z',
    },
  },
];

describe('truncateDescription', () => {
  it('returns short text unchanged', () => {
    expect(truncateDescription('hello', 100)).toBe('hello');
  });

  it('truncates on a word boundary when possible', () => {
    const text = 'one two three four five six seven eight nine ten';
    const out = truncateDescription(text, 20);
    expect(out.length).toBeLessThanOrEqual(20);
    expect(out).not.toMatch(/ $/);
    expect(out.startsWith('one')).toBe(true);
  });
});

describe('normalizeArxivId / keywords', () => {
  it('strips version suffixes', () => {
    expect(normalizeArxivId('2503.13657v2')).toBe('2503.13657');
    expect(normalizeArxivId('http://arxiv.org/abs/2412.15701v5')).toBe('2412.15701');
  });

  it('matches thesis keyword phrases', () => {
    expect(matchesKeywordFilter('A multi-agent coordination protocol')).toBe(true);
    expect(matchesKeywordFilter('pure cryptography')).toBe(false);
  });
});

describe('parseArxivAtom', () => {
  it('extracts id, title, abstract, categories', () => {
    const cs = parseArxivAtom(SAMPLE_ATOM);
    expect(cs).toHaveLength(2);
    expect(cs[0]!.id).toBe('2503.13657');
    expect(cs[0]!.source).toBe('arxiv');
    expect(cs[0]!.url).toBe('https://arxiv.org/abs/2503.13657');
    expect(cs[0]!.title).toContain('MAST');
    expect(cs[0]!.abstract).toMatch(/multi-agent/i);
    expect(cs[0]!.categories).toEqual(expect.arrayContaining(['cs.MA', 'cs.AI']));
    expect(cs[0]!.published).toBe('2025-03-17');
  });
});

describe('parseHfDailyPapers', () => {
  it('keeps keyword hits and drops unrelated', () => {
    const cs = parseHfDailyPapers(SAMPLE_HF);
    expect(cs).toHaveLength(1);
    expect(cs[0]!.id).toBe('2503.13657');
    expect(cs[0]!.source).toBe('hf');
    expect(cs[0]!.url).toContain('huggingface.co/papers/');
  });
});

describe('dedup', () => {
  const cand = (over: Partial<RadarCandidate>): RadarCandidate => ({
    source: 'arxiv',
    id: '2503.13657',
    title: 't',
    url: 'https://arxiv.org/abs/2503.13657',
    published: '2025-03-17',
    ...over,
  });

  it('loadSeen reads ledger shape', () => {
    const dir = mkdtempSync(join(tmpdir(), 'radar-seen-'));
    const path = join(dir, 'seen.json');
    writeFileSync(path, JSON.stringify({ arxiv: ['1111.22222'], hf: [] }));
    expect(loadSeen(path)).toEqual({ arxiv: ['1111.22222'], hf: [] });
  });

  it('partitionBySeen splits fresh vs known (incl. cross-source)', () => {
    const seen: SeenLedger = { arxiv: ['2503.13657'], hf: [] };
    const { fresh, alreadySeen } = partitionBySeen(
      [
        cand({ source: 'arxiv' }),
        cand({ source: 'hf', url: 'https://huggingface.co/papers/2503.13657' }),
        cand({ id: '2412.15701' }),
      ],
      seen,
    );
    expect(alreadySeen.map((c) => `${c.source}:${c.id}`).sort()).toEqual([
      'arxiv:2503.13657',
      'hf:2503.13657',
    ]);
    expect(fresh).toHaveLength(1);
    expect(fresh[0]!.id).toBe('2412.15701');
  });

  it('mergeCandidates prefers arxiv over hf for same id', () => {
    const merged = mergeCandidates([
      [cand({ source: 'hf', title: 'HF title' })],
      [cand({ source: 'arxiv', title: 'arXiv title' })],
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.source).toBe('arxiv');
    expect(merged[0]!.title).toBe('arXiv title');
  });
});

describe('buildArxivSearchQuery', () => {
  it('ORs the configured categories (keywords filtered client-side)', () => {
    const q = buildArxivSearchQuery();
    expect(q).toContain('cat:cs.MA');
    expect(q).toContain('cat:cs.AI');
    expect(q).toContain('cat:cs.HC');
    expect(q).toBe('cat:cs.MA OR cat:cs.AI OR cat:cs.HC');
  });
});

describe('runSweep (mocked fetch)', () => {
  it('returns new candidates and never requires writing seen.json', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'radar-sweep-'));
    const seenFile = join(dir, 'seen.json');
    writeFileSync(seenFile, JSON.stringify({ arxiv: [], hf: [] }));

    const fetchFn = async (url: string): Promise<Response> => {
      if (url.includes('export.arxiv.org')) {
        return new Response(SAMPLE_ATOM, { status: 200 });
      }
      if (url.includes('huggingface.co/api/daily_papers')) {
        return new Response(JSON.stringify(SAMPLE_HF), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    };

    const report = await runSweep({
      json: true,
      sinceDays: 3650, // include 2024–2025 sample dates
      limit: 10,
      fetchFn,
      seenFile,
    });

    expect(report.warnings).toEqual([]);
    expect(report.new_count).toBeGreaterThanOrEqual(2);
    expect(report.new.some((c) => c.id === '2503.13657')).toBe(true);
    expect(forbiddenWritePaths().some((p) => p.endsWith('research-foundation.md'))).toBe(true);
    expect(forbiddenWritePaths().some((p) => p.endsWith('seen.json'))).toBe(true);
  });

  it('parseArgs reads flags', () => {
    expect(parseArgs(['--json', '--since', '14', '--limit', '3', '--triage'])).toEqual({
      json: true,
      sinceDays: 14,
      limit: 3,
      triage: true,
    });
  });
});
