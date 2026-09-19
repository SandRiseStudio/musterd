import {
  GovernedAuthorizationRequestSchema,
  GovernedLaunchAuthorizationMintSchema,
  TOKEN_PREFIXES,
  type GovernedLaunchAuthorizationMint,
} from '@musterd/protocol';
import { z } from 'zod';

const GovernedHarnessSchema = z.enum(['claude-code', 'codex']);
const NonEmptyValueSchema = z
  .string()
  .min(1)
  .refine((value) => !/[\u0000\r\n]/.test(value), 'value must not contain control characters');

export type GovernedHarness = z.infer<typeof GovernedHarnessSchema>;

export interface GovernedLaunchPlanInput {
  harness: GovernedHarness | string;
  server: string;
  team: string;
  agentKey: string;
  apertureBaseUrl: string;
  model: string;
  workspace: string;
  launch: GovernedLaunchAuthorizationMint;
  baseEnv?: Readonly<Record<string, string | undefined>>;
}

export interface GovernedLaunchPlan {
  harness: GovernedHarness;
  command: 'claude' | 'codex';
  args: string[];
  env: Record<string, string>;
}

const SAFE_INHERITED_ENV = [
  'HOME',
  'PATH',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'NO_COLOR',
] as const;

function parseHarness(value: string): GovernedHarness {
  const parsed = GovernedHarnessSchema.safeParse(value);
  if (!parsed.success) throw new Error('governed launch supports only claude-code or codex');
  return parsed.data;
}

function parseEndpoint(value: string): string {
  const parsedValue = NonEmptyValueSchema.safeParse(value);
  if (!parsedValue.success) throw new Error('governed launch Aperture URL is invalid');

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('governed launch Aperture URL is invalid');
  }
  if (url.username || url.password) {
    throw new Error('governed launch Aperture URL must not contain userinfo');
  }
  if (url.search || url.hash) {
    throw new Error('governed launch Aperture URL must not contain a query or fragment');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase());
  if (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) {
    throw new Error('governed launch Aperture URL must use HTTPS except for loopback HTTP');
  }
  return url.toString().replace(/\/$/, '');
}

function validateModel(launch: GovernedLaunchAuthorizationMint, model: string): void {
  const separator = model.indexOf('/');
  const parsed = GovernedAuthorizationRequestSchema.safeParse({
    launch_id: launch.authorization.id,
    presence_id: launch.authorization.presence_id ?? 'pending-presence',
    correlation: launch.authorization.correlation,
    member: launch.authorization.member,
    node_id: launch.authorization.node_id,
    provider: separator > 0 ? model.slice(0, separator) : model,
    model,
  });
  if (!parsed.success)
    throw new Error('governed launch model is not an exact supported identifier');
}

function safeEnvironment(
  baseEnv: Readonly<Record<string, string | undefined>>,
  harness: GovernedHarness,
): Record<string, string> {
  const env: Record<string, string> = {};
  const names = [
    ...SAFE_INHERITED_ENV,
    harness === 'claude-code' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME',
  ];
  for (const name of names) {
    const value = baseEnv[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

function parseLaunchMint(value: GovernedLaunchAuthorizationMint): GovernedLaunchAuthorizationMint {
  const parsed = GovernedLaunchAuthorizationMintSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error('governed launch handoff did not match the protocol schema');
  }
  return parsed.data;
}

/** Build an ephemeral, secret-aware child-process plan without starting the harness. */
export function buildGovernedLaunchPlan(input: GovernedLaunchPlanInput): GovernedLaunchPlan {
  const harness = parseHarness(input.harness);
  const launch = parseLaunchMint(input.launch);
  const server = NonEmptyValueSchema.parse(input.server);
  const team = NonEmptyValueSchema.parse(input.team);
  const workspace = NonEmptyValueSchema.parse(input.workspace);
  const agentKey = NonEmptyValueSchema.parse(input.agentKey);
  if (!agentKey.startsWith(TOKEN_PREFIXES.agent_key)) {
    throw new Error('governed launch requires an mskey_ agent key');
  }
  const model = NonEmptyValueSchema.parse(input.model);
  validateModel(launch, model);
  const apertureBaseUrl = parseEndpoint(input.apertureBaseUrl);
  const env = safeEnvironment(input.baseEnv ?? process.env, harness);

  Object.assign(env, {
    MUSTERD_SERVER: server,
    MUSTERD_TEAM: team,
    MUSTERD_AGENT_KEY: agentKey,
    MUSTERD_CLAIM: `seat:${launch.authorization.member}`,
    MUSTERD_LAUNCH_SURFACE: harness,
    MUSTERD_GOVERNED_LAUNCH_ID: launch.authorization.id,
    MUSTERD_GOVERNED_LAUNCH_TOKEN: launch.token,
    MUSTERD_GOVERNED_NODE_ID: launch.authorization.node_id,
    MUSTERD_GOVERNED_CORRELATION: launch.authorization.correlation,
    MUSTERD_GOVERNED_APERTURE_BASE_URL: apertureBaseUrl,
  });

  if (harness === 'claude-code') {
    env.ANTHROPIC_BASE_URL = apertureBaseUrl;
    return { harness, command: 'claude', args: ['--model', model], env };
  }

  env.OPENAI_BASE_URL = apertureBaseUrl;
  return {
    harness,
    command: 'codex',
    args: ['exec', '--json', '--model', model, '-C', workspace],
    env,
  };
}
