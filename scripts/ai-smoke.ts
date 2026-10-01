import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readEnv } from '../apps/server/src/config.js';
import { OpenAIPlanner } from '../packages/core/src/openai-planner.js';
import { MistralPlanner } from '../packages/core/src/mistral-planner.js';
import { composeGrounded } from '../packages/core/src/grounding.js';
import { planSchema } from '../packages/core/src/model-protocol.js';
import type { ConversationInput, ModelUsage } from '../packages/core/src/conversation.js';

type Provider = 'openai' | 'mistral';
type SmokeEnvironment = Pick<ReturnType<typeof readEnv>, 'openaiKey' | 'openaiModel' | 'mistralKey' | 'mistralModel'>;
export interface SmokeOptions {
  env?: SmokeEnvironment; fetch?: typeof fetch; signal?: AbortSignal;
}
export interface SmokeResult {
  provider: Provider; model: string; pass: true; durationMs: number;
  inputTokens: number | null; outputTokens: number | null;
  calls: Array<Pick<ModelUsage, 'operation' | 'inputTokens' | 'outputTokens' | 'durationMs' | 'success'>>;
}

const errors = {
  usage: 'Usage: pnpm ai:smoke <openai|mistral>. Choose exactly one provider.',
  configuration: 'AI smoke test requires a valid API key and model for the selected provider. Check local environment configuration.',
  failed: 'AI smoke test failed its provider or response contract checks. No response contents or provider error details are logged.',
} as const;
export class SmokeError extends Error {
  constructor(code: keyof typeof errors) { super(errors[code]); this.name = 'SmokeError'; }
}

const sumTokens = (calls: ModelUsage[], field: 'inputTokens' | 'outputTokens'): number | null =>
  calls.every(call => call[field] !== null) ? calls.reduce((sum, call) => sum + call[field]!, 0) : null;

/** An explicit paid API readiness check, not a language-quality or sales benchmark. */
export async function runSmoke(provider: string, options: SmokeOptions = {}): Promise<SmokeResult> {
  if (provider !== 'openai' && provider !== 'mistral') throw new SmokeError('usage');
  let env: SmokeEnvironment;
  try { env = options.env ?? readEnv(); }
  catch { throw new SmokeError('configuration'); }
  const apiKey = provider === 'openai' ? env.openaiKey : env.mistralKey;
  const model = provider === 'openai' ? env.openaiModel : env.mistralModel;
  // Reject URLs or accidentally pasted secrets in the only configuration value printed by this helper.
  const modelPattern = provider === 'openai' ? /^gpt-[a-z0-9][a-z0-9._-]{0,94}$/ : /^mistral-[a-z0-9][a-z0-9._-]{0,90}$/;
  if (!apiKey?.trim() || !model || !modelPattern.test(model)) throw new SmokeError('configuration');
  const started = Date.now();
  const calls: ModelUsage[] = [];
  const deadline = AbortSignal.timeout(25_000);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  const adapterOptions = { apiKey, model, fetch: options.fetch, signal, timeoutMs: 6000,
    onUsage: (usage: ModelUsage) => { calls.push(usage); } };
  try {
    signal.throwIfAborted();
    const adapter = provider === 'openai' ? new OpenAIPlanner(adapterOptions) : new MistralPlanner(adapterOptions);
    const input: ConversationInput = {
      message: 'Γεια σου!', history: [], locale: 'el', brand: 'Δοκιμή ετοιμότητας',
      instructions: 'Απάντησε σύντομα και φυσικά στα Ελληνικά. Κάνε μία απλή ερώτηση για το προϊόν που αναζητά ο επισκέπτης.',
      examples: [], products: [], facts: [], intent: 'greeting',
    };
    const plan = planSchema.parse(await adapter.plan({
      message: input.message, history: [], locale: input.locale, products: [], facts: [],
      guidance: { instructions: input.instructions, examples: [] },
    }));
    if (plan.intent !== 'greeting' || plan.productIds.length || plan.factIds.length || plan.variantId !== null || plan.quantity !== null) throw new SmokeError('failed');
    signal.throwIfAborted();
    const reply = await composeGrounded(adapter, input);
    // This only confirms basic requested-script compliance, not Greek fluency or naturalness.
    const greekLetters = reply.match(/\p{Script=Greek}/gu)?.length ?? 0;
    const letters = reply.match(/\p{L}/gu)?.length ?? 0;
    if (greekLetters < 4 || !letters || greekLetters / letters < 0.6) throw new SmokeError('failed');
    return {
      provider, model, pass: true, durationMs: Math.max(0, Date.now() - started),
      inputTokens: sumTokens(calls, 'inputTokens'), outputTokens: sumTokens(calls, 'outputTokens'),
      calls: calls.map(({ operation, inputTokens, outputTokens, durationMs, success }) => ({ operation, inputTokens, outputTokens, durationMs, success })),
    };
  } catch { throw new SmokeError('failed'); }
}

export async function runSmokeCommand(args: string[], options: SmokeOptions & { output?: (value: string) => void } = {}): Promise<SmokeResult> {
  if (args.length !== 1) throw new SmokeError('usage');
  const result = await runSmoke(args[0]!, options);
  (options.output ?? console.log)(JSON.stringify(result));
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await runSmokeCommand(process.argv.slice(2)); }
  catch (error) {
    console.error(error instanceof SmokeError ? error.message : errors.failed);
    process.exitCode = 1;
  }
}
