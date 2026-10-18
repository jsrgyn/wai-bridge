/** A reloaded MV3 extension cannot revive an old content script's runtime. */
export class ContentRuntimeClient {
  private invalidated = false;
  private readonly originalId: string | undefined;
  constructor(
    private readonly getRuntime: () => {
      readonly id?: string | undefined;
      sendMessage(message: unknown): unknown;
    },
    private readonly onInvalidated: () => void,
  ) {
    try {
      this.originalId = getRuntime().id;
    } catch {
      this.originalId = undefined;
    }
  }
  get extensionId(): string | undefined {
    return this.originalId;
  }
  isValid(): boolean {
    if (this.invalidated) return false;
    try {
      const runtime = this.getRuntime();
      if (this.originalId && runtime.id !== this.originalId) {
        this.invalidate();
        return false;
      }
      return true;
    } catch {
      this.invalidate();
      return false;
    }
  }
  async request(message: unknown): Promise<unknown> {
    if (!this.isValid()) throw new Error('EXTENSION_CONTEXT_INVALIDATED');
    try {
      // await inside try catches both a synchronous throw and a rejected Promise.
      const reply = await this.getRuntime().sendMessage(message);
      if (!this.isValid()) throw new Error('EXTENSION_CONTEXT_INVALIDATED');
      return reply;
    } catch (error) {
      this.handleFailure(error);
      if (this.invalidated) throw new Error('EXTENSION_CONTEXT_INVALIDATED', { cause: error });
      throw error;
    }
  }
  notify(message: unknown): void {
    void this.request(message).catch(() => undefined);
  }
  handleFailure(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    if (/extension context invalidated|EXTENSION_CONTEXT_INVALIDATED/i.test(message))
      this.invalidate();
    else this.isValid();
  }
  private invalidate(): void {
    if (this.invalidated) return;
    this.invalidated = true;
    this.onInvalidated();
  }
}
