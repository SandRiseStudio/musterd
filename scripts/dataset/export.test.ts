/**
 * The ADR 184 gate, as a test: a candidate export that leaks prose or a real seat name is a
 * regression against zero. The canary strings below are planted in every prose-bearing column the
 * daemon stores; after export they must appear in none of the public files.
 *
 * The mapping file is the other leak: a per-release pseudonym table that rides in the public dir
 * would undo the HMAC. `--map` is allowed only outside `--out`.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_MANIFEST_PATH,
  PUBLIC_MANIFEST_NAME,
  bucketProject,
  exportDataset,
  fillCard,
  histogramLines,
  parseExportArgs,
  projectMeta,
  pseudonym,
} from './export.ts';

const CANARY = 'UNIQUE-PROSE-CANARY-7f3a9c';
const SALT_A = Buffer.from('a'.repeat(32));
const SALT_B = Buffer.from('b'.repeat(32));

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'dataset-export-'));
  dirs.push(d);
  return d;
}

function fixtureDb(dir: string): string {
  const path = join(dir, 'corpus.db');
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE teams (
      id TEXT PRIMARY KEY, slug TEXT NOT NULL, display TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE members (
      id TEXT PRIMARY KEY, team_id TEXT NOT NULL, name TEXT NOT NULL,
      kind TEXT NOT NULL, role TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY, team_id TEXT NOT NULL, from_member TEXT NOT NULL,
      to_kind TEXT NOT NULL, to_member TEXT, act TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '', thread_id TEXT, meta TEXT,
      ts INTEGER NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE lanes (
      id TEXT PRIMARY KEY, team_id TEXT NOT NULL, project TEXT NOT NULL,
      title TEXT NOT NULL, detail TEXT, owner_seat TEXT, created_by TEXT NOT NULL,
      state TEXT NOT NULL, depends_on TEXT NOT NULL DEFAULT '[]',
      branch TEXT, goal_id TEXT,
      created_at INTEGER NOT NULL, claimed_at INTEGER, resolved_at INTEGER,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE seat_memory (
      member_id TEXT PRIMARY KEY, headline TEXT NOT NULL, body TEXT NOT NULL, saved_at INTEGER NOT NULL
    );
  `);
  db.prepare(
    `INSERT INTO teams (id, slug, display, created_at, updated_at) VALUES (?, ?, ?, 1, 1)`,
  ).run('t1', 'revive', 'Revive');
  db.prepare(
    `INSERT INTO members (id, team_id, name, kind, role, created_at, updated_at)
     VALUES (?, 't1', ?, ?, ?, 1, 1)`,
  ).run('m-nick', 'nick', 'human', 'admin');
  db.prepare(
    `INSERT INTO members (id, team_id, name, kind, role, created_at, updated_at)
     VALUES (?, 't1', ?, ?, ?, 1, 1)`,
  ).run('m-ada', 'Ada', 'agent', 'backend');
  db.prepare(
    `INSERT INTO messages
       (id, team_id, from_member, to_kind, to_member, act, body, thread_id, meta, ts, created_at)
     VALUES (?, 't1', ?, 'member', ?, 'handoff', ?, NULL, ?, 1000, 1000)`,
  ).run(
    'msg1',
    'm-nick',
    'm-ada',
    `${CANARY} please take this`,
    JSON.stringify({
      model: 'claude-opus-5',
      in_reply_to: 'msg0',
      urgent_reason: CANARY,
      risk: CANARY,
      eligible: ['Ada', 'nick'],
      progress: 0.5,
    }),
  );
  db.prepare(
    `INSERT INTO lanes
       (id, team_id, project, title, detail, owner_seat, created_by, state, depends_on, branch, goal_id,
        created_at, claimed_at, resolved_at, updated_at)
     VALUES (?, 't1', 'agents', ?, ?, 'Ada', 'nick', 'active', '[]', 'feat/x', 'g1', 1, 2, NULL, 3)`,
  ).run('lane1', `Lane title ${CANARY}`, `Lane detail ${CANARY}`);
  // miley's #908 reject: `<seat>/<topic>` branches and `agents-<seat>` projects carry plaintext names.
  db.prepare(
    `INSERT INTO lanes
       (id, team_id, project, title, detail, owner_seat, created_by, state, depends_on, branch, goal_id,
        created_at, claimed_at, resolved_at, updated_at)
     VALUES ('lane2', 't1', 'agents-Ada', 'x', 'y', 'Ada', 'nick', 'active', '[]', 'Ada/leaky-topic', NULL, 1, 2, NULL, 3)`,
  ).run();
  db.prepare(
    `INSERT INTO seat_memory (member_id, headline, body, saved_at) VALUES (?, ?, ?, 1)`,
  ).run('m-ada', `headline ${CANARY}`, `memory ${CANARY}`);
  db.close();
  return path;
}

function writeManifest(dir: string): string {
  const p = join(dir, 'manifest.v1.json');
  writeFileSync(
    p,
    `${JSON.stringify({ id: 'coordination-traces-v1', adr: 184, version: 'v1' })}\n`,
  );
  return p;
}

function traceText(out: string): string {
  return ['acts.jsonl', 'members.jsonl', 'lanes.jsonl']
    .map((f) => readFileSync(join(out, f), 'utf8'))
    .join('\n');
}

function jsonl<T>(out: string, file: string): T[] {
  return readFileSync(join(out, file), 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as T);
}

function publicFiles(out: string): string[] {
  return readdirSync(out).sort();
}

describe('pseudonym', () => {
  it('is stable inside one salt and unlinkable across salts', () => {
    const a = pseudonym('m-nick', SALT_A);
    expect(a).toBe(pseudonym('m-nick', SALT_A));
    expect(a).toMatch(/^seat_[0-9a-f]{12}$/);
    expect(a).not.toBe(pseudonym('m-nick', SALT_B));
    expect(a).not.toBe(pseudonym('m-ada', SALT_A));
  });
});

describe('projectMeta', () => {
  const names = new Map([
    ['nick', 'm-nick'],
    ['Ada', 'm-ada'],
  ]);
  const ids = new Map([
    ['m-nick', pseudonym('m-nick', SALT_A)],
    ['m-ada', pseudonym('m-ada', SALT_A)],
  ]);

  it('keeps structural keys and drops prose keys', () => {
    const meta = projectMeta(
      {
        model: 'claude-opus-5',
        in_reply_to: 'msg0',
        progress: 0.5,
        urgent_reason: CANARY,
        risk: CANARY,
        chosen_approach: CANARY,
      },
      names,
      ids,
    );
    expect(meta).toEqual({
      model: 'claude-opus-5',
      in_reply_to: 'msg0',
      progress: 0.5,
    });
  });

  it('pseudonymises eligible seat names', () => {
    const meta = projectMeta({ eligible: ['Ada', 'nick'] }, names, ids);
    expect(meta?.['eligible']).toEqual([ids.get('m-ada'), ids.get('m-nick')]);
  });

  it('drops unmapped eligible names rather than emitting them', () => {
    const meta = projectMeta({ eligible: ['Ada', 'stranger'] }, names, ids);
    expect(meta?.['eligible']).toEqual([ids.get('m-ada')]);
  });
});

describe('exportDataset', () => {
  it('omits every planted prose canary and every real seat name from the public dir', () => {
    const dir = tmp();
    const db = fixtureDb(dir);
    const out = join(dir, 'public');
    const manifest = writeManifest(dir);
    exportDataset({
      dbPath: db,
      outDir: out,
      manifestPath: manifest,
      authorizedBy: 'nick',
      salt: SALT_A,
    });
    const text = traceText(out);
    expect(text).not.toContain(CANARY);
    expect(text).not.toMatch(/"nick"/);
    expect(text).not.toMatch(/"Ada"/);
    expect(text).not.toContain('please take this');
    expect(text).not.toContain('Lane title');
    expect(text).not.toContain('headline');
    expect(text).not.toContain('agents-Ada');
    expect(text).not.toContain('Ada/');
    expect(text).not.toContain('leaky-topic');
  });

  it('emits structural act / member / lane rows with HMAC seat ids', () => {
    const dir = tmp();
    const out = join(dir, 'public');
    exportDataset({
      dbPath: fixtureDb(dir),
      outDir: out,
      manifestPath: writeManifest(dir),
      authorizedBy: 'nick',
      salt: SALT_A,
    });
    const nick = pseudonym('m-nick', SALT_A);
    const ada = pseudonym('m-ada', SALT_A);
    const acts = jsonl<Record<string, unknown>>(out, 'acts.jsonl');
    expect(acts).toHaveLength(1);
    expect(acts[0]).toMatchObject({
      id: 'msg1',
      team: 'revive',
      from: nick,
      to: { kind: 'member', seat: ada },
      act: 'handoff',
      ts: 1000,
    });
    expect(acts[0]).not.toHaveProperty('body');
    expect((acts[0]?.['meta'] as Record<string, unknown>)['model']).toBe('claude-opus-5');

    const members = jsonl<Record<string, unknown>>(out, 'members.jsonl');
    expect(members.map((m) => m['id']).sort()).toEqual([ada, nick].sort());
    expect(members.every((m) => m['kind'] === 'human' || m['kind'] === 'agent')).toBe(true);

    const lanes = jsonl<Record<string, unknown>>(out, 'lanes.jsonl');
    const lane1 = lanes.find((l) => l['id'] === 'lane1');
    expect(lane1).toMatchObject({
      id: 'lane1',
      state: 'active',
      owner: ada,
      created_by: nick,
      goal_id: 'g1',
      project: 'agents',
    });
    expect(lane1).not.toHaveProperty('title');
    expect(lane1).not.toHaveProperty('detail');
    expect(lane1).not.toHaveProperty('branch');

    const lane2 = lanes.find((l) => l['id'] === 'lane2');
    expect(lane2).toMatchObject({
      id: 'lane2',
      project: `agents-${ada}`,
      owner: ada,
    });
    expect(lane2).not.toHaveProperty('branch');
    expect(JSON.stringify(lane2)).not.toContain('Ada');

    const release = JSON.parse(readFileSync(join(out, 'RELEASE.json'), 'utf8')) as {
      adr: number;
      authorized_by: string;
      salt_sha256: string;
      experiment_manifest: { path: string; sha256: string };
      counts: { acts: number; members: number; lanes: number };
    };
    expect(release.adr).toBe(184);
    expect(release.authorized_by).toBe('nick');
    expect(release.salt_sha256).toBe(createHash('sha256').update(SALT_A).digest('hex'));
    expect(release.counts).toEqual({ acts: 1, members: 2, lanes: 2 });
    expect(release.experiment_manifest.sha256).toHaveLength(64);
    expect(release.experiment_manifest.path).toBe(PUBLIC_MANIFEST_NAME);
  });

  it('writes a filled README.md and in-dir manifest so the folder is self-describing', () => {
    const dir = tmp();
    const out = join(dir, 'public');
    const manifest = writeManifest(dir);
    exportDataset({
      dbPath: fixtureDb(dir),
      outDir: out,
      manifestPath: manifest,
      authorizedBy: 'nick',
      salt: SALT_A,
    });
    expect(publicFiles(out)).toEqual([
      'README.md',
      'RELEASE.json',
      'acts.jsonl',
      'lanes.jsonl',
      'manifest.v1.json',
      'members.jsonl',
    ]);
    expect(existsSync(join(out, PUBLIC_MANIFEST_NAME))).toBe(true);
    const readme = readFileSync(join(out, 'README.md'), 'utf8');
    expect(readme).toContain('structural-only');
    expect(readme).toContain('not a chat dump');
    for (const act of [
      'message',
      'status_update',
      'request_help',
      'handoff',
      'accept',
      'decline',
      'wait',
      'resolve',
      'steer',
      'challenge',
      'defer',
      'ask',
    ]) {
      expect(readme).toContain(`\`${act}\``);
    }
    expect(readme).not.toContain('{{');
    expect(readme).toContain('**1** acts');
    expect(readme).toContain('**2** members');
    expect(readme).toContain('**2** lanes');
    expect(readme).toContain('1970-01-01');
    expect(readme).toContain('- `handoff`: 1');
    expect(readme).not.toContain(CANARY);
    expect(readme).not.toMatch(/"nick"/);
    expect(readme).not.toMatch(/"Ada"/);
  });

  it('refuses to write a pseudonym map inside the public dir', () => {
    const dir = tmp();
    const out = join(dir, 'public');
    expect(() =>
      exportDataset({
        dbPath: fixtureDb(dir),
        outDir: out,
        manifestPath: writeManifest(dir),
        authorizedBy: 'nick',
        salt: SALT_A,
        mapPath: join(out, 'MAP.json'),
      }),
    ).toThrow(/mapPath must not be inside outDir/);
  });

  it('writes the private map only when asked, outside the public dir', () => {
    const dir = tmp();
    const out = join(dir, 'public');
    const mapPath = join(dir, 'MAP.json');
    exportDataset({
      dbPath: fixtureDb(dir),
      outDir: out,
      manifestPath: writeManifest(dir),
      authorizedBy: 'nick',
      salt: SALT_A,
      mapPath,
    });
    const map = JSON.parse(readFileSync(mapPath, 'utf8')) as { nick: string };
    expect(map['nick']).toBe(pseudonym('m-nick', SALT_A));
    expect(traceText(out)).not.toContain('MAP.json');
  });

  it('refuses a run without authorized_by', () => {
    const dir = tmp();
    expect(() =>
      exportDataset({
        dbPath: fixtureDb(dir),
        outDir: join(dir, 'public'),
        manifestPath: writeManifest(dir),
        authorizedBy: '',
        salt: SALT_A,
      }),
    ).toThrow(/authorized_by/);
  });
});

describe('bucketProject', () => {
  const names = new Map([
    ['nick', 'm-nick'],
    ['Ada', 'm-ada'],
    ['izzo', 'm-izzo'],
  ]);
  const ids = new Map([
    ['m-nick', pseudonym('m-nick', SALT_A)],
    ['m-ada', pseudonym('m-ada', SALT_A)],
    ['m-izzo', pseudonym('m-izzo', SALT_A)],
  ]);

  it('leaves a project with no seat token alone', () => {
    expect(bucketProject('agents', names, ids)).toBe('agents');
    expect(bucketProject('default', names, ids)).toBe('default');
  });

  it('replaces a seat token in agents-<seat> and is case-insensitive', () => {
    expect(bucketProject('agents-Ada', names, ids)).toBe(`agents-${ids.get('m-ada')}`);
    expect(bucketProject('agents-ada', names, ids)).toBe(`agents-${ids.get('m-ada')}`);
    expect(bucketProject('agents-izzo', names, ids)).toBe(`agents-${ids.get('m-izzo')}`);
  });

  it('does not rewrite a token that merely contains a seat name as a substring', () => {
    expect(bucketProject('nickel', names, ids)).toBe('nickel');
  });
});

describe('parseExportArgs', () => {
  it('requires --db --out --manifest --authorized-by', () => {
    expect(() => parseExportArgs([])).toThrow(/--authorized-by/);
    expect(() => parseExportArgs(['--authorized-by', 'nick'])).toThrow(/--db/);
  });

  it('does not default --db to the live daemon file', () => {
    const args = parseExportArgs([
      '--db',
      '/tmp/snapshot.db',
      '--out',
      '/tmp/out',
      '--manifest',
      DEFAULT_MANIFEST_PATH,
      '--authorized-by',
      'nick',
    ]);
    expect(args.dbPath).toBe('/tmp/snapshot.db');
    expect(args.salt).toBeInstanceOf(Buffer);
  });

  it('refuses the live ~/.musterd/musterd.db unless --from-live', () => {
    const live = join('/Users/x', '.musterd', 'musterd.db');
    expect(() =>
      parseExportArgs([
        '--db',
        live,
        '--out',
        '/tmp/out',
        '--manifest',
        DEFAULT_MANIFEST_PATH,
        '--authorized-by',
        'nick',
      ]),
    ).toThrow(/--from-live/);
    const ok = parseExportArgs([
      '--db',
      live,
      '--out',
      '/tmp/out',
      '--manifest',
      DEFAULT_MANIFEST_PATH,
      '--authorized-by',
      'nick',
      '--from-live',
    ]);
    expect(ok.dbPath).toBe(live);
  });
});

describe('fillCard', () => {
  it('replaces every placeholder and refuses leftovers', () => {
    expect(fillCard('n={{acts}}', { acts: '3' })).toBe('n=3');
    expect(() => fillCard('{{acts}} {{nope}}', { acts: '1' })).toThrow(/unfilled card placeholder/);
  });
});

describe('histogramLines', () => {
  it('sorts by count desc then name, and names an empty tally', () => {
    expect(histogramLines({ b: 1, a: 3, c: 3 })).toBe('- `a`: 3\n- `c`: 3\n- `b`: 1');
    expect(histogramLines({})).toBe('_none_');
  });
});

describe('salt generation', () => {
  it('draw is 32 bytes so two CLI runs do not share a mapping', () => {
    expect(randomBytes(32)).not.toEqual(randomBytes(32));
  });
});
