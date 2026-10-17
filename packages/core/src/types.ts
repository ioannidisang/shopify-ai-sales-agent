import type { PronunciationConfig } from './pronunciation.js';

export type Locale = 'el' | 'en';
export type ModelProvider = 'openai' | 'mistral';
export interface Money { amount: string; currencyCode: string }
export interface ProductVariant {
  id: string; legacyId: string; title: string; price: Money;
  availableForSale: boolean; currentlyNotInStock: boolean;
  requiresComponents?: boolean;
  quantityRule?: { minimum: number; maximum: number | null; increment: number };
}
export interface Product {
  id: string; title: string; handle: string; url: string;
  imageUrl: string | null; variants: ProductVariant[];
  requiresSellingPlan?: boolean;
}
export interface ApprovedFact {
  id: string; shop: string; productId: string | null; locale: Locale;
  text: string; source: string; approvedBy: string; approvedAt: string;
  status: 'approved' | 'draft' | 'revoked'; expiresAt?: string | null;
  sourceVersion?: string; sourceHash?: string; retrievedAt?: string;
}
/** Explicit, temporary display permission for a closed-store preview, never proof of publication. */
export interface PreviewCatalogApproval {
  purpose: 'private_preview'; shop: string; version: string; approvedBy: string;
  verifiedOn: string; expiresAt: string;
  products: Array<{ id: string; handle: string; evidenceUrl: string }>;
}
export interface ShopConfig {
  shop: string; brand: string; locale: Locale; allowedCountries: string[]; enabled: boolean;
  experiment: { id: string; enabled: boolean; treatmentPercent: number; arms?: Array<{ id: ModelProvider | 'control'; weight: number }> };
  defaultProvider?: ModelProvider;
  conversation?: { version: string; instructions: string; examples: Array<{ user: string; assistant: string }>; approvedBy?: string; approvedAt?: string };
  approvedImageUrls: string[]; knowledgeVersion: string;
  previewCatalog?: PreviewCatalogApproval;
  pronunciation?: PronunciationConfig;
}
export interface CatalogContext { country: string; locale: Locale; signal?: AbortSignal }
export interface Catalog {
  /** Fresh, complete buyer-context catalog within the small-catalog bounds, or null when ineligible. Never a partial page. */
  getCompleteSmallCatalog?(context: CatalogContext): Promise<Product[] | null>;
  search(query: string, context: CatalogContext): Promise<Product[]>;
  getProducts(ids: string[], context: CatalogContext): Promise<Product[]>;
  getVariant(id: string, context: CatalogContext): Promise<{ product: Product; variant: ProductVariant } | null>;
}
export interface HistoryMessage {
  role: 'user' | 'assistant'; content: string;
  /** Display order only: never persist prices or availability as later evidence. */
  context?: { productIds: string[]; factIds: string[] };
}
export interface Plan {
  intent: 'search' | 'facts' | 'add_to_cart' | 'clarify' | 'greeting' | 'medical' | 'unsupported';
  searchQuery: string; productIds: string[]; factIds: string[];
  variantId: string | null; quantity: number | null;
}
export interface PlannerInput {
  message: string; history: HistoryMessage[]; locale: Locale; products: Product[]; facts: ApprovedFact[];
  guidance?: { instructions: string; examples: Array<{ user: string; assistant: string }> };
}
export interface Planner { plan(input: PlannerInput): Promise<Plan> }
export interface PendingAction { kind: 'add'; variantId: string; quantity: number }
export interface GroundedFact { id: string; productId: string | null; text: string; source: string }
export interface AssistantResponse {
  text: string; products: Product[]; facts: GroundedFact[]; pendingAction?: PendingAction;
  /** Internal retention signal; the HTTP boundary may omit it from the client response. */
  policy?: 'medical' | 'unavailable';
}
export interface RespondInput {
  shop: ShopConfig; facts: ApprovedFact[]; catalog: Catalog; planner: Planner;
  composer?: import('./conversation.js').ConversationModel;
  /** Selected by the trusted server transport, not by a shopper request field. */
  responseMode?: 'voice';
  /** Optional internal operational observer; receives no text, references or policy category. */
  onGroundingRejected?: (stage: import('./grounding.js').GroundingRejectionStage) => void | Promise<void>;
  signal?: AbortSignal;
  message: string; history: HistoryMessage[]; country: string; locale: Locale;
}
