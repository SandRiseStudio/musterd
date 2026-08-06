import { describe, expect, it } from 'vitest';
import { slackSecretHint, twilioTokenHint } from './hints.js';

/**
 * These guard a MESSAGE, not a decision — which is the whole design (see hints.ts). So the
 * assertions are about what a stuck reader is told, and the most important one is the last in each
 * block: a correctly-shaped credential must NOT be accused, or the hint becomes the thing that
 * sends the next person down the wrong path.
 */
describe('twilioTokenHint', () => {
  // Synthetic by construction, never a real credential — a fixture that pastes a live secret is how
  // one ends up in git history (this file's first draft did exactly that and push protection caught it).
  const authToken = 'a'.repeat(32); // 32 lowercase hex — the Auth Token shape
  const apiKeySecret = `Mixed${'B'.repeat(13)}${'c'.repeat(14)}`; // 32 mixed-case — API key secret shape

  it('names the API-key mix-up when the configured value cannot be an Auth Token', () => {
    const hint = twilioTokenHint(apiKeySecret);
    expect(hint).toContain('API key secret');
    expect(hint).toContain('Auth Token');
  });

  it('points at the URL, not the credential, when the token is correctly shaped', () => {
    const hint = twilioTokenHint(authToken);
    expect(hint).toContain('URL');
    expect(hint).not.toContain('API key secret');
  });

  it('never leaks the configured value', () => {
    expect(twilioTokenHint(apiKeySecret)).not.toContain(apiKeySecret);
    expect(twilioTokenHint(authToken)).not.toContain(authToken);
  });

  it('treats an SK-prefixed value as the API key it is, whatever its length', () => {
    // Built rather than pasted so no credential-shaped literal ever lands in the repo.
    expect(twilioTokenHint(`SK${'0'.repeat(32)}`)).toContain('API key');
  });
});

describe('slackSecretHint', () => {
  it('names the bot-token mix-up for an xox- prefixed value', () => {
    expect(slackSecretHint('xoxb-123-456-abcdef')).toContain('bot token');
  });

  it('points at the URL when the signing secret is correctly shaped', () => {
    const hint = slackSecretHint('b'.repeat(32));
    expect(hint).toContain('URL');
    expect(hint).not.toContain('bot token');
  });

  it('never leaks the configured value', () => {
    expect(slackSecretHint('xoxb-123-456-abcdef')).not.toContain('abcdef');
  });
});
