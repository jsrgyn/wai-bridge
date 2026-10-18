import { randomUUID } from 'node:crypto';
import type { AIProcessingApi, ClaimResult } from './contracts.js';
export class AIMessageStateService {
  constructor(private readonly api: AIProcessingApi, readonly consumerId: string, private readonly leaseMs = 60_000) {
    if (!consumerId.trim() || consumerId.length > 128) throw new Error('Invalid AI consumer ID');
    if (!Number.isInteger(leaseMs) || leaseMs < 1000 || leaseMs > 86400000) throw new Error('Invalid AI lease duration');
  }
  claim(messageId: string): Promise<ClaimResult> { return this.api.claim(messageId,this.consumerId,this.leaseMs,randomUUID()); }
  get(messageId:string){return this.api.getState(messageId,this.consumerId);}
  acknowledge(messageId: string, claimToken: string): Promise<void> { return this.api.acknowledge(messageId,this.consumerId,claimToken,randomUUID()); }
  fail(messageId: string, claimToken: string, code: string): Promise<void> { return this.api.fail(messageId,this.consumerId,claimToken,code,randomUUID()); }
  recoverable(limit=50) { return this.api.recoverable(this.consumerId,limit); }
}
