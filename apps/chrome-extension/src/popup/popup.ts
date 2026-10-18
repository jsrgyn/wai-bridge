import { ExtensionStateSchema } from '../contracts.js';
import { commandMessage } from '../commands/popup-command.js';

const button = document.querySelector<HTMLButtonElement>('#toggle-monitor');
const stateLabel = document.querySelector<HTMLElement>('#monitor-state');
const connectionLabel = document.querySelector<HTMLElement>('#connection');
const activityList = document.querySelector<HTMLUListElement>('#activities');
const errorList = document.querySelector<HTMLUListElement>('#errors');

function render(state: unknown): void {
  const parsed = ExtensionStateSchema.safeParse(state);
  if (!parsed.success) return;
  const value = parsed.data;
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
