import { describe, expect, it } from 'vitest';
import { coerceToolArgs, unknownKeyBounce } from './coerce.js';
import { bounceRepair } from './repair.js';

/**
 * Every case here is a shape observed in live telemetry between 2026-07-15 and 2026-07-24 (the
 * `tool_call_stats` bounce rows joined to the harness transcripts that produced them) — the rule
 * table is measured, so its tests are too. The "deliberately not coerced" block is the other half
 * of the contract: forgiveness that invents meaning is worse than a bounce.
 */

describe('lane id aliases', () => {
  // 70% of every bounce in the window, from 5 seats across 2 harnesses. Our own results and prose
  // say "lane" while the schema said `id` — agents pattern-matched us and paid a turn for it.
  it('accepts `lane` for `id` (izzo, miley, ryder, stanley)', () => {
    const { args, applied } = coerceToolArgs('lane_claim', { lane: '01KYAG1M52' });
    expect(args).toEqual({ id: '01KYAG1M52' });
    expect(applied).toEqual(['lane→id']);
  });

  it('accepts `lane_id` for `id` (gptbot/Codex, izzo)', () => {
    const { args, applied } = coerceToolArgs('lane_claim', { lane_id: '01KY0MATE2' });
    expect(args).toEqual({ id: '01KY0MATE2' });
    expect(applied).toEqual(['lane_id→id']);
  });

  it('carries the rest of the call through untouched', () => {
    const { args } = coerceToolArgs('lane_claim', {
      lane: '01KYAG1M52',
      branch: 'design/model-attestation-truth',
    });
    expect(args).toEqual({ id: '01KYAG1M52', branch: 'design/model-attestation-truth' });
  });

  it('applies to every lane tool that takes an id', () => {
    for (const tool of ['lane_claim', 'lane_handoff', 'lane_update', 'lane_resolve']) {
      expect(coerceToolArgs(tool, { lane_id: 'x' }).args).toEqual({ id: 'x' });
    }
  });

  it('lets an explicit `id` win over an alias — a caller that sends both meant the real one', () => {
    const { args, applied } = coerceToolArgs('lane_claim', { id: 'real', lane: 'stale' });
    expect(args).toEqual({ id: 'real', lane: 'stale' });
    expect(applied).toEqual([]);
  });
});

describe('lane surface alias', () => {
  // Reproduced 2026-07-27: `lane_open`+`lane_update` with `surface:[…]` returned SUCCESS both times
  // with `surface_globs: []` — the schema dropped the key, so the seat believed it had declared a
  // surface it had not. `surface` is the name our own render (`surface=[…]`) and the tool
  // description taught, so the natural guess now works.
  it('accepts `surface` for `surface_globs` on lane_open and lane_update', () => {
    for (const tool of ['lane_open', 'lane_update']) {
      const { args, applied } = coerceToolArgs(tool, { surface: ['packages/mcp/src/**'] });
      expect(args).toEqual({ surface_globs: ['packages/mcp/src/**'] });
      expect(applied).toEqual(['surface→surface_globs']);
    }
  });

  it('lets an explicit surface_globs win', () => {
    const { args, applied } = coerceToolArgs('lane_update', {
      id: 'x',
      surface_globs: ['real/**'],
      surface: ['stale/**'],
    });
    expect(args['surface_globs']).toEqual(['real/**']);
    expect(applied).toEqual([]);
  });
});

describe('unknown-key bounce text', () => {
  const known = new Set(['id', 'state', 'detail', 'surface_globs', 'depends_on', 'branch']);

  it('bounces in the SDK-anchored shape so telemetry still classes it invalid_input', () => {
    const text = unknownKeyBounce('lane_update', ['surface_glob'], known);
    expect(text.startsWith('Input validation error:')).toBe(true);
  });

  it('names the nearest valid key and the full valid set', () => {
    const text = unknownKeyBounce('lane_update', ['surface_glob'], known);
    expect(text).toContain("'surface_glob' (did you mean 'surface_globs'?)");
    expect(text).toContain('lane_update accepts: id, state, detail, surface_globs');
    expect(text).toContain('fix and retry the same call');
  });

  it('suggests nothing when nothing is close — a wrong suggestion is worse than none', () => {
    expect(unknownKeyBounce('lane_update', ['zzzzzzzzzz'], known)).not.toContain('did you mean');
  });

  it('carries its own repair line, so repair.ts leaves it alone', () => {
    const text = unknownKeyBounce('lane_update', ['surface_glob'], known);
    expect(text).toContain('\nrepair: ');
    expect(bounceRepair(text)).toBe('');
  });
});

describe('team_send recipient shapes', () => {
  it('unwraps a single-element array (gptbot: to:["nick"])', () => {
    const { args, applied } = coerceToolArgs('team_send', { act: 'status_update', to: ['nick'] });
    expect(args['to']).toBe('nick');
    expect(applied).toEqual(['to:[one]→string']);
  });

  it('drops an empty array so the schema default (@team) applies (gptbot: to:[])', () => {
    const { args, applied } = coerceToolArgs('team_send', { act: 'status_update', to: [] });
    expect('to' in args).toBe(false);
    expect(applied).toEqual(['to:[]→default']);
  });

  it('converts a wire Recipient back to the string form (gptbot: to:{kind:"team"})', () => {
    expect(coerceToolArgs('team_send', { to: { kind: 'team' } }).args['to']).toBe('@team');
    expect(coerceToolArgs('team_send', { to: { kind: 'broadcast' } }).args['to']).toBe(
      '@broadcast',
    );
    expect(coerceToolArgs('team_send', { to: { kind: 'member', name: 'nick' } }).args['to']).toBe(
      'nick',
    );
  });

  it('leaves a multi-recipient array to bounce — dropping recipients would lose a message', () => {
    const { args, applied } = coerceToolArgs('team_send', { to: ['nick', 'stanley'] });
    expect(args['to']).toEqual(['nick', 'stanley']);
    expect(applied).toEqual([]);
  });
});

describe('team_send body aliases', () => {
  it('accepts text/content/message for body (gptbot sent all three over two days)', () => {
    expect(coerceToolArgs('team_send', { act: 'status_update', text: 'a' }).args['body']).toBe('a');
    expect(coerceToolArgs('team_send', { act: 'status_update', content: 'b' }).args['body']).toBe(
      'b',
    );
    expect(coerceToolArgs('team_send', { act: 'message', message: 'c' }).args['body']).toBe('c');
  });

  it('does not overwrite a body that is already there', () => {
    const { args } = coerceToolArgs('team_send', { body: 'real', text: 'stale' });
    expect(args['body']).toBe('real');
  });
});

describe('lane_resolve pr', () => {
  it('coerces an unambiguous numeric string', () => {
    expect(coerceToolArgs('lane_resolve', { id: 'x', pr: '343' }).args['pr']).toBe(343);
    expect(coerceToolArgs('lane_resolve', { id: 'x', pr: '#343' }).args['pr']).toBe(343);
  });

  it('leaves pr:"local" alone — attesting a PR that never existed would corrupt the audit join', () => {
    const { args, applied } = coerceToolArgs('lane_resolve', { id: 'x', pr: 'local' });
    expect(args['pr']).toBe('local');
    expect(applied).toEqual([]);
  });

  it('leaves a real number alone', () => {
    expect(coerceToolArgs('lane_resolve', { id: 'x', pr: 343 }).args['pr']).toBe(343);
  });
});

describe('team_memory_save headline derivation', () => {
  // Every measured team_memory_save bounce: a long, carefully-written body rejected over a missing
  // one-line subject. Deriving is lossless here — the body keeps every word.
  it('derives the headline from the first line of the body', () => {
    const { args, applied } = coerceToolArgs('team_memory_save', {
      body: 'Cell-D compliance step-2 parked\n\nDetail follows.',
    });
    expect(args['headline']).toBe('Cell-D compliance step-2 parked');
    expect(applied).toEqual(['headline←body']);
  });

  it('strips markdown ornament from the derived line', () => {
    const { args } = coerceToolArgs('team_memory_save', {
      body: '## Office visual arc — session wrap\nbody text',
    });
    expect(args['headline']).toBe('Office visual arc — session wrap');
  });

  it('clips a long derived headline inside the 120-char cap, on a word boundary', () => {
    const long = 'word '.repeat(60).trim();
    const { args } = coerceToolArgs('team_memory_save', { body: long });
    const headline = args['headline'] as string;
    expect(headline.length).toBeLessThanOrEqual(120);
    expect(headline.endsWith('…')).toBe(true);
    expect(headline).not.toContain('wor…'); // clipped between words, not mid-word
  });

  it('cannot derive from an absent or blank body', () => {
    expect(coerceToolArgs('team_memory_save', {}).applied).toEqual([]);
    expect(coerceToolArgs('team_memory_save', { body: '   \n\n' }).applied).toEqual([]);
  });
});

describe('team_memory_save headline overflow (2026-08-01 re-measurement)', () => {
  // The top measured bounce source post-#417: an explicit headline 121–160 chars, cap already in
  // the description. The repair is lossless — the full line moves to the body, the clipped version
  // is only the display pointer — which is why the earlier "never truncate explicit" stance
  // (whose objection was data loss) does not apply to it.
  it('moves an over-cap headline into the body and clips the pointer', () => {
    const over = `${'word '.repeat(27)}tail-of-the-sentence`.trim(); // 155 chars
    const { args, applied } = coerceToolArgs('team_memory_save', {
      headline: over,
      body: 'existing body',
    });
    expect(applied).toEqual(['headline:overflow→body']);
    expect((args['headline'] as string).length).toBeLessThanOrEqual(120);
    expect((args['headline'] as string).endsWith('…')).toBe(true);
    expect(args['body']).toBe(`${over}\n\nexisting body`); // every word survives
  });

  it('an over-cap headline with no body becomes the body', () => {
    const over = 'x'.repeat(134);
    const { args } = coerceToolArgs('team_memory_save', { headline: over });
    expect(args['body']).toBe(over);
    expect((args['headline'] as string).length).toBeLessThanOrEqual(120);
  });

  it('a headline at exactly the cap is untouched', () => {
    const at = 'y'.repeat(120);
    const { args, applied } = coerceToolArgs('team_memory_save', { headline: at, body: 'b' });
    expect(args['headline']).toBe(at);
    expect(args['body']).toBe('b');
    expect(applied).toEqual([]);
  });
});

describe('surface_globs sent as a string (2026-08-01 re-measurement)', () => {
  it('parses a JSON-stringified array', () => {
    const { args, applied } = coerceToolArgs('lane_open', {
      title: 't',
      surface_globs: '["packages/mcp/src/**", "docs/**"]',
    });
    expect(args['surface_globs']).toEqual(['packages/mcp/src/**', 'docs/**']);
    expect(applied).toEqual(['surface_globs:json-string→array']);
  });

  it('wraps a bare single glob', () => {
    const { args, applied } = coerceToolArgs('lane_update', {
      id: 'x',
      surface_globs: 'packages/web/src/live/**',
    });
    expect(args['surface_globs']).toEqual(['packages/web/src/live/**']);
    expect(applied).toEqual(['surface_globs:string→[string]']);
  });

  it('never splits on commas — a brace glob is one glob', () => {
    const { args } = coerceToolArgs('lane_open', {
      title: 't',
      surface_globs: 'packages/{mcp,cli}/src/**',
    });
    expect(args['surface_globs']).toEqual(['packages/{mcp,cli}/src/**']);
  });

  it('composes with the surface alias: a string under the taught name still lands as a list', () => {
    const { args, applied } = coerceToolArgs('lane_open', {
      title: 't',
      surface: 'packages/mcp/src/**',
    });
    expect(args['surface_globs']).toEqual(['packages/mcp/src/**']);
    expect(applied).toEqual(['surface→surface_globs', 'surface_globs:string→[string]']);
  });

  it('leaves a real array alone', () => {
    const { applied } = coerceToolArgs('lane_open', { title: 't', surface_globs: ['a/**'] });
    expect(applied).toEqual([]);
  });
});

describe('lane prose aliases: note/notes/summary → detail (2026-08-01 re-measurement)', () => {
  it('lane_update forgives note', () => {
    const { args, applied } = coerceToolArgs('lane_update', { id: 'x', note: 'merged as #421' });
    expect(args['detail']).toBe('merged as #421');
    expect(args['note']).toBeUndefined();
    expect(applied).toEqual(['note→detail']);
  });

  it('lane_open forgives summary and notes', () => {
    expect(coerceToolArgs('lane_open', { title: 't', summary: 's' }).args['detail']).toBe('s');
    expect(coerceToolArgs('lane_open', { title: 't', notes: 'n' }).args['detail']).toBe('n');
  });

  // Asserted as a MATRIX rather than a case per verb, because the gap #576 closed was invisible
  // exactly where the tests were: `summary` was checked on lane_open only, so a rule table missing
  // it on lane_update passed clean. Pinning the PRODUCT of spellings × verbs means a spelling added
  // to one verb can never silently skip the other. (This subsumes the single lane_update/summary
  // case it replaces — same assertion, closed over the whole set.)
  it.each(['note', 'notes', 'summary'])(
    'both lane_open and lane_update forgive "%s" — the synonym set does not diverge per verb',
    (spelling) => {
      const open = coerceToolArgs('lane_open', { title: 't', [spelling]: 'prose' });
      const update = coerceToolArgs('lane_update', { id: 'x', [spelling]: 'prose' });
      expect(open.args['detail']).toBe('prose');
      expect(update.args['detail']).toBe('prose');
      expect(open.args[spelling]).toBeUndefined();
      expect(update.args[spelling]).toBeUndefined();
      expect(update.applied).toEqual([`${spelling}→detail`]);
    },
  );

  it('an explicit detail always wins over the alias', () => {
    const { args } = coerceToolArgs('lane_update', { id: 'x', detail: 'real', note: 'guess' });
    expect(args['detail']).toBe('real');
  });

  it('lane_resolve does NOT forgive note — no prose field exists to carry it', () => {
    const { args, applied } = coerceToolArgs('lane_resolve', { id: 'x', note: 'closing note' });
    expect(args['note']).toBe('closing note'); // left to bounce with the unknown-key repair line
    expect(applied).toEqual([]);
  });
});

describe('team_goal_declare wave sent as a string (2026-08-12, measured live)', () => {
  // Measured, not speculated: miley hit this declaring the ADR 256 stories. `{wave: 7}` bounced
  // with `wave: Invalid input` while `{wave: "later"}` passed, and the same number landed first try
  // through `team_send {act:'defer', meta:{wave: 7}}` — so the number survives everywhere the arg
  // is not a union. The schema is `z.union([z.number().int(), z.literal('later')])`, which publishes
  // as `anyOf[integer, const "later"]`; the string arrives as `"7"` and neither member accepts it.
  //
  // The cost was not the bounce. A re-declaration replaces the Goal skeleton wholesale, so the
  // workaround (declare, then defer the wave back) bumped the epoch on insight-dashboard and
  // board-loops — a re-sequencing the board showed but nobody performed.
  it('coerces an unambiguous numeric wave', () => {
    expect(
      coerceToolArgs('team_goal_declare', { id: 'g', title: 't', wave: '7' }).args['wave'],
    ).toBe(7);
  });

  it('leaves the "later" sentinel alone — it is a valid member of the union, not a near-miss', () => {
    const { args, applied } = coerceToolArgs('team_goal_declare', {
      id: 'g',
      title: 't',
      wave: 'later',
    });
    expect(args['wave']).toBe('later');
    expect(applied).toEqual([]);
  });

  it('leaves a real number alone', () => {
    expect(coerceToolArgs('team_goal_declare', { id: 'g', title: 't', wave: 7 }).args['wave']).toBe(
      7,
    );
  });

  // The same discipline `pr:"local"` gets: a wave that is not mechanically a number keeps its
  // bounce. Inventing an order here would silently re-sequence the board, which is the exact
  // damage this lane exists to stop.
  it('leaves an unparseable wave to bounce rather than inventing a build order', () => {
    const { args, applied } = coerceToolArgs('team_goal_declare', {
      id: 'g',
      title: 't',
      wave: 'soon-ish',
    });
    expect(args['wave']).toBe('soon-ish');
    expect(applied).toEqual([]);
  });
});

describe('normalization vs coercion', () => {
  it('trims strings silently — whitespace is not a mistake worth measuring', () => {
    const { args, applied } = coerceToolArgs('lane_claim', { id: '  01KYAG1M52 \n' });
    expect(args['id']).toBe('01KYAG1M52');
    expect(applied).toEqual([]);
  });

  it('is a no-op for tools with no rules, and never mutates the caller object', () => {
    const original = { anything: 1 };
    const { args, applied } = coerceToolArgs('team_status', original);
    expect(applied).toEqual([]);
    expect(args).not.toBe(original);
    expect(original).toEqual({ anything: 1 });
  });

  it('reports nothing applied for an already-valid call', () => {
    expect(
      coerceToolArgs('team_send', { act: 'status_update', body: 'x', to: 'nick' }).applied,
    ).toEqual([]);
  });
});
