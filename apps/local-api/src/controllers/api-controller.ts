import type { ApiService } from '../services/api-service.js';
import type { CaptureObservation } from '@wai-bridge/shared';
import type { MessageQuery, PageQuery } from '../types.js';
export class ApiController {
  listContactDirectory(input:unknown) { return this.service.listContactDirectory(input); }
  requestDialogueBatch(input:unknown) { return this.service.requestDialogueBatch(input); }
  dialogueBatch(id:string,input:unknown) { return this.service.dialogueBatch(id,input); }
  cancelDialogueBatch(id:string,input:unknown) { return this.service.cancelDialogueBatch(id,input); }
  resumeDialogueBatch(id:string,input:unknown) { return this.service.resumeDialogueBatch(id,input); }
  listConversationReviews(input: unknown) { return this.service.listConversationReviews(input); }
  conversationReview(id: string) { return this.service.conversationReview(id); }
  acknowledgeConversationReview(id: string, input: unknown) { return this.service.acknowledgeConversationReview(id,input); }
  linkConversationReview(id: string, input: unknown) { return this.service.linkConversationReview(id,input); }
  requestDialogueSync(input: unknown) {
    return this.service.requestDialogueSync(input);
  }
  dialogueSyncStatus(id: string) {
    return this.service.dialogueSyncStatus(id);
  }
  dialogueSyncMessages(id: string) {
    return this.service.dialogueSyncMessages(id);
  }
  pollDialogueSync(input: unknown) {
    return this.service.pollDialogueSync(input);
  }
  completeDialogueSync(input: unknown) {
    return this.service.completeDialogueSync(input);
  }
  constructor(private readonly service: ApiService) {}
  status() {
    return this.service.status();
  }
  recordExtensionState(input: {
    extensionInstanceId: string;
    status: 'CONNECTED' | 'DISCONNECTED';
    lastSeenAt: string;
  }) {
    return this.service.recordExtensionState(input);
  }
  recordObservation(input: { extensionInstanceId: string; observation: CaptureObservation }) {
    return this.service.recordObservation(input);
  }
  observation(id: string) {
    return this.service.observation(id);
  }
  contacts(q: PageQuery) {
    return this.service.contacts(q);
  }
  searchContacts(q: PageQuery & { q: string }) {
    return this.service.searchContacts(q);
  }
  conversations(q: PageQuery & { q?: string | undefined }) {
    return this.service.conversations(q);
  }
  captureCoverage(id: string) {
    return this.service.captureCoverage(id);
  }
  conversation(id: string) {
    return this.service.conversation(id);
  }
  messages(q: MessageQuery) {
    return this.service.messages(q);
  }
  recoverableMessages(consumerId: string, limit: number) {
    return this.service.recoverableMessages(consumerId, limit);
  }
  consumerMessageState(messageId: string, consumerId: string) {
    return this.service.consumerMessageState(messageId, consumerId);
  }
  claimForConsumer(input: { messageId: string; consumerId: string; leaseMs: number }) {
    return this.service.claimForConsumer(input.messageId, input.consumerId, input.leaseMs);
  }
  acknowledgeForConsumer(input: { messageId: string; consumerId: string; claimToken: string }) {
    return this.service.acknowledgeForConsumer(input.messageId, input.consumerId, input.claimToken);
  }
  failForConsumer(input: {
    messageId: string;
    consumerId: string;
    claimToken: string;
    errorCode: string;
  }) {
    return this.service.failForConsumer(
      input.messageId,
      input.consumerId,
      input.claimToken,
      input.errorCode,
    );
  }
  unread(q: PageQuery) {
    return this.service.unread(q);
  }
  recent(q: PageQuery) {
    return this.service.recent(q);
  }
  conversationMessages(id: string, q: PageQuery) {
    return this.service.conversationMessages(id, q);
  }
  media(id: string) {
    return this.service.media(id);
  }
  events(q: PageQuery, pending = false) {
    return this.service.events(q, pending);
  }
  claim(input: { messageId: string; consumerId: string }) {
    return this.service.claim(input.messageId, input.consumerId);
  }
  ack(input: { messageId: string; consumerId: string; claimToken: string }) {
    return this.service.acknowledge(input.messageId, input.consumerId, input.claimToken);
  }
  createOutbox(
    input: {
      recipientId: string;
      text: string;
      mode: 'AUTO' | 'SUPERVISED';
      explicitAuthorization: true;
    },
    key: string,
  ) {
    return this.service.createOutbox(input, key);
  }
  outbox(q: PageQuery) {
    return this.service.outbox(q);
  }
  outboxItem(id: string) {
    return this.service.outboxItem(id);
  }
  cancelOutbox(id: string) {
    return this.service.cancelOutbox(id);
  }
  recordOutboxResult(id: string, result: 'SENT' | 'UNKNOWN' | 'FAILED', evidenceRef?: string) {
    return this.service.recordOutboxResult(id, result, evidenceRef);
  }
}
