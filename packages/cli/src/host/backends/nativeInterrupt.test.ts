import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { appendInterrupt, bridgeTools } from './nativeBridge.js';

/**
 * The native row's doorbell (clause 1 of `docs/design/daemon-doorbell-contract.md`, lane
 * 01M2GNYGEY). Before this, native was the one harness recorded **not shipped**: nothing bridged a
 * raised act into the loop's context, so a `steer` addressed to a woken native seat reached it only
 * if the model happened to read its own inbox.
 *
 * Two things are pinned here. First, the seam that ships: the composed line rides out on the next
 * tool result. Second, the seam that does NOT ship, and why — the `onBeforeTurn` message push the
 * contract sketched is unsafe against the shipping runner, and the fixture below fails the moment
 * that stops being true.
 */

const oneTool = {
  listTools: async () => ({
    tools: [{ name: 'team_next', description: 'orient', inputSchema: { type: 'object' } }],
  }),
  callTool: async () => ({ content: [{ type: 'text', text: 'next — as ryder' }] }),
};

describe('the composed line rides the tool result', () => {
  it('appends a raised line after the tool output, separated from it', async () => {
    const [tool] = await bridgeTools(oneTool, async () => 'musterd: schmidt raised a steer');
    await expect(tool!.run({})).resolves.toBe('next — as ryder\n\nmusterd: schmidt raised a steer');
  });

  it('is silent on the common path — an unraised probe leaves the result byte-identical', async () => {
    const [tool] = await bridgeTools(oneTool, async () => null);
    await expect(tool!.run({})).resolves.toBe('next — as ryder');
  });

  it('never fails the tool call it rides on: a throwing probe is swallowed', async () => {
    const [tool] = await bridgeTools(oneTool, async () => {
      throw new Error('daemon down');
    });
    await expect(tool!.run({})).resolves.toBe('next — as ryder');
  });

  it('with no probe wired, the bridge behaves exactly as it did before the doorbell', async () => {
    const [tool] = await bridgeTools(oneTool);
    await expect(tool!.run({})).resolves.toBe('next — as ryder');
  });

  it('delivers the line even when the tool returned nothing to append to', () => {
    expect(appendInterrupt('', 'musterd: a steer is waiting')).toBe('musterd: a steer is waiting');
    expect(appendInterrupt('result', null)).toBe('result');
  });
});

/**
 * The regression fixture for the road not taken. `pushMessages` → `setMessagesParams` sets the
 * runner's private `#mutated` flag, and the iterator's post-yield branch appends the assistant
 * message only `if (!this.#mutated)`. So injecting from inside the `for await` body silently DROPS
 * the turn the model just took — and the tool response is then computed against the injected user
 * message rather than the assistant's `tool_use`, so no tool runs at all.
 *
 * If a future SDK makes the push safe, this test fails, and the bridge-side seam can be revisited
 * on purpose rather than by accident.
 */
describe('why the doorbell is not an onBeforeTurn message push', () => {
  it('pushMessages mid-iteration drops the assistant turn from the runner history', async () => {
    const client = new Anthropic({ apiKey: 'test-key-not-used' });
    let calls = 0;
    (client.beta.messages as unknown as Record<string, unknown>)['create'] = async (params: {
      model: string;
    }) => {
      calls += 1;
      return {
        id: `msg_${String(calls)}`,
        role: 'assistant',
        model: params.model,
        content: [{ type: 'text', text: `turn ${String(calls)}` }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    };

    const runner = client.beta.messages.toolRunner({
      model: 'claude-sonnet-5',
      max_tokens: 16,
      messages: [{ role: 'user', content: 'the composed wake line' }],
      tools: [],
      max_iterations: 2,
    });

    for await (const _message of runner) {
      // What an `onBeforeTurn` injection would do at exactly this point.
      runner.pushMessages({ role: 'user', content: 'musterd: schmidt raised a steer' });
    }

    const roles = runner.params.messages.map((m) => m.role);
    // The wake prompt and our injected line survive; the assistant turns do not.
    expect(roles).toEqual(['user', 'user', 'user']);
    expect(runner.params.messages.some((m) => m.role === 'assistant')).toBe(false);
  });
});
