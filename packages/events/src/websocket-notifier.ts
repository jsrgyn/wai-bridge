import type { EventEnvelope, Notifier } from './contracts.js';
export interface WebSocketClient {
  readonly id: string;
  send(payload: string): Promise<void>;
  isOpen(): boolean;
}
export class WebSocketNotifier implements Notifier {
  private readonly clients = new Map<string, WebSocketClient>();
  addClient(client: WebSocketClient): () => void {
    this.clients.set(client.id, client);
    return () => {
      if (this.clients.get(client.id) === client) this.clients.delete(client.id);
    };
  }
  async notify(event: EventEnvelope, signal?: AbortSignal): Promise<boolean> {
    const payload = JSON.stringify(event);
    let delivered = false;
    const results = await Promise.allSettled(
      [...this.clients.values()]
        .filter((client) => client.isOpen())
        .map(async (client) => {
          if (signal?.aborted) throw new Error('NOTIFICATION_ABORTED');
          await client.send(payload);
          delivered = true;
        }),
    );
    if (!delivered && results.some((result) => result.status === 'rejected'))
      throw new Error('WEBSOCKET_SEND_FAILED');
    return delivered;
  }
  get clientCount(): number {
    return this.clients.size;
  }
}
