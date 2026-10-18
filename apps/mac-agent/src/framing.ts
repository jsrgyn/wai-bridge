import type { Readable, Writable } from 'node:stream';
import { NativeRequestSchema, NativeResponseSchema, type NativeRequest, type NativeResponse } from '@wai-bridge/shared';

export const MAX_INCOMING_BYTES = 64 * 1024 * 1024;
export const MAX_OUTGOING_BYTES = 1024 * 1024;

export class NativeMessageReader {
  constructor(private readonly input: Readable, private readonly maxBytes = MAX_INCOMING_BYTES) {}

  async *readMessages(): AsyncGenerator<NativeRequest> {
    let buffered = Buffer.alloc(0);
    for await (const chunk of this.input) {
      buffered = Buffer.concat([buffered, Buffer.from(chunk as Uint8Array)]);
      while (buffered.length >= 4) {
        const length = buffered.readUInt32LE(0);
        if (length === 0 || length > this.maxBytes) throw new Error('INVALID_FRAME_LENGTH');
        if (buffered.length < length + 4) break;
        const body = buffered.subarray(4, length + 4);
        buffered = buffered.subarray(length + 4);
        let decoded: unknown;
        try {
          decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
        } catch {
          throw new Error('INVALID_FRAME_JSON');
        }
        const parsed = NativeRequestSchema.safeParse(decoded);
        if (!parsed.success) throw new Error('INVALID_REQUEST_SCHEMA');
        yield parsed.data;
      }
    }
    if (buffered.length) throw new Error('TRUNCATED_FRAME');
  }
}

export async function writeNativeMessage(output: Writable, message: NativeResponse): Promise<void> {
  const parsed = NativeResponseSchema.safeParse(message);
  if (!parsed.success) throw new Error('INVALID_RESPONSE_SCHEMA');
  const body = Buffer.from(JSON.stringify(parsed.data), 'utf8');
  if (body.length > MAX_OUTGOING_BYTES) throw new Error('RESPONSE_TOO_LARGE');
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32LE(body.length, 0);
  await new Promise<void>((resolve, reject) => {
    output.write(Buffer.concat([header, body]), (error) => error ? reject(error) : resolve());
  });
}
