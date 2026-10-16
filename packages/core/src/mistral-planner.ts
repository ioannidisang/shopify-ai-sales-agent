import { z } from 'zod';
import { conversationDraftSchema, verificationSchema, type ConversationDraft, type ConversationInput, type ConversationModel, type ConversationSelection, type ModelOptions, type ModelUsage, type Verification } from './conversation.js';
import { composerInstructions, conversationContext, conversationSelectionSchema, measuredCall, PlannerError, plannerContext, plannerInstructions, planSchema, selectionComposerInstructions, verifierInstructions } from './model-protocol.js';
import { compactSelectionReferences, selectionReferenceInstructions } from './selection-references.js';
import type { Planner, PlannerInput, Plan } from './types.js';

const completionSchema = z.object({
  choices: z.array(z.object({
    finish_reason: z.string(),
    message: z.object({ role: z.literal('assistant'), content: z.string(), tool_calls: z.array(z.unknown()).nullish() }),
  })).min(1).max(1),
  usage: z.object({ prompt_tokens: z.unknown().optional(), completion_tokens: z.unknown().optional() }).optional(),
});

/** Fixed vendor endpoint: credentials can never be redirected by store or model data. */
export class MistralPlanner implements Planner, ConversationModel {
  private readonly fetcher: typeof fetch;
  private readonly model: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly onUsage: ModelOptions['onUsage'];
  private readonly signal?: AbortSignal;
  constructor(options: ModelOptions) {
    this.fetcher = options.fetch ?? fetch;
    this.model = options.model;
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? 6000;
    this.onUsage = options.onUsage;
    this.signal = options.signal;
  }

  private request<T>(operation: ModelUsage['operation'], instructions: string, context: unknown, schema: z.ZodType<T>, maxTokens: number, decode: (value: T) => T = value => value): Promise<T> {
    return measuredCall({ provider: 'mistral', model: this.model, operation }, this.onUsage, async report => {
      this.signal?.throwIfAborted();
      const response = await this.fetcher('https://api.mistral.ai/v1/chat/completions', {
        method: 'POST', redirect: 'error', signal: this.signal ? AbortSignal.any([this.signal, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs),
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({
          model: this.model, stream: false, n: 1, reasoning_effort: 'none', max_tokens: maxTokens,
          messages: [{ role: 'system', content: instructions }, { role: 'user', content: JSON.stringify(context) }],
          response_format: { type: 'json_schema', json_schema: { name: `shopping_${operation}`, strict: true, schema: z.toJSONSchema(schema) } },
        }),
      });
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new PlannerError();
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 131072) { await reader.cancel(); throw new PlannerError(); }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      const payload = completionSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      report(payload.usage?.prompt_tokens, payload.usage?.completion_tokens);
      const choice = payload.choices[0]!;
      if (choice.finish_reason !== 'stop' || choice.message.tool_calls?.length) throw new PlannerError();
      return decode(schema.parse(JSON.parse(choice.message.content)));
    });
  }

  plan(input: PlannerInput): Promise<Plan> {
    return this.request('plan', plannerInstructions, plannerContext(input), planSchema, 1000);
  }

  compose(input: ConversationInput): Promise<ConversationDraft> {
    return this.request('compose', composerInstructions, conversationContext(input), conversationDraftSchema, 1600);
  }

  async selectAndCompose(input: ConversationInput): Promise<ConversationSelection> {
    const { context, decode } = compactSelectionReferences(input);
    return this.request('compose', `${selectionComposerInstructions}\n${selectionReferenceInstructions}`, context, conversationSelectionSchema, 1600, decode);
  }

  verify(input: ConversationInput, draft: ConversationDraft): Promise<Verification> {
    return this.request('verify', verifierInstructions, { context: conversationContext(input, true), draft }, verificationSchema, 100);
  }
}
