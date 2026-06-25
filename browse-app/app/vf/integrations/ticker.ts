import type { VisibilityChangeEvent } from '√'
import { store } from '../../store'
import { handleTransitioningUniforms, initPerformanceMonitor } from '../utils'
import { initAdaptiveQuality } from '../utils/adaptive-quality'
import type { AdaptiveQualityApi } from '../utils/adaptive-quality'
import { VOROFORCE_PRESET } from '../consts'

export let adaptiveQuality: AdaptiveQualityApi | undefined

export const handleTicker = () => {
  const {
    voroforce,
    configUniforms: { transitioning: transitioningUniforms },
    estimatedDeviceClass,
  } = store.getState()

  if (!voroforce) return

  const performanceMonitor = initPerformanceMonitor()
  store.setState({
    performanceMonitor,
  })

  // Initialize adaptive quality system
  const deviceClass = estimatedDeviceClass ?? store.getState().deviceClass ?? 1
  adaptiveQuality = initAdaptiveQuality(performanceMonitor, deviceClass)
  store.setState({
    qualityLevel: adaptiveQuality.qualityLevel,
  })

  voroforce.ticker.listen('tick', (() => {
    handleTransitioningUniforms(transitioningUniforms)
    performanceMonitor.onTick()
  }) as unknown as EventListener)

  voroforce.listen('visibilityChange', ((e: VisibilityChangeEvent) => {
    performanceMonitor.onVisibilityChange(e.visible)
  }) as unknown as EventListener)

  // Listen for quality changes and update the store / engine config
  adaptiveQuality.subscribe((quality) => {
    const state = store.getState()
    store.setState({
      qualityLevel: quality.qualityLevel,
    })

    // When quality suggests changing preset, update it
    if (quality.suggestedPreset && state.voroforce) {
      const currentPreset = state.preset
      const suggested = quality.suggestedPreset

      // Only switch if the suggested preset is more conservative
      const presetPriority: Record<string, number> = {
        [VOROFORCE_PRESET.mobile]: 0,
        [VOROFORCE_PRESET.minimal]: 1,
        [VOROFORCE_PRESET.contours]: 2,
        [VOROFORCE_PRESET.depth]: 2,
        [VOROFORCE_PRESET.chaos]: 2,
      }

      if (
        currentPreset &&
        (presetPriority[suggested as string] ?? 0) < (presetPriority[currentPreset] ?? 2)
      ) {
        store.getState().setPreset(suggested as VOROFORCE_PRESET)
      }
    }

    // Apply render scale to the engine
    if (state.voroforce && quality.renderScale < 1) {
      const config = state.voroforce.config
      config.renderScale = quality.renderScale
    }
  })
}
