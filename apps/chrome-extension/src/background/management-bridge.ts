import { ManagementRequestSchema, NativeResponseSchema } from '@wai-bridge/shared';
import type { NativePort } from './event-publisher.js';
export class ManagementBridge {
  private port: NativePort | undefined;
  private readonly pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (reason: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  connect(port: NativePort) {
    this.port = port;
  }
  disconnect() {
    this.port = undefined;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(Error('NATIVE_DISCONNECTED'));
    }
    this.pending.clear();
  }
  request(raw: unknown, extensionInstanceId: string): Promise<unknown> {
    const input = ManagementRequestSchema.parse(raw);
    if (!this.port) return Promise.reject(Error('NATIVE_DISCONNECTED'));
    if (this.pending.size >= 10) return Promise.reject(Error('MANAGEMENT_BUSY'));
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Error('MANAGEMENT_TIMEOUT'));
      }, 35000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.port!.postMessage({ version: 1, id, type: 'MANAGEMENT', extensionInstanceId, input });
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(Error('NATIVE_DISCONNECTED'));
      }
    });
  }
  receive(raw: unknown) {
    const result = NativeResponseSchema.safeParse(raw);
    if (!result.success) return false;
    const item = this.pending.get(result.data.id);
    if (!item) return false;
    if (
      result.data.type !== 'MANAGEMENT_RESULT' &&
      result.data.type !== 'ERROR' &&
      result.data.type !== 'MANAGEMENT_FAILURE'
    )
      return false;
    clearTimeout(item.timer);
    this.pending.delete(result.data.id);
    if (result.data.type === 'ERROR' || result.data.type === 'MANAGEMENT_FAILURE')
      item.reject(Error(result.data.code));
    else item.resolve(result.data.result);
    return true;
  }
}
