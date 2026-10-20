import { ExtensionStateSchema } from '../contracts.js';
import { commandMessage } from '../commands/popup-command.js';
import '../identity/popup.js';

const button = document.querySelector<HTMLButtonElement>('#toggle-monitor');
const stateLabel = document.querySelector<HTMLElement>('#monitor-state');
const connectionLabel = document.querySelector<HTMLElement>('#connection');
const activityList = document.querySelector<HTMLUListElement>('#activities');
const errorList = document.querySelector<HTMLUListElement>('#errors');

function render(state: unknown): void {
  const parsed = ExtensionStateSchema.safeParse(state);
  if (!parsed.success) return;
  const value = parsed.data;
  const context = document.querySelector<HTMLElement>('#capture-context');
  if (context) context.textContent = value.captureContext === 'NO_CONVERSATION'
    ? 'Abra uma conversa para capturar mensagens novas. A lista registra somente avisos de atividade.'
    : value.captureContext === 'UNAVAILABLE'
      ? 'Monitor indisponível nesta aba. Recarregue o WhatsApp e clique em Start monitoring.'
      : value.captureContext === 'NOT_WHATSAPP'
        ? 'Abra a aba do WhatsApp Web.'
        : value.captureContext === 'ACTIVE_CONVERSATION'
          ? value.monitoring ? 'Observando mensagens, alterações e anexos visíveis da conversa aberta. A lista registra atividades; a cobertura não é completa.' : 'Monitor parado nesta aba. Clique em Start monitoring para observar mensagens novas.'
          : '';
  if (stateLabel) stateLabel.textContent = `Monitoring: ${value.monitoring ? 'on' : 'off'}`;
  if (connectionLabel) connectionLabel.textContent = `Local agent: ${value.connection.toLowerCase()}`;
  if (button) button.textContent = value.monitoring ? 'Stop monitoring' : 'Start monitoring';
  if (activityList) {
    activityList.replaceChildren(...value.activities.map((activity) => {
      const item = document.createElement('li');
      item.textContent = `${activity.label} · ${new Date(activity.timestamp).toLocaleTimeString()}`;
      return item;
    }));
  }
  if (errorList) {
    errorList.replaceChildren(...value.errors.map((error) => {
      const item = document.createElement('li');
      item.textContent = error;
      return item;
    }));
  }
}

async function refresh(): Promise<void> {
  const result = await chrome.runtime.sendMessage(commandMessage('GET_STATE'));
  render(result?.state);
}

button?.addEventListener('click', async () => {
  const starting = button.textContent === 'Start monitoring';
  const result = await chrome.runtime.sendMessage(commandMessage(starting ? 'MONITOR_START' : 'MONITOR_STOP'));
  render(result?.state);
});

void refresh();

const sendOptIn=document.querySelector<HTMLInputElement>('#allow-extension-sends');
if(sendOptIn){
  void chrome.storage?.local.get('waiExtensionSendsEnabled').then(stored=>{sendOptIn.checked=stored.waiExtensionSendsEnabled===true;});
  sendOptIn.addEventListener('change',()=>{
    void chrome.storage.local.set({waiExtensionSendsEnabled:sendOptIn.checked}).then(async()=>{
      const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
      if(tab?.id!==undefined&&tab.url?.startsWith('https://web.whatsapp.com/'))await chrome.tabs.sendMessage(tab.id,{kind:'SEND_CONTEXT',enabled:sendOptIn.checked});
    }).catch(()=>{sendOptIn.checked=false;});
  });
}
