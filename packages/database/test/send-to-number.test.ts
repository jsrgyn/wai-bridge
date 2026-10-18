import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { openDatabase, ExtensionSendRepository } from '../src/index.js';
function setup() {
  const db = openDatabase(':memory:');
  let now = '2026-10-18T12:00:00.000Z';
  const repo = new ExtensionSendRepository(db, () => now);
  const identity = {
    version: 1 as const,
    type: 'UI_CONTEXT' as const,
    source: 'VISIBLE_UI' as const,
    accountId: randomUUID(),
    contextId: randomUUID(),
    conversationKey: randomUUID(),
    conversationKind: 'INDIVIDUAL' as const,
    confirmedAt: now,
  };
  const extensionInstanceId = randomUUID();
  const request = {
    phoneNumber: '+1 (202) 555-0199',
    text: 'Synthetic direct phone request',
    mode: 'AUTO' as const,
    explicitAuthorization: true as const,
  };
  return {
    db,
    repo,
    identity,
    extensionInstanceId,
    request,
    setTime: (at: string) => {
      now = at;
    },
  };
}
it('persists a request to a new phone without fabricating a verified contact or conversation', () => {
  const { db, repo, identity, extensionInstanceId, request } = setup();
  try {
    repo.poll({ extensionInstanceId, identity });
    const before = db.prepare('SELECT count(*) n FROM wa_conversation_identities').get();
    const created = repo.createToNumber(request, 'synthetic-direct-number-key');
    expect(created.status).toBe('REQUESTED');
    expect(db.prepare('SELECT count(*) n FROM wa_conversation_identities').get()).toEqual(before);
    expect(
      db.prepare('SELECT count(*) n FROM wa_contacts WHERE phone_number IS NOT NULL').get(),
    ).toEqual({ n: 0 });
    const command = repo.poll({ extensionInstanceId, identity }).command!;
    expect(command).toMatchObject({
      id: created.id,
      locateByPhone: true,
      recipientPhone: '+12025550199',
      target: { accountId: identity.accountId, type: 'PHONE', referenceKey: '+12025550199' },
    });
    expect(command.conversationId).toBeUndefined();
    expect(db.pragma('foreign_key_check')).toEqual([]);
  } finally {
    db.close();
  }
});
it('replays normalized requests after context expiry without rebinding accounts or creating another send', () => {
  const { db, repo, identity, extensionInstanceId, request, setTime } = setup();
  try {
    repo.poll({ extensionInstanceId, identity });
    const created = repo.createToNumber(request, 'synthetic-direct-replay-key');
    setTime('2026-10-18T12:01:00.000Z');
    expect(
      repo.createToNumber(
        { ...request, phoneNumber: '+12025550199' },
        'synthetic-direct-replay-key',
      ),
    ).toMatchObject({ id: created.id, inserted: false });
    expect(() =>
      repo.createToNumber(
        { ...request, text: 'Different synthetic intent' },
        'synthetic-direct-replay-key',
      ),
    ).toThrow('IDEMPOTENCY_CONFLICT');
    expect(db.prepare('SELECT count(*) n FROM wa_outbox').get()).toEqual({ n: 1 });
  } finally {
    db.close();
  }
});
it('requires one fresh opted-in account and never guesses international prefixes', () => {
  const { db, repo, identity, extensionInstanceId, request, setTime } = setup();
  try {
    expect(() => repo.createToNumber(request, 'synthetic-no-active-account')).toThrow(
      'ACTIVE_SEND_ACCOUNT_REQUIRED',
    );
    repo.poll({ extensionInstanceId, identity, allowClaim: false });
    expect(() => repo.createToNumber(request, 'synthetic-disabled-account')).toThrow(
      'ACTIVE_SEND_ACCOUNT_REQUIRED',
    );
    repo.poll({ extensionInstanceId, identity });
    const second = { ...identity, accountId: randomUUID() };
    repo.poll({ extensionInstanceId: randomUUID(), identity: second });
    expect(() => repo.createToNumber(request, 'synthetic-ambiguous-account')).toThrow(
      'AMBIGUOUS_SEND_ACCOUNT',
    );
    expect(
      repo.createToNumber(
        { ...request, accountId: identity.accountId },
        'synthetic-explicit-account',
      ).status,
    ).toBe('REQUESTED');
    expect(() =>
      repo.createToNumber(
        { ...request, accountId: randomUUID() },
        'synthetic-wrong-active-account',
      ),
    ).toThrow('ACTIVE_SEND_ACCOUNT_REQUIRED');
    expect(() =>
      repo.createToNumber({ ...request, phoneNumber: '2025550199' }, 'synthetic-no-country-prefix'),
    ).toThrow();
    setTime('2026-10-18T12:00:16.000Z');
    expect(() =>
      repo.createToNumber(
        { ...request, accountId: identity.accountId },
        'synthetic-expired-account',
      ),
    ).toThrow('ACTIVE_SEND_ACCOUNT_REQUIRED');
  } finally {
    db.close();
  }
});

it('queues while the tab is hidden, then registers the proven new contact before send authorization', () => {
  const { db, repo, identity, extensionInstanceId, request } = setup();
  try {
    repo.poll({ extensionInstanceId, identity, ready: false });
    const created = repo.createToNumber(request, 'synthetic-hidden-then-visible');
    expect(repo.poll({ extensionInstanceId, identity, ready: false }).command).toBeNull();
    const command = repo.poll({ extensionInstanceId, identity, ready: true }).command!;
    const step = {
      extensionInstanceId,
      commandId: created.id,
      leaseToken: command.leaseToken,
      contextId: command.contextId,
      step: 'WAITING_AUTO_SEND',
      code: 'SYNTHETIC_PROOF',
    };
    expect(() => repo.progress(step)).toThrow('RECIPIENT_PROOF_REQUIRED');
    const resolvedIdentity = {
      ...identity,
      contextId: randomUUID(),
      conversationKey: randomUUID(),
      phone: '+12025550199',
    };
    expect(() =>
      repo.progress({
        ...step,
        resolvedIdentity: { ...resolvedIdentity, phone: '+12025550198' },
        conversationLabel: 'Synthetic new contact',
      }),
    ).toThrow('RECIPIENT_PROOF_REQUIRED');
    expect(
      repo.progress({ ...step, resolvedIdentity, conversationLabel: 'Synthetic new contact' })
        .status,
    ).toBe('WAITING_AUTO_SEND');
    expect(
      db
        .prepare('SELECT display_name,phone_number FROM wa_contacts WHERE phone_number=?')
        .get('+12025550199'),
    ).toEqual({ display_name: 'Synthetic new contact', phone_number: '+12025550199' });
    expect(db.pragma('foreign_key_check')).toEqual([]);
  } finally {
    db.close();
  }
});

it('resolves names in the active account, rejects ambiguity and replays the original intent after rename/expiry', () => {
  const { db, repo, identity, extensionInstanceId, setTime } = setup();
  try {
    repo.poll({
      extensionInstanceId,
      identity: { ...identity, phone: '+12025550199' },
      conversationLabel: 'Synthetic Espósa Person',
    });
    const request = {
      recipientName: 'esposa',
      text: 'Synthetic named request',
      explicitAuthorization: true,
    };
    const created = repo.createToName(request, 'synthetic-by-name-request');
    expect(repo.poll({ extensionInstanceId, identity }).command?.recipientPhone).toBe(
      '+12025550199',
    );
    repo.poll({
      extensionInstanceId,
      identity: {
        ...identity,
        conversationKey: randomUUID(),
        contextId: randomUUID(),
        phone: '+12025550198',
      },
      conversationLabel: 'Synthetic esposa namesake',
    });
    expect(() => repo.createToName(request, 'synthetic-ambiguous-name')).toThrow(
      'AMBIGUOUS_RECIPIENT',
    );
    expect(() =>
      repo.createToName({ ...request, recipientName: 'missing' }, 'synthetic-missing-name'),
    ).toThrow('RECIPIENT_NAME_NOT_FOUND');
    repo.poll({
      extensionInstanceId,
      identity: { ...identity, conversationKey: randomUUID(), contextId: randomUUID() },
      conversationLabel: 'Synthetic no phone',
    });
    expect(() =>
      repo.createToName({ ...request, recipientName: 'no phone' }, 'synthetic-missing-phone'),
    ).toThrow('RECIPIENT_PHONE_REQUIRED');
    db.prepare('UPDATE wa_contacts SET display_name=?').run('Synthetic renamed');
    setTime('2026-10-18T12:01:00.000Z');
    expect(repo.createToName(request, 'synthetic-by-name-request')).toMatchObject({
      id: created.id,
      inserted: false,
    });
    expect(() =>
      repo.createToName({ ...request, text: 'Changed' }, 'synthetic-by-name-request'),
    ).toThrow('IDEMPOTENCY_CONFLICT');
    expect(db.prepare('SELECT count(*) n FROM wa_outbox').get()).toEqual({ n: 1 });
  } finally {
    db.close();
  }
});

it('advertises a hidden pending intent and supervises cancellation using the original lease without claiming twice', () => {
  const { db, repo, identity, extensionInstanceId, request } = setup();
  try {
    repo.poll({
      extensionInstanceId,
      identity,
      ready: false,
      reason: 'TAB_HIDDEN',
      protocolVersion: 2,
    });
    const created = repo.createToNumber(request, 'synthetic-responsive-delivery');
    expect(
      repo.poll({
        extensionInstanceId,
        identity,
        ready: false,
        reason: 'TAB_HIDDEN',
        protocolVersion: 2,
      }),
    ).toEqual({ command: null, pending: true });
    expect(repo.diagnostics()).toMatchObject({
      bridge: 'TAB_HIDDEN',
      protocolVersion: 2,
      ready: false,
      queue: [{ status: 'REQUESTED', count: 1 }],
    });
    const command = repo.poll({ extensionInstanceId, identity, ready: true }).command!;
    const activeCommand = {
      id: command.id,
      contextId: command.contextId,
      leaseToken: command.leaseToken,
    };
    expect(
      repo.poll({
        extensionInstanceId,
        identity,
        activeCommand,
        ready: false,
        reason: 'EXECUTING',
      }),
    ).toMatchObject({ command: null, activeStatus: 'CLAIMED' });
    expect(() =>
      repo.poll({
        extensionInstanceId,
        identity,
        activeCommand: { ...activeCommand, leaseToken: randomUUID() },
      }),
    ).toThrow('SEND_LEASE_MISMATCH');
    repo.cancel(created.id);
    expect(repo.poll({ extensionInstanceId, identity, activeCommand, ready: false })).toMatchObject(
      { command: null, activeStatus: 'CANCELLED' },
    );
    expect(db.prepare('SELECT attempt_count FROM wa_outbox WHERE id=?').get(created.id)).toEqual({
      attempt_count: 1,
    });
    repo.poll({
      extensionInstanceId,
      allowClaim: false,
      ready: false,
      reason: 'CONTENT_UNREACHABLE',
      protocolVersion: 2,
    });
    expect(repo.diagnostics()).toMatchObject({
      bridge: 'CONTENT_UNREACHABLE',
      ready: false,
      queue: [],
    });
  } finally {
    db.close();
  }
});

it('does not silently choose the last account when one extension instance monitors two accounts', () => {
  const { db, repo, identity, extensionInstanceId, request } = setup();
  try {
    repo.poll({
      extensionInstanceId,
      identity,
      ready: false,
      visible: true,
      reason: 'READY',
      protocolVersion: 2,
      clientBuild: 'synthetic-build',
    });
    repo.poll({
      extensionInstanceId,
      identity: { ...identity, accountId: randomUUID() },
      ready: false,
      visible: true,
      reason: 'READY',
      protocolVersion: 2,
      clientBuild: 'synthetic-build',
    });
    expect(() => repo.createToNumber(request, 'synthetic-same-instance-accounts')).toThrow(
      'AMBIGUOUS_SEND_ACCOUNT',
    );
    expect(repo.diagnostics()).toMatchObject({
      bridge: 'READY',
      ready: true,
      build: 'synthetic-build',
    });
    repo.poll({
      extensionInstanceId,
      allowClaim: false,
      ready: false,
      reason: 'NO_MONITORED_CONTEXT',
      protocolVersion: 2,
      clientBuild: 'synthetic-build',
    });
    expect(() => repo.createToNumber(request, 'synthetic-context-revoked')).toThrow(
      'ACTIVE_SEND_ACCOUNT_REQUIRED',
    );
  } finally {
    db.close();
  }
});
