<script setup lang="ts">
import { errorMessageFrom } from '@moeru/std'
import { Button, FieldInput, Textarea } from '@proj-airi/ui'
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'

import { useAgentModeStore } from '../../stores/agent-mode'
import { useChatSessionStore } from '../../stores/chat/session-store'

const mode = useAgentModeStore()
const sessions = useChatSessionStore()
const { t } = useI18n()
const expanded = ref(false)
const endpoint = ref(mode.endpoint)
const agent = ref(mode.agentId)
// The token stays in this control and the live transport. It is never persisted in application settings.
const token = ref('')
const voiceCatalog = ref(JSON.stringify(mode.configuredVoices, null, 2))
const failure = ref<string>()
const busy = ref(false)

async function selectMode() {
  failure.value = undefined
  try {
    await mode.selectMode(mode.active ? 'normal' : 'agent')
  }
  catch (cause) { failure.value = errorMessageFrom(cause) ?? 'Connection operation failed' }
}

async function saveVoiceCatalog() {
  failure.value = undefined
  try {
    await mode.setVoiceCatalog(voiceCatalog.value)
  }
  catch (cause) { failure.value = errorMessageFrom(cause) ?? 'Voice catalog is invalid' }
}

async function connect() {
  busy.value = true
  failure.value = undefined
  try {
    await mode.connect({ url: endpoint.value, token: token.value, agentId: agent.value, conversationId: sessions.activeSessionId })
    token.value = ''
  }
  catch (cause) { failure.value = errorMessageFrom(cause) ?? 'Connection operation failed' }
  finally { busy.value = false }
}
</script>

<template>
  <section :class="['absolute left-3 top-3 max-h-[85dvh] max-w-sm overflow-y-auto rounded-xl bg-neutral-50/95 p-3 text-neutral-900 shadow-sm dark:bg-neutral-900/95 dark:text-neutral-100']" :aria-label="t('stage.agent-mode.title')" @pointerdown.stop>
    <div :class="['flex items-center gap-2']">
      <Button size="sm" :aria-expanded="expanded" @click="expanded = !expanded">
        {{ mode.active ? t('stage.agent-mode.agent') : t('stage.agent-mode.normal') }}
      </Button>
      <span v-if="mode.active" role="status" :class="['text-xs']">{{ mode.agentId }} · {{ mode.connection }}</span>
    </div>
    <div v-if="expanded" :class="['mt-3 flex flex-col gap-3']">
      <p :class="['text-xs']">
        {{ t('stage.agent-mode.description') }}
      </p>
      <Button size="sm" @click="selectMode">
        {{ mode.active ? t('stage.agent-mode.return-normal') : t('stage.agent-mode.enable') }}
      </Button>
      <template v-if="mode.active">
        <FieldInput v-model="endpoint" :label="t('stage.agent-mode.endpoint')" placeholder="wss://host/plugins/airi/v1" />
        <FieldInput v-model="agent" :label="t('stage.agent-mode.agent-id')" />
        <FieldInput v-model="token" type="password" autocomplete="off" :label="t('stage.agent-mode.token')" />
        <Button size="sm" :loading="busy" @click="connect">
          {{ t('stage.agent-mode.connect') }}
        </Button>
        <Button v-if="mode.ready" size="sm" @click="mode.disconnect()">
          {{ t('stage.agent-mode.disconnect') }}
        </Button>
        <p :class="['text-xs']">
          {{ t('stage.agent-mode.disconnected-note') }}
        </p>
        <details>
          <summary :class="['text-xs']">
            {{ t('stage.agent-mode.voice-catalog') }}
          </summary>
          <label for="openclaw-voice-catalog" :class="['text-xs']">{{ t('stage.agent-mode.voice-catalog-description') }}</label>
          <Textarea id="openclaw-voice-catalog" v-model="voiceCatalog" :rows="5" />
          <Button size="sm" @click="saveVoiceCatalog">
            {{ t('stage.agent-mode.save-catalog') }}
          </Button>
        </details>
      </template>
      <p v-if="failure || mode.error" role="alert" :class="['text-xs text-red-600 dark:text-red-300']">
        {{ failure || mode.error }}
      </p>
    </div>
    <p v-if="mode.approvalFeedback" role="status" :class="['mt-2 text-xs']">
      {{ t(`stage.agent-mode.approval-${mode.approvalFeedback}`) }}
    </p>
    <div v-for="approval in mode.approvals" :key="approval.id" :class="['mt-3 flex flex-col gap-2']" role="alert">
      <p :class="['text-sm']">
        {{ approval.description }}
      </p>
      <div :class="['flex gap-2']">
        <Button v-if="approval.allowedDecisions.includes('allow-once')" :disabled="approval.resolving" size="sm" @click="mode.resolveApproval(approval.id, 'allow-once')">
          {{ t('stage.agent-mode.allow-once') }}
        </Button>
        <Button v-if="approval.allowedDecisions.includes('deny')" :disabled="approval.resolving" size="sm" @click="mode.resolveApproval(approval.id, 'deny')">
          {{ t('stage.agent-mode.deny') }}
        </Button>
      </div>
    </div>
  </section>
</template>
