import { describe, expect, it } from 'vitest';
import {
  type Capabilities,
  CapabilitiesSchema,
  clampNarrow,
  effectiveCapabilities,
  GENERALIST_CAPABILITIES,
  RoleSchema,
} from './capabilities.js';

describe('capability model (ADR 070)', () => {
  it('the generalist default is backward-compatible (everyone may do everything but admin)', () => {
    expect(GENERALIST_CAPABILITIES).toEqual({
      is_admin: false,
      can_flag_urgent: true, // urgent stays ungated until P2 flips the default
      can_observe: true,
      can_message: 'team',
      visibility_level: 'team',
      tool_allowlist: [],
      declared_resource_scopes: [],
    });
    // a real Capabilities record validates against the schema
    expect(CapabilitiesSchema.parse(GENERALIST_CAPABILITIES)).toEqual(GENERALIST_CAPABILITIES);
  });

  it('no role + no override resolves to the generalist default', () => {
    expect(effectiveCapabilities()).toEqual(GENERALIST_CAPABILITIES);
  });

  it('role defaults set the ceiling freely (incl. an admin role)', () => {
    const lead = effectiveCapabilities({ is_admin: true, visibility_level: 'admin' });
    expect(lead.is_admin).toBe(true);
    expect(lead.visibility_level).toBe('admin');
    // unset role fields fall back to generalist
    expect(lead.can_flag_urgent).toBe(true);
  });

  it('a seat override NARROWS a boolean (true→false) but cannot widen it', () => {
    // role allows urgent; seat narrows it off
    expect(
      effectiveCapabilities({ can_flag_urgent: true }, { can_flag_urgent: false }).can_flag_urgent,
    ).toBe(false);
    // role forbids urgent; seat tries to widen it on → clamped back to false
    expect(
      effectiveCapabilities({ can_flag_urgent: false }, { can_flag_urgent: true }).can_flag_urgent,
    ).toBe(false);
  });

  it('a seat cannot self-promote to admin', () => {
    expect(effectiveCapabilities({ is_admin: false }, { is_admin: true }).is_admin).toBe(false);
  });

  it('scoped fields narrow down their rank only', () => {
    // can_message: team→none allowed; none→team clamped
    expect(
      effectiveCapabilities({ can_message: 'team' }, { can_message: 'none' }).can_message,
    ).toBe('none');
    expect(
      effectiveCapabilities({ can_message: 'none' }, { can_message: 'team' }).can_message,
    ).toBe('none');
    // visibility: admin→team allowed; team→admin clamped
    expect(
      effectiveCapabilities({ visibility_level: 'admin' }, { visibility_level: 'team' })
        .visibility_level,
    ).toBe('team');
    expect(
      effectiveCapabilities({ visibility_level: 'team' }, { visibility_level: 'admin' })
        .visibility_level,
    ).toBe('team');
  });

  it('declared lists subset under a non-empty ceiling; an empty ceiling is unrestricted', () => {
    // ceiling [a,b]; seat declares [a,c] → keeps only the in-ceiling 'a'
    expect(
      effectiveCapabilities({ tool_allowlist: ['a', 'b'] }, { tool_allowlist: ['a', 'c'] })
        .tool_allowlist,
    ).toEqual(['a']);
    // empty ceiling = unrestricted → a seat may declare a narrowing list under it
    expect(
      effectiveCapabilities({}, { declared_resource_scopes: ['repo/x'] }).declared_resource_scopes,
    ).toEqual(['repo/x']);
  });

  it('clampNarrow never widens any field, for arbitrary ceiling/override pairs', () => {
    const ceilings: Capabilities[] = [
      GENERALIST_CAPABILITIES,
      {
        ...GENERALIST_CAPABILITIES,
        can_flag_urgent: false,
        can_message: 'none',
        visibility_level: 'team',
        tool_allowlist: ['a'],
      },
      { ...GENERALIST_CAPABILITIES, is_admin: true, visibility_level: 'admin' },
    ];
    const overrides = [
      {
        is_admin: true,
        can_flag_urgent: true,
        can_observe: true,
        can_message: 'team' as const,
        visibility_level: 'admin' as const,
        tool_allowlist: ['a', 'b', 'c'],
        declared_resource_scopes: ['y'],
      },
      {},
      { can_message: 'none' as const, can_flag_urgent: false },
    ];
    for (const c of ceilings) {
      for (const o of overrides) {
        const r = clampNarrow(c, o);
        // booleans: result implies ceiling (never gained)
        expect(!r.is_admin || c.is_admin).toBe(true);
        expect(!r.can_flag_urgent || c.can_flag_urgent).toBe(true);
        expect(!r.can_observe || c.can_observe).toBe(true);
        // scopes: result rank ≤ ceiling rank
        if (c.can_message === 'none') expect(r.can_message).toBe('none');
        if (c.visibility_level === 'team') expect(r.visibility_level).toBe('team');
        // lists: every kept entry was in the ceiling (when the ceiling restricts)
        if (c.tool_allowlist.length > 0)
          expect(r.tool_allowlist.every((x) => c.tool_allowlist.includes(x))).toBe(true);
      }
    }
  });

  it('RoleSchema parses a role file shape with partial caps + charter', () => {
    const role = RoleSchema.parse({
      name: 'reviewer',
      capabilities: { can_flag_urgent: false },
      charter: 'Review PRs; do not merge.',
    });
    expect(role.name).toBe('reviewer');
    expect(role.capabilities.can_flag_urgent).toBe(false);
    // capabilities defaults to {} when omitted
    expect(RoleSchema.parse({ name: 'backend' }).capabilities).toEqual({});
  });
});
