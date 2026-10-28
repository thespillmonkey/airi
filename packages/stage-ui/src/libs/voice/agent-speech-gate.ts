/** Agent Mode uses half duplex for automatic input. Explicit user controls keep their interruption path. */
export function createAgentSpeechGate(options: { active: () => boolean, captureContext?: () => (() => boolean), now?: () => number, hangoverMs?: number }) {
  const now = options.now ?? (() => performance.now())
  const outputs = new Set<string>()
  let generation = 0
  let speaking = false
  let quietAfter = 0
  const hangover = () => {
    quietAfter = now() + (options.hangoverMs ?? 400)
  }
  function blocked() {
    return options.active() && (outputs.size > 0 || speaking || now() < quietAfter)
  }
  function captureAutomatic() {
    const isCurrent = options.captureContext?.() ?? (() => true)
    const captured = generation
    const admitted = !blocked()
    return () => isCurrent() && (!options.active() || (admitted && captured === generation && !blocked()))
  }
  return {
    outputStarted(id: string) {
      if (!outputs.has(id)) {
        outputs.add(id)
        generation += 1
      }
    },
    outputFinished(id: string) {
      if (outputs.delete(id))
        hangover()
    },
    setSpeaking(value: boolean) {
      if (value && !speaking)
        generation += 1
      if (!value && speaking)
        hangover()
      speaking = value
    },
    /** Recheck after asynchronous detectors and again before automatic transcript submission. */
    captureAutomatic,
    async acceptAutomatic(accept: () => boolean | Promise<boolean>) {
      const accepts = captureAutomatic()
      if (!accepts())
        return false
      return await accept() && accepts()
    },
  }
}
