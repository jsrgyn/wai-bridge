import { z } from 'zod';
import { IdentityReplySchema, IdentityPreviewSchema } from '../contracts.js';

const ChoicesSchema = z.object({
  accounts: z.array(z.object({ id: z.uuid(), label: z.string().min(1).max(80) })).max(50),
  groups: z
    .array(z.object({ id: z.uuid(), accountId: z.uuid(), label: z.string().min(1).max(256) }))
    .max(200),
});
type Choices = z.infer<typeof ChoicesSchema>;
const key = 'waiIdentityChoicesV1';
let choices: Choices = { accounts: [], groups: [] };
let preview: z.infer<typeof IdentityPreviewSchema> | undefined;
const account = document.querySelector<HTMLSelectElement>('#identity-account')!;
const group = document.querySelector<HTMLSelectElement>('#identity-group')!;
const confirmed = document.querySelector<HTMLInputElement>('#identity-confirm')!;
const bind = document.querySelector<HTMLButtonElement>('#identity-bind')!;
const status = document.querySelector<HTMLElement>('#identity-status')!;
function reset() {
  preview = undefined;
  confirmed.checked = false;
  bind.disabled = true;
}
function option(value: string, label: string) {
  const el = document.createElement('option');
  el.value = value;
  el.textContent = label;
  return el;
}
function renderGroups() {
  group.replaceChildren(
    option('new', 'Criar um novo grupo'),
    ...choices.groups
      .filter((g) => g.accountId === account.value)
      .map((g) => option(g.id, `${g.label} · ${g.id.slice(0, 8)}`)),
  );
}
function render() {
  const previous = account.value;
  account.replaceChildren(
    option('', 'Selecione a conta conectada'),
    ...choices.accounts.map((a) => option(a.id, `${a.label} · ${a.id.slice(0, 8)}`)),
  );
  if (choices.accounts.some((a) => a.id === previous)) account.value = previous;
  renderGroups();
}
async function save(next: Choices) {
  const parsed = ChoicesSchema.parse(next);
  await chrome.storage.local.set({ [key]: parsed });
  choices = parsed;
}
async function send(message: unknown) {
  const reply = IdentityReplySchema.parse(await chrome.runtime.sendMessage(message));
  if (!reply.ok) throw new Error(reply.error ?? 'Não foi possível confirmar.');
  return reply;
}
function action(id: string, run: () => Promise<void>) {
  document.querySelector<HTMLButtonElement>(id)?.addEventListener('click', () => {
    void run().catch((error) => {
      status.textContent = error instanceof Error ? error.message : 'Falha ao confirmar.';
    });
  });
}

account?.addEventListener('change', () => {
  reset();
  renderGroups();
  void send({ kind: 'IDENTITY_CLEAR' })
    .then(() => {
      status.textContent = 'Conta alterada. Confira novamente a conversa.';
    })
    .catch(() => {
      status.textContent = 'Não foi possível descartar o vínculo na página. Recarregue o WhatsApp.';
    });
});
group?.addEventListener('change', () => {
  confirmed.checked = false;
  bind.disabled = true;
  if (!preview)
    void send({ kind: 'IDENTITY_CLEAR' }).catch(() => {
      status.textContent = 'Confira novamente a conversa antes de vincular.';
    });
});
confirmed?.addEventListener('change', () => {
  bind.disabled = !confirmed.checked || !preview || !account.value;
});
action('#identity-add-account', async () => {
  const input = document.querySelector<HTMLInputElement>('#identity-account-name')!;
  const label = z.string().trim().min(1).max(80).parse(input.value);
  const recovered = document
    .querySelector<HTMLInputElement>('#identity-account-restore')!
    .value.trim();
  const id = recovered ? z.uuid().parse(recovered) : crypto.randomUUID();
  await send({ kind: 'IDENTITY_CLEAR' });
  await save({
    ...choices,
    accounts: [...choices.accounts.filter((a) => a.id !== id), { id, label }],
  });
  render();
  account.value = id;
  renderGroups();
  reset();
  input.value = '';
  status.textContent = 'Conta local criada. Confira se ela corresponde à sessão conectada.';
});
action('#identity-preview', async () => {
  reset();
  const reply = await send({ kind: 'IDENTITY_PREVIEW' });
  preview = IdentityPreviewSchema.parse(reply.preview);
  document.querySelector<HTMLElement>('#identity-group-fields')!.hidden =
    preview.type !== 'GROUP_LOCAL';
  status.textContent =
    preview.type === 'PHONE'
      ? `Telefone exibido no perfil: ${preview.phone}. Confira a conta e confirme o vínculo.`
      : 'Dados de grupo reconhecidos. Crie ou selecione conscientemente o cadastro local.';
});
action('#identity-bind', async () => {
  if (!preview || !confirmed.checked || !choices.accounts.some((a) => a.id === account.value))
    throw new Error('Confira a conversa e confirme a conta selecionada.');
  let selected: Choices['groups'][number] | undefined;
  if (preview.type === 'GROUP_LOCAL') {
    selected =
      group.value === 'new'
        ? {
            id: document.querySelector<HTMLInputElement>('#identity-group-restore')!.value.trim()
              ? z
                  .uuid()
                  .parse(
                    document
                      .querySelector<HTMLInputElement>('#identity-group-restore')!
                      .value.trim(),
                  )
              : crypto.randomUUID(),
            accountId: account.value,
            label: z
              .string()
              .trim()
              .min(1)
              .max(256)
              .parse(document.querySelector<HTMLInputElement>('#identity-group-name')!.value),
          }
        : choices.groups.find((g) => g.id === group.value && g.accountId === account.value);
    if (!selected) throw new Error('Selecione um grupo válido.');
    // Persist the local reference before activation so a storage failure cannot lose it.
    if (group.value === 'new')
      await save({
        ...choices,
        groups: [
          ...choices.groups.filter(
            (g) => g.id !== selected!.id || g.accountId !== selected!.accountId,
          ),
          selected,
        ],
      });
  }
  await send({
    kind: 'IDENTITY_BIND',
    contextId: preview.contextId,
    accountId: account.value,
    confirmed: true,
    ...(selected ? { groupId: selected.id, groupLabel: selected.label } : {}),
  });
  renderGroups();
  if (selected) group.value = selected.id;
  reset();
  status.textContent =
    'Vínculo confirmado para esta conversa. Navegação ou alteração do cabeçalho exige nova confirmação. O monitoramento continua sob seu controle.';
});
action('#identity-clear', async () => {
  await send({ kind: 'IDENTITY_CLEAR' });
  reset();
  status.textContent = 'Vínculo descartado.';
});
void (async () => {
  try {
    const data = await chrome.storage.local.get(key);
    if (data[key]) choices = ChoicesSchema.parse(data[key]);
    render();
    const reply = await send({ kind: 'IDENTITY_STATE' });
    if (reply.identity?.type === 'UI_CONTEXT') {
      status.textContent = 'Identificação automática ativa nesta conversa. Não é necessário vincular manualmente.';
    } else if (reply.identity) {
      const active = choices.accounts.find((a) => a.id === reply.identity!.accountId);
      if (active) account.value = active.id;
      renderGroups();
      if (reply.identity.type === 'GROUP_LOCAL') group.value = reply.identity.groupId;
      status.textContent =
        'Existe um vínculo confirmado nesta conversa. Para alterá-lo, confira os dados novamente.';
    }
  } catch {
    status.textContent =
      'Não foi possível carregar os cadastros locais. Nenhum vínculo foi ativado.';
  }
})();
