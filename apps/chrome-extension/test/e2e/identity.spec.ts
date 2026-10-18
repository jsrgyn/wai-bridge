import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const accountId = '11111111-1111-4111-8111-111111111111';
const groupId = '22222222-2222-4222-8222-222222222222';
type Reply = {
  ok: boolean;
  preview?: { contextId: string; type: string; phone?: string };
  error?: string;
};
async function command(page: Page, message: unknown): Promise<Reply> {
  return page.evaluate(
    (message) =>
      (window as unknown as { __command: (message: unknown) => Promise<Reply> }).__command(message),
    message,
  );
}
async function append(page: Page) {
  await page.evaluate(() => {
    const article = document.createElement('article');
    article.dataset.waiMessage = '';
    article.dataset.waiDirection = 'INBOUND';
    article.setAttribute('role', 'article');
    article.innerHTML = '<span data-wai-message-text>Synthetic new message</span>';
    document.querySelector('#messages')!.append(article);
  });
}

async function setup(page: Page, kind: 'INDIVIDUAL' | 'GROUP', automatic = false, intent = true) {
  const delivered: Array<Record<string, unknown>> = [];
  await page.setContent(
    `<button id="nav">Synthetic navigation</button><main id="main" data-wai-conversation-type="${kind}"><header data-testid="conversation-header"><button>Synthetic conversation</button></header><div id="messages"><article role="article" data-wai-message>Historical synthetic message</article></div><div contenteditable="true" aria-label="Synthetic composer"></div></main><aside data-testid="chat-info-drawer"><div data-testid="${kind === 'GROUP' ? 'group-info-header' : 'contact-info-header'}"><h2>${kind === 'GROUP' ? 'Dados do grupo' : 'Dados do contato'}</h2></div>${kind === 'GROUP' ? '' : '<span id="phone">+1 (202) 555-0123</span>'}</aside>`,
  );
  await page.exposeFunction('__delivered', (message: Record<string, unknown>) => {
    if (message.kind === 'CAPTURE_OBSERVATION') delivered.push(message);
  });
  if (automatic) await page.evaluate(() => {
    document.querySelector('header')!.innerHTML = '<span data-testid="conversation-info-header-chat-title">Synthetic conversation</span>';
    const pane=document.createElement('div');pane.id='pane-side';
    pane.innerHTML='<div role="row" id="first"><div aria-selected="true">Synthetic conversation</div></div><div role="row" id="second"><div aria-selected="false">Synthetic conversation</div></div>';
    document.body.append(pane);
  });
  await page.evaluate(({automatic,intent,accountId}) => {
    let sequence = 1;
    Object.defineProperty(window, 'crypto', {
      value: {
        randomUUID: () => `123e4567-e89b-42d3-a456-${(sequence++).toString(16).padStart(12, '0')}`,
      },
    });
    const listeners: Array<
      (raw: unknown, sender: unknown, respond: (value: unknown) => void) => void
    > = [];
    (window as unknown as { chrome: unknown }).chrome = {
      runtime: {
        onMessage: {
          addListener: (listener: (typeof listeners)[number]) => listeners.push(listener),
        },
        sendMessage: async (message: unknown) => {
          if ((message as {kind?:string}).kind==='GET_MONITOR_BOOT' && automatic) return {ok:true,accountId,monitoring:intent};
          await (
            window as unknown as { __delivered: (message: unknown) => Promise<void> }
          ).__delivered(message);
          return { ok: true };
        },
      },
    };
    (window as unknown as { __command: (message: unknown) => Promise<unknown> }).__command = (
      message,
    ) => new Promise((resolve) => listeners[0]!(message, {}, resolve));
  }, {automatic,intent,accountId});
  await page.addScriptTag({ path: resolve(process.cwd(), 'dist/content-script.js') });
  return delivered;
}

test('confirms a visible phone and attaches identity only to newly observed messages', async ({
  page,
}) => {
  const delivered = await setup(page, 'INDIVIDUAL');
  const preview = await command(page, { kind: 'IDENTITY_PREVIEW' });
  expect(preview.preview).toMatchObject({ type: 'PHONE', phone: '+12025550123' });
  expect(
    (
      await command(page, {
        kind: 'IDENTITY_BIND',
        contextId: preview.preview!.contextId,
        accountId,
        confirmed: false,
      })
    ).ok,
  ).toBe(false);
  expect(
    (
      await command(page, {
        kind: 'IDENTITY_BIND',
        contextId: preview.preview!.contextId,
        accountId,
        confirmed: true,
      })
    ).ok,
  ).toBe(true);
  await command(page, { kind: 'MONITOR_CONTROL', enabled: true });
  await append(page);
  await expect.poll(() => delivered.length).toBe(1);
  expect(delivered[0]).toMatchObject({
    identity: { accountId, phone: '+12025550123', source: 'PROFILE_PHONE' },
    conversation: { kind: 'INDIVIDUAL' },
  });
  await command(page, { kind: 'MONITOR_CONTROL', enabled: false });
  await command(page, { kind: 'MONITOR_CONTROL', enabled: true });
  await append(page);
  await expect.poll(() => delivered.length).toBe(2);
  expect(delivered[1]!.identity).toBeUndefined();
});

for (const change of ['navigation', 'header', 'root', 'phone', 'shortcut'] as const)
  test(`discards identity after ${change} and rejects stale confirmation`, async ({ page }) => {
    const delivered = await setup(page, 'INDIVIDUAL');
    const preview = (await command(page, { kind: 'IDENTITY_PREVIEW' })).preview!;
    await command(page, {
      kind: 'IDENTITY_BIND',
      contextId: preview.contextId,
      accountId,
      confirmed: true,
    });
    await command(page, { kind: 'MONITOR_CONTROL', enabled: true });
    if (change === 'navigation') await page.locator('#nav').click();
    if (change === 'header')
      await page.evaluate(() => {
        document.querySelector('header button')!.textContent = 'Synthetic conversation';
      });
    if (change === 'root')
      await page.evaluate(() => {
        const root = document.querySelector('#main')!;
        root.replaceWith(root.cloneNode(true));
      });
    if (change === 'phone')
      await page.evaluate(() => {
        document.querySelector('#phone')!.textContent = '+12025550124';
      });
    if (change === 'shortcut') await page.locator('[contenteditable]').press('Escape');
    await append(page);
    await expect.poll(() => delivered.length).toBe(1);
    expect(delivered[0]!.identity).toBeUndefined();
    expect(
      (
        await command(page, {
          kind: 'IDENTITY_BIND',
          contextId: preview.contextId,
          accountId,
          confirmed: true,
        })
      ).ok,
    ).toBe(false);
  });

test('requires explicit local group selection and reconfirmation after rename', async ({
  page,
}) => {
  const delivered = await setup(page, 'GROUP');
  const preview = (await command(page, { kind: 'IDENTITY_PREVIEW' })).preview!;
  expect(preview.type).toBe('GROUP_LOCAL');
  expect(
    (
      await command(page, {
        kind: 'IDENTITY_BIND',
        contextId: preview.contextId,
        accountId,
        confirmed: true,
      })
    ).ok,
  ).toBe(false);
  await command(page, {
    kind: 'IDENTITY_BIND',
    contextId: preview.contextId,
    accountId,
    confirmed: true,
    groupId,
    groupLabel: 'Synthetic group',
  });
  await command(page, { kind: 'MONITOR_CONTROL', enabled: true });
  await append(page);
  await expect.poll(() => delivered.length).toBe(1);
  expect(delivered[0]).toMatchObject({ identity: { groupId, source: 'USER_GROUP' } });
  await page.evaluate(() => {
    document.querySelector('header button')!.textContent = 'Synthetic renamed group';
  });
  await append(page);
  await expect.poll(() => delivered.length).toBe(2);
  expect(delivered[1]!.identity).toBeUndefined();
  const next = (await command(page, { kind: 'IDENTITY_PREVIEW' })).preview!;
  await command(page, {
    kind: 'IDENTITY_BIND',
    contextId: next.contextId,
    accountId,
    confirmed: true,
    groupId,
    groupLabel: 'Synthetic renamed group',
  });
  await append(page);
  await expect.poll(() => delivered.length).toBe(3);
  expect(delivered[2]).toMatchObject({
    identity: { groupId, groupLabel: 'Synthetic renamed group' },
  });
});

test('rejects ambiguous profile phones and does not guess country digits', async ({ page }) => {
  await setup(page, 'INDIVIDUAL');
  await page.evaluate(() => {
    (document.querySelector('#phone') as HTMLElement).style.visibility = 'hidden';
  });
  expect((await command(page, { kind: 'IDENTITY_PREVIEW' })).ok).toBe(false);
  await page.evaluate(() => {
    (document.querySelector('#phone') as HTMLElement).style.visibility = 'visible';
  });
  await page.evaluate(() => {
    document.querySelector('#phone')!.textContent = '2025550123';
  });
  expect((await command(page, { kind: 'IDENTITY_PREVIEW' })).ok).toBe(false);
  await page.evaluate(() => {
    document.querySelector('#phone')!.textContent = '+12025550123';
    const second = document.createElement('span');
    second.textContent = '+12025550124';
    document.querySelector('aside')!.append(second);
  });
  expect((await command(page, { kind: 'IDENTITY_PREVIEW' })).ok).toBe(false);
});

test('popup persists explicit local account and group choices without starting monitoring', async ({
  page,
}) => {
  const popup = await readFile(resolve(process.cwd(), 'dist/popup.html'), 'utf8');
  const script = await readFile(resolve(process.cwd(), 'dist/popup.js'), 'utf8');
  await page.setContent(popup.replace('<script src="popup.js"></script>', ''));
  const calls: unknown[] = [];
  let saved: Record<string, unknown> = {};
  await page.exposeFunction('__save', async (value: Record<string, unknown>) => {
    saved = { ...saved, ...value };
  });
  await page.exposeFunction('__call', async (value: unknown) => {
    calls.push(value);
  });
  await page.evaluate(() => {
    let sequence = 1;
    Object.defineProperty(window, 'crypto', {
      value: {
        randomUUID: () => `123e4567-e89b-42d3-a456-${(sequence++).toString(16).padStart(12, '0')}`,
      },
    });
    (window as unknown as { chrome: unknown }).chrome = {
      storage: {
        local: {
          get: async () => ({}),
          set: async (value: unknown) =>
            (window as unknown as { __save: (value: unknown) => Promise<void> }).__save(value),
        },
      },
      runtime: {
        sendMessage: async (message: { kind?: string }) => {
          await (window as unknown as { __call: (value: unknown) => Promise<void> }).__call(
            message,
          );
          return message.kind === 'IDENTITY_PREVIEW'
            ? {
                ok: true,
                preview: { contextId: '33333333-3333-4333-8333-333333333333', type: 'GROUP_LOCAL' },
              }
            : { ok: true };
        },
      },
    };
  });
  await page.addScriptTag({ content: script });
  await page.getByText('Identificação manual avançada (opcional)', {exact:true}).click();
  await page.locator('#identity-account-name').fill('Synthetic account');
  await page.getByRole('button', { name: 'Adicionar conta local' }).click();
  await expect(page.locator('#identity-status')).toContainText('Conta local criada');
  await page.getByRole('button', { name: 'Conferir conversa aberta' }).click();
  await expect(page.locator('#identity-group-fields')).toBeVisible();
  await page.locator('#identity-group-name').fill('Synthetic group');
  await expect(page.locator('#identity-bind')).toBeDisabled();
  await page.locator('#identity-confirm').check();
  await page.getByRole('button', { name: 'Vincular conversa atual', exact: true }).click();
  await expect(page.locator('#identity-status')).toContainText('Vínculo confirmado');
  expect(saved.waiIdentityChoicesV1).toMatchObject({
    accounts: [{ label: 'Synthetic account' }],
    groups: [{ label: 'Synthetic group' }],
  });
  expect(calls).not.toEqual(
    expect.arrayContaining([expect.objectContaining({ command: 'MONITOR_START' })]),
  );
});

for (const kind of ['INDIVIDUAL', 'GROUP'] as const)
  test(`preserves ${kind} binding across manual send and presence changes`, async ({ page }) => {
    const delivered = await setup(page, kind);
    await page.evaluate(() => {
      document.querySelector('header')!.innerHTML =
        '<span data-testid="conversation-info-header-chat-title">Synthetic conversation</span><span data-testid="chat-subtitle">online</span>';
      const footer = document.createElement('footer');
      footer.innerHTML = '<button type="button" aria-label="Enviar">Synthetic send</button>';
      footer.querySelector('button')!.addEventListener('click', () => {
        const row = document.createElement('div');
        row.setAttribute('role', 'row');
        row.setAttribute('data-testid', 'conv-msg-synthetic-outbound');
        row.innerHTML =
          '<div style="display:flex;flex-direction:column;align-items:flex-end"><div data-testid="msg-container"><span class="selectable-text">Synthetic manual reply</span><span data-testid="tail-out"></span><span data-testid="msg-meta">12:01</span></div></div>';
        document.querySelector('#messages')!.append(row);
      });
      document.querySelector('#main')!.append(footer);
    });
    const preview = (await command(page, { kind: 'IDENTITY_PREVIEW' })).preview!;
    expect(
      (
        await command(page, {
          kind: 'IDENTITY_BIND',
          contextId: preview.contextId,
          accountId,
          confirmed: true,
          ...(kind === 'GROUP' ? { groupId, groupLabel: 'Synthetic group' } : {}),
        })
      ).ok,
    ).toBe(true);
    await command(page, { kind: 'MONITOR_CONTROL', enabled: true });
    await append(page);
    await expect.poll(() => delivered.length).toBe(1);
    // Local click in a synthetic page; never sends through WhatsApp.
    await page.getByRole('button', { name: 'Enviar', exact: true }).click();
    await expect.poll(() => delivered.length).toBe(2);
    await page.evaluate(() => {
      document.querySelector('[data-testid="chat-subtitle"]')!.textContent = 'digitando…';
    });
    await append(page);
    await expect.poll(() => delivered.length).toBe(3);
    expect(delivered.map((item) => item.direction)).toEqual(['INBOUND', 'OUTBOUND', 'INBOUND']);
    for (const item of delivered)
      expect(item.identity).toMatchObject({ accountId, contextId: preview.contextId });
    expect(delivered[1]).toMatchObject({
      content: 'Synthetic manual reply',
      captureState: 'CAPTURED',
    });
    await page.evaluate(() => {
      document.querySelector('[data-testid="conversation-info-header-chat-title"]')!.textContent =
        'Different synthetic conversation';
    });
    await append(page);
    await expect.poll(() => delivered.length).toBe(4);
    expect(delivered[3]!.identity).toBeUndefined();
  });

for (const kind of ['INDIVIDUAL','GROUP'] as const) test(`automatically groups ${kind} incoming and phone/browser outbound messages without binding`, async ({page})=>{
  const delivered=await setup(page,kind,true);
  await expect.poll(async()=> (await command(page,{kind:'GET_CONTENT_STATE'}) as Reply & {monitoring:boolean}).monitoring).toBe(true);
  expect(delivered).toHaveLength(0); // existing history was not imported
  await append(page);
  await expect.poll(()=>delivered.length).toBe(1);
  await page.evaluate(()=>{
    const item=document.createElement('article');item.dataset.waiMessage='';item.dataset.waiDirection='OUTBOUND';item.setAttribute('role','article');
    item.innerHTML='<span data-wai-message-text>Synthetic synced phone reply</span>';
    document.querySelector('#messages')!.append(item);
  });
  await expect.poll(()=>delivered.length).toBe(2);
  expect(delivered.map(x=>x.direction)).toEqual(['INBOUND','OUTBOUND']);
  expect(delivered[0]!.identity).toMatchObject({type:'UI_CONTEXT',source:'VISIBLE_UI',conversationKind:kind});
  expect(delivered[1]!.identity).toEqual(delivered[0]!.identity);
  // Equal names in different selected UI rows must never merge.
  await page.evaluate(()=>{
    document.querySelector('#first div')!.setAttribute('aria-selected','false');
    document.querySelector('#second div')!.setAttribute('aria-selected','true');
  });
  await append(page);
  await expect.poll(()=>delivered.length).toBe(3);
  expect(delivered[2]!.identity).not.toEqual(delivered[0]!.identity);
  await page.evaluate(()=>{
    document.querySelector('#second div')!.setAttribute('aria-selected','false');
    document.querySelector('#first div')!.setAttribute('aria-selected','true');
  });
  await append(page);
  await expect.poll(()=>delivered.length).toBe(4);
  expect(delivered[3]!.identity).toMatchObject({conversationKey:(delivered[0]!.identity as {conversationKey:string}).conversationKey});
});

test('persisted OFF does not start capture on page boot',async({page})=>{
  const delivered=await setup(page,'INDIVIDUAL',true,false);
  await append(page);
  await page.waitForTimeout(300);
  expect(delivered).toHaveLength(0);
  expect(await command(page,{kind:'GET_CONTENT_STATE'})).toMatchObject({monitoring:false});
});

test('does not import recognized older history inserted after activation',async({page})=>{
  const delivered=await setup(page,'GROUP',true);
  await expect.poll(async()=> (await command(page,{kind:'GET_CONTENT_STATE'}) as Reply & {monitoring:boolean}).monitoring).toBe(true);
  await page.evaluate(()=>{
    const item=document.createElement('article');item.dataset.waiMessage='';item.dataset.waiDirection='INBOUND';item.setAttribute('role','article');
    item.innerHTML='<span data-pre-plain-text="[12:00, 01/01/2020] Synthetic: "></span><span data-wai-message-text>Synthetic older history</span>';
    document.querySelector('#messages')!.append(item);
  });
  await page.waitForTimeout(250);
  expect(delivered).toHaveLength(0);
  await append(page);
  await expect.poll(()=>delivered.length).toBe(1);
});

test('automatically reads one visible phone only from the matching contact profile',async({page})=>{
  const delivered=await setup(page,'INDIVIDUAL',true);
  await page.evaluate(()=>{
    const name=document.createElement('span');name.id='profile-name';name.textContent='Synthetic conversation';
    document.querySelector('aside')!.append(name);
  });
  await append(page);
  await expect.poll(()=>delivered.length).toBe(1);
  expect(delivered[0]!.identity).toMatchObject({type:'UI_CONTEXT',phone:'+12025550123',conversationKind:'INDIVIDUAL'});
  // Closing a profile does not discard metadata already observed for this context.
  await page.evaluate(()=>document.querySelector('aside')!.remove());
  await append(page);
  await expect.poll(()=>delivered.length).toBe(2);
  expect(delivered[1]!.identity).toEqual(delivered[0]!.identity);
});

for(const invalid of ['different-name','hidden-phone','ambiguous-phone','group'] as const)
  test(`does not assign a phone from ${invalid} profile evidence`,async({page})=>{
    const delivered=await setup(page,invalid==='group'?'GROUP':'INDIVIDUAL',true);
    await page.evaluate((invalid)=>{
      const name=document.createElement('span');name.textContent=invalid==='different-name'?'Different synthetic profile':'Synthetic conversation';
      document.querySelector('aside')!.append(name);
      if(invalid==='hidden-phone')(document.querySelector('#phone') as HTMLElement).style.display='none';
      if(invalid==='ambiguous-phone'||invalid==='group'){
        const phone=document.createElement('span');phone.textContent='+12025550124';document.querySelector('aside')!.append(phone);
      }
    },invalid);
    await append(page);
    await expect.poll(()=>delivered.length).toBe(1);
    expect((delivered[0]!.identity as {phone?:string}).phone).toBeUndefined();
  });
