import { trace } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { beforeEach, describe, expect, it } from 'vitest';
import type { WorktreeProvisioning } from '@musterd/protocol';
import { loadProvisioning, saveProvisioning } from '../manifest.js';
import { memoryFs, type HarnessContext, type MemoryFs } from './context.js';
import { reconcileHarnesses, inspectHarnesses } from './engine.js';
import {
  canonicalFingerprint,
  folderResourceKey,
  repoSharedResourceKey,
  type FragmentIntent,
  type HarnessAdapter,
} from './fragments.js';
import { loadJournal, loadLedger, saveJournal } from './store.js';

const MACHINE = '/machine/.musterd';

function ctxOf(fs: MemoryFs, worktreeRoot = '/w/a', machineConfigRoot = MACHINE): HarnessContext {
  let now = 1_000_000;
  return {
    worktreeRoot,
    machineConfigRoot,
    env: {},
    fs,
    proc: { pid: 42, startedAt: () => 's42', liveness: () => false },
    clock: { now: () => (now += 1) },
  };
}

function seedProvisioning(fs: MemoryFs, root: string, desired: string[]) {
  const provisioning: WorktreeProvisioning = {
    version: 2,
    profile: '',
    desired,
    contributions: {},
    provisionedAt: '2026-08-19T00:00:00.000Z',
  };
  saveProvisioning(root, provisioning, fs);
}

/**
 * A JSON-container adapter backed by the injected fs: the container is one JSON file; each managed
 * fragment is one top-level key. Unrelated keys are somebody else's and must survive every write.
 */
function jsonAdapter(opts: {
  id: string;
  containerPath: string;
  scope?: 'folder' | 'repo-shared';
  fragments: Record<string, unknown>; // fragmentKey -> desired payload
  resourceKeyOf?: (fragmentKey: string) => string;
  failApplyOnce?: { current: boolean };
}): HarnessAdapter {
  const scope = opts.scope ?? 'folder';
  const containerKey = `${scope} ${opts.containerPath}`;
  const readContainer = (ctx: HarnessContext): Record<string, unknown> | null => {
    const raw = ctx.fs.readFile(opts.containerPath);
    if (raw === null) return {};
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return null;
    }
  };
  return {
    id: opts.id,
    surface: 'other',
    adapterVersion: 1,
    availability: async () => ({ available: true }),
    target: async () => ({ containers: [{ containerKey, scope, handle: opts.containerPath }] }),
    desiredFragments: async (ctx) =>
      Object.entries(opts.fragments).map(([fragmentKey, payload]) => ({
        harness: opts.id,
        resourceKey:
          opts.resourceKeyOf?.(fragmentKey) ??
          folderResourceKey(ctx.worktreeRoot, opts.id, fragmentKey),
        containerKey,
        fragmentKey,
        scope,
        fingerprint: canonicalFingerprint(payload),
        payload,
      })),
    observe: async (ctx, intent) => {
      const container = readContainer(ctx);
      if (container === null)
        return { state: 'invalid-container', issues: [{ path: '<file>', message: 'not JSON' }] };
      if (!(intent.fragmentKey in container)) return { state: 'absent' };
      return { state: 'present', fingerprint: canonicalFingerprint(container[intent.fragmentKey]) };
    },
    apply: async (ctx, mutation) => {
      if (opts.failApplyOnce?.current) {
        opts.failApplyOnce.current = false;
        throw new Error('injected stop at external write');
      }
      const container = readContainer(ctx);
      if (container === null) throw new Error('container invalid at apply time');
      const key = mutation.intent.fragmentKey;
      if (mutation.kind === 'remove') delete container[key];
      else container[key] = mutation.intent.payload;
      ctx.fs.mkdirp('/w');
      ctx.fs.writeFile(opts.containerPath, `${JSON.stringify(container, null, 2)}\n`, 0o600);
    },
  };
}

describe('stop-injection recovery (ADR 282 §4)', () => {
  let fs: MemoryFs;
  beforeEach(() => {
    fs = memoryFs();
  });

  const CONTAINER = '/w/a/.fake/settings.json';
  const payload = { command: 'node', args: ['adapter.js'] };
  const fp = canonicalFingerprint(payload);

  const adapter = (failApplyOnce?: { current: boolean }) =>
    jsonAdapter({
      id: 'fake',
      containerPath: CONTAINER,
      fragments: { musterd: payload },
      ...(failApplyOnce !== undefined ? { failApplyOnce } : {}),
    });
  const containerKey = `folder ${CONTAINER}`;
  const resource = folderResourceKey('/w/a', 'fake', 'musterd');

  const run = (a = adapter()) =>
    reconcileHarnesses(ctxOf(fs), ['fake'], { legacyRepair: false, registry: [a] });

  const ledgerEntry = () => {
    const got = loadLedger(fs, MACHINE);
    return got.kind === 'valid' ? got.value.fragments[resource] : undefined;
  };

  it('a stop at lease acquisition leaves nothing behind; the next run completes cleanly', async () => {
    seedProvisioning(fs, '/w/a', ['fake']);
    fs.failNext({ op: 'writeFile', pathIncludes: 'harness-locks' });
    const first = await run();
    expect(first.results[0]!.result).toBe('failed');
    expect(loadJournal(fs, MACHINE, containerKey).kind).toBe('missing');
    const second = await run();
    expect(second.results[0]!.result).toBe('applied');
    expect(ledgerEntry()?.fingerprint).toBe(fp);
  });

  it('a stop right after journal publication: observed == oldFingerprint → the retry re-runs the mutation', async () => {
    seedProvisioning(fs, '/w/a', ['fake']);
    const failing = { current: true };
    const first = await run(adapter(failing));
    expect(first.results[0]!.result).toBe('failed');
    // The prepared journal survived the stop; the external file was never written.
    expect(loadJournal(fs, MACHINE, containerKey).kind).toBe('valid');
    expect(fs.readFile(CONTAINER)).toBeNull();

    const second = await run(adapter());
    expect(second.results[0]!.recovery).toBe('retried');
    expect(JSON.parse(fs.readFile(CONTAINER)!)['musterd']).toEqual(payload);
    expect(ledgerEntry()?.owners).toEqual(['/w/a']);
    expect(loadJournal(fs, MACHINE, containerKey).kind).toBe('missing');
  });

  it('a stop after the external write but before the ledger: observed == intendedFingerprint → finalize only', async () => {
    seedProvisioning(fs, '/w/a', ['fake']);
    fs.failNext({ op: 'writeFile', pathIncludes: 'harness-ledger' });
    const first = await run();
    expect(first.results[0]!.result).toBe('failed');
    expect(loadJournal(fs, MACHINE, containerKey).kind).toBe('valid');
    expect(JSON.parse(fs.readFile(CONTAINER)!)['musterd']).toEqual(payload);

    const applied: string[] = [];
    const spy = jsonAdapter({ id: 'fake', containerPath: CONTAINER, fragments: { musterd: payload } });
    const wrapped: HarnessAdapter = {
      ...spy,
      apply: async (ctx, mutation) => {
        applied.push(mutation.kind);
        return spy.apply(ctx, mutation);
      },
    };
    const second = await reconcileHarnesses(ctxOf(fs), ['fake'], {
      legacyRepair: false,
      registry: [wrapped],
    });
    expect(second.results[0]!.recovery).toBe('finalized');
    // Finalization is ledger-side only — the external mutation is NOT replayed.
    expect(applied).toEqual([]);
    expect(ledgerEntry()?.owners).toEqual(['/w/a']);
    expect(loadJournal(fs, MACHINE, containerKey).kind).toBe('missing');
  });

  it('a stop between contribution write and journal removal still converges', async () => {
    seedProvisioning(fs, '/w/a', ['fake']);
    fs.failNext({ op: 'rm', pathIncludes: 'harness-journal' });
    const first = await run();
    expect(first.results[0]!.result).toBe('failed');
    expect(loadJournal(fs, MACHINE, containerKey).kind).toBe('valid');
    const second = await run();
    expect(second.results[0]!.recovery).toBe('finalized');
    expect(second.results[0]!.result).toBe('unchanged');
    expect(loadJournal(fs, MACHINE, containerKey).kind).toBe('missing');
  });

  it('a journal matching NEITHER fingerprint is preserved and reports conflict', async () => {
    seedProvisioning(fs, '/w/a', ['fake']);
    // Physical state: some foreign content the journal never described.
    fs.writeFile(CONTAINER, JSON.stringify({ musterd: { foreign: true } }), 0o600);
    saveJournal(fs, MACHINE, {
      version: 1,
      operationId: 'op-x',
      action: 'create',
      harness: 'fake',
      containerKey,
      resourceKey: resource,
      oldFingerprint: null,
      intendedFingerprint: fp,
      oldOwners: [],
      intendedOwners: ['/w/a'],
      worktreeRoot: '/w/a',
      phase: 'prepared',
    });
    const report = await run();
    expect(report.results[0]!.recovery).toBe('conflict');
    expect(report.results[0]!.result).toBe('conflict');
    expect(loadJournal(fs, MACHINE, containerKey).kind).toBe('valid'); // evidence preserved
    expect(JSON.parse(fs.readFile(CONTAINER)!)['musterd']).toEqual({ foreign: true });
  });

  it('owner-only operations converge to intendedOwners despite equal old/intended hashes', async () => {
    seedProvisioning(fs, '/w/a', ['fake']);
    fs.writeFile(CONTAINER, `${JSON.stringify({ musterd: payload }, null, 2)}\n`, 0o600);
    saveJournal(fs, MACHINE, {
      version: 1,
      operationId: 'op-o',
      action: 'add-owner',
      harness: 'fake',
      containerKey,
      resourceKey: resource,
      oldFingerprint: fp,
      intendedFingerprint: fp,
      oldOwners: ['/w/b'],
      intendedOwners: ['/w/a', '/w/b'],
      worktreeRoot: '/w/a',
      phase: 'prepared',
    });
    const report = await run();
    expect(report.results[0]!.recovery).toBe('finalized');
    expect(ledgerEntry()?.owners).toEqual(['/w/a', '/w/b']);
  });
});

describe('operation spans (ADR 282 O&E)', () => {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  const tracer = provider.getTracer('test');

  beforeEach(() => exporter.reset());

  it('one finished operation span per fragment, allowlisted attributes only', async () => {
    const fs = memoryFs();
    seedProvisioning(fs, '/w/a', ['fake']);
    const adapter = jsonAdapter({
      id: 'fake',
      containerPath: '/w/a/.fake/settings.json',
      fragments: { musterd: { command: 'node' }, hooks: { on: true } },
    });
    await reconcileHarnesses(ctxOf(fs), ['fake'], {
      legacyRepair: false,
      registry: [adapter],
      tracer,
    });
    const spans = exporter.getFinishedSpans().filter((s) => s.name === 'musterd.provisioning.operation');
    expect(spans).toHaveLength(2);
    for (const span of spans) {
      expect(span.attributes['musterd.action']).toBe('create');
      expect(span.attributes['musterd.result']).toBe('applied');
      expect(span.attributes['musterd.journal_recovery']).toBe('none');
      expect(span.attributes['musterd.marker_generation']).toBeDefined();
      expect(span.attributes['musterd.lock_recovery']).toBe('none');
      const dump = JSON.stringify(span.attributes);
      expect(dump).not.toContain('/w/a'); // no path, resource key, or owner root
      expect(dump).not.toContain('settings.json');
      expect(dump).not.toContain('command'); // no config bodies
    }
  });

  it('a conflict span carries an error status; inspection emits the same span shape', async () => {
    const fs = memoryFs();
    seedProvisioning(fs, '/w/a', ['fake']);
    fs.writeFile('/w/a/.fake/settings.json', JSON.stringify({ musterd: { theirs: 1 } }), 0o600);
    const adapter = jsonAdapter({
      id: 'fake',
      containerPath: '/w/a/.fake/settings.json',
      fragments: { musterd: { command: 'node' } },
    });
    await reconcileHarnesses(ctxOf(fs), ['fake'], {
      legacyRepair: false,
      registry: [adapter],
      tracer,
    });
    const conflict = exporter.getFinishedSpans().find((s) => s.attributes['musterd.result'] === 'conflict');
    expect(conflict).toBeDefined();
    expect(conflict!.status.code).toBe(2); // SpanStatusCode.ERROR

    exporter.reset();
    await inspectHarnesses(ctxOf(fs), ['fake'], { registry: [adapter], tracer });
    const inspected = exporter.getFinishedSpans().filter((s) => s.name === 'musterd.provisioning.operation');
    expect(inspected).toHaveLength(1);
    expect(inspected[0]!.attributes['musterd.result']).toBe('inspected');
    expect(inspected[0]!.attributes['musterd.observation']).toBe('unmanaged-conflict');
  });
});

describe('unrelated content and partial progress (ADR 282 §5)', () => {
  it('preserves unrelated JSON keys semantically across create and remove', async () => {
    const fs = memoryFs();
    const CONTAINER = '/w/a/.fake/settings.json';
    fs.writeFile(
      CONTAINER,
      JSON.stringify({ theirs: { keep: true }, alsoTheirs: [1, 2, 3] }, null, 2),
      0o600,
    );
    seedProvisioning(fs, '/w/a', ['fake']);
    const adapter = jsonAdapter({
      id: 'fake',
      containerPath: CONTAINER,
      fragments: { musterd: { command: 'node' } },
    });
    await reconcileHarnesses(ctxOf(fs), ['fake'], { legacyRepair: false, registry: [adapter] });
    let parsed = JSON.parse(fs.readFile(CONTAINER)!);
    expect(parsed.theirs).toEqual({ keep: true });
    expect(parsed.alsoTheirs).toEqual([1, 2, 3]);
    expect(parsed.musterd).toEqual({ command: 'node' });

    // Deselect: the owned fragment goes, everything unrelated stays.
    seedProvisioning(fs, '/w/a', []);
    await reconcileHarnesses(ctxOf(fs), [], { legacyRepair: false, registry: [adapter] });
    parsed = JSON.parse(fs.readFile(CONTAINER)!);
    expect(parsed.theirs).toEqual({ keep: true });
    expect(parsed.musterd).toBeUndefined();
  });

  it('resumes deterministically when one of several fragments completed before a stop', async () => {
    const fs = memoryFs();
    seedProvisioning(fs, '/w/a', ['fake']);
    const CONTAINER = '/w/a/.fake/settings.json';
    // First run: second fragment's external write stops.
    const failing = { current: false };
    const adapter = jsonAdapter({
      id: 'fake',
      containerPath: CONTAINER,
      fragments: { aFirst: { v: 1 }, bSecond: { v: 2 } },
      failApplyOnce: failing,
    });
    // Let the first apply succeed, then fail the second.
    const wrapped: HarnessAdapter = {
      ...adapter,
      apply: async (ctx, mutation) => {
        if (mutation.intent.fragmentKey === 'bSecond') failing.current = true;
        return adapter.apply(ctx, mutation);
      },
    };
    const first = await reconcileHarnesses(ctxOf(fs), ['fake'], {
      legacyRepair: false,
      registry: [wrapped],
    });
    expect(first.results.map((r) => r.result)).toEqual(['applied', 'failed']);

    const second = await reconcileHarnesses(ctxOf(fs), ['fake'], {
      legacyRepair: false,
      registry: [adapter],
    });
    // Journals are per container: the first fragment's lease finds bSecond's prepared journal and
    // retries it, so by the time bSecond is planned it is already converged.
    expect(second.results[0]!.recovery).toBe('retried');
    expect(second.results.map((r) => r.result)).toEqual(['unchanged', 'unchanged']);
    expect(second.ok).toBe(true);
    const parsed = JSON.parse(fs.readFile(CONTAINER)!);
    expect(parsed.aFirst).toEqual({ v: 1 });
    expect(parsed.bSecond).toEqual({ v: 2 });
  });

  it('two sibling worktrees share one repo-shared fragment; deselecting one keeps it', async () => {
    const fs = memoryFs();
    const CONTAINER = '/repo/.mcp.json';
    const resourceKeyOf = (k: string) => repoSharedResourceKey('/repo', 'musterd', 'fake', k);
    const adapter = jsonAdapter({
      id: 'fake',
      containerPath: CONTAINER,
      scope: 'repo-shared',
      fragments: { musterd: { command: 'node' } },
      resourceKeyOf,
    });
    seedProvisioning(fs, '/w/a', ['fake']);
    seedProvisioning(fs, '/w/b', ['fake']);
    await reconcileHarnesses(ctxOf(fs, '/w/a'), ['fake'], { legacyRepair: false, registry: [adapter] });
    await reconcileHarnesses(ctxOf(fs, '/w/b'), ['fake'], { legacyRepair: false, registry: [adapter] });
    const resource = resourceKeyOf('musterd');
    let ledger = loadLedger(fs, MACHINE);
    expect(ledger.kind === 'valid' && ledger.value.fragments[resource]?.owners).toEqual([
      '/w/a',
      '/w/b',
    ]);

    // /w/b deselects: the shared registration remains, /w/b's ownership is released.
    seedProvisioning(fs, '/w/b', []);
    await reconcileHarnesses(ctxOf(fs, '/w/b'), [], { legacyRepair: false, registry: [adapter] });
    ledger = loadLedger(fs, MACHINE);
    expect(ledger.kind === 'valid' && ledger.value.fragments[resource]?.owners).toEqual(['/w/a']);
    expect(JSON.parse(fs.readFile(CONTAINER)!)['musterd']).toEqual({ command: 'node' });

    // /w/a deselects last: the fragment disappears, unrelated content stays.
    seedProvisioning(fs, '/w/a', []);
    await reconcileHarnesses(ctxOf(fs, '/w/a'), [], { legacyRepair: false, registry: [adapter] });
    ledger = loadLedger(fs, MACHINE);
    expect(ledger.kind === 'valid' && ledger.value.fragments[resource]).toBeUndefined();
    expect(JSON.parse(fs.readFile(CONTAINER)!)['musterd']).toBeUndefined();
  });

  it('two machine roots share no ledger, journal, or lock state', async () => {
    const fs = memoryFs();
    const adapter = jsonAdapter({
      id: 'fake',
      containerPath: '/w/a/.fake/settings.json',
      fragments: { musterd: { command: 'node' } },
    });
    seedProvisioning(fs, '/w/a', ['fake']);
    await reconcileHarnesses(ctxOf(fs, '/w/a', '/machine-one/.musterd'), ['fake'], {
      legacyRepair: false,
      registry: [adapter],
    });
    expect(loadLedger(fs, '/machine-one/.musterd').kind).toBe('valid');
    expect(loadLedger(fs, '/machine-two/.musterd').kind).toBe('missing');
    // Machine two, same worktree: it has no evidence, so the present fragment is unmanaged there.
    const report = await reconcileHarnesses(ctxOf(fs, '/w/a', '/machine-two/.musterd'), ['fake'], {
      legacyRepair: false,
      registry: [adapter],
    });
    expect(report.results[0]!.result).toBe('satisfied-unmanaged');
  });
});

describe('byte preservation outside an adapter-owned block (TOML-style container)', () => {
  it('leaves every byte outside the managed block untouched', async () => {
    const fs = memoryFs();
    const CONTAINER = '/w/a/.codexish/config.toml';
    const before = [
      '# a comment the user wrote, with   weird   spacing',
      '[their_table]',
      'value = 1   # trailing comment',
      '',
      '[another]',
      'x = "y"',
      '',
    ].join('\n');
    fs.writeFile(CONTAINER, before, 0o600);
    seedProvisioning(fs, '/w/a', ['fake']);

    const payload = 'managed = true';
    const adapter: HarnessAdapter = {
      id: 'fake',
      surface: 'other',
      adapterVersion: 1,
      availability: async () => ({ available: true }),
      target: async () => ({
        containers: [{ containerKey: `folder ${CONTAINER}`, scope: 'folder', handle: CONTAINER }],
      }),
      desiredFragments: async (ctx) => [
        {
          harness: 'fake',
          resourceKey: folderResourceKey(ctx.worktreeRoot, 'fake', 'block'),
          containerKey: `folder ${CONTAINER}`,
          fragmentKey: 'block',
          scope: 'folder',
          fingerprint: canonicalFingerprint(payload),
          payload,
        },
      ],
      observe: async (ctx) => {
        const raw = ctx.fs.readFile(CONTAINER) ?? '';
        const m = raw.match(/# musterd:begin\n([\s\S]*?)# musterd:end/);
        if (!m) return { state: 'absent' };
        return { state: 'present', fingerprint: canonicalFingerprint(m[1]!.trimEnd()) };
      },
      apply: async (ctx, mutation) => {
        const raw = ctx.fs.readFile(CONTAINER) ?? '';
        const block = `# musterd:begin\n${String(mutation.intent.payload)}\n# musterd:end\n`;
        const replaced =
          mutation.kind === 'remove'
            ? raw.replace(/# musterd:begin\n[\s\S]*?# musterd:end\n?/, '')
            : /# musterd:begin\n[\s\S]*?# musterd:end/.test(raw)
              ? raw.replace(/# musterd:begin\n[\s\S]*?# musterd:end\n?/, block)
              : `${raw}${block}`;
        ctx.fs.writeFile(CONTAINER, replaced, 0o600);
      },
    };

    // Create appends the managed block; every pre-existing byte survives verbatim.
    await reconcileHarnesses(ctxOf(fs), ['fake'], { legacyRepair: false, registry: [adapter] });
    const after = fs.readFile(CONTAINER)!;
    expect(after.startsWith(before)).toBe(true);
    expect(after).toContain('managed = true');

    // Deselect: the managed block goes, and the file returns to its original bytes.
    seedProvisioning(fs, '/w/a', []);
    await reconcileHarnesses(ctxOf(fs), [], { legacyRepair: false, registry: [adapter] });
    expect(fs.readFile(CONTAINER)).toBe(before);
  });
});

describe('inspectHarnesses is read-only', () => {
  it('saves no files and acquires no mutation lease', async () => {
    const fs = memoryFs();
    seedProvisioning(fs, '/w/a', ['fake']);
    const writesBefore = fs.log.length;
    const adapter = jsonAdapter({
      id: 'fake',
      containerPath: '/w/a/.fake/settings.json',
      fragments: { musterd: { command: 'node' } },
    });
    const inspections = await inspectHarnesses(ctxOf(fs), ['fake'], { registry: [adapter] });
    expect(fs.log.length).toBe(writesBefore); // not one mutating fs op
    const fake = inspections.find((i) => i.harness === 'fake')!;
    expect(fake.fragments[0]!.plan).toBe('create');
    expect(fake.fragments[0]!.lock).toBe('free');
    const prov = loadProvisioning('/w/a', fs);
    expect(prov.kind === 'valid' && prov.value.contributions).toEqual({});
  });
});
