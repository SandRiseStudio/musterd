export type ModelProviderId =
  | 'claude'
  | 'openai'
  | 'gemini'
  | 'xai'
  | 'meta'
  | 'mistral'
  | 'qwen'
  | 'deepseek'
  | 'kimi'
  | 'minimax'
  | 'glm'
  | 'nova'
  | 'unknown';

export type ModelProvider = {
  id: ModelProviderId;
  border: string;
  fill: string;
  ink: string;
};

/** Chip tokens from lab AI training deck Model landscape (`.b-*`). */
const CHIPS: Record<ModelProviderId, Omit<ModelProvider, 'id'>> = {
  claude: { border: '#D97757', fill: '#FCEEE8', ink: '#5C2E1F' },
  openai: { border: '#10A37F', fill: '#E8F7F2', ink: '#0B5C47' },
  gemini: { border: '#8E75B2', fill: '#F0EBF8', ink: '#4A3A6E' },
  xai: { border: '#333', fill: '#F2F2F2', ink: '#111' },
  meta: { border: '#0668E1', fill: '#E7F0FD', ink: '#044A9E' },
  mistral: { border: '#F54E00', fill: '#FFF0E8', ink: '#8A2C00' },
  qwen: { border: '#FF6A00', fill: '#FFF1E6', ink: '#9A4000' },
  deepseek: { border: '#4D6BFE', fill: '#EBF0FF', ink: '#2A3FBF' },
  kimi: { border: '#6366F1', fill: '#EEF0FF', ink: '#3730A3' },
  minimax: { border: '#E11D48', fill: '#FDE8EF', ink: '#9F1239' },
  glm: { border: '#E11D48', fill: '#FDE8EF', ink: '#9F1239' },
  nova: { border: '#FF9900', fill: '#FFF4E5', ink: '#9A5C00' },
  unknown: { border: 'transparent', fill: 'transparent', ink: 'currentColor' },
};

function chip(id: ModelProviderId): ModelProvider {
  return { id, ...CHIPS[id] };
}

/**
 * Map an attested model id to a provider chip. Order matters: match specific families before
 * broad vendor prefixes. Exhaustive via Record — adding a provider requires a CHIPS entry.
 */
export function modelProvider(model: string | null | undefined): ModelProvider {
  if (!model) return chip('unknown');
  const lower = model.trim().toLowerCase();
  if (!lower || lower === 'unknown') return chip('unknown');

  if (/\b(opus|sonnet|haiku|fable)\b/.test(lower) || lower.includes('claude')) return chip('claude');
  if (/\bgpt\b/.test(lower) || /\bo[1-9]\b/.test(lower)) return chip('openai');
  if (lower.includes('gemini')) return chip('gemini');
  if (lower.includes('grok')) return chip('xai');
  if (lower.includes('llama')) return chip('meta');
  if (lower.includes('mistral')) return chip('mistral');
  if (lower.includes('qwen')) return chip('qwen');
  if (lower.includes('deepseek')) return chip('deepseek');
  if (lower.includes('kimi') || lower.includes('moonshot')) return chip('kimi');
  if (lower.includes('minimax')) return chip('minimax');
  if (/\bglm\b/.test(lower) || lower.includes('zai')) return chip('glm');
  if (lower.includes('nova')) return chip('nova');
  return chip('unknown');
}
