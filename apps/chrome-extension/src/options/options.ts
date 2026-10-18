import { ExtensionStateSchema } from '../contracts.js';

const toggle = document.querySelector<HTMLInputElement>('#retain-activities');
const status = document.querySelector<HTMLElement>('#save-state');

void chrome.storage.local.get('waiBridgeState').then((stored) => {
  const parsed = ExtensionStateSchema.safeParse(stored.waiBridgeState);
  if (toggle) toggle.checked = parsed.success ? parsed.data.retainActivitySummaries : true;
});

toggle?.addEventListener('change', async () => {
  const stored = await chrome.storage.local.get('waiBridgeState');
  const parsed = ExtensionStateSchema.safeParse(stored.waiBridgeState);
  const current = parsed.success ? parsed.data : {
    monitoring: false,
    connection: 'UNCONFIGURED' as const,
    activities: [],
    errors: [],
    retainActivitySummaries: true,
  };
  await chrome.storage.local.set({ waiBridgeState: { ...current, retainActivitySummaries: toggle?.checked ?? true } });
  if (status) status.textContent = 'Saved on this device.';
});
