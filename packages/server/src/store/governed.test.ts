import { GovernedPolicySchema, PROTOCOL_VERSION } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { openDb } from '../db/open.js';
import {
  authorizeGovernedRequest,
  consumeGovernedLaunch,
  issueGovernedLaunch,
  revokeGovernedLaunch,
  setGovernedPolicy,
} from './governed.js';
import { openLane, updateLane } from './lanes.js';
import { addMember } from './members.js';
import { insertMessage } from './messages.js';
import { bindNode, bindSeatToNode, revokeNode } from './nodes.js';
import { attach, release } from './presence.js';
import { createTeam } from './teams.js';

function fixture() {
  const db = openDb(':memory:');
  const team = createTeam(db, { slug: 'governed' });
  const human = addMember(db, team, { name: 'nick', kind: 'human' }).row;
  const agent = addMember(db, team, { name: 'ada', kind: 'agent' }).row;
  bindNode(db, team.id, 'node-a', 'laptop', 'msnode_node-a', human.name);
  bindSeatToNode(db, team.id, agent.id, 'node-a', 10);
  const presence = attach(db, agent.id, 'claude-code', 'conn-1');
  return { db, team, human, agent, presence };
}

const policy = GovernedPolicySchema.parse({
  version: 1,
  team: { models: ['anthropic/claude-sonnet-4-6'] },
  members: { ada: { models: ['anthropic/claude-sonnet-4-6'] } },
});

function requestFor(
  launchId: string,
  presenceId: string,
  overrides: Partial<{
    correlation: string;
    member: string;
    node_id: string;
    provider: string;
    model: string;
  }> = {},
) {
  return {
    launch_id: launchId,
    presence_id: presenceId,
    correlation: overrides.correlation ?? 'corr-1',
    member: overrides.member ?? 'ada',
    node_id: overrides.node_id ?? 'node-a',
    provider: overrides.provider ?? 'anthropic',
    model: overrides.model ?? 'anthropic/claude-sonnet-4-6',
  };
}

describe('governed authorization store (ADR 410)', () => {
  it('issues and consumes a launch handoff exactly once for a bound agent', () => {
    const db = openDb(':memory:');
    const team = createTeam(db, { slug: 'governed' });
    const human = addMember(db, team, { name: 'nick', kind: 'human' }).row;
    const agent = addMember(db, team, { name: 'ada', kind: 'agent' }).row;
    bindNode(db, team.id, 'node-a', 'laptop', 'msnode_node-a', human.name);
    bindSeatToNode(db, team.id, agent.id, 'node-a', 10);
    const presence = attach(db, agent.id, 'claude-code', 'conn-1');
    const mint = issueGovernedLaunch(
      db,
      team.id,
      human,
      {
        member: agent.name,
        node_id: 'node-a',
        correlation: 'corr-1',
        context: { kind: 'orientation', allowance_id: 'allow-1' },
        ttl_ms: 60_000,
      },
      100,
    );

    expect(mint.token).toMatch(/^msla_/);
    const persisted = db
      .prepare<
        [string, string],
        { token_hash: string; work_context: string }
      >('SELECT token_hash, work_context FROM governed_launch_authorizations WHERE team_id = ? AND id = ?')
      .get(team.id, mint.authorization.id)!;
    expect(persisted.token_hash).not.toBe(mint.token);
    expect(persisted.work_context).not.toContain(mint.token);
    expect(mint.authorization).toMatchObject({
      team: 'governed',
      member: 'ada',
      node_id: 'node-a',
      consumed_at: null,
    });
    const consumed = consumeGovernedLaunch(
      db,
      team.id,
      {
        token: mint.token,
        launch_id: mint.authorization.id,
        presence_id: presence.id,
        member: 'ada',
        node_id: 'node-a',
        correlation: 'corr-1',
      },
      200,
    );
    expect(consumed.ok).toBe(true);
    expect(
      consumeGovernedLaunch(
        db,
        team.id,
        {
          token: mint.token,
          launch_id: mint.authorization.id,
          presence_id: presence.id,
          member: 'ada',
          node_id: 'node-a',
          correlation: 'corr-1',
        },
        300,
      ),
    ).toMatchObject({ ok: false, reason: 'denied_launch_replayed' });
    db.close();
  });

  it('refuses a model request when the launch is bound to a different node or model', () => {
    const { db, team, human, presence } = fixture();
    setGovernedPolicy(db, team.id, policy, Date.now());
    const mint = issueGovernedLaunch(db, team.id, human, {
      member: 'ada',
      node_id: 'node-a',
      correlation: 'corr-1',
      context: { kind: 'orientation', allowance_id: 'allow-1' },
      ttl_ms: 60_000,
    });
    expect(
      consumeGovernedLaunch(
        db,
        team.id,
        {
          token: mint.token,
          launch_id: mint.authorization.id,
          presence_id: presence.id,
          member: 'ada',
          node_id: 'node-a',
          correlation: 'corr-1',
        },
        200,
      ).ok,
    ).toBe(true);
    expect(
      authorizeGovernedRequest(
        db,
        team.id,
        'msnode_node-a',
        requestFor(mint.authorization.id, presence.id, { node_id: 'node-b' }),
      ),
    ).toMatchObject({
      decision: 'deny',
      reason: 'denied_node_binding',
    });
    db.close();
  });

  it('requires the exact live Presence and refuses expiry, revoke, and replay attempts', () => {
    const { db, team, human, agent, presence } = fixture();
    const expired = issueGovernedLaunch(
      db,
      team.id,
      human,
      {
        member: agent.name,
        node_id: 'node-a',
        correlation: 'expired',
        context: { kind: 'orientation', allowance_id: 'allow-1' },
        ttl_ms: 60_000,
      },
      100,
    );
    expect(
      consumeGovernedLaunch(
        db,
        team.id,
        {
          token: expired.token,
          launch_id: expired.authorization.id,
          presence_id: 'missing-presence',
          member: agent.name,
          node_id: 'node-a',
          correlation: 'expired',
        },
        200,
      ),
    ).toEqual({ ok: false, reason: 'denied_presence_unknown' });
    expect(
      consumeGovernedLaunch(
        db,
        team.id,
        {
          token: expired.token,
          launch_id: expired.authorization.id,
          presence_id: presence.id,
          member: agent.name,
          node_id: 'node-a',
          correlation: 'expired',
        },
        60_100,
      ),
    ).toEqual({ ok: false, reason: 'denied_launch_expired' });

    const revoked = issueGovernedLaunch(db, team.id, human, {
      member: agent.name,
      node_id: 'node-a',
      correlation: 'revoked',
      context: { kind: 'orientation', allowance_id: 'allow-2' },
      ttl_ms: 60_000,
    });
    expect(revokeGovernedLaunch(db, team.id, revoked.authorization.id, Date.now())).toBe(true);
    expect(
      consumeGovernedLaunch(db, team.id, {
        token: revoked.token,
        launch_id: revoked.authorization.id,
        presence_id: presence.id,
        member: agent.name,
        node_id: 'node-a',
        correlation: 'revoked',
      }),
    ).toEqual({ ok: false, reason: 'denied_launch_revoked' });
    db.close();
  });

  it('distinguishes a revoked node and a model outside the server-owned policy', () => {
    const { db, team, human, agent, presence } = fixture();
    setGovernedPolicy(db, team.id, policy);
    const mint = issueGovernedLaunch(db, team.id, human, {
      member: agent.name,
      node_id: 'node-a',
      correlation: 'corr-node',
      context: { kind: 'orientation', allowance_id: 'allow-node' },
      ttl_ms: 60_000,
    });
    expect(
      consumeGovernedLaunch(db, team.id, {
        token: mint.token,
        launch_id: mint.authorization.id,
        presence_id: presence.id,
        member: agent.name,
        node_id: 'node-a',
        correlation: 'corr-node',
      }).ok,
    ).toBe(true);
    expect(
      authorizeGovernedRequest(
        db,
        team.id,
        'msnode_node-a',
        requestFor(mint.authorization.id, presence.id, {
          correlation: 'corr-node',
          model: 'openai/gpt-5',
          provider: 'openai',
        }),
      ),
    ).toMatchObject({ decision: 'deny', reason: 'denied_model' });
    revokeNode(db, team.id, 'node-a');
    expect(
      authorizeGovernedRequest(
        db,
        team.id,
        'msnode_node-a',
        requestFor(mint.authorization.id, presence.id, { correlation: 'corr-node' }),
      ),
    ).toMatchObject({ decision: 'deny', reason: 'denied_node_revoked' });
    db.close();
  });

  it('authorizes active Lane and unresolved directed Act contexts, then closes the Lane', () => {
    const { db, team, human, agent, presence } = fixture();
    setGovernedPolicy(db, team.id, policy);
    const lane = openLane(
      db,
      team.id,
      team.slug,
      agent.name,
      {
        title: 'governed work',
        claim: true,
      },
      Date.now(),
    );
    const laneLaunch = issueGovernedLaunch(db, team.id, human, {
      member: agent.name,
      node_id: 'node-a',
      correlation: 'corr-lane',
      context: { kind: 'lane', lane_id: lane.id },
      ttl_ms: 60_000,
    });
    expect(
      consumeGovernedLaunch(db, team.id, {
        token: laneLaunch.token,
        launch_id: laneLaunch.authorization.id,
        presence_id: presence.id,
        member: agent.name,
        node_id: 'node-a',
        correlation: 'corr-lane',
      }).ok,
    ).toBe(true);
    expect(
      authorizeGovernedRequest(
        db,
        team.id,
        'msnode_node-a',
        requestFor(laneLaunch.authorization.id, presence.id, { correlation: 'corr-lane' }),
      ),
    ).toMatchObject({ decision: 'allow', reason: 'allowed' });
    updateLane(db, team.id, lane.id, team.slug, { state: 'done' });
    expect(
      authorizeGovernedRequest(
        db,
        team.id,
        'msnode_node-a',
        requestFor(laneLaunch.authorization.id, presence.id, { correlation: 'corr-lane' }),
      ),
    ).toMatchObject({ decision: 'deny', reason: 'denied_context_lane' });

    const act = {
      id: 'act-governed',
      v: PROTOCOL_VERSION,
      team: team.slug,
      from: human.name,
      to: { kind: 'member' as const, name: agent.name },
      act: 'request_help' as const,
      body: 'need review',
      ts: Date.now(),
    };
    insertMessage(db, team.id, human.id, agent.id, act);
    const actLaunch = issueGovernedLaunch(db, team.id, human, {
      member: agent.name,
      node_id: 'node-a',
      correlation: 'corr-act',
      context: { kind: 'act', act_id: act.id },
      ttl_ms: 60_000,
    });
    expect(
      consumeGovernedLaunch(db, team.id, {
        token: actLaunch.token,
        launch_id: actLaunch.authorization.id,
        presence_id: presence.id,
        member: agent.name,
        node_id: 'node-a',
        correlation: 'corr-act',
      }).ok,
    ).toBe(true);
    expect(
      authorizeGovernedRequest(
        db,
        team.id,
        'msnode_node-a',
        requestFor(actLaunch.authorization.id, presence.id, { correlation: 'corr-act' }),
      ),
    ).toMatchObject({ decision: 'allow', reason: 'allowed' });
    db.close();
  });

  it('refuses a held Presence and a model outside the effective Member ceiling', () => {
    const { db, team, human, agent, presence } = fixture();
    setGovernedPolicy(db, team.id, policy);
    const launch = issueGovernedLaunch(db, team.id, human, {
      member: agent.name,
      node_id: 'node-a',
      correlation: 'corr-stale',
      context: { kind: 'orientation', allowance_id: 'allow-stale' },
      ttl_ms: 60_000,
    });
    release(db, presence.id, 60_000);
    expect(
      consumeGovernedLaunch(db, team.id, {
        token: launch.token,
        launch_id: launch.authorization.id,
        presence_id: presence.id,
        member: agent.name,
        node_id: 'node-a',
        correlation: 'corr-stale',
      }),
    ).toEqual({ ok: false, reason: 'denied_presence_stale' });

    const live = attach(db, agent.id, 'claude-code', 'conn-2');
    const allowedLaunch = issueGovernedLaunch(db, team.id, human, {
      member: agent.name,
      node_id: 'node-a',
      correlation: 'corr-model',
      context: { kind: 'orientation', allowance_id: 'allow-model' },
      ttl_ms: 60_000,
    });
    expect(
      consumeGovernedLaunch(db, team.id, {
        token: allowedLaunch.token,
        launch_id: allowedLaunch.authorization.id,
        presence_id: live.id,
        member: agent.name,
        node_id: 'node-a',
        correlation: 'corr-model',
      }).ok,
    ).toBe(true);
    expect(
      authorizeGovernedRequest(
        db,
        team.id,
        'msnode_node-a',
        requestFor(allowedLaunch.authorization.id, live.id, {
          correlation: 'corr-model',
          model: 'openai/gpt-5',
          provider: 'openai',
        }),
      ),
    ).toMatchObject({ decision: 'deny', reason: 'denied_model' });
    db.close();
  });
});
