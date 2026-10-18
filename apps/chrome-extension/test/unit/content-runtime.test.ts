import { expect, it, vi } from 'vitest';
import { ContentRuntimeClient } from '../../src/messaging/content-runtime.js';

it.each(['sync', 'async'] as const)(
  'contains %s invalidation and shuts down only once',
  async (mode) => {
    const invalidated = vi.fn();
    const sendMessage = vi.fn(() => {
      if (mode === 'sync') throw new Error('Extension context invalidated.');
      return Promise.reject(new Error('Extension context invalidated.'));
    });
    const client = new ContentRuntimeClient(
      () => ({ id: 'synthetic-extension', sendMessage }),
      invalidated,
    );
    await expect(client.request({ kind: 'SYNTHETIC' })).rejects.toThrow(
      'EXTENSION_CONTEXT_INVALIDATED',
    );
    await expect(client.request({ kind: 'SYNTHETIC' })).rejects.toThrow(
      'EXTENSION_CONTEXT_INVALIDATED',
    );
    expect(client.isValid()).toBe(false);
    expect(invalidated).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  },
);
it('detects an absent runtime id without invoking the dead API', async () => {
  const invalidated = vi.fn();
  let id: string | undefined = 'synthetic-extension';
  const sendMessage = vi.fn();
  const client = new ContentRuntimeClient(() => ({ id, sendMessage }), invalidated);
  id = undefined;
  await expect(client.request({})).rejects.toThrow('EXTENSION_CONTEXT_INVALIDATED');
  expect(sendMessage).not.toHaveBeenCalled();
  expect(invalidated).toHaveBeenCalledTimes(1);
});
it('handles a throwing runtime getter without leaking a synchronous exception', async () => {
  let unavailable = false;
  const invalidated = vi.fn();
  const client = new ContentRuntimeClient(() => {
    if (unavailable) throw new Error('Extension context invalidated.');
    return { id: 'synthetic', sendMessage: () => ({ ok: true }) };
  }, invalidated);
  unavailable = true;
  await expect(client.request({})).rejects.toThrow('EXTENSION_CONTEXT_INVALIDATED');
  expect(invalidated).toHaveBeenCalledTimes(1);
});
it('keeps transient delivery failures recoverable and consumes fire-and-forget failures', async () => {
  const invalidated = vi.fn();
  const sendMessage = vi
    .fn()
    .mockRejectedValueOnce(new Error('Receiving end does not exist.'))
    .mockResolvedValue({ ok: true });
  const client = new ContentRuntimeClient(() => ({ id: 'synthetic', sendMessage }), invalidated);
  await expect(client.request({})).rejects.toThrow('Receiving end');
  expect(client.isValid()).toBe(true);
  expect(invalidated).not.toHaveBeenCalled();
  await expect(client.request({})).resolves.toEqual({ ok: true });
  sendMessage.mockRejectedValue(new Error('Extension context invalidated.'));
  client.notify({});
  await Promise.resolve();
  await Promise.resolve();
  expect(invalidated).toHaveBeenCalledTimes(1);
});

it('rejects a delayed acknowledgement if its runtime was invalidated while awaiting it', async () => {
  let id: string | undefined = 'synthetic';
  let finish: (value: unknown) => void = () => {};
  const invalidated = vi.fn();
  const client = new ContentRuntimeClient(
    () => ({
      id,
      sendMessage: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    }),
    invalidated,
  );
  const pending = client.request({ kind: 'SYNTHETIC_PROGRESS' });
  id = undefined;
  finish({ ok: true });
  await expect(pending).rejects.toThrow('EXTENSION_CONTEXT_INVALIDATED');
  expect(invalidated).toHaveBeenCalledTimes(1);
});
