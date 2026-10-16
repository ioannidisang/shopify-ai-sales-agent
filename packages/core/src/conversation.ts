import { z } from 'zod';
import type { GroundedFact, HistoryMessage, Locale, PendingAction, Plan, Product } from './types.js';

export interface ConversationInput {
  message: string; history: HistoryMessage[]; locale: Locale; brand: string;
  instructions: string; examples: Array<{ user: string; assistant: string }>;
  products: Product[]; facts: GroundedFact[]; intent: string; pendingAction?: PendingAction;
}
export interface ConversationDraft {
  segments: Array<{ text: string; productIds: string[]; factIds: string[] }>;
}
export interface ConversationSelection { plan: Plan; draft: ConversationDraft | null }
export interface Verification { supported: boolean; medical: boolean }
export interface ConversationModel {
  compose(input: ConversationInput): Promise<ConversationDraft>;
  /** Select from live candidates and draft once; final selected evidence is independently verified afterward. */
  selectAndCompose?(input: ConversationInput): Promise<ConversationSelection>;
  verify(input: ConversationInput, draft: ConversationDraft): Promise<Verification>;
}
export interface ModelUsage {
  provider: 'openai' | 'mistral'; model: string; operation: 'plan' | 'compose' | 'verify';
  inputTokens: number | null; outputTokens: number | null; durationMs: number; success: boolean;
}
export interface ModelOptions {
  apiKey: string; model: string; timeoutMs?: number; fetch?: typeof fetch; signal?: AbortSignal;
  onUsage?: (usage: ModelUsage) => void | Promise<void>;
}

export const conversationDraftSchema = z.object({
  segments: z.array(z.object({
    text: z.string().min(1).max(400).regex(/\S/u),
    productIds: z.array(z.string().min(1).max(160)).max(4),
    factIds: z.array(z.string().min(1).max(100)).max(8),
  }).strict()).min(1).max(8),
}).strict().refine(draft => draft.segments.reduce((total, segment) => total + segment.text.length, 0) <= 2400,
  { message: 'Conversation draft exceeds the text limit' });

export const verificationSchema = z.object({ supported: z.boolean(), medical: z.boolean() }).strict();
