import { z } from 'zod';

export function normalizeProfilePhone(value: string): string | null {
  if (!/^\+[\d ()-]+$/.test(value.trim())) return null;
  const phone = value.trim().replace(/[ ()-]/g, '');
  return /^\+[1-9]\d{7,14}$/.test(phone) ? phone : null;
}

const base = {
  version: z.literal(1),
  accountId: z.uuid(),
  contextId: z.uuid(),
  confirmedAt: z.iso.datetime().refine((value) => value.endsWith('Z')),
};
export const ConversationIdentitySchema = z.discriminatedUnion('type', [
  z
    .object({
      ...base,
      type: z.literal('UI_CONTEXT'),
      source: z.literal('VISIBLE_UI'),
      conversationKey: z.uuid(),
      conversationKind: z.enum(['INDIVIDUAL', 'GROUP', 'UNKNOWN']),
      phone: z
        .string()
        .regex(/^\+[1-9]\d{7,14}$/)
        .optional(),
    })
    .strict()
    .refine((value) => !value.phone || value.conversationKind === 'INDIVIDUAL', {
      message: 'Phone requires an individual conversation',
    }),

  z
    .object({
      ...base,
      type: z.literal('PHONE'),
      source: z.literal('PROFILE_PHONE'),
      phone: z.string().regex(/^\+[1-9]\d{7,14}$/),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal('GROUP_LOCAL'),
      source: z.literal('USER_GROUP'),
      groupId: z.uuid(),
      groupLabel: z.string().trim().min(1).max(256),
    })
    .strict(),
]);
export type ConversationIdentity = z.infer<typeof ConversationIdentitySchema>;
