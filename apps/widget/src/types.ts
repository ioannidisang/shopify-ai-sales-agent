export interface Variant {
  id: string;
  legacyId: string;
  title: string;
  price: { amount: string; currencyCode: string };
  availableForSale: boolean;
  currentlyNotInStock: boolean;
  requiresComponents?: boolean;
  requiresSellingPlan?: boolean;
  quantityRule?: { minimum: number; maximum: number | null; increment: number };
}

export interface Product {
  id: string;
  title: string;
  handle: string;
  url: string;
  imageUrl: string | null;
  variants: Variant[];
  requiresSellingPlan?: boolean;
}

export interface Bootstrap {
  token: string;
  conversationId: string;
  assignment: 'assistant' | 'openai' | 'mistral' | 'control' | 'untracked';
  experimentId: string;
  brand: string | { name: string };
  enabled: boolean;
  knowledgeVersion: string;
}

export interface ChatResponse {
  text: string;
  products: Product[];
  facts: { id: string; text: string; source: string }[];
  pendingAction?: { kind: 'add'; variantId: string; quantity: number };
}

export interface ShopifyBrowser {
  routes?: { root: string };
  customerPrivacy?: { analyticsProcessingAllowed(): boolean };
  loadFeatures?: (features: { name: string; version: string }[], callback: (error?: unknown) => void) => void;
  analytics?: { publish(name: string, data: Record<string, unknown>): unknown };
}

declare global {
  interface Window {
    Shopify?: ShopifyBrowser;
    privacyBanner?: { showPreferences(): void | Promise<void> };
  }
}

export type AnalyticsEventName = 'assistant_open' | 'conversation_started' | 'recommendation_shown' | 'product_clicked' | 'add_to_cart' | 'cart_updated' | 'experiment_exposure';
