export interface RetryPolicy {
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}
export class RetryService {
  constructor(private readonly policy: RetryPolicy = { baseDelayMs: 1000, maxDelayMs: 300_000 }) {}
  nextAttemptAt(now: string, attempt: number): string {
    const exponent = Math.max(0, Math.min(30, attempt - 1));
    const delay = Math.min(this.policy.maxDelayMs, this.policy.baseDelayMs * 2 ** exponent);
    return new Date(Date.parse(now) + delay).toISOString();
  }
}
