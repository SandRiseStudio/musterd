/**
 * Minimal Anthropic Messages client via fetch — no SDK dependency (ADR: env key only).
 */
import { ANTHROPIC_API_URL, ANTHROPIC_VERSION, LLM_TIMEOUT_MS, USER_AGENT } from './config.ts';
import type { FetchFn } from './fetch.ts';

export interface LlmMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface LlmCompleteArgs {
  model: string;
  system: string;
  messages: LlmMessage[];
  maxTokens?: number;
  apiKey: string;
  fetchFn?: FetchFn;
}

export interface LlmCompleteResult {
  text: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
}

export async function completeAnthropic(args: LlmCompleteArgs): Promise<LlmCompleteResult> {
  const fetchFn = args.fetchFn ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), LLM_TIMEOUT_MS);
  try {
    const res = await fetchFn(ANTHROPIC_API_URL, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'content-type': 'application/json',
        'User-Agent': USER_AGENT,
        'x-api-key': args.apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: args.model,
        max_tokens: args.maxTokens ?? 4096,
        system: args.system,
        messages: args.messages.map((m) => ({ role: m.role, content: m.content })),
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Anthropic ${res.status}: ${body.slice(0, 400)}`);
    }
    const data = (await res.json()) as {
      content?: Array<{ type: string; text?: string }>;
      model?: string;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const text = (data.content ?? [])
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text!)
      .join('\n')
      .trim();
    if (!text) throw new Error('Anthropic response had no text blocks');
    return {
      text,
      model: data.model ?? args.model,
      inputTokens: data.usage?.input_tokens,
      outputTokens: data.usage?.output_tokens,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Extract the first JSON value (object or array) from a model reply. */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced?.[1]?.trim() ?? text.trim();
  const startObj = raw.indexOf('{');
  const startArr = raw.indexOf('[');
  let start = -1;
  if (startObj >= 0 && (startArr < 0 || startObj < startArr)) start = startObj;
  else if (startArr >= 0) start = startArr;
  if (start < 0) throw new Error('no JSON object/array in model reply');
  const slice = raw.slice(start);
  return JSON.parse(slice);
}

export function requireAnthropicKey(env: NodeJS.ProcessEnv = process.env): string {
  const key = env.ANTHROPIC_API_KEY?.trim();
  if (!key) {
    throw new Error(
      'ANTHROPIC_API_KEY is required for --triage (tier-1/tier-2 LLM). Export it or skip --triage for dry-sweep only.',
    );
  }
  return key;
}
