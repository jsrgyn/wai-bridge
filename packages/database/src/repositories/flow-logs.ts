import type Database from 'better-sqlite3';
import {
  FlowLogBatchSchema,
  FlowLogQuerySchema,
  makeFlowLog,
  type FlowLogInput,
} from '@wai-bridge/shared';
export class FlowLogRepository {
  constructor(
    private readonly db: Database.Database,
    private readonly now = () => new Date().toISOString(),
  ) {}
  append(raw: unknown) {
    const { events } = FlowLogBatchSchema.parse(raw);
    const at = this.now();
    return this.db
      .transaction(() => {
        const insert = this.db.prepare(
          'INSERT OR IGNORE INTO wa_flow_logs(id,trace_id,resource_id,component,level,received_at,event_json) VALUES(?,?,?,?,?,?,?)',
        );
        let inserted = 0;
        for (const event of events)
          inserted += insert.run(
            event.id,
            event.traceId,
            event.resourceId ?? null,
            event.component,
            event.level,
            at,
            JSON.stringify(event),
          ).changes;
        this.db
          .prepare('DELETE FROM wa_flow_logs WHERE received_at<?')
          .run(new Date(Date.parse(at) - 7 * 86400000).toISOString());
        this.db
          .prepare(
            'DELETE FROM wa_flow_logs WHERE sequence <= (SELECT sequence FROM wa_flow_logs ORDER BY sequence DESC LIMIT 1 OFFSET 20000)',
          )
          .run();
        return { accepted: events.length, inserted };
      })
      .immediate();
  }
  record(input: FlowLogInput): void {
    try {
      this.append({ events: [makeFlowLog(input)] });
    } catch {
      /* Diagnostic failure cannot undo a committed operation. */
    }
  }
  list(raw: unknown) {
    const query = FlowLogQuerySchema.parse(raw);
    const filters: string[] = ['received_at>=?'];
    const args: (string | number)[] = [
      new Date(Date.parse(this.now()) - 7 * 86400000).toISOString(),
    ];
    const related = query.resourceId
      ? (
          this.db
            .prepare('SELECT flow_trace_id FROM wa_outbox WHERE id=?')
            .get(query.resourceId) as { flow_trace_id: string | null } | undefined
        )?.flow_trace_id
      : undefined;
    for (const [column, value] of [
      ['trace_id', query.traceId],

      ['component', query.component],
      ['level', query.level],
    ] as const)
      if (value !== undefined) {
        filters.push(`${column}=?`);
        args.push(value);
      }
    if (query.resourceId) {
      filters.push('(resource_id=? OR trace_id=?)');
      args.push(query.resourceId, related ?? query.resourceId);
    }
    const where = filters.length ? ' WHERE ' + filters.join(' AND ') : '';
    const latest = this.db
      .prepare('SELECT event_json FROM wa_flow_logs' + where + ' ORDER BY sequence DESC LIMIT 1')
      .get(...args) as { event_json: string } | undefined;
    const pageFilters = [...filters];
    const pageArgs = [...args];
    if (query.beforeSequence) {
      pageFilters.push('sequence<?');
      pageArgs.push(query.beforeSequence);
    }
    const rows = this.db
      .prepare(
        'SELECT sequence,received_at,event_json FROM wa_flow_logs' +
          (pageFilters.length ? ' WHERE ' + pageFilters.join(' AND ') : '') +
          ' ORDER BY sequence DESC LIMIT ?',
      )
      .all(...pageArgs, query.limit + 1) as {
      sequence: number;
      received_at: string;
      event_json: string;
    }[];
    const more = rows.length > query.limit;
    const selected = rows.slice(0, query.limit);
    const command = query.resourceId
      ? this.db.prepare('SELECT status FROM wa_outbox WHERE id=?').get(query.resourceId)
      : query.traceId
        ? this.db
            .prepare(
              'SELECT status FROM wa_outbox WHERE flow_trace_id=? ORDER BY created_at DESC LIMIT 1',
            )
            .get(query.traceId)
        : undefined;
    return {
      items: selected.reverse().map((row) => ({
        ...JSON.parse(row.event_json),
        sequence: row.sequence,
        receivedAt: row.received_at,
      })),
      nextBeforeSequence: more ? selected[0]!.sequence : null,
      latestRecorded: latest ? JSON.parse(latest.event_json) : null,
      commandStatus: (command as { status: string } | undefined)?.status ?? null,
      resolvedTraceId: query.traceId ?? related ?? query.resourceId ?? null,
      coverage: 'BEST_EFFORT_INSTRUMENTATION',
      retention: { days: 7, maxRows: 20000 },
    };
  }
}
