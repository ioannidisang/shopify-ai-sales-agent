import type { Catalog, Planner } from '../../../packages/core/src/types.js';
import type { ConversationModel } from '../../../packages/core/src/conversation.js';

const stages = ['plan', 'compose', 'verify', 'catalogComplete', 'catalogSearch', 'catalogProducts', 'catalogVariant'] as const;
type Stage = typeof stages[number];
type Measurement = { calls: number; failed: number; durationMs: number };
type Model = { planner: Planner; composer?: ConversationModel };
const duration = (value: number) => Number.isFinite(value) ? Math.max(0, Math.min(60_000, Math.round(value))) : 0;

/** Operational durations only: no messages, evidence, tenant or conversation identifiers. */
export class TurnTimings {
  private readonly started: number;
  private readonly measurements: Record<Stage, Measurement> = {
    plan: { calls: 0, failed: 0, durationMs: 0 },
    compose: { calls: 0, failed: 0, durationMs: 0 },
    verify: { calls: 0, failed: 0, durationMs: 0 },
    catalogComplete: { calls: 0, failed: 0, durationMs: 0 },
    catalogSearch: { calls: 0, failed: 0, durationMs: 0 },
    catalogProducts: { calls: 0, failed: 0, durationMs: 0 },
    catalogVariant: { calls: 0, failed: 0, durationMs: 0 },
  };

  constructor(private readonly now: () => number = () => performance.now()) { this.started = this.now(); }

  private async measure<T>(stage: Stage, work: () => Promise<T>): Promise<T> {
    const started = this.now();
    const measured = this.measurements[stage];
    measured.calls = Math.min(100, measured.calls + 1);
    try { return await work(); }
    catch (error) { measured.failed = Math.min(100, measured.failed + 1); throw error; }
    finally { measured.durationMs = duration(measured.durationMs + duration(this.now() - started)); }
  }

  catalog(catalog: Catalog): Catalog {
    return {
      ...(catalog.getCompleteSmallCatalog ? { getCompleteSmallCatalog: (context: Parameters<NonNullable<Catalog['getCompleteSmallCatalog']>>[0]) =>
        this.measure('catalogComplete', () => catalog.getCompleteSmallCatalog!(context)) } : {}),
      search: (query, context) => this.measure('catalogSearch', () => catalog.search(query, context)),
      getProducts: (ids, context) => this.measure('catalogProducts', () => catalog.getProducts(ids, context)),
      getVariant: (id, context) => this.measure('catalogVariant', () => catalog.getVariant(id, context)),
    };
  }

  model(model: Model): Model {
    const composer = model.composer;
    return {
      planner: { plan: input => this.measure('plan', () => model.planner.plan(input)) },
      ...(composer ? { composer: {
        compose: input => this.measure('compose', () => composer.compose(input)),
        ...(composer.selectAndCompose ? { selectAndCompose: input => this.measure('compose', () => composer.selectAndCompose!(input)) } : {}),
        verify: (input, draft) => this.measure('verify', () => composer.verify(input, draft)),
      } } : {}),
    };
  }

  snapshot() {
    // Copy only fixed numeric fields; never spread a vendor result or an error.
    const values = Object.fromEntries(stages.map(stage => [stage, { ...this.measurements[stage] }])) as Record<Stage, Measurement>;
    return { durationMs: duration(this.now() - this.started), stages: values };
  }
}
