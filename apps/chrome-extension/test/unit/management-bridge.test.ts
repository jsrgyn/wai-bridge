import { it, expect, vi } from 'vitest';
import { ManagementBridge } from '../../src/background/management-bridge.js';
it('validates allowlisted operations, correlates replies, rejects disconnects and bounded timeouts', async () => {
  vi.useFakeTimers();
  const bridge = new ManagementBridge();
  const frames: Array<{ id: string }> = [];
  bridge.connect({ postMessage: (frame) => frames.push(frame as { id: string }) });
  try {
    expect(() =>
      bridge.request({ operation: 'FETCH', url: 'https://evil.test' }, crypto.randomUUID()),
    ).toThrow();
    const response = bridge.request({ operation: 'SUMMARY' }, crypto.randomUUID());
    expect(
      bridge.receive({
        version: 1,
        type: 'MANAGEMENT_RESULT',
        id: crypto.randomUUID(),
        result: { other: true },
      }),
    ).toBe(false);
    expect(
      bridge.receive({
        version: 1,
        type: 'MANAGEMENT_RESULT',
        id: frames[0]!.id,
        result: { coverageComplete: false },
      }),
    ).toBe(true);
    expect(await response).toEqual({ coverageComplete: false });
    const pending = bridge.request({ operation: 'SUMMARY' }, crypto.randomUUID());
    const rejected = expect(pending).rejects.toThrow('NATIVE_DISCONNECTED');
    bridge.disconnect();
    await rejected;
    bridge.connect({ postMessage: () => {} });
    const timeout = expect(
      bridge.request({ operation: 'SUMMARY' }, crypto.randomUUID()),
    ).rejects.toThrow('MANAGEMENT_TIMEOUT');
    await vi.advanceTimersByTimeAsync(35001);
    await timeout;
  } finally {
    bridge.disconnect();
    vi.useRealTimers();
  }
});
