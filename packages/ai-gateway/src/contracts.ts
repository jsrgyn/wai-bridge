import { z } from 'zod';

export const AIStateSchema = z.enum(['UNREAD','CLAIMED','READ','FAILED']);
export const MediaTaskSchema = z.enum(['AUDIO_TRANSCRIPTION','AUDIO_ANALYSIS','IMAGE_ANALYSIS','VIDEO_ANALYSIS','DOCUMENT_EXTRACTION']);
export const MediaInputSchema = z.object({ mediaId: z.string().min(1).max(128), mimeType: z.string().min(1).max(128), bytes: z.instanceof(Uint8Array), originalContentRef: z.string().min(1).max(256) }).strict();
export const AIResultSchema = z.object({ text: z.string().max(100000), provider: z.enum(['cloud','local','mock']), model: z.string().max(128), limitations: z.array(z.string().max(256)).max(32), sourceRef: z.string().max(256) }).strict();
export type AIState = z.infer<typeof AIStateSchema>;
export type MediaTask = z.infer<typeof MediaTaskSchema>;
export type MediaInput = z.infer<typeof MediaInputSchema>;
export type AIResult = z.infer<typeof AIResultSchema>;
export interface ClaimResult { state: 'CLAIMED'; claimToken: string; leaseUntil: string; attempts: number }
export interface ConsumerState { messageId:string;consumerId:string;state:AIState;version:number;leaseUntil:string|null;lastErrorCode:string|null }
export interface AIProcessingApi {
  getState(messageId:string,consumerId:string):Promise<ConsumerState>;
  claim(messageId: string, consumerId: string, leaseMs: number, idempotencyKey: string): Promise<ClaimResult>;
  acknowledge(messageId: string, consumerId: string, claimToken: string, idempotencyKey: string): Promise<void>;
  fail(messageId: string, consumerId: string, claimToken: string, errorCode: string, idempotencyKey: string): Promise<void>;
  recoverable(consumerId: string, limit: number): Promise<readonly { messageId: string; leaseExpired: boolean }[]>;
  pendingEvents(cursor?: string): Promise<{ items: readonly unknown[]; nextCursor: string | null }>;
}
export interface AIProviderAdapter {
  readonly provider: 'cloud'|'local'|'mock';
  readonly acceptsExternalMedia: boolean;
  analyze(task: MediaTask, input: MediaInput, signal?: AbortSignal): Promise<AIResult>;
}
export interface StructuredLogger { info(fields: Record<string, unknown>, message: string): void; warn(fields: Record<string, unknown>, message: string): void; error(fields: Record<string, unknown>, message: string): void }
export const stderrLogger: StructuredLogger = {
  info(fields,message){process.stderr.write(`${JSON.stringify({level:'info',message,...fields})}\n`);},
  warn(fields,message){process.stderr.write(`${JSON.stringify({level:'warn',message,...fields})}\n`);},
  error(fields,message){process.stderr.write(`${JSON.stringify({level:'error',message,...fields})}\n`);},
};
