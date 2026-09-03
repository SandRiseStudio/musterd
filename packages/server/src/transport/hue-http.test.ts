import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../db/open.js';
import { createServer, type RunningServer } from '../index.js';

/**
 * `POST /teams/:slug/members/:name/hue` on a DB-only team (ADR 374): the member themself or a
 * team admin sets it; a collision is refused by name; the roster shows the new value.
 */
let server: RunningServer;
let base: string;
let nickCred: string;
let miley: string;

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as any) : null };
}
async function get(path: string, headers: Record<string, string> = {}) {
  const res = await fetch(base + path, { headers });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as any) : null };
}
const bearer = (auth: string) => ({ authorization: `Bearer ${auth}` });

beforeEach(async () => {
  server = createServer({ db: openDb(':memory:'), port: 0 });
  const { port } = await server.listen();
  base = `http://127.0.0.1:${port}`;
  const team = await post('/teams', { slug: 'dawn', creator: { name: 'nick', kind: 'human' } });
  nickCred = team.json.human_credential;
  // Two humans so a non-admin can try to recolour someone else.
  miley = (
    await post('/teams/dawn/members', { name: 'miley', kind: 'human', hue: 212 }, bearer(nickCred))
  ).json.human_credential;
  await post('/teams/dawn/members', { name: 'dolly', kind: 'human', hue: 40 }, bearer(nickCred));
});
afterEach(async () => {
  await server.close();
});

describe('POST /members/:name/hue (ADR 374)', () => {
  it('a member sets their own hue and the roster shows it', async () => {
    const r = await post('/teams/dawn/members/miley/hue', { hue: 300 }, bearer(miley));
    expect(r.status).toBe(200);
    expect(r.json.member.hue).toBe(300);
    const roster = await get('/teams/dawn/members', bearer(nickCred));
    expect(roster.json.members.find((m: any) => m.name === 'miley').hue).toBe(300);
  });

  it('an admin sets another member’s hue', async () => {
    const r = await post('/teams/dawn/members/dolly/hue', { hue: 120 }, bearer(nickCred));
    expect(r.status).toBe(200);
    expect(r.json.member.name).toBe('dolly');
    expect(r.json.member.hue).toBe(120);
  });

  it('a non-admin may not recolour a teammate', async () => {
    const r = await post('/teams/dawn/members/dolly/hue', { hue: 120 }, bearer(miley));
    expect(r.status).toBe(403);
  });

  it('a collision is refused, naming the neighbour', async () => {
    const r = await post('/teams/dawn/members/miley/hue', { hue: 42 }, bearer(miley));
    expect(r.status).toBe(409);
    expect(r.json.error.message).toMatch(/"dolly" \(40\)/);
  });

  it('a hue off the wheel is a bad request', async () => {
    const r = await post('/teams/dawn/members/miley/hue', { hue: 360 }, bearer(miley));
    expect(r.status).toBe(400);
  });
});
