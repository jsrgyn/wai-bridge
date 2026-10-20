import { it, expect } from 'vitest';
import { parsePermissions, toolCapability } from '../src/permissions.js';
it('distinguishes omitted legacy settings from empty deny-all and rejects unknown capabilities', () => {
  expect(parsePermissions(undefined)).toBeUndefined();
  expect(parsePermissions('')).toEqual([]);
  expect(parsePermissions('CONTACTS_READ,BATCH_SYNC')).toEqual(['CONTACTS_READ', 'BATCH_SYNC']);
  expect(() => parsePermissions('ADMIN')).toThrow();
  expect(toolCapability('whatsapp_update_conversation_policy')).toBe('CONVERSATIONS_WRITE');
  expect(toolCapability('whatsapp_get_outbox_status')).toBe('OPERATIONS_READ');
});
