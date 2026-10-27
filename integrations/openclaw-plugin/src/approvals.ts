import type { ServerMessage } from '@proj-airi/openclaw-bridge/contracts'
import type { ChannelApprovalNativeAvailabilityAdapter } from 'openclaw/plugin-sdk/approval-handler-runtime'
import type { ChannelPlugin } from 'openclaw/plugin-sdk/channel-core'

import type { Config } from './config'
import type { Conversation, Registry } from './registry'

import { createLazyChannelApprovalNativeRuntimeAdapter } from 'openclaw/plugin-sdk/approval-handler-adapter-runtime'
import { createChannelApprovalNativeRuntimeAdapter } from 'openclaw/plugin-sdk/approval-handler-runtime'
import { createApproverRestrictedNativeApprovalCapability } from 'openclaw/plugin-sdk/approval-runtime'

type ApprovalRequest = Parameters<ChannelApprovalNativeAvailabilityAdapter['shouldHandle']>[0]['request']

interface Pending {
  request: Extract<ServerMessage, { type: 'approval.request' }>
  commands: readonly { decision: NonNullable<Extract<ServerMessage, { type: 'approval.request' }>['allowedDecisions']>[number], command: string }[]
}
interface Entry { conversation: Conversation, approvalId: string }
type Resolution = Omit<Extract<ServerMessage, { type: 'approval.resolved' }>, 'sequence'>

/** Core owns the native subscription and reviewer policy. This adapter owns exact-client presentation and acknowledgement. */
export function createApprovals(config: Config, registry: Registry, isRunning: () => boolean): NonNullable<ChannelPlugin['approvalCapability']> {
  function target(request: ApprovalRequest) {
    if (request.request.turnSourceChannel !== 'airi' || !request.request.sessionKey)
      return undefined
    const conversation = registry.approvalConversation(request.request.sessionKey)
    if (!conversation)
      return undefined
    const origin = request.request.turnSourceTo
    if (origin && origin !== conversation.peerId && origin !== `airi:${conversation.peerId}`)
      return undefined
    return conversation
  }
  const availability = {
    isConfigured: () => config.clients.length > 0,
    shouldHandle: ({ request }: { request: ApprovalRequest }) => target(request) !== undefined,
  }
  const native = createChannelApprovalNativeRuntimeAdapter<Pending, Conversation, Entry, undefined, Resolution>({
    eventKinds: ['exec', 'plugin', 'system-agent'],
    availability,
    presentation: {
      buildPendingPayload: ({ request, approvalKind, view }) => ({
        request: {
          version: 1,
          type: 'approval.request',
          approvalId: request.id,
          kind: approvalKind,
          description: [view.title, view.description, 'commandText' in view ? view.commandText : undefined].filter(Boolean).join('\n'),
          expiresAt: view.expiresAtMs,
          allowedDecisions: view.actions.map(action => action.decision),
        },
        commands: view.actions.map(action => ({ decision: action.decision, command: action.command })),
      }),
      buildResolvedResult: ({ view }) => ({
        kind: 'update',
        payload: {
          version: 1,
          type: 'approval.resolved',
          approvalId: view.approvalId,
          status: 'terminalStatus' in view && view.terminalStatus === 'cancelled' ? 'cancelled' : 'resolved',
          decision: view.decision,
          applicationStatus: 'applicationStatus' in view ? view.applicationStatus : undefined,
        },
      }),
      buildExpiredResult: ({ view }) => ({
        kind: 'update',
        payload: { version: 1, type: 'approval.resolved', approvalId: view.approvalId, status: 'expired' },
      }),
    },
    transport: {
      prepareTarget: ({ plannedTarget, request }) => {
        const conversation = target(request)
        if (!conversation || ![conversation.peerId, `airi:${conversation.peerId}`].includes(plannedTarget.target.to))
          return null
        return { dedupeKey: `${conversation.sessionKey}:${request.id}`, target: conversation }
      },
      deliverPending: async ({ preparedTarget, pendingPayload }) => {
        registry.recordApproval(preparedTarget, pendingPayload.request.approvalId, pendingPayload.request, pendingPayload.commands)
        return { conversation: preparedTarget, approvalId: pendingPayload.request.approvalId }
      },
      updateEntry: async ({ entry, payload }) => {
        registry.settleApproval(entry.conversation, payload)
      },
    },
    interactions: {
      cancelDelivered: ({ entry }) => {
        registry.settleApproval(entry.conversation, { version: 1, type: 'approval.resolved', approvalId: entry.approvalId, status: 'cancelled' })
      },
    },
  })

  return createApproverRestrictedNativeApprovalCapability({
    channel: 'airi',
    channelLabel: 'AIRI',
    listAccountIds: () => ['default'],
    hasApprovers: () => config.clients.length > 0,
    isExecAuthorizedSender: ({ senderId }) => config.clients.some(client => client.principalId === senderId),
    isNativeDeliveryEnabled: () => isRunning(),
    resolveNativeDeliveryMode: () => 'channel',
    requireMatchingTurnSourceChannel: true,
    resolveOriginTarget: ({ request }) => {
      const conversation = target(request)
      return conversation ? { to: `airi:${conversation.peerId}` } : null
    },
    nativeRuntime: createLazyChannelApprovalNativeRuntimeAdapter({
      load: async () => native,
      ...availability,
      eventKinds: ['exec', 'plugin', 'system-agent'],
      capabilityBoundary: true,
    }),
  })
}
