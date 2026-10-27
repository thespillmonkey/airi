import type { ExecApprovalPendingView } from 'openclaw/plugin-sdk/approval-handler-runtime'
import type { ExecApprovalRequest } from 'openclaw/plugin-sdk/approval-runtime'

import { describe, expect, it, vi } from 'vitest'

import { createApprovals } from './approvals'
import { createRegistry } from './registry'

function fixture() {
  const registry = createRegistry()
  const principal = { principalId: 'gary', tokenEnv: 'AIRI_TEST_TOKEN', agentIds: ['mitsuki'] }
  const connection = { send: vi.fn(), close: vi.fn() }
  const conversation = registry.attach(principal, { version: 1, type: 'hello', token: 'fixture', clientId: 'client', conversationId: 'chat', agentId: 'mitsuki' }, connection, peer => `agent:mitsuki:airi:${peer}`)
  const capability = createApprovals({ clients: [principal], allowedOrigins: [] }, registry, () => true)
  const native = capability.nativeRuntime
  if (!native)
    throw new Error('Missing native approval subscription adapter')
  const request: ExecApprovalRequest = {
    id: 'approval-a',
    createdAtMs: 1000,
    expiresAtMs: 10000,
    request: { command: 'printf approval', sessionKey: conversation.sessionKey, turnSourceChannel: 'airi', turnSourceTo: `airi:${conversation.peerId}` },
  }
  const baseView = { approvalId: 'approval-a', approvalKind: 'exec' as const, title: 'Execution approval', commandText: 'printf approval', metadata: [] }
  const view: ExecApprovalPendingView = {
    ...baseView,
    phase: 'pending',
    expiresAtMs: 10000,
    actions: [
      { decision: 'allow-once', label: 'Allow once', style: 'primary', command: '/approve exact-owned-id allow-once' },
      { decision: 'deny', label: 'Deny', style: 'danger', command: '/approve exact-owned-id deny' },
    ],
  }
  const context = { cfg: {}, accountId: 'default', request, approvalKind: 'exec' as const }
  const plannedTarget = { surface: 'origin' as const, target: { to: `airi:${conversation.peerId}` }, reason: 'preferred' as const }
  return { registry, connection, conversation, capability, native, request, view, baseView, context, plannedTarget }
}

describe('public native approval adapter', () => {
  it('delivers exact-source pending actions, preserves canonical commands, and acknowledges the recorded resolution', async () => {
    const f = fixture()
    expect(f.native.availability.shouldHandle(f.context)).toBe(true)
    const pendingPayload = await f.native.presentation.buildPendingPayload({ ...f.context, nowMs: 1000, view: f.view })
    const prepared = await f.native.transport.prepareTarget({ ...f.context, plannedTarget: f.plannedTarget, view: f.view, pendingPayload })
    expect(prepared).not.toBeNull()
    if (!prepared)
      throw new Error('Missing prepared target')
    const entry = await f.native.transport.deliverPending({ ...f.context, plannedTarget: f.plannedTarget, preparedTarget: prepared.target, view: f.view, pendingPayload })
    expect(f.connection.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'approval.request', approvalId: 'approval-a', allowedDecisions: ['allow-once', 'deny'], expiresAt: 10000 }))
    expect(() => f.registry.resolveApproval(f.conversation, 'approval-a', 'allow-always')).toThrow('unavailable')
    expect(f.registry.resolveApproval(f.conversation, 'approval-a', 'allow-once')).toBe('/approve exact-owned-id allow-once')
    expect(f.conversation.approvals.has('approval-a')).toBe(true)
    const final = await f.native.presentation.buildResolvedResult({ cfg: {}, accountId: 'default', request: f.request, resolved: { id: 'approval-a', decision: 'allow-once', ts: 1200 }, view: { ...f.baseView, phase: 'resolved', decision: 'allow-once' }, entry })
    if (final.kind !== 'update' || !f.native.transport.updateEntry)
      throw new Error('Missing native resolution transport')
    await f.native.transport.updateEntry({ ...f.context, entry, payload: final.payload, phase: 'resolved' })
    expect(f.conversation.approvals.has('approval-a')).toBe(false)
    expect(f.connection.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'approval.resolved', approvalId: 'approval-a', status: 'resolved', decision: 'allow-once', sequence: 1 }))
    f.registry.dispose()
  })

  it('rejects cross-conversation native targets and unauthorized actors', async () => {
    const f = fixture()
    expect(f.native.availability.shouldHandle({ ...f.context, request: { ...f.request, request: { ...f.request.request, turnSourceChannel: 'discord' } } })).toBe(false)
    expect(f.native.availability.shouldHandle({ ...f.context, request: { ...f.request, request: { ...f.request.request, sessionKey: 'another-session' } } })).toBe(false)
    expect(f.capability.authorizeActorAction?.({ cfg: {}, senderId: 'other-person', action: 'approve', approvalKind: 'exec', request: f.request }).authorized).toBe(false)
    const pendingPayload = await f.native.presentation.buildPendingPayload({ ...f.context, nowMs: 1000, view: f.view })
    const prepared = await f.native.transport.prepareTarget({ ...f.context, plannedTarget: { ...f.plannedTarget, target: { to: 'another-client' } }, view: f.view, pendingPayload })
    expect(prepared).toBeNull()
    expect(f.connection.send).not.toHaveBeenCalled()
    f.registry.dispose()
  })

  it('clears expired native requests and replays their terminal state after reconnect', async () => {
    const f = fixture()
    const pendingPayload = await f.native.presentation.buildPendingPayload({ ...f.context, nowMs: 1000, view: f.view })
    const prepared = await f.native.transport.prepareTarget({ ...f.context, plannedTarget: f.plannedTarget, view: f.view, pendingPayload })
    if (!prepared)
      throw new Error('Missing prepared target')
    const entry = await f.native.transport.deliverPending({ ...f.context, plannedTarget: f.plannedTarget, preparedTarget: prepared.target, view: f.view, pendingPayload })
    const final = await f.native.presentation.buildExpiredResult({ cfg: {}, accountId: 'default', request: f.request, view: { ...f.baseView, phase: 'expired' }, entry })
    if (final.kind !== 'update' || !f.native.transport.updateEntry)
      throw new Error('Missing expiry transport')
    f.registry.disconnect(f.conversation, f.connection)
    await f.native.transport.updateEntry({ ...f.context, entry, payload: final.payload, phase: 'expired' })
    expect(f.conversation.approvals.size).toBe(0)
    const reconnected = { send: vi.fn(), close: vi.fn() }
    f.registry.attach(f.conversation.principal, { version: 1, type: 'hello', token: 'fixture', clientId: 'client', conversationId: 'chat', agentId: 'mitsuki', lastSequence: 0 }, reconnected, peer => `agent:mitsuki:airi:${peer}`)
    f.registry.replay(f.conversation, 0)
    expect(reconnected.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'approval.resolved', status: 'expired', sequence: 1 }))
    f.registry.dispose()
  })
})
