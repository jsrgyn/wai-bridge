import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { EventInputSchema, type EventInput, type PublishResult } from './contracts.js';
import { EventRepository } from './event-repository.js';
export class EventService {
  private readonly repository: EventRepository;
  constructor(db: Database.Database) {
    this.repository = new EventRepository(db);
  }
  publish(input: EventInput & { id?: string }): PublishResult {
    const event = EventInputSchema.parse({ ...input, id: input.id ?? randomUUID() });
    return this.repository.append(event);
  }
  getRepository(): EventRepository {
    return this.repository;
  }
}
