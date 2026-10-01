import { describe, expect, it, vi } from 'vitest';
import { runSmoke, runSmokeCommand, type SmokeOptions } from '../scripts/ai-smoke.js';

const env: NonNullable<SmokeOptions['env']> = { openaiKey: 'synthetic-openai-key', openaiModel: 'gpt-4.1-mini-2025-04-14', mistralKey: 'synthetic-mistral-key', mistralModel: 'mistral-small-2603' };
const greetingPlan = { intent: 'greeting', searchQuery: '', productIds: [], factIds: [], variantId: null, quantity: null };
const greekReply = 'Γεια σου! Ποιο προϊόν αναζητάς;';
const goodDraft = { segments: [{ text: greekReply, productIds: [], factIds: [] }] };

function providerFetch(provider: 'openai' | 'mistral', values: unknown[], includeUsage = true): typeof fetch {
  return vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    expect(request.model).toBe(provider === 'openai' ? env.openaiModel : env.mistralModel);
    const context = JSON.parse((provider === 'openai' ? request.input : request.messages)[1].content);
    expect(context.context?.facts ?? context.facts).toEqual([]);
    expect(context.context?.products ?? context.products).toEqual([]);
    const value = values.shift();
    const body = provider === 'openai' ? {
      id: 'resp_smoke', object: 'response', created_at: 1, status: 'completed',
      ...(includeUsage ? { usage: { input_tokens: 20, output_tokens: 10 } } : {}),
      output: [{ id: 'msg_smoke', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(value), annotations: [] }] }],
    } : {
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(value) } }],
      ...(includeUsage ? { usage: { prompt_tokens: 20, completion_tokens: 10 } } : {}),
    };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
}

describe('explicit provider readiness smoke helper', () => {
  it.each(['openai', 'mistral'] as const)('uses the actual %s adapter for three structured calls and prints only safe metadata', async provider => {
    const fetcher = providerFetch(provider, [greetingPlan, goodDraft, { supported: true, medical: false }]);
    const output = vi.fn();
    const result = await runSmokeCommand([provider], { env, fetch: fetcher, output });
    expect(result).toMatchObject({ provider, model: provider === 'openai' ? env.openaiModel : env.mistralModel, pass: true, inputTokens: 60, outputTokens: 30 });
    expect(result.calls.map(call => call.operation)).toEqual(['plan', 'compose', 'verify']);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(output).toHaveBeenCalledOnce();
    const printed = output.mock.calls[0]![0];
    expect(JSON.parse(printed)).toEqual(result);
    for (const forbidden of [env.openaiKey, env.mistralKey, greekReply, 'Γεια σου!', 'Δοκιμή ετοιμότητας']) expect(printed).not.toContain(forbidden);
  });

  it.each(['openai', 'mistral'] as const)('refuses a missing %s key before network access, without falling back to the other provider', async provider => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(runSmoke(provider, { env: { ...env, [provider === 'openai' ? 'openaiKey' : 'mistralKey']: undefined }, fetch: fetcher })).rejects.toThrow('requires a valid API key and model');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([[], ['openai', 'mistral'], ['all'], ['private-invalid-provider-value']].map(args => ({ args })))('requires exactly one known provider: $args', async ({ args }) => {
    const fetcher = vi.fn<typeof fetch>();
    const output = vi.fn();
    await expect(runSmokeCommand(args, { env, fetch: fetcher, output })).rejects.toThrow(/^Usage: pnpm ai:smoke/);
    expect(fetcher).not.toHaveBeenCalled();
    expect(output).not.toHaveBeenCalled();
  });

  it('rejects missing or unsafe model configuration before requests or output', async () => {
    const fetcher = vi.fn<typeof fetch>();
    for (const openaiModel of [undefined, 'sk-private-value', 'https://private.example/token', '']) {
      await expect(runSmoke('openai', { env: { ...env, openaiModel }, fetch: fetcher })).rejects.toThrow('requires a valid API key and model');
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('fails if the selected model does not recognize the synthetic greeting', async () => {
    const fetcher = providerFetch('openai', [{ ...greetingPlan, intent: 'search' }]);
    await expect(runSmoke('openai', { env, fetch: fetcher })).rejects.toThrow('failed its provider or response contract');
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('does not pass an English response as a Greek readiness check', async () => {
    const fetcher = providerFetch('mistral', [greetingPlan, { segments: [{ text: 'Hello! What product are you looking for?', productIds: [], factIds: [] }] }, { supported: true, medical: false }]);
    await expect(runSmoke('mistral', { env, fetch: fetcher })).rejects.toThrow('failed its provider or response contract');
  });

  it('withholds output if semantic verification rejects the reply', async () => {
    const fetcher = providerFetch('openai', [greetingPlan, goodDraft, { supported: false, medical: false }]);
    const output = vi.fn();
    await expect(runSmokeCommand(['openai'], { env, fetch: fetcher, output })).rejects.toThrow('failed its provider or response contract');
    expect(output).not.toHaveBeenCalled();
  });

  it('redacts provider failures without retrying or printing their bodies', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ error: { message: 'private-provider-failure' } }), { status: 401 }));
    const output = vi.fn();
    await expect(runSmokeCommand(['mistral'], { env, fetch: fetcher, output })).rejects.toThrow(/^AI smoke test failed its provider or response contract checks\./);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(output).not.toHaveBeenCalled();
  });

  it('reports unknown token totals honestly when provider usage is absent', async () => {
    const fetcher = providerFetch('openai', [greetingPlan, goodDraft, { supported: true, medical: false }], false);
    expect(await runSmoke('openai', { env, fetch: fetcher })).toMatchObject({ pass: true, inputTokens: null, outputTokens: null });
  });

  it('never starts a request after cancellation', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(runSmoke('openai', { env, fetch: fetcher, signal: AbortSignal.abort() })).rejects.toThrow('failed its provider or response contract');
    expect(fetcher).not.toHaveBeenCalled();
  });
});
