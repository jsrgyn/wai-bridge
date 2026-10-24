import { describe, expect, it } from 'vitest';
import { managementRoute } from '../src/operations.js';

const id = '11111111-1111-4111-8111-111111111111';
describe('send queue management routes', () => {
  it.each([
    [{ operation: 'SEND_QUEUE' }, { path: '/api/extension/outbox/queue', method: 'GET' }],
    [
      { operation: 'SEND_STATUS', id },
      { path: `/api/extension/outbox/${id}`, method: 'GET' },
    ],
    [
      { operation: 'SEND_SETTINGS_GET' },
      { path: '/api/extension/send-settings', method: 'GET' },
    ],
    [
      { operation: 'SEND_SETTINGS_UPDATE', input: { autoCountdownMs: 0 } },
      { path: '/api/extension/send-settings', method: 'PATCH', body: { autoCountdownMs: 0 } },
    ],
    [
      { operation: 'SEND_CANCEL', id },
      { path: `/api/extension/outbox/${id}/cancel`, method: 'POST', body: {} },
    ],
  ])('maps %j', (request, expected) => {
    expect(managementRoute(request)).toEqual(expected);
  });
  it('rejects non-UUID ids and out-of-range settings', () => {
    expect(() => managementRoute({ operation: 'SEND_STATUS', id: 'x' })).toThrow();
    expect(() => managementRoute({ operation: 'SEND_CANCEL', id: 'x' })).toThrow();
    expect(() =>
      managementRoute({ operation: 'SEND_SETTINGS_UPDATE', input: { autoCountdownMs: 999999 } }),
    ).toThrow();
  });
});
