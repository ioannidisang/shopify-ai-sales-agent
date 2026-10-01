import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import type { z } from 'zod';
import { conversationDraftSchema, verificationSchema, type ConversationDraft, type ConversationInput, type ConversationModel, type ModelOptions, type ModelUsage, type Verification } from './conversation.js';
import { composerInstructions, conversationContext, measuredCall, PlannerError, plannerContext, plannerInstructions, planSchema, verifierInstructions } from './model-protocol.js';
import type { Planner, PlannerInput, Plan } from './types.js';

export { planSchema, PlannerError } from './model-protocol.js';

export class OpenAIPlanner implements Planner, ConversationModel {
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly onUsage: ModelOptions['onUsage'];
  private readonly signal?: AbortSignal;
  constructor(options: ModelOptions) {
    this.model = options.model;
    this.onUsage = options.onUsage;
    this.signal = options.signal;
    this.client = new OpenAI({ apiKey: options.apiKey, timeout: options.timeoutMs ?? 6000, maxRetries: 0, fetch: options.fetch });
  }

  private request<T>(operation: ModelUsage['operation'], instructions: string, context: unknown, schema: z.ZodType<T>, maxTokens: number): Promise<T> {
    return measuredCall({ provider: 'openai', model: this.model, operation }, this.onUsage, async report => {
      this.signal?.throwIfAborted();
      const result = await this.client.responses.parse({
        model: this.model, store: false, max_output_tokens: maxTokens,
        input: [{ role: 'system', content: instructions }, { role: 'user', content: JSON.stringify(context) }],
        text: { format: zodTextFormat(schema, `shopping_${operation}`) },
      }, { signal: this.signal });
      report(result.usage?.input_tokens, result.usage?.output_tokens);
      if (result.status !== 'completed' || !result.output_parsed) throw new PlannerError();
      return schema.parse(result.output_parsed);
    });
  }

  plan(input: PlannerInput): Promise<Plan> {
    return this.request('plan', plannerInstructions, plannerContext(input), planSchema, 1000);
  }

  compose(input: ConversationInput): Promise<ConversationDraft> {
    return this.request('compose', composerInstructions, conversationContext(input), conversationDraftSchema, 1600);
  }

  verify(input: ConversationInput, draft: ConversationDraft): Promise<Verification> {
    return this.request('verify', verifierInstructions, { context: conversationContext(input, true), draft }, verificationSchema, 100);
  }
}
