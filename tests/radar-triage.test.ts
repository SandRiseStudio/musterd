import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractJson } from '../scripts/radar/llm.ts';
import { runSweep } from '../scripts/radar/sweep.ts';
import {
  buildTier1System,
  buildTier2System,
  runTriage,
  selectShortlist,
} from '../scripts/radar/triage.ts';
import type { RadarCandidate, Tier1Hit } from '../scripts/radar/types.ts';

const cand = (over: Partial<RadarCandidate> & { id: string; title: string }): RadarCandidate => ({
  source: 'arxiv',
  url: `https://arxiv.org/abs/${over.id}`,
  published: '2026-07-20',
  abstract: 'A multi-agent coordination study.',
  ...over,
});

describe('extractJson', () => {
  it('parses fenced and bare JSON', () => {
    expect(extractJson('```json\n[{"id":"1"}]\n```')).toEqual([{ id: '1' }]);
    expect(extractJson('Here you go:\n{"a":1}')).toEqual({ a: 1 });
  });
});

describe('selectShortlist', () => {
  it('keeps highest-score keeps and truncates', () => {
    const candidates = [
      cand({ id: 'a', title: 'A' }),
      cand({ id: 'b', title: 'B' }),
      cand({ id: 'c', title: 'C' }),
    ];
    const tier1: Tier1Hit[] = [
      { id: 'a', keep: true, score: 0.5, reason: 'ok' },
      { id: 'b', keep: true, score: 0.9, reason: 'best' },
      { id: 'c', keep: false, score: 0.1, reason: 'no' },
    ];
    const { shortlist, truncated } = selectShortlist(candidates, tier1, 1);
    expect(shortlist.map((c) => c.id)).toEqual(['b']);
    expect(truncated).toBe(true);
  });
});

describe('runTriage (mocked LLM)', () => {
  it('runs tier-1 then tier-2 and surfaces non-ignore verdicts', async () => {
    const candidates = [
      cand({
        id: '2503.13657',
        title: 'MAST',
        abstract: 'Multi-agent failure taxonomy for human-agent teams.',
      }),
      cand({
        id: '9999.00001',
        title: 'VisionNet',
        abstract: 'Image classification on ImageNet.',
      }),
    ];

    let calls = 0;
    const completeFn = async (args: { model: string; messages: { content: string }[] }) => {
      calls += 1;
      if (calls === 1) {
        expect(args.model).toContain('haiku');
        return {
          model: args.model,
          text: JSON.stringify([
            { id: '2503.13657', keep: true, score: 0.85, reason: 'MAST-like' },
            { id: '9999.00001', keep: false, score: 0.05, reason: 'vision only' },
          ]),
        };
      }
      expect(args.model).toContain('sonnet');
      expect(args.messages[0]!.content).toContain('2503.13657');
      expect(args.messages[0]!.content).not.toContain('9999.00001');
      return {
        model: args.model,
        text: JSON.stringify([
          {
            id: '2503.13657',
            score: 0.82,
            dimensions: { 'failure-taxonomies': 0.9, 'human-agent-loop': 0.6 },
            one_line: 'MAST-style failure taxonomy',
            why_musterd: 'Direct substrate for coordination-density / MAST-in-the-wild',
            gut_check: 'Close to what we already operationalize; still useful as evidence.',
            confidence: 0.7,
            verdict: 'record-as-evidence',
          },
        ]),
      };
    };

    const report = await runTriage({
      candidates,
      apiKey: 'test-key',
      completeFn,
      promptBody: '# stub prompt\n',
    });

    expect(report.prompt_version).toBe('radar-v1');
    expect(report.shortlisted).toBe(1);
    expect(report.surfaced).toHaveLength(1);
    expect(report.surfaced[0]!.verdict).toBe('record-as-evidence');
    expect(report.surfaced[0]!.id).toBe('2503.13657');
    expect(report.warnings).toEqual([]);
  });

  it('forces ignore when score is below floor', async () => {
    const candidates = [cand({ id: '1111.22222', title: 'Borderline' })];
    let calls = 0;
    const completeFn = async () => {
      calls += 1;
      if (calls === 1) {
        return {
          model: 't1',
          text: JSON.stringify([{ id: '1111.22222', keep: true, score: 0.6, reason: 'maybe' }]),
        };
      }
      return {
        model: 't2',
        text: JSON.stringify([
          {
            id: '1111.22222',
            score: 0.2,
            dimensions: {},
            one_line: 'weak',
            why_musterd: 'n/a',
            gut_check: 'Too thin.',
            confidence: 0.4,
            verdict: 'record-as-evidence',
          },
        ]),
      };
    };
    const report = await runTriage({
      candidates,
      apiKey: 'k',
      completeFn,
      promptBody: 'p',
      relevanceFloor: 0.45,
    });
    expect(report.tier2[0]!.verdict).toBe('ignore');
    expect(report.surfaced).toHaveLength(0);
  });

  it('buildTier systems mention verdict ladder', () => {
    expect(buildTier1System('body')).toContain('Tier-1');
    expect(buildTier2System('body', 0.45)).toContain('consider-ADR');
  });
});

describe('runSweep --triage (mocked)', () => {
  it('attaches triage to the sweep report', async () => {
    const SAMPLE_ATOM = `<?xml version="1.0"?>
<feed><entry>
  <id>http://arxiv.org/abs/2503.13657v1</id>
  <published>2025-03-17T00:00:00Z</published>
  <title>MAST</title>
  <summary>multi-agent failure taxonomy</summary>
  <category term="cs.MA"/>
</entry></feed>`;

    const fetchFn = async (url: string): Promise<Response> => {
      if (url.includes('export.arxiv.org')) return new Response(SAMPLE_ATOM, { status: 200 });
      if (url.includes('huggingface.co')) return new Response('[]', { status: 200 });
      return new Response('nf', { status: 404 });
    };

    let calls = 0;
    const completeFn = async () => {
      calls += 1;
      if (calls === 1) {
        return {
          model: 'haiku',
          text: JSON.stringify([{ id: '2503.13657', keep: true, score: 0.9, reason: 'yes' }]),
        };
      }
      return {
        model: 'sonnet',
        text: JSON.stringify([
          {
            id: '2503.13657',
            score: 0.8,
            dimensions: { 'failure-taxonomies': 0.9 },
            one_line: 'MAST',
            why_musterd: 'failure taxonomy',
            gut_check: 'Useful evidence.',
            confidence: 0.8,
            verdict: 'consider-ADR',
          },
        ]),
      };
    };

    const dir = mkdtempSync(join(tmpdir(), 'radar-t-'));
    const seenFile = join(dir, 'seen.json');
    writeFileSync(seenFile, JSON.stringify({ arxiv: [], hf: [] }));

    const report = await runSweep({
      json: true,
      sinceDays: 3650,
      limit: 10,
      triage: true,
      fetchFn,
      seenFile,
      apiKey: 'k',
      completeFn,
      promptBody: 'prompt',
    });

    expect(report.triage?.surfaced[0]?.verdict).toBe('consider-ADR');
    expect(calls).toBe(2);
  });
});
