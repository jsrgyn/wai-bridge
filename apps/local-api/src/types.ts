export interface PageQuery {
  readonly cursor?: string | undefined;
  readonly limit: number;
}
export interface MessageQuery extends PageQuery {
  readonly conversationId?: string | undefined;
  readonly aiState?: 'UNREAD' | 'CLAIMED' | 'READ' | 'FAILED' | undefined;
  readonly direction?: 'INBOUND' | 'OUTBOUND' | undefined;
  readonly captureStatus?: 'DETECTED' | 'CAPTURED' | 'PENDING' | 'FAILED' | undefined;
  readonly consumerId?: string | undefined;
}
