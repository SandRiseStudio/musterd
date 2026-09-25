import { describe, expect, it } from 'vitest';
import { TOKEN_PREFIXES } from './credentials.js';
import { redactionMarker, scrubCredentials, scrubToText } from './traceScrub.js';

/*
 * ADR 445 §3: "1b does not ship without the scrub tests green". This file is that corpus. Two halves,
 * and both matter: every credential shape must go (a miss stores a secret in trace.db), and ordinary
 * text must survive (a scrub that eats prose, SHAs and paths makes the content column useless, and
 * a useless column is how someone ends up turning the scrub off).
 */

const BODY = 'Zq7xK2mNvB9pLw4R'; // 16 chars, mixed — the shape of a real token body

describe('every registered musterd prefix is scrubbed (registry-driven)', () => {
  for (const [kind, prefix] of Object.entries(TOKEN_PREFIXES)) {
    it(`${prefix} → ${redactionMarker(kind)}`, () => {
      const secret = `${prefix}${BODY}`;
      for (const text of [
        secret,
        `export MUSTERD_AGENT_KEY=${secret}`,
        `{"agent_key":"${secret}","team":"revive"}`,
        `curl -s localhost:4849 -H 'x-key: ${secret}'`,
        `line one\n  ${secret}\nline three`,
        `${prefix.toUpperCase()}${BODY}`,
      ]) {
        const r = scrubCredentials(text);
        expect(r.text, text).not.toContain(BODY);
        expect(r.redactions, text).toBeGreaterThanOrEqual(1);
      }
      expect(scrubCredentials(secret)).toEqual({ text: redactionMarker(kind), redactions: 1 });
    });
  }

  it('a bare prefix in prose is a mention of the namespace, not a credential', () => {
    const prose = 'agent keys start with mskey_ and seat credentials with msac_.';
    expect(scrubCredentials(prose)).toEqual({ text: prose, redactions: 0 });
  });

  it('a token glued onto a word is still a token — a miss stores a secret, a hit costs a tail', () => {
    const r = scrubCredentials(`prefixmskey_${BODY} and foomsgr_${BODY}`);
    expect(r.redactions).toBe(2);
    expect(r.text).not.toContain(BODY);
    // …while an identifier whose tail is too short to be a token stays whole.
    const ident = 'const my_mskey_ok = 1;';
    expect(scrubCredentials(ident)).toEqual({ text: ident, redactions: 0 });
  });
});

describe('the generic shapes', () => {
  const cases: [label: string, input: string, gone: string, kind: string][] = [
    [
      'Authorization header, Bearer',
      'curl -H "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig"',
      'eyJhbGciOiJIUzI1NiJ9',
      'authorization',
    ],
    [
      'Authorization header, Basic',
      'Authorization: Basic dXNlcjpodW50ZXIy',
      'dXNlcjpodW50ZXIy',
      'authorization',
    ],
    [
      'Authorization as a JSON field',
      '{"headers":{"Authorization":"Bearer abc123def456ghi789"}}',
      'abc123def456ghi789',
      'authorization',
    ],
    [
      'bare Bearer in a log line',
      'retrying with Bearer 9f8e7d6c5b4a39281706',
      '9f8e7d6c5b4a39281706',
      'bearer',
    ],
    ['Anthropic key', 'ANTHROPIC=sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv', 'AbCdEfGhIjKlMnOp', 'sk'],
    ['OpenAI project key', 'key sk-proj-AbCdEfGhIjKlMnOpQrStUv here', 'AbCdEfGhIjKlMnOp', 'sk'],
    [
      'GitHub classic PAT',
      'gh auth login --with-token ghp_AbCdEfGhIjKlMnOpQrStUvWx12',
      'ghp_Ab',
      'github',
    ],
    [
      'GitHub fine-grained PAT',
      'github_pat_11ABCDEFG0123456789_abcdefghij',
      'github_pat_11',
      'github',
    ],
    ['GitHub server token', 'GITHUB_TOKEN ghs_AbCdEfGhIjKlMnOpQrStUvWx', 'ghs_Ab', 'github'],
    [
      'AWS access key id',
      'aws_access_key_id = AKIAIOSFODNN7EXAMPLE',
      'AKIAIOSFODNN7EXAMPLE',
      'aws',
    ],
    ['Slack bot token', 'xoxb-1234567890-abcdefghijkl', 'xoxb-1234567890', 'slack'],
    [
      'env assignment of a long secret',
      'STRIPE_SECRET=4f3c2b1a0e9d8c7b6a5f4e3d2c1b0a99',
      '4f3c2b1a0e9d8c7b6a5f4e3d2c1b0a99',
      'assignment',
    ],
    [
      'JSON access_token',
      '{"access_token": "ya29.a0AfH6SMBx3kq9Vd8Lw2PzR4tY7uN1mC5e"}',
      'ya29.a0AfH6SMBx3kq9Vd8Lw2PzR4tY7uN1mC5e',
      'assignment',
    ],
    [
      'CLI flag password',
      'psql --password=Tr0ub4dor-and-3-correct-horse-battery',
      'Tr0ub4dor',
      'assignment',
    ],
    [
      'base64 api key assignment',
      "apiKey: 'dGhpcyBpcyBhIHZlcnkgc2VjcmV0IGtleSBpbmRlZWQ='",
      'dGhpcyBpcyBhIHZlcnkgc2VjcmV0',
      'assignment',
    ],
  ];
  for (const [label, input, gone, kind] of cases) {
    it(label, () => {
      const r = scrubCredentials(input);
      expect(r.text).not.toContain(gone);
      expect(r.text).toContain(redactionMarker(kind));
      expect(r.redactions).toBe(1);
    });
  }

  it('a PEM private key block goes whole, and an unterminated one to the end', () => {
    const pem =
      'before\n-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\nQUFBQUFBQUFBQUFBQUFB\n' +
      '-----END OPENSSH PRIVATE KEY-----\nafter';
    expect(scrubCredentials(pem)).toEqual({
      text: `before\n${redactionMarker('private_key')}\nafter`,
      redactions: 1,
    });
    const cut = 'x\n-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA';
    expect(scrubCredentials(cut).text).toBe(`x\n${redactionMarker('private_key')}`);
  });

  it('keeps the header name and scheme, so the row still says what auth was used', () => {
    expect(scrubCredentials('Authorization: Bearer abcdefgh12345678').text).toBe(
      `Authorization: Bearer ${redactionMarker('authorization')}`,
    );
    expect(scrubCredentials('API_KEY=0123456789abcdef0123456789abcdef').text).toBe(
      `API_KEY=${redactionMarker('assignment')}`,
    );
  });

  it('a musterd token in an Authorization header counts once', () => {
    const r = scrubCredentials(`Authorization: Bearer msac_${BODY}`);
    expect(r.redactions).toBe(1);
    expect(r.text).not.toContain(BODY);
  });

  it('counts every credential in a text that carries several', () => {
    const text = [
      `cat .musterd/binding.json`,
      `{"agent_key":"mskey_${BODY}","seat_credential":"msac_${BODY}x",`,
      `"session_lease":"msls_${BODY}y"}`,
      `GH=ghp_AbCdEfGhIjKlMnOpQrStUvWx12`,
    ].join('\n');
    const r = scrubCredentials(text);
    expect(r.redactions).toBe(4);
    expect(r.text).not.toMatch(/Zq7xK2mNvB9pLw4R|ghp_Ab/);
  });
});

describe('what the scrub must leave alone', () => {
  const keep = [
    'The quick brown fox — a sentence with an email, ada@example.com, stays prose (ADR 184 §2).',
    'commit a02c2eb7b98ab6f47b3020eb3950c61c145b9c9d landed on main',
    'sha256: 3a7bd3e2360a3d29eea436fcfb7e44c735d117c42d1c1835420b6b9942dd4f1b',
    'Bearer authentication is described in RFC 6750.',
    'Token refreshed successfully after the daemon bounce.',
    'Basic arithmetic still works.',
    '{"file_path":"/Users/nick/musterd/revive/agents/ryder/packages/protocol/src/trace.ts"}',
    'keyPath: /Users/nick/musterd/revive/agents/ryder/packages/protocol/src/credentials.ts',
    'token_count: 12345, key: short, secret: no',
    'the task-runner-with-a-long-hyphenated-name ran',
    'session_digest 3f9a1c2b4d5e and tool_use_id toolu_01AbCdEfGhIjKlMnOpQrStUv',
    'const monkeyPatchedTokenizer = createTokenizer();',
  ];
  for (const text of keep) {
    it(text.slice(0, 60), () => {
      expect(scrubCredentials(text)).toEqual({ text, redactions: 0 });
    });
  }

  it('is idempotent: a second pass over scrubbed text changes nothing and counts nothing', () => {
    const once = scrubCredentials(
      `Authorization: Bearer msac_${BODY}\nAPI_KEY=0123456789abcdef0123456789abcdef\nmskey_${BODY}`,
    );
    expect(once.redactions).toBe(3);
    expect(scrubCredentials(once.text)).toEqual({ text: once.text, redactions: 0 });
  });
});

describe('credentials inside escapes — content arrives as JSON text and URL-encoded strings', () => {
  const token = `mskey_${BODY}`;
  const escaped: [label: string, text: string][] = [
    ['after a JSON-escaped newline', `{"stdout":"line one\\n${token}\\nline three"}`],
    ['after a JSON-escaped tab', `{"stdout":"k\\t${token}"}`],
    ['after a \\u0022 quote', `\\u0022${token}\\u0022`],
    ['URL-encoded in a query string', `GET /x?key=%22${token}%22`],
    ['an escaped .env line', `{"stdout":"PORT=1\\nAPI_KEY=0123456789abcdef0123456789abcdef"}`],
    ['an escaped header dump', `{"stderr":"> GET /\\r\\nAuthorization: Bearer abcdefgh12345678"}`],
    ['an escaped sk- key', `{"stdout":"\\nsk-ant-api03-AbCdEfGhIjKlMnOpQrStUv"}`],
  ];
  for (const [label, text] of escaped) {
    it(label, () => {
      const r = scrubCredentials(text);
      expect(r.redactions, r.text).toBe(1);
      expect(r.text).not.toMatch(
        /Zq7xK2mNvB9pLw4R|0123456789abcdef0123|abcdefgh12345678|AbCdEfGhIjKl/,
      );
    });
  }
});

describe('scrubToText — leaves first, then the JSON text', () => {
  it('scrubs string leaves of a structured value before stringifying it', () => {
    const r = scrubToText({
      stdout: `line one\nagent_key: mskey_${BODY}\n`,
      nested: [{ header: `Authorization: Bearer abcdefgh12345678` }],
      code: 0,
    });
    expect(r.redactions).toBe(2);
    expect(JSON.parse(r.text)).toEqual({
      stdout: `line one\nagent_key: ${redactionMarker('agent_key')}\n`,
      nested: [{ header: `Authorization: Bearer ${redactionMarker('authorization')}` }],
      code: 0,
    });
  });

  it('catches a secret that is one only as a key/value pair', () => {
    const r = scrubToText({ api_key: '0123456789abcdef0123456789abcdef' });
    expect(r.text).not.toContain('0123456789abcdef0123');
    expect(r.redactions).toBe(1);
  });

  it('passes a plain string straight to the scrub', () => {
    expect(scrubToText(`mskey_${BODY}`)).toEqual({
      text: redactionMarker('agent_key'),
      redactions: 1,
    });
  });
});
