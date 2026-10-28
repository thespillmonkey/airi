import type { OpenClawPluginApi, PluginRuntime } from 'openclaw/plugin-sdk/channel-core'
import type { ChannelInboundTurnPlan } from 'openclaw/plugin-sdk/channel-inbound'

import { buildChannelInboundEventContext } from 'openclaw/plugin-sdk/channel-inbound'
import { buildAgentSessionKey } from 'openclaw/plugin-sdk/routing'
import { describe, expect, it, vi } from 'vitest'

import { createChannel } from './channel'
import { createRegistry } from './registry'

/** The fixture mocks the host runtime boundary. Real SDK routing and context code remain imported. */
function setup() {
  const dispatch = vi.fn<(plan: Omit<ChannelInboundTurnPlan, 'delivery'> & { delivery: ChannelInboundTurnPlan['delivery'] | ChannelInboundTurnPlan<'provider_message_sending'>['delivery'] }) => ReturnType<PluginRuntime['channel']['inbound']['dispatch']>>()
  const resolveStable = vi.fn<PluginRuntime['channel']['inbound']['ingress']['resolveStable']>()
  resolveStable.mockResolvedValue({ ingress: { admission: 'dispatch' }, commandAccess: { authorized: true } } as Awaited<ReturnType<typeof resolveStable>>)
  const buildContext = buildChannelInboundEventContext
  const cfg: OpenClawPluginApi['config'] = { agents: { entries: { mitsuki: {} } } }
  const ingressResolver: PluginRuntime['channel']['inbound']['ingress']['resolveStable'] = resolveStable
  const contextBuilder: PluginRuntime['channel']['inbound']['buildContext'] = buildContext
  const dispatcher: PluginRuntime['channel']['inbound']['dispatch'] = dispatch
  const runtime = {
    channel: {
      routing: { buildAgentSessionKey },
      inbound: { ingress: { resolveStable: ingressResolver }, buildContext: contextBuilder, dispatch: dispatcher },
    },
  } as PluginRuntime
  const api = {
    config: cfg,
    runtime,
  } as OpenClawPluginApi
  const principal = { principalId: 'gary', tokenEnv: 'AIRI_TEST_TOKEN', agentIds: ['mitsuki'] }
  const registry = createRegistry()
  const native = createChannel(api, { clients: [principal], allowedOrigins: [] }, registry)
  const connection = { send: vi.fn(), close: vi.fn() }
  const conversation = registry.attach(principal, {
    version: 1,
    type: 'hello',
    token: 'fixture',
    clientId: 'desktop',
    conversationId: 'chat',
    agentId: 'mitsuki',
  }, connection, peer => native.sessionKey({ agentId: 'mitsuki' }, peer))
  return { native, registry, conversation, connection, dispatch, resolveStable, buildContext }
}

describe('native OpenClaw channel adapter', () => {
  it('binds ingress to authenticated sender, selected agent, and stable session while forwarding sanitized output', async () => {
    const fixture = setup()
    fixture.dispatch.mockImplementation(async (plan) => {
      await plan.replyOptions?.onPartialReply?.({ text: 'Hello' })
      await plan.replyOptions?.onPartialReply?.({ text: 'Hello Gary' })
      await plan.delivery.deliver?.({ text: 'private reasoning', isReasoning: true }, { kind: 'final' })
      await plan.delivery.deliver?.({ text: 'Hello Gary' }, { kind: 'final' })
      return {
        admission: { kind: 'dispatch' },
        dispatched: true,
        ctxPayload: plan.ctxPayload,
        routeSessionKey: plan.route.sessionKey,
        dispatchResult: { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } },
      } as Awaited<ReturnType<PluginRuntime['channel']['inbound']['dispatch']>>
    })
    const controller = new AbortController()
    const result = await fixture.native.dispatch(fixture.conversation, {
      version: 1,
      type: 'user.message',
      messageId: 'message-a',
      text: 'Use your tools',
      input: 'voice',
    }, controller)
    expect(fixture.resolveStable).toHaveBeenCalledWith(expect.objectContaining({
      subject: { stableId: 'gary' },
      contextBinding: expect.objectContaining({ agentId: 'mitsuki', sessionKey: fixture.conversation.sessionKey, messageId: 'message-a' }),
    }))
    const plan = fixture.dispatch.mock.calls[0][0]
    expect(plan.ctxPayload.SenderId).toBe('gary')
    expect(plan.ctxPayload.BodyForAgent).toBe('Use your tools')
    expect(plan.replyOptions?.abortSignal).toBe(controller.signal)
    expect(plan.replyOptions?.disableTools).toBeUndefined()
    expect(plan.route.agentId).toBe('mitsuki')
    expect(plan.route.sessionKey).toContain('agent:mitsuki:airi:default:direct:')
    expect(fixture.connection.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'response.delta', text: 'Hello' }))
    expect(fixture.connection.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'response.delta', text: ' Gary' }))
    expect(result).toEqual({ text: 'Hello Gary', cancelled: false })
    expect(fixture.connection.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'response.final' }))
    expect(fixture.connection.send).not.toHaveBeenCalledWith(expect.objectContaining({ text: 'private reasoning' }))
    fixture.registry.dispose()
  })

  it('passes exact native cancellation and never emits a late response as spoken final content', async () => {
    const fixture = setup()
    const controller = new AbortController()
    fixture.dispatch.mockImplementation(async (plan) => {
      controller.abort()
      await plan.replyOptions?.onPartialReply?.({ text: 'Late preview' })
      await plan.delivery.deliver?.({ text: 'Late final' }, { kind: 'final' })
      return {
        admission: { kind: 'dispatch' },
        dispatched: true,
        ctxPayload: plan.ctxPayload,
        routeSessionKey: plan.route.sessionKey,
        dispatchResult: { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } },
      } as Awaited<ReturnType<PluginRuntime['channel']['inbound']['dispatch']>>
    })
    const result = await fixture.native.dispatch(fixture.conversation, { version: 1, type: 'user.message', messageId: 'message-a', text: 'Hello', input: 'text' }, controller)
    expect(fixture.dispatch.mock.calls[0][0].replyOptions?.abortSignal?.aborted).toBe(true)
    expect(result).toEqual({ text: '', cancelled: true })
    expect(fixture.connection.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'response.final' }))
    fixture.registry.dispose()
  })

  it('returns an empty terminal body when core intentionally returns no visible content', async () => {
    const fixture = setup()
    fixture.dispatch.mockImplementation(async plan => ({
      admission: { kind: 'dispatch' },
      dispatched: true,
      ctxPayload: plan.ctxPayload,
      routeSessionKey: plan.route.sessionKey,
      dispatchResult: { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } },
    }) as Awaited<ReturnType<PluginRuntime['channel']['inbound']['dispatch']>>)
    const result = await fixture.native.dispatch(fixture.conversation, { version: 1, type: 'user.message', messageId: 'silent-message', text: 'Stay silent', input: 'text' }, new AbortController())
    expect(result).toEqual({ text: '', cancelled: false })
    fixture.registry.dispose()
  })

  it('keeps the passive listener alive until abort and reports authenticated clients without faking a connection', async () => {
    const fixture = setup()
    fixture.registry.disconnect(fixture.conversation, fixture.connection)
    const start = fixture.native.channel.gateway?.startAccount
    if (!start)
      throw new Error('Missing account lifecycle')
    type Context = Parameters<typeof start>[0]
    let snapshot: ReturnType<Context['getStatus']> = { accountId: 'default' }
    const controller = new AbortController()
    const disposeContext = vi.fn()
    const registerContext = vi.fn<NonNullable<Context['channelRuntime']>['runtimeContexts']['register']>(() => ({ dispose: disposeContext }))
    const lifecycle = start({
      cfg: {},
      accountId: 'default',
      account: { accountId: 'default', enabled: true },
      runtime: { log: vi.fn(), error: vi.fn(), exit: () => { throw new Error('Unexpected exit') } },
      abortSignal: controller.signal,
      channelRuntime: { runtimeContexts: { register: registerContext, get: () => undefined, watch: () => () => {} } },
      getStatus: () => snapshot,
      setStatus: (next) => {
        snapshot = next
      },
    })
    expect(registerContext).toHaveBeenCalledWith(expect.objectContaining({ channelId: 'airi', accountId: 'default', capability: 'approval.native', context: {} }))
    expect(fixture.native.isRunning()).toBe(true)
    expect(snapshot.lifecycle).toBe('ready')
    expect(snapshot.connected).toBeUndefined()
    expect(snapshot.statusState).toBe('listening')
    expect(snapshot.stateReason).toBe('0 authenticated AIRI clients')
    controller.abort()
    await lifecycle
    expect(disposeContext).toHaveBeenCalled()
    expect(fixture.native.isRunning()).toBe(false)
    expect(snapshot.lifecycle).toBe('stopped')
    fixture.registry.dispose()
  })

  it('aggregates all final fragments only after native dispatch teardown completes', async () => {
    const fixture = setup()
    let release: (() => void) | undefined
    const teardown = new Promise<void>((resolve) => {
      release = resolve
    })
    fixture.dispatch.mockImplementation(async (plan) => {
      await plan.delivery.deliver?.({ text: 'First fragment' }, { kind: 'final' })
      await plan.delivery.deliver?.({ text: 'Second fragment' }, { kind: 'final' })
      await teardown
      return {
        admission: { kind: 'dispatch' },
        dispatched: true,
        ctxPayload: plan.ctxPayload,
        routeSessionKey: plan.route.sessionKey,
        dispatchResult: { queuedFinal: true, counts: { tool: 0, block: 0, final: 2 } },
      } as Awaited<ReturnType<PluginRuntime['channel']['inbound']['dispatch']>>
    })
    const result = fixture.native.dispatch(fixture.conversation, { version: 1, type: 'user.message', messageId: 'fragments', text: 'Hello', input: 'text' }, new AbortController())
    await Promise.resolve()
    expect(fixture.connection.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'response.final' }))
    release?.()
    await expect(result).resolves.toEqual({ text: 'First fragment\n\nSecond fragment', cancelled: false })
    fixture.registry.dispose()
  })
})
