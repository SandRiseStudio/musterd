import { describe, expect, it } from 'vitest';
import { modelProvider } from './modelProvider';
import { providerIconHtml } from './modelProviderIcon';

describe('modelProvider', () => {
  it('maps Claude families (including fable) to claude chip colors', () => {
    for (const id of ['claude-opus-5', 'claude-fable-5', 'claude-sonnet-4-5', 'claude-haiku-4-5']) {
      const p = modelProvider(id);
      expect(p.id).toBe('claude');
      expect(p.border).toBe('#D97757');
      expect(p.fill).toBe('#FCEEE8');
      expect(p.ink).toBe('#5C2E1F');
    }
  });

  it('maps gpt / o-series to openai', () => {
    expect(modelProvider('gpt-5.6-terra-medium').id).toBe('openai');
    expect(modelProvider('o3-pro').id).toBe('openai');
    expect(modelProvider('gpt-5.6-luna-medium').border).toBe('#10A37F');
  });

  it('maps gemini, grok, llama, mistral, qwen, deepseek, kimi, minimax, glm, nova', () => {
    expect(modelProvider('gemini-3.2-pro').id).toBe('gemini');
    expect(modelProvider('grok-4.5').id).toBe('xai');
    expect(modelProvider('llama-4-maverick').id).toBe('meta');
    expect(modelProvider('mistral-large-3').id).toBe('mistral');
    expect(modelProvider('qwen-3.5').id).toBe('qwen');
    expect(modelProvider('deepseek-v4-pro').id).toBe('deepseek');
    expect(modelProvider('kimi-k3').id).toBe('kimi');
    expect(modelProvider('moonshot-v1').id).toBe('kimi');
    expect(modelProvider('minimax-m3').id).toBe('minimax');
    expect(modelProvider('glm-5.2').id).toBe('glm');
    expect(modelProvider('zai-glm').id).toBe('glm');
    expect(modelProvider('amazon-nova-2-pro').id).toBe('nova');
  });

  it('returns unknown for missing / unknown / empty', () => {
    expect(modelProvider(null).id).toBe('unknown');
    expect(modelProvider('unknown').id).toBe('unknown');
    expect(modelProvider('').id).toBe('unknown');
  });
});

describe('providerIconHtml', () => {
  it('returns an svg for claude and openai', () => {
    const claude = providerIconHtml(modelProvider('claude-opus-5'));
    expect(claude).toContain('<svg');
    expect(claude).toContain('#D97757');

    const openai = providerIconHtml(modelProvider('gpt-5.6'));
    expect(openai).toContain('<svg');
    expect(openai).toContain('#10A37F');
  });

  it('returns a letter mark for glm (no deck logo)', () => {
    const html = providerIconHtml(modelProvider('glm-5.2'));
    expect(html).toContain('G');
    expect(html).not.toMatch(/<svg[\s\S]*path/i);
  });

  it('returns a neutral mark for unknown', () => {
    const html = providerIconHtml(modelProvider(null));
    expect(html.length).toBeGreaterThan(0);
  });
});
