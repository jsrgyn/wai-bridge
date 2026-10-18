import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';

export const MediaStatusSchema = z.enum(['DETECTED', 'AVAILABLE', 'CACHING', 'CACHED', 'UNAVAILABLE', 'FAILED', 'REMOVED']);
export const MediaKindSchema = z.enum(['AUDIO', 'IMAGE', 'VIDEO', 'PDF', 'DOCUMENT', 'OTHER']);
export type MediaStatus = z.infer<typeof MediaStatusSchema>;
export type MediaKind = z.infer<typeof MediaKindSchema>;
export interface MediaRecord {
  id: string;
  messageId: string;
  mediaType: MediaKind | null;
  mimeType: string | null;
  sizeBytes: number | null;
  sha256: string | null;
  storageKey: string | null;
  availability: 'AVAILABLE' | 'PARTIAL' | 'UNAVAILABLE';
  processingStatus: MediaStatus;
  durationMs: number | null;
  cachingStartedAt: string | null;
  createdAt: string;
  cachedAt: string | null;
  verifiedAt: string | null;
  removedAt: string | null;
  errorCode: string | null;
}

const CreateSchema = z.object({ id: z.uuid(), messageId: z.uuid(), at: z.iso.datetime() });
const CachedSchema = z.object({
  mimeType: z.string().min(1).max(128), mediaType: MediaKindSchema,
  sizeBytes: z.number().int().positive(), sha256: z.string().regex(/^[a-f0-9]{64}$/),
  storageKey: z.string().min(1).max(256), durationMs: z.number().int().nonnegative().nullable(),
});

export class MediaRepository {
  constructor(private readonly db: Database.Database) {}

  create(input: { id: string; messageId: string; at: string }): MediaRecord {
    const value = CreateSchema.parse(input);
    this.db.prepare(`INSERT INTO wa_media(id,message_id,availability,processing_status,created_at)
      VALUES(?,?,'PARTIAL','DETECTED',?)`).run(value.id, value.messageId, value.at);
    return this.require(value.id);
  }

  get(id: string): MediaRecord | undefined {
    z.uuid().parse(id);
    return this.db.prepare(`SELECT id,message_id AS messageId,media_type AS mediaType,mime_type AS mimeType,
      size_bytes AS sizeBytes,sha256,storage_key AS storageKey,availability,
      processing_status AS processingStatus,duration_ms AS durationMs,created_at AS createdAt,
      caching_started_at AS cachingStartedAt,cached_at AS cachedAt,verified_at AS verifiedAt,
      removed_at AS removedAt,error_code AS errorCode
      FROM wa_media WHERE id=?`).get(id) as MediaRecord | undefined;
  }

  require(id: string): MediaRecord {
    const row = this.get(id);
    if (!row) throw new Error('MEDIA_NOT_FOUND');
    return row;
  }

  setAvailable(id: string, at: string): void {
    this.transition(id, ['DETECTED', 'UNAVAILABLE', 'FAILED'], 'AVAILABLE', at,
      `UPDATE wa_media SET processing_status='AVAILABLE',availability='AVAILABLE',error_code=NULL WHERE id=?`);
  }

  setUnavailable(id: string, at: string): void {
    this.transition(id, ['DETECTED', 'AVAILABLE', 'FAILED'], 'UNAVAILABLE', at,
      `UPDATE wa_media SET processing_status='UNAVAILABLE',availability='UNAVAILABLE' WHERE id=?`);
  }

  claimCaching(id: string, at: string): void {
    this.transition(id, ['DETECTED', 'AVAILABLE', 'UNAVAILABLE', 'FAILED'], 'CACHING', at,
      `UPDATE wa_media SET processing_status='CACHING',availability='PARTIAL',error_code=NULL,caching_started_at=? WHERE id=?`, [at]);
  }

  completeCaching(id: string, metadata: {
    mimeType: string; mediaType: MediaKind; sizeBytes: number; sha256: string;
    storageKey: string; durationMs: number | null;
  }, at: string): MediaRecord {
    const value = CachedSchema.parse(metadata);
    this.transition(id, ['CACHING'], 'CACHED', at,
      `UPDATE wa_media SET processing_status='CACHED',availability='AVAILABLE',media_type=?,mime_type=?,
       size_bytes=?,sha256=?,storage_key=?,duration_ms=?,cached_at=?,verified_at=?,error_code=NULL,caching_started_at=NULL WHERE id=?`,
      [value.mediaType, value.mimeType, value.sizeBytes, value.sha256, value.storageKey, value.durationMs, at, at]);
    return this.require(id);
  }

  fail(id: string, errorCode: string, at: string): void {
    z.string().regex(/^[A-Z0-9_]{1,64}$/).parse(errorCode);
    this.transition(id, ['CACHING', 'CACHED'], 'FAILED', at,
      `UPDATE wa_media SET processing_status='FAILED',availability='PARTIAL',error_code=?,caching_started_at=NULL WHERE id=?`, [errorCode]);
  }

  recoverInterrupted(before: string, at: string): number {
    z.iso.datetime().parse(before);
    const ids = this.db.prepare(`SELECT id FROM wa_media WHERE processing_status='CACHING'
      AND caching_started_at<? ORDER BY caching_started_at,id`).all(before) as { id: string }[];
    for (const row of ids) this.fail(row.id, 'MEDIA_INTERRUPTED', at);
    return ids.length;
  }

  markVerified(id: string, at: string): void {
    const row = this.require(id);
    if (row.processingStatus !== 'CACHED') throw new Error('MEDIA_STATE_CONFLICT');
    this.db.prepare('UPDATE wa_media SET verified_at=? WHERE id=?').run(at, id);
  }

  markRemoved(id: string, at: string): void {
    this.transition(id, ['CACHED', 'FAILED'], 'REMOVED', at,
      `UPDATE wa_media SET processing_status='REMOVED',availability='UNAVAILABLE',removed_at=? WHERE id=?`, [at]);
  }

  listExpired(cutoff: string, limit = 100): MediaRecord[] {
    return this.db.prepare(`SELECT id FROM wa_media WHERE processing_status='CACHED' AND cached_at<?
      ORDER BY cached_at,id LIMIT ?`).all(cutoff, limit).map((row) => this.require((row as { id: string }).id));
  }

  countOtherCachedByKey(key: string, excludeId: string): number {
    return (this.db.prepare(`SELECT count(*) AS count FROM wa_media WHERE storage_key=?
      AND id<>? AND processing_status='CACHED'`).get(key, excludeId) as { count: number }).count;
  }

  findCachedByHash(sha256: string, sizeBytes: number, mimeType: string): MediaRecord | undefined {
    const row = this.db.prepare(`SELECT id FROM wa_media WHERE sha256=? AND size_bytes=? AND mime_type=?
      AND processing_status='CACHED' ORDER BY cached_at,id LIMIT 1`)
      .get(sha256, sizeBytes, mimeType) as { id: string } | undefined;
    return row ? this.require(row.id) : undefined;
  }

  private transition(id: string, allowed: MediaStatus[], to: MediaStatus, at: string, sql: string, params: unknown[] = []): void {
    z.iso.datetime().parse(at);
    const tx = this.db.transaction(() => {
      const row = this.require(id);
      if (!allowed.includes(row.processingStatus)) throw new Error('MEDIA_STATE_CONFLICT');
      this.db.prepare(sql).run(...params, id);
      this.db.prepare(`INSERT INTO wa_audit_log(id,actor_type,action,resource_type,resource_id,at,outcome,correlation_id,metadata_json)
        VALUES(?,'SYSTEM','MEDIA_STATUS','MEDIA',?,?,'SUCCESS',?,?)`)
        .run(randomUUID(), id, at, id, JSON.stringify({ from: row.processingStatus, to }));
    });
    tx.immediate();
  }
}
