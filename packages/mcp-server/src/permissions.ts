import { CapabilitySchema } from '@wai-bridge/shared';
import { z } from 'zod';
export type Capability = z.infer<typeof CapabilitySchema>;
export function parsePermissions(value: string | undefined): Capability[] | undefined {
  return value === undefined
    ? undefined
    : CapabilitySchema.array().parse(value === '' ? [] : value.split(',').map((s) => s.trim()));
}
export function toolCapability(name: string): Capability {
  if (['whatsapp_get_outbox_status', 'whatsapp_get_send_queue', 'whatsapp_get_send_status'].includes(name))
    return 'OPERATIONS_READ';
  if (name === 'whatsapp_update_conversation_policy') return 'CONVERSATIONS_WRITE';
  if (/(?:send|outbox|prepare_message)/.test(name)) return 'SEND';
  if (/(?:create_contact|update_contact)/.test(name)) return 'CONTACTS_WRITE';
  if (/(?:contacts|contact_catalog)/.test(name)) return 'CONTACTS_READ';
  if (/(?:reference|candidates)/.test(name))
    return name.includes('list') ? 'CONVERSATIONS_READ' : 'REFERENCES_WRITE';
  if (name === 'whatsapp_confirm_conversation_read') return 'REVIEW_ACK';
  if (/(?:sync_batch|sync_pending|retry_failed)/.test(name)) return 'BATCH_SYNC';
  if (/(?:sync_dialogue|sync_status)/.test(name)) return 'DIALOGUE_SYNC';
  if (/(?:maintenance_update|backup_run)/.test(name)) return 'MAINTENANCE_WRITE';
  if (/(?:operations|maintenance_get|flow_logs|status|pending_tasks)/.test(name))
    return 'OPERATIONS_READ';
  return 'CONVERSATIONS_READ';
}
