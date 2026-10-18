import { systemClock, type Clock } from './contracts.js';
import { EventDispatcher } from './dispatcher.js';
export class EventWorker {
  private stopped = false;
  constructor(
    private readonly dispatcher: EventDispatcher,
    private readonly workerId: string,
    private readonly clock: Clock = systemClock,
    private readonly pollIntervalMs = 500,
  ) {}
  stop(): void {
    this.stopped = true;
  }
  async runOnce(): Promise<'IDLE' | 'DELIVERED' | 'RETRY' | 'DEAD_LETTER'> {
    return this.dispatcher.dispatchOne(this.workerId);
  }
  async run(): Promise<void> {
    this.stopped = false;
    while (!this.stopped) {
      const result = await this.runOnce();
      if (result === 'IDLE') await this.clock.sleep(this.pollIntervalMs);
    }
  }
}
