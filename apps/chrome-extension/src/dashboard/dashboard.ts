import {
  ManagementRequestSchema,
  ContactCatalogSchema,
  MaintenancePolicySchema,
  SendTimingSchema,
  ExtensionSendQueueSchema,
  DEFAULT_SEND_TIMING,
  type SendTiming,
} from '@wai-bridge/shared';
import { z } from 'zod';
const element = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const status = element('status');
function show(value: unknown, id: string) {
  element(id).textContent = JSON.stringify(value, null, 2);
}
const DashboardReplySchema = z
  .object({ requestId: z.uuid(), result: z.json().optional(), error: z.string().optional() })
  .strict();
type DashboardPort = {
  postMessage(value: unknown): void;
  onMessage: { addListener(listener: (value: unknown) => void): void };
  onDisconnect: { addListener(listener: () => void): void };
};
let dashboardPort: DashboardPort | undefined;
const pending = new Map<
  string,
  {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }
>();
function connectDashboard() {
  if (dashboardPort) return dashboardPort;
  const port = chrome.runtime.connect({ name: 'wai-dashboard-v1' });
  dashboardPort = port;
  port.onMessage.addListener((raw) => {
    const parsed = DashboardReplySchema.safeParse(raw);
    if (!parsed.success) return;
    const request = pending.get(parsed.data.requestId);
    if (!request) return;
    clearTimeout(request.timer);
    pending.delete(parsed.data.requestId);
    if (parsed.data.error) request.reject(Error(parsed.data.error));
    else request.resolve(parsed.data.result);
  });
  port.onDisconnect.addListener(() => {
    if (dashboardPort === port) dashboardPort = undefined;
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(Error('NATIVE_DISCONNECTED'));
    }
    pending.clear();
  });
  return port;
}
function request(raw: unknown): Promise<unknown> {
  const input = ManagementRequestSchema.parse(raw);
  const port = connectDashboard();
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(Error('MANAGEMENT_TIMEOUT'));
    }, 40000);
    pending.set(requestId, { resolve, reject, timer });
    try {
      port.postMessage({ requestId, input });
    } catch {
      clearTimeout(timer);
      pending.delete(requestId);
      reject(Error('NATIVE_DISCONNECTED'));
    }
  });
}

function action(work: () => Promise<void>) {
  return () => {
    status.dataset.error = 'false';
    status.textContent = 'Processando…';
    void work()
      .then(() => {
        status.textContent = 'Operação concluída.';
      })
      .catch((error) => {
        status.dataset.error = 'true';
        status.textContent =
          error instanceof z.ZodError
            ? 'Verifique os campos e as confirmações.'
            : error instanceof Error
              ? error.message
              : 'Falha de comunicação.';
      });
  };
}
function click(id: string, work: () => Promise<void>) {
  element(id).addEventListener('click', action(work));
}
function submit(id: string, work: (form: HTMLFormElement) => Promise<void>) {
  element<HTMLFormElement>(id).addEventListener('submit', (event) => {
    event.preventDefault();
    action(() => work(element<HTMLFormElement>(id)))();
  });
}
const field = (form: HTMLFormElement, key: string) =>
  form.elements.namedItem(key) as HTMLInputElement;
function fill(form: HTMLFormElement, data: Record<string, unknown>) {
  for (const [key, value] of Object.entries(data)) {
    const input = field(form, key);
    if (!input) continue;
    if (input.type === 'checkbox') input.checked = Boolean(value);
    else
      input.value = Array.isArray(value) ? value.join(', ') : value === null ? '' : String(value);
  }
}
const confirmed = (id: string) => {
  if (!element<HTMLInputElement>(id).checked)
    throw Error('Confirme o pedido explícito antes de executar.');
};
const jsonObject = z.record(z.string(), z.unknown());
async function refresh() {
  const raw = await request({ operation: 'SUMMARY' });
  show(raw, 'summary');
  const wrapper = jsonObject.parse(raw);
  const summary = jsonObject.parse(wrapper.data);
  const list = element('batches');
  list.replaceChildren();
  for (const rawBatch of z.array(jsonObject).parse(summary.batches)) {
    const button = document.createElement('button');
    button.textContent = `${String(rawBatch.id)} · ${String(rawBatch.status)}`;
    button.addEventListener('click', () => {
      element<HTMLInputElement>('batch-id').value = String(rawBatch.id);
    });
    list.append(button);
  }
  await maintenanceLoad();
  await sendTimingLoad();
  await sendQueueLoad();
}
let contactsCursor: string | null = null,
  contactQuery: Record<string, string> = {};
async function contacts(next = false) {
  const result = jsonObject.parse(
    await request({
      operation: 'CONTACTS',
      query: { ...contactQuery, ...(next && contactsCursor ? { cursor: contactsCursor } : {}) },
    }),
  );
  const list = element('contacts');
  list.replaceChildren();
  const count = document.createElement('p');
  count.textContent = `${String(result.total)} contatos encontrados`;
  list.append(count);
  for (const raw of z.array(jsonObject).parse(result.items)) {
    const card = document.createElement('div');
    card.className = 'card';
    const text = document.createElement('span');
    text.textContent = [raw.name, raw.nickname, raw.fullName, raw.phone]
      .filter(Boolean)
      .join(' · ');
    const edit = document.createElement('button');
    edit.textContent = 'Editar';
    edit.addEventListener(
      'click',
      action(async () => {
        const data = ContactCatalogSchema.parse(
          await request({ operation: 'CONTACT_GET', id: raw.id }),
        );
        fill(element<HTMLFormElement>('contact'), data);
        field(element('contact'), 'confirmed').checked = false;
      }),
    );
    card.append(text, edit);
    list.append(card);
  }
  contactsCursor = z.string().nullable().parse(result.nextCursor);
  element<HTMLButtonElement>('contacts-next').disabled = !contactsCursor;
}
submit('search', async (form) => {
  contactQuery = Object.fromEntries(
    [...new FormData(form)].filter(([, v]) => String(v)).map(([k, v]) => [k, String(v)]),
  );
  await contacts();
});
click('contacts-next', () => contacts(true));
click('new-contact', async () => element<HTMLFormElement>('contact').reset());
submit('contact', async (form) => {
  if (!field(form, 'confirmed').checked) throw Error('Confirme a alteração.');
  const values = Object.fromEntries(
    ['name', 'nickname', 'fullName', 'phone'].map((k) => [k, field(form, k).value.trim() || null]),
  );
  const input = {
    ...values,
    relationships: field(form, 'relationships')
      .value.split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    explicitConfirmation: true,
    idempotencyKey: crypto.randomUUID(),
  };
  const id = field(form, 'id').value;
  const result = await request(
    id
      ? {
          operation: 'CONTACT_UPDATE',
          id,
          input: { ...input, expectedVersion: Number(field(form, 'version').value) },
        }
      : {
          operation: 'CONTACT_CREATE',
          input: { ...input, accountId: field(form, 'accountId').value.trim() },
        },
  );
  fill(form, ContactCatalogSchema.parse(result));
  field(form, 'confirmed').checked = false;
  await contacts();
});
let candidatesCursor: string | null = null;
async function candidates(next = false) {
  const result = jsonObject.parse(
    await request({
      operation: 'CANDIDATES',
      query: next && candidatesCursor ? { cursor: candidatesCursor } : {},
    }),
  );
  const list = element('candidates');
  list.replaceChildren();
  for (const row of z.array(jsonObject).parse(result.items)) {
    const card = document.createElement('div');
    card.className = 'card';
    const text = document.createElement('p');
    text.textContent = `${String(row.leftTitle)} (${String(row.leftId)}) ↔ ${String(row.rightTitle)} (${String(row.rightId)}) · ${String(row.reason)}`;
    const check = document.createElement('input');
    check.type = 'checkbox';
    const label = document.createElement('label');
    label.append(check, document.createTextNode('Confirmei a revisão destas referências'));
    card.append(text, label);
    for (const [decision, title] of [
      ['LINK', 'Vincular referências'],
      ['DISMISS', 'Descartar proposta'],
    ]) {
      const button = document.createElement('button');
      button.textContent = title!;
      button.addEventListener(
        'click',
        action(async () => {
          if (!check.checked) throw Error('Confirme a revisão.');
          await request({
            operation: 'REFERENCE_DECIDE',
            input: {
              leftId: row.leftId,
              rightId: row.rightId,
              decision,
              explicitConfirmation: true,
            },
          });
          await candidates();
        }),
      );
      card.append(button);
    }
    list.append(card);
  }
  candidatesCursor = z.string().nullable().parse(result.nextCursor);
  element<HTMLButtonElement>('candidates-next').disabled = !candidatesCursor;
}
click('candidates-refresh', () => candidates());
click('candidates-next', () => candidates(true));
click('policy-load', async () => {
  const form = element<HTMLFormElement>('policy');
  fill(
    form,
    jsonObject.parse(await request({ operation: 'POLICY_GET', id: field(form, 'id').value })),
  );
});
submit('policy', async (form) => {
  if (!field(form, 'confirmed').checked) throw Error('Confirme a política.');
  await request({
    operation: 'POLICY_UPDATE',
    id: field(form, 'id').value,
    input: {
      favorite: field(form, 'favorite').checked,
      priority: Number(field(form, 'priority').value),
      batchMode: field(form, 'batchMode').value,
      explicitConfirmation: true,
    },
  });
  field(form, 'confirmed').checked = false;
});
let reportCursor: number | null = null;
async function report(next = false) {
  const result = jsonObject.parse(
    await request({
      operation: 'BATCH_REPORT',
      id: element<HTMLInputElement>('batch-id').value,
      ...(next && reportCursor !== null ? { cursor: reportCursor } : {}),
    }),
  );
  show(result, 'report');
  reportCursor = z.number().nullable().parse(result.nextCursor);
  element<HTMLButtonElement>('report-next').disabled = reportCursor === null;
}
click('batch-report', () => report());
click('report-next', () => report(true));
for (const [id, operation] of [
  ['batch-cancel', 'BATCH_CANCEL'],
  ['batch-resume', 'BATCH_RESUME'],
  ['batch-retry', 'BATCH_RETRY'],
])
  click(id!, async () => {
    confirmed('batch-confirm');
    const input = {
      explicitAuthorization: true,
      ...(operation === 'BATCH_RESUME'
        ? { retryFailedItem: element<HTMLInputElement>('retry-paused').checked }
        : {}),
      ...(operation === 'BATCH_RETRY' ? { idempotencyKey: crypto.randomUUID() } : {}),
    };
    show(
      await request({ operation, id: element<HTMLInputElement>('batch-id').value, input }),
      'report',
    );
    element<HTMLInputElement>('batch-confirm').checked = false;
    await refresh();
  });
async function maintenanceLoad() {
  const result = jsonObject.parse(await request({ operation: 'MAINTENANCE_GET' }));
  fill(element('maintenance'), MaintenancePolicySchema.parse(result.policy));
  show(result, 'maintenance-result');
}
submit('maintenance', async (form) => {
  if (!field(form, 'confirmed').checked) throw Error('Confirme a configuração.');
  const numeric = [
    'intervalHours',
    'retentionDays',
    'maxBackupBytes',
    'minBackups',
    'logRetentionDays',
  ];
  const flags = ['backupEnabled', 'pruneBackups', 'pruneLogs', 'authorizeDeletion'];
  const input = {
    ...Object.fromEntries(numeric.map((k) => [k, Number(field(form, k).value)])),
    ...Object.fromEntries(flags.map((k) => [k, field(form, k).checked])),
    explicitConfirmation: true,
  };
  show(await request({ operation: 'MAINTENANCE_UPDATE', input }), 'maintenance-result');
  field(form, 'confirmed').checked = false;
});
click('backup-run', async () => {
  confirmed('backup-confirm');
  show(
    await request({ operation: 'BACKUP_RUN', explicitConfirmation: true }),
    'maintenance-result',
  );
  element<HTMLInputElement>('backup-confirm').checked = false;
});
const TIMING_FIELDS = [
  { input: 'autoCountdownS', key: 'autoCountdownMs', factor: 1000, unit: 's' },
  { input: 'executionTimeoutS', key: 'executionTimeoutMs', factor: 1000, unit: 's' },
  { input: 'queueMaxWaitMin', key: 'queueMaxWaitMs', factor: 60000, unit: 'min' },
  { input: 'sendVerifyS', key: 'sendVerifyMs', factor: 1000, unit: 's' },
] as const;
function fillTiming(timing: SendTiming) {
  const form = element<HTMLFormElement>('send-timing');
  for (const { input, key, factor } of TIMING_FIELDS) {
    const value = timing[key];
    if (value === null) continue;
    field(form, input).value = String(value / factor);
  }
  const unlimited = timing.queueMaxWaitMs === null;
  field(form, 'queueUnlimited').checked = unlimited;
  field(form, 'queueMaxWaitMin').disabled = unlimited;
  if (unlimited) field(form, 'queueMaxWaitMin').value = '';
  else if (!field(form, 'queueMaxWaitMin').value)
    field(form, 'queueMaxWaitMin').value = String(DEFAULT_SEND_TIMING.queueMaxWaitMs! / 60000);
  clearTimingErrors();
}
function clearTimingErrors() {
  for (const node of element('send-timing').querySelectorAll('[data-error-for]'))
    node.textContent = '';
}
async function sendTimingLoad() {
  fillTiming(SendTimingSchema.parse(await request({ operation: 'SEND_SETTINGS_GET' })));
}
function collectTiming(form: HTMLFormElement) {
  clearTimingErrors();
  const input: Record<string, number | null> = {};
  let valid = true;
  for (const { input: name, key, factor, unit } of TIMING_FIELDS) {
    if (key === 'queueMaxWaitMs' && field(form, 'queueUnlimited').checked) {
      input[key] = null;
      continue;
    }
    const raw = field(form, name).value.trim();
    const bounds = SendTimingSchema.shape[key];
    const value = raw === '' ? Number.NaN : Math.round(Number(raw) * factor);
    const parsed = bounds.safeParse(value);
    if (parsed.success) input[key] = parsed.data;
    else {
      valid = false;
      const min = Number(field(form, name).min);
      const max = Number(field(form, name).max);
      element('send-timing').querySelector(`[data-error-for="${name}"]`)!.textContent =
        `Informe um valor entre ${min} e ${max} ${unit === 's' ? 'segundos' : 'minutos'}.`;
    }
  }
  if (!valid) throw new z.ZodError([]);
  return input;
}
element<HTMLInputElement>('send-timing')
  .querySelector<HTMLInputElement>('[name=queueUnlimited]')!
  .addEventListener('change', (event) => {
    const form = element<HTMLFormElement>('send-timing');
    field(form, 'queueMaxWaitMin').disabled = (event.target as HTMLInputElement).checked;
  });
submit('send-timing', async (form) => {
  await request({ operation: 'SEND_SETTINGS_UPDATE', input: collectTiming(form) });
});
click('send-timing-reset', async () => {
  fillTiming(DEFAULT_SEND_TIMING);
  await request({ operation: 'SEND_SETTINGS_UPDATE', input: DEFAULT_SEND_TIMING });
});
const SEND_STATUS_LABELS: Record<string, string> = {
  QUEUED: 'Na fila',
  WAITING_WHATSAPP: 'Aguardando WhatsApp',
  CLAIMED: 'Em execução',
  TARGET_VERIFIED: 'Em execução',
  COMPOSED: 'Em execução',
  WAITING_AUTO_SEND: 'Em execução',
  SENDING: 'Em execução',
  DRAFTED: 'Rascunho pronto',
  SENT: 'Enviado',
  UNKNOWN: 'Resultado incerto',
  FAILED: 'Falhou',
  CANCELLED: 'Cancelado',
};
const SEND_CANCELLABLE = new Set([
  'QUEUED',
  'WAITING_WHATSAPP',
  'CLAIMED',
  'TARGET_VERIFIED',
  'COMPOSED',
  'WAITING_AUTO_SEND',
]);
async function sendQueueLoad() {
  const queue = ExtensionSendQueueSchema.parse(await request({ operation: 'SEND_QUEUE' }));
  const banner = element('send-paused');
  banner.hidden = !queue.paused;
  banner.textContent = queue.paused
    ? `Fila pausada: ${queue.pauseReason ?? 'motivo não informado'}`
    : '';
  const list = element('send-queue');
  list.replaceChildren();
  if (queue.items.length === 0) list.textContent = 'Nenhum envio na fila.';
  for (const item of queue.items) {
    const card = document.createElement('div');
    card.className = 'card';
    const text = document.createElement('span');
    text.textContent = [
      item.position === null ? '—' : `#${item.position}`,
      item.mode === 'AUTO' ? 'Automático' : 'Supervisionado',
      SEND_STATUS_LABELS[item.status] ?? item.status,
      `${item.attempts} ${item.attempts === 1 ? 'tentativa' : 'tentativas'}`,
      ...(item.resultCode ? [item.resultCode] : []),
    ].join(' · ');
    card.append(text);
    if (SEND_CANCELLABLE.has(item.status)) {
      const cancel = document.createElement('button');
      cancel.textContent = 'Cancelar';
      cancel.addEventListener(
        'click',
        action(async () => {
          await request({ operation: 'SEND_CANCEL', id: item.id });
          await sendQueueLoad();
        }),
      );
      card.append(cancel);
    }
    list.append(card);
  }
}
function pollQueue() {
  if (document.visibilityState !== 'visible') return;
  sendQueueLoad().catch(() => {
    element('send-paused').hidden = true;
  });
}
setInterval(pollQueue, 3000);
document.addEventListener('visibilitychange', pollQueue);
click('refresh', refresh);
action(refresh)();
