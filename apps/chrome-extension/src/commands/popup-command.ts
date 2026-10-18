export type PopupCommand = 'MONITOR_START' | 'MONITOR_STOP' | 'GET_STATE';

export function commandMessage(command: PopupCommand) {
  return { kind: 'COMMAND' as const, command };
}
