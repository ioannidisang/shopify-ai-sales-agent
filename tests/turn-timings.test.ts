import { describe, expect, it } from 'vitest';
import { TurnTimings } from '../apps/server/src/turn-timings.js';
import type { Catalog, CatalogContext, Planner, PlannerInput } from '../packages/core/src/types.js';
import type { ConversationInput, ConversationModel } from '../packages/core/src/conversation.js';

const plan = { intent: 'greeting' as const, searchQuery: '', productIds: [], factIds: [], variantId: null, quantity: null };
const privateInput: PlannerInput = { message: 'private shopper message', history: [], products: [], facts: [], locale: 'el' };
const privateConversation: ConversationInput = { ...privateInput, brand: 'private tenant', instructions: '', examples: [], intent: 'greeting' };

describe('private turn duration measurements', () => {
  it('accepts only fixed operational rejection stages and retains no error objects or policy categories', () => {
    const timings = new TurnTimings(() => 0);
    for (const value of [null, undefined, 'private shopper text', 'medical', new Error('private provider body'), { stage: 'reference_check', text: 'private draft' }]) {
      timings.groundingRejected(value);
    }
    expect(timings.snapshot()).not.toHaveProperty('groundingRejectionStage');
    timings.groundingRejected('numeric_check');
    timings.groundingRejected('semantic_check');
    expect(timings.snapshot().groundingRejectionStage).toBe('numeric_check');
    const snapshot = JSON.stringify(timings.snapshot());
    for (const value of ['private', 'medical', 'body', 'draft', 'shopper', 'policy']) expect(snapshot).not.toContain(value);
  });

  it('counts completed model stages and preserves adapter receivers, inputs and results', async () => {
    let now = 0;
    const timings = new TurnTimings(() => now);
    const draft = { segments: [{ text: 'private draft', productIds: [], factIds: [] }] };
    const planner: Planner = { async plan(input) { expect(this).toBe(planner); expect(input).toBe(privateInput); now += 125; return plan; } };
    const composer: ConversationModel = {
      async compose(input) { expect(this).toBe(composer); expect(input).toBe(privateConversation); now += 250; return draft; },
      async verify(input, value) { expect(this).toBe(composer); expect(input).toBe(privateConversation); expect(value).toBe(draft); now += 175; return { supported: true, medical: false }; },
    };
    const model = timings.model({ planner, composer });
    expect(await model.planner.plan(privateInput)).toBe(plan);
    expect(await model.composer!.compose(privateConversation)).toBe(draft);
    expect(await model.composer!.verify(privateConversation, draft)).toEqual({ supported: true, medical: false });
    expect(timings.snapshot()).toEqual({ durationMs: 550, stages: {
      plan: { calls: 1, failed: 0, durationMs: 125 }, compose: { calls: 1, failed: 0, durationMs: 250 },
      verify: { calls: 1, failed: 0, durationMs: 175 }, catalogSearch: { calls: 0, failed: 0, durationMs: 0 },
      catalogComplete: { calls: 0, failed: 0, durationMs: 0 },
      catalogProducts: { calls: 0, failed: 0, durationMs: 0 }, catalogVariant: { calls: 0, failed: 0, durationMs: 0 },
    } });
    const snapshot = JSON.stringify(timings.snapshot());
    for (const value of ['private', 'shopper', 'draft', 'greeting', 'supported', 'medical']) expect(snapshot).not.toContain(value);
    expect(timings.model({ planner }).composer).toBeUndefined();
  });

  it('measures live catalog calls without changing arguments, abort signals, failures or fetching behavior', async () => {
    let now = 0;
    const timings = new TurnTimings(() => now);
    const signal = new AbortController().signal;
    const context: CatalogContext = { country: 'GR', locale: 'el', signal };
    const ids = ['private-product-id'];
    const failure = new Error('private vendor response');
    const catalog: Catalog = {
      async search(query, input) { expect(this).toBe(catalog); expect(query).toBe('private query'); expect(input).toBe(context); now += 50; return []; },
      async getProducts(input, ctx) { expect(this).toBe(catalog); expect(input).toBe(ids); expect(ctx).toBe(context); now += 75; return []; },
      async getVariant(id, ctx) { expect(this).toBe(catalog); expect(id).toBe(ids[0]); expect(ctx).toBe(context); now += 100; throw failure; },
    };
    const measured = timings.catalog(catalog);
    await measured.search('private query', context);
    await measured.getProducts(ids, context);
    await measured.getProducts(ids, context);
    await expect(measured.getVariant(ids[0]!, context)).rejects.toBe(failure);
    expect(timings.snapshot()).toMatchObject({ durationMs: 300, stages: {
      catalogSearch: { calls: 1, failed: 0, durationMs: 50 },
      catalogProducts: { calls: 2, failed: 0, durationMs: 150 },
      catalogVariant: { calls: 1, failed: 1, durationMs: 100 },
    } });
    expect(JSON.stringify(timings.snapshot())).not.toContain('private');
    // Returned diagnostic objects cannot rewrite subsequent measurements.
    timings.snapshot().stages.catalogProducts.calls = 100;
    expect(timings.snapshot().stages.catalogProducts.calls).toBe(2);
  });

  it('preserves optional combined composition and counts it once without exposing its selection or draft', async () => {
    let now = 0;
    const timings = new TurnTimings(() => now);
    const value = { plan, draft: { segments: [{ text: 'private draft', productIds: [], factIds: [] }] } };
    const composer: ConversationModel = {
      async compose() { throw new Error('Unexpected separate composition'); },
      async verify() { return { supported: true, medical: false }; },
      async selectAndCompose(input) { expect(this).toBe(composer); expect(input).toBe(privateConversation); now += 200; return value; },
    };
    const measured = timings.model({ planner: { async plan() { return plan; } }, composer });
    expect(await measured.composer!.selectAndCompose!(privateConversation)).toBe(value);
    expect(timings.snapshot().stages.compose).toEqual({ calls: 1, failed: 0, durationMs: 200 });
    expect(timings.snapshot().stages.plan.calls).toBe(0);
    expect(JSON.stringify(timings.snapshot())).not.toContain('private');
  });

  it('preserves optional complete-catalog capability, receiver and incomplete results', async () => {
    let now = 0;
    const timings = new TurnTimings(() => now);
    const context: CatalogContext = { country: 'GR', locale: 'el' };
    const catalog: Catalog = {
      async getCompleteSmallCatalog(input) { expect(this).toBe(catalog); expect(input).toBe(context); now += 120; return null; },
      async search() { return []; }, async getProducts() { return []; }, async getVariant() { return null; },
    };
    expect(await timings.catalog(catalog).getCompleteSmallCatalog!(context)).toBeNull();
    expect(timings.snapshot().stages.catalogComplete).toEqual({ calls: 1, failed: 0, durationMs: 120 });
    const { getCompleteSmallCatalog: _ignored, ...legacy } = catalog;
    expect(timings.catalog(legacy).getCompleteSmallCatalog).toBeUndefined();
  });

  it('bounds accumulated values and records failed calls without exposing their exceptions', async () => {
    let now = 0;
    const timings = new TurnTimings(() => now);
    const failure = new Error('private failed request');
    const model = timings.model({ planner: { async plan() { now += 70_000; throw failure; } } });
    for (let i = 0; i < 101; i++) await expect(model.planner.plan(privateInput)).rejects.toBe(failure);
    expect(timings.snapshot().durationMs).toBe(60_000);
    expect(timings.snapshot().stages.plan).toEqual({ calls: 100, failed: 100, durationMs: 60_000 });
    now = -1;
    expect(timings.snapshot().durationMs).toBe(0);
    now = Number.NaN;
    expect(timings.snapshot().durationMs).toBe(0);
  });
});
