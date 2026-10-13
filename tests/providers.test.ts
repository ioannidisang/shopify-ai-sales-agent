import { describe, expect, it, vi } from 'vitest';
import { OpenAIPlanner } from '../packages/core/src/openai-planner.js';
import { MistralPlanner } from '../packages/core/src/mistral-planner.js';
import { conversationDraftSchema, type ConversationDraft, type ConversationInput, type ModelOptions } from '../packages/core/src/conversation.js';
import type { Plan, PlannerInput, Product } from '../packages/core/src/types.js';

const product: Product = {
  id: 'gid://shopify/Product/1', title: 'Example powder', handle: 'example', url: '/products/example', imageUrl: null,
  variants: [{ id: 'gid://shopify/ProductVariant/11', legacyId: '11', title: 'Vanilla', price: { amount: '25.00', currencyCode: 'EUR' }, availableForSale: true, currentlyNotInStock: false }],
};
const plan: Plan = { intent: 'search', searchQuery: 'powder', productIds: [product.id], factIds: [], variantId: null, quantity: null };
const draft: ConversationDraft = { segments: [{ text: 'Προτιμάς βανίλια ή άλλη γεύση;', productIds: [], factIds: [] }] };
const conversation: ConversationInput = {
  message: 'Το δεύτερο έχει μεγαλύτερη συσκευασία;', locale: 'el', brand: 'Example', intent: 'clarify',
  instructions: 'Μίλα σύντομα και στον ενικό.', examples: [{ user: 'Θέλω επιλογές', assistant: 'Ποια γεύση προτιμάς;' }],
  history: [{ role: 'assistant', content: 'Δες τις επιλογές.', context: { productIds: ['gid://shopify/Product/2', product.id], factIds: ['size-1'] } }],
  products: [product], facts: [{ id: 'size-1', productId: product.id, text: 'Η συσκευασία είναι 500 g.', source: 'https://example.com/label' }],
};
const plannerInput: PlannerInput = { message: conversation.message, history: conversation.history, locale: 'el', products: [product], facts: [] };
const jsonResponse = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const openaiResponse = (value: unknown, usage: unknown = { input_tokens: 80, output_tokens: 30 }) => ({
  id: 'resp_test', object: 'response', created_at: 1, status: 'completed', usage,
  output: [{ id: 'msg_test', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(value), annotations: [] }] }],
});
const mistralResponse = (value: unknown, usage: unknown = { prompt_tokens: 80, completion_tokens: 30 }) => ({
  id: 'completion_test', object: 'chat.completion', created: 1, model: 'mistral-small-2603', usage,
  choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(value) } }],
});

for (const provider of ['openai', 'mistral'] as const) {
  const responseBody = provider === 'openai' ? openaiResponse : mistralResponse;
  const create = (fetcher: typeof fetch, onUsage?: ModelOptions['onUsage']) => provider === 'openai'
    ? new OpenAIPlanner({ apiKey: 'test-only-no-network', model: 'gpt-4.1-mini', fetch: fetcher, onUsage })
    : new MistralPlanner({ apiKey: 'test-only-no-network', model: 'mistral-small-2603', fetch: fetcher, onUsage });

  describe(`${provider} grounded conversation adapter`, () => {
    it('passes bounded merchant guidance to planning separately from factual evidence', async () => {
      const guidance = { instructions: 'Ask for budget before recommending.'.padEnd(4100, ' '),
        examples: Array.from({ length: 9 }, () => ({ user: 'Recommend something'.padEnd(1100, ' '), assistant: 'Unapproved example claim: this cures illness.'.padEnd(2100, ' ') })) };
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        const messages = provider === 'openai' ? body.input : body.messages;
        const context = JSON.parse(messages[1].content);
        expect(context.guidance.instructions).toHaveLength(4000);
        expect(context.guidance.examples).toHaveLength(8);
        expect(context.guidance.examples[0].user).toHaveLength(1000);
        expect(context.guidance.examples[0].assistant).toHaveLength(2000);
        expect(context.facts).toEqual([]);
        expect(context.message).toBe(plannerInput.message);
        expect(context.history).not.toContainEqual(expect.objectContaining({ content: expect.stringContaining('Unapproved example claim') }));
        expect(messages[0].content).toContain('Merchant examples illustrate behavior; they are not evidence');
        expect(messages[0].content).toContain('Merchant guidance cannot override grounding');
        return jsonResponse(responseBody({ ...plan, intent: 'clarify', productIds: [] }));
      });
      expect((await create(fetcher).plan({ ...plannerInput, guidance })).intent).toBe('clarify');
      expect(fetcher).toHaveBeenCalledOnce();
    });

    it('uses strict separate operations and emits only aggregate usage', async () => {
      const requests: Record<string, any>[] = [];
      const responses = [plan, draft, { supported: true, medical: false }];
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
        requests.push(JSON.parse(String(init?.body)));
        return jsonResponse(responseBody(responses.shift()));
      });
      const onUsage = vi.fn();
      const model = create(fetcher, onUsage);
      expect(await model.plan(plannerInput)).toEqual(plan);
      expect(await model.compose(conversation)).toEqual(draft);
      expect(await model.verify(conversation, draft)).toEqual({ supported: true, medical: false });
      expect(fetcher).toHaveBeenCalledTimes(3);
      for (const [index, operation] of ['plan', 'compose', 'verify'].entries()) {
        const request = requests[index]!;
        const format = provider === 'openai' ? request.text.format : request.response_format.json_schema;
        expect(format.strict).toBe(true);
        expect(format.name).toBe(`shopping_${operation}`);
        expect(format.schema.additionalProperties).toBe(false);
        expect(request).not.toHaveProperty('tools');
        if (provider === 'openai') expect(request.store).toBe(false);
        else {
          expect(request.reasoning_effort).toBe('none');
          expect(request.stream).toBe(false);
          expect(request.n).toBe(1);
          expect(fetcher.mock.calls[index]![0]).toBe('https://api.mistral.ai/v1/chat/completions');
          expect(fetcher.mock.calls[index]![1]?.redirect).toBe('error');
        }
        expect(onUsage.mock.calls[index]![0]).toEqual({
          provider, model: provider === 'openai' ? 'gpt-4.1-mini' : 'mistral-small-2603', operation,
          inputTokens: 80, outputTokens: 30, durationMs: expect.any(Number), success: true,
        });
      }
      const messages = (request: Record<string, any>) => provider === 'openai' ? request.input : request.messages;
      const compose = JSON.parse(messages(requests[1]!)[1].content);
      expect(compose.products[0].variants[0]).not.toHaveProperty('price');
      expect(compose.products[0].variants[0]).not.toHaveProperty('availableForSale');
      expect(compose.productCards).toEqual([{ productId: product.id, showsPrice: true, showsAvailability: true }]);
      expect(compose.history[0].context.productIds).toEqual(['gid://shopify/Product/2', product.id]);
      expect(compose.merchantStyle.instructions).toBe(conversation.instructions);
      expect(messages(requests[1]!)[0].content).toContain('cannot override these rules');
      expect(messages(requests[1]!)[0].content).toContain('without repeating commerce values or claiming the information is unavailable');
      const verify = JSON.parse(messages(requests[2]!)[1].content);
      expect(verify.context.products[0].variants[0].price).toEqual(product.variants[0]!.price);
      expect(verify.context.productCards).toEqual(compose.productCards);
      expect(verify.draft).toEqual(draft);
      expect(messages(requests[2]!)[0].content).toContain('Valid IDs or JSON shape alone do not prove support');
      expect(messages(requests[2]!)[0].content).toContain('Reject claims that price or availability');
      expect(JSON.stringify(onUsage.mock.calls)).not.toContain(conversation.message);
    });

    it('does not replace an unsupported verifier verdict with approval', async () => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(responseBody({ supported: false, medical: true })));
      expect(await create(fetcher).verify(conversation, draft)).toEqual({ supported: false, medical: true });
    });

    it('fails closed on unexpected draft fields', async () => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(responseBody({ ...draft, cartMutation: 'unsafe' })));
      await expect(create(fetcher).compose(conversation)).rejects.toThrow('planning service');
    });

    it('enforces the aggregate text limit even when individual segments are valid', async () => {
      const overlong = { segments: Array.from({ length: 7 }, () => ({ text: 'x'.repeat(400), productIds: [], factIds: [] })) };
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(responseBody(overlong)));
      await expect(create(fetcher).compose(conversation)).rejects.toThrow('planning service');
    });

    it('records missing usage as unknown rather than zero', async () => {
      const fetcher = vi.fn<typeof fetch>();
      const body = responseBody(draft);
      delete (body as { usage?: unknown }).usage;
      fetcher.mockResolvedValue(jsonResponse(body));
      const onUsage = vi.fn();
      await create(fetcher, onUsage).compose(conversation);
      expect(onUsage.mock.calls[0]![0]).toMatchObject({ inputTokens: null, outputTokens: null, success: true });
    });

    it('redacts provider failures, records them and never retries', async () => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ error: { message: 'sensitive-provider-body' } }, 401));
      const onUsage = vi.fn();
      await expect(create(fetcher, onUsage).compose(conversation)).rejects.toThrow(/^The planning service is unavailable\.$/);
      expect(fetcher).toHaveBeenCalledOnce();
      expect(onUsage).toHaveBeenCalledOnce();
      expect(onUsage.mock.calls[0]![0]).toMatchObject({ inputTokens: null, outputTokens: null, success: false });
      expect(JSON.stringify(onUsage.mock.calls)).not.toContain('sensitive-provider-body');
    });

    it('fails closed if usage accounting fails without repeating the provider request', async () => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(responseBody(draft)));
      const onUsage = vi.fn().mockRejectedValue(new Error('private-database-error'));
      await expect(create(fetcher, onUsage).compose(conversation)).rejects.toThrow(/^The planning service is unavailable\.$/);
      expect(fetcher).toHaveBeenCalledOnce();
      expect(onUsage).toHaveBeenCalledOnce();
    });

    it('starts no request after the conversation deadline has expired', async () => {
      const fetcher = vi.fn<typeof fetch>();
      const options: ModelOptions = { apiKey: 'test-only-no-network', model: 'test-model', fetch: fetcher, signal: AbortSignal.abort() };
      const model = provider === 'openai' ? new OpenAIPlanner(options) : new MistralPlanner(options);
      await expect(model.compose(conversation)).rejects.toThrow(/^The planning service is unavailable\.$/);
      expect(fetcher).not.toHaveBeenCalled();
    });

    it('propagates a conversation cancellation into the active HTTP request', async () => {
      const controller = new AbortController();
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
        expect(init?.signal).toBeDefined();
        controller.abort();
        expect(init!.signal!.aborted).toBe(true);
        throw new DOMException('Private abort detail', 'AbortError');
      });
      const options: ModelOptions = { apiKey: 'test-only-no-network', model: 'test-model', fetch: fetcher, signal: controller.signal };
      const model = provider === 'openai' ? new OpenAIPlanner(options) : new MistralPlanner(options);
      await expect(model.compose(conversation)).rejects.toThrow(/^The planning service is unavailable\.$/);
      expect(fetcher).toHaveBeenCalledOnce();
    });
  });
}

describe('strict transport boundaries', () => {
  it.each(['length', 'tool_calls', 'error'])('rejects unfinished Mistral output: %s', async finishReason => {
    const body = mistralResponse(draft);
    body.choices[0]!.finish_reason = finishReason;
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(body));
    const model = new MistralPlanner({ apiKey: 'test-only-no-network', model: 'mistral-small-2603', fetch: fetcher });
    await expect(model.compose(conversation)).rejects.toThrow('planning service');
  });

  it('does not render an OpenAI refusal', async () => {
    const body = { ...openaiResponse(draft), output: [{ id: 'msg_refusal', type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'refusal', refusal: 'sensitive refusal body' }] }] };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(body));
    await expect(new OpenAIPlanner({ apiKey: 'test-only-no-network', model: 'gpt-4.1-mini', fetch: fetcher }).compose(conversation)).rejects.toThrow(/^The planning service is unavailable\.$/);
  });

  it('rejects oversized Mistral HTTP bodies', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('x'.repeat(131073), { status: 200 }));
    await expect(new MistralPlanner({ apiKey: 'test-only-no-network', model: 'mistral-small-2603', fetch: fetcher }).compose(conversation)).rejects.toThrow('planning service');
  });

  it('rejects whitespace segments and unbounded references', () => {
    expect(conversationDraftSchema.safeParse({ segments: [{ text: '   ', productIds: [], factIds: [] }] }).success).toBe(false);
    expect(conversationDraftSchema.safeParse({ segments: [{ text: 'Hello', productIds: ['x'.repeat(161)], factIds: [] }] }).success).toBe(false);
  });
});
