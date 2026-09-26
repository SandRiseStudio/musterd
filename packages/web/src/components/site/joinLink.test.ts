import { describe, expect, it } from 'vitest';
import { connectorUrl, parseJoinFragment, roomCodeFromInvite } from './joinLink';

// Vector from the daemon's own mint derivation (store/invites.ts `crockford`) over a fixed secret.
const SECRET = '-yBFao-02f4jSG2St9wBJktwlbo';

describe('roomCodeFromInvite', () => {
  it('derives the same room code the daemon prints at mint', () => {
    expect(roomCodeFromInvite(`ABC.${SECRET}`)).toBe('ABC-ZCG4-ATMF');
  });

  it('refuses anything that is not <selector>.<27-char secret>', () => {
    expect(roomCodeFromInvite(SECRET)).toBeNull();
    expect(roomCodeFromInvite(`abc.${SECRET}`)).toBeNull();
    expect(roomCodeFromInvite(`ABC.${SECRET}x`)).toBeNull();
  });
});

describe('parseJoinFragment', () => {
  it('reads an invite', () => {
    expect(parseJoinFragment(`#i=ABC.${SECRET}`)).toEqual({
      kind: 'invite',
      value: `ABC.${SECRET}`,
      roomCode: 'ABC-ZCG4-ATMF',
    });
  });

  it('reads an agent connect code', () => {
    const nonce = 'a'.repeat(43);
    expect(parseJoinFragment(`#n=${nonce}`)).toEqual({ kind: 'agent', nonce });
  });

  it('treats a missing or malformed fragment as none', () => {
    expect(parseJoinFragment('')).toEqual({ kind: 'none' });
    expect(parseJoinFragment('#i=nope')).toEqual({ kind: 'none' });
    expect(parseJoinFragment('#n=short')).toEqual({ kind: 'none' });
  });
});

describe('connectorUrl', () => {
  it('is the origin plus /mcp/<team>', () => {
    expect(connectorUrl('https://mcp-demo.example.org', 'demo')).toBe(
      'https://mcp-demo.example.org/mcp/demo',
    );
  });
});
