/** Transport interfaces keep voice/avatar presentation separate from commerce authority. */
export interface ConversationTransport {
  readonly kind: 'text' | 'realtime';
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  onInput(listener: (text: string) => Promise<void>): () => void;
  present(response: { text: string; productIds: string[]; pendingActionId?: string }): Promise<void>;
}
export interface AvatarAdapter {
  mount(element: HTMLElement): Promise<void>;
  setState(state: 'idle' | 'listening' | 'thinking' | 'speaking'): void;
  /** Only audio derived from server-approved speech may be played. */
  playApprovedAudio(audio: MediaStream): Promise<void>;
  destroy(): Promise<void>;
}
