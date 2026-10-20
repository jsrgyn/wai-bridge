import type Database from 'better-sqlite3';
import {
  ContactDirectoryPageSchema,
  ContactDirectoryQuerySchema,
  type ContactDirectoryQuery,
} from '@wai-bridge/shared';

export const normalizeContactName = (value: string) =>
  value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase('pt-BR')
    .trim()
    .replace(/\s+/gu, ' ');
const addDay = (date: string, days: number) => {
  const value = new Date(date + 'T12:00:00.000Z');
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
};
export function registrationBounds(input: ContactDirectoryQuery, now: Date) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: input.timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const localDate = (instant: number) => {
    const parts = formatter.formatToParts(new Date(instant));
    const part = (type: string) => parts.find((p) => p.type === type)!.value;
    return `${part('year').padStart(4, '0')}-${part('month')}-${part('day')}`;
  };
  // Find the first instant of the calendar day, including DST midnight gaps/folds.
  const start = (date: string) => {
    const noon = Date.parse(date + 'T12:00:00.000Z');
    let lo = noon - 3 * 86400000,
      hi = noon + 3 * 86400000;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (localDate(mid) < date) lo = mid + 1;
      else hi = mid;
    }
    return new Date(lo).toISOString();
  };
  let from = input.registeredOn ?? input.registeredFrom,
    through = input.registeredOn ?? input.registeredTo;
  if (input.registeredPeriod) {
    from = addDay(localDate(now.getTime()), input.registeredPeriod === 'YESTERDAY' ? -1 : 0);
    through = from;
  }
  return { from: from ? start(from) : null, before: through ? start(addDay(through, 1)) : null };
}
export class ContactDirectoryRepository {
  constructor(
    private readonly db: Database.Database,
    private readonly now = () => new Date(),
  ) {
    db.function('wai_contact_fold', { deterministic: true }, (value: unknown) =>
      typeof value === 'string' ? normalizeContactName(value) : '',
    );
  }
  list(raw: unknown) {
    const input = ContactDirectoryQuerySchema.parse(raw),
      bounds = registrationBounds(input, this.now());
    const normalized = input.query ? normalizeContactName(input.query) : null;
    const compare = (field: string) =>
      input.match === 'EXACT'
        ? `wai_contact_fold(${field})=?`
        : input.match === 'STARTS_WITH'
          ? `instr(wai_contact_fold(${field}),?)=1`
          : `instr(wai_contact_fold(${field}),?)>0`;
    const where = `WHERE (? IS NULL OR c.account_scope=?)
      AND (? IS NULL OR julianday(c.created_at)>=julianday(?)) AND (? IS NULL OR julianday(c.created_at)<julianday(?))
      AND (? IS NULL OR ${['CASE WHEN p.contact_id IS NULL THEN c.display_name ELSE p.name END', 'CASE WHEN p.contact_id IS NULL THEN c.nickname ELSE p.nickname END', 'CASE WHEN p.contact_id IS NULL THEN c.full_name ELSE p.full_name END'].map(compare).join(' OR ')} OR EXISTS(SELECT 1 FROM json_each(COALESCE(p.relationships_json,'[]')) rel WHERE ${compare('rel.value')}))`;
    const params = [
      input.accountId ?? null,
      input.accountId ? `local-account:${input.accountId}` : null,
      bounds.from,
      bounds.from,
      bounds.before,
      bounds.before,
      normalized,
      normalized,
      normalized,
      normalized,
      normalized,
    ];
    const total = (
      this.db
        .prepare(
          'SELECT COUNT(*) n FROM wa_contacts c LEFT JOIN wa_contact_catalog p ON p.contact_id=c.id ' +
            where,
        )
        .get(...params) as { n: number }
    ).n;
    const rows = this.db
      .prepare(
        `SELECT c.id,c.account_scope accountScope,CASE WHEN p.contact_id IS NULL THEN c.display_name ELSE p.name END name,CASE WHEN p.contact_id IS NULL THEN c.nickname ELSE p.nickname END nickname,CASE WHEN p.contact_id IS NULL THEN c.full_name ELSE p.full_name END fullName,CASE WHEN p.contact_id IS NULL THEN c.phone_number ELSE p.phone END phone,c.created_at registeredAt
      FROM wa_contacts c LEFT JOIN wa_contact_catalog p ON p.contact_id=c.id ${where} AND (? IS NULL OR c.id>?) ORDER BY c.id LIMIT ?`,
      )
      .all(...params, input.cursor ?? null, input.cursor ?? null, input.limit + 1) as Array<{
      id: string;
    }>;
    const items = rows.slice(0, input.limit);
    return ContactDirectoryPageSchema.parse({
      items,
      total,
      nextCursor: rows.length > input.limit ? items.at(-1)!.id : null,
      source: 'SQLITE_ONLY',
      timeZone: input.timeZone,
      registeredFromUtc: bounds.from,
      registeredBeforeUtc: bounds.before,
    });
  }
}
