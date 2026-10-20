import { z } from 'zod';
const timeZone = z
  .string()
  .min(1)
  .max(100)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }, 'Invalid IANA time zone');
export const ContactDirectoryQuerySchema = z
  .object({
    accountId: z.uuid().optional(),
    query: z.string().trim().min(1).max(256).optional(),
    match: z.enum(['EXACT', 'STARTS_WITH', 'CONTAINS']).default('CONTAINS'),
    registeredPeriod: z.enum(['TODAY', 'YESTERDAY']).optional(),
    registeredOn: z.iso.date().optional(),
    registeredFrom: z.iso.date().optional(),
    registeredTo: z.iso.date().optional(),
    timeZone: timeZone.default('America/Sao_Paulo'),
    cursor: z.uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (
      (v.registeredPeriod && (v.registeredOn || v.registeredFrom || v.registeredTo)) ||
      (v.registeredOn && (v.registeredFrom || v.registeredTo)) ||
      (v.registeredFrom && v.registeredTo && v.registeredFrom > v.registeredTo)
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Conflicting registration date filters',
        path: ['registeredOn'],
      });
  });
export const ContactDirectoryItemSchema = z
  .object({
    id: z.uuid(),
    accountScope: z.string(),
    name: z.string().nullable(),
    nickname: z.string().nullable(),
    fullName: z.string().nullable(),
    phone: z.string().nullable(),
    registeredAt: z.iso.datetime(),
  })
  .strict();
export const ContactDirectoryPageSchema = z
  .object({
    items: ContactDirectoryItemSchema.array().max(100),
    total: z.number().int().nonnegative(),
    nextCursor: z.uuid().nullable(),
    source: z.literal('SQLITE_ONLY'),
    timeZone: z.string(),
    registeredFromUtc: z.iso.datetime().nullable(),
    registeredBeforeUtc: z.iso.datetime().nullable(),
  })
  .strict();
export type ContactDirectoryQuery = z.infer<typeof ContactDirectoryQuerySchema>;
