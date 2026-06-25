import type { PerformanceMonitorApi } from './performance-monitor'
import { store } from '../../store'
import { VOROFORCE_PRESET, DEVICE_CLASS, CELL_LIMIT } from '../consts'

export type QualityLevel = 'ultra' | 'high' | 'medium' | 'low' | 'potato'

export type QualitySubscriber = (quality: {
  qualityLevel: QualityLevel
  renderScale: number
  frameSkipIdle: number
  suggestedPreset?: string
}) => void

export interface AdaptiveQualityApi {
  qualityLevel: QualityLevel
  cellLimit: number
  pixelSearchRadius: number
  renderScale: number
  postProcessing: boolean
  noiseEnabled: boolean
  bulgeEnabled: boolean
  rippleEnabled: boolean
  edgesEnabled: boolean
  mediaEnabled: boolean
  simulationAlpha: number
  simulationVelocityDecay: number
  frameSkipIdle: number
  performance: PerformanceMonitorApi
  suggestedPreset?: string
  subscribe: (fn: QualitySubscriber) => () => void
}

type QualityConfig = {
  cellLimit: number
  pixelSearchRadius: number
  renderScale: number
  postProcessing: boolean
  noiseEnabled: boolean
  bulgeEnabled: boolean
  rippleEnabled: boolean
  edgesEnabled: boolean
  mediaEnabled: boolean
  simulationAlpha: number
  simulationVelocityDecay: number
  frameSkipIdle: number
}

const QUALITY_CONFIGS: Record<QualityLevel, QualityConfig> = {
  ultra: {
    cellLimit: CELL_LIMIT.lg,
    pixelSearchRadius: 16,
    renderScale: 1,
    postProcessing: true,
    noiseEnabled: true,
    bulgeEnabled: true,
    rippleEnabled: true,
    edgesEnabled: true,
    mediaEnabled: true,
    simulationAlpha: 0.15,
    simulationVelocityDecay: 0.7,
    frameSkipIdle: 0,
  },
  high: {
    cellLimit: CELL_LIMIT.md,
    pixelSearchRadius: 12,
    renderScale: 1,
    postProcessing: true,
    noiseEnabled: true,
    bulgeEnabled: true,
    rippleEnabled: false,
    edgesEnabled: true,
    mediaEnabled: true,
    simulationAlpha: 0.15,
    simulationVelocityDecay: 0.7,
    frameSkipIdle: 0,
  },
  medium: {
    cellLimit: CELL_LIMIT.sm,
    pixelSearchRadius: 8,
    renderScale: 1,
    postProcessing: true,
    noiseEnabled: false,
    bulgeEnabled: true,
    rippleEnabled: false,
    edgesEnabled: true,
    mediaEnabled: true,
    simulationAlpha: 0.12,
    simulationVelocityDecay: 0.65,
    frameSkipIdle: 1,
  },
  low: {
    cellLimit: CELL_LIMIT.xs,
    pixelSearchRadius: 4,
    renderScale: 0.75,
    postProcessing: false,
    noiseEnabled: false,
    bulgeEnabled: false,
    rippleEnabled: false,
    edgesEnabled: true,
    mediaEnabled: true,
    simulationAlpha: 0.1,
    simulationVelocityDecay: 0.6,
    frameSkipIdle: 2,
  },
  potato: {
    cellLimit: CELL_LIMIT.xxs,
    pixelSearchRadius: 0,
    renderScale: 0.5,
    postProcessing: false,
    noiseEnabled: false,
    bulgeEnabled: false,
    rippleEnabled: false,
    edgesEnabled: false,
    mediaEnabled: false,
    simulationAlpha: 0.08,
    simulationVelocityDecay: 0.5,
    frameSkipIdle: 3,
  },
}

const QUALITY_ORDER: QualityLevel[] = ['potato', 'low', 'medium', 'high', 'ultra']

const PRESET_FOR_LEVEL: Record<QualityLevel, string | undefined> = {
  potato: VOROFORCE_PRESET.mobile,
  low: VOROFORCE_PRESET.mobile,
  medium: VOROFORCE_PRESET.minimal,
  high: undefined,
  ultra: undefined,
}

function nextHigherLevel(current: QualityLevel): QualityLevel | null {
  const idx = QUALITY_ORDER.indexOf(current)
  if (idx >= QUALITY_ORDER.length - 1) return null
  return QUALITY_ORDER[idx + 1]
}

function nextLowerLevel(current: QualityLevel): QualityLevel | null {
  const idx = QUALITY_ORDER.indexOf(current)
  if (idx <= 0) return null
  return QUALITY_ORDER[idx - 1]
}

function initialQualityForDevice(deviceClass: number): QualityLevel {
  if (deviceClass <= DEVICE_CLASS.mobile) return 'low'
  if (deviceClass === DEVICE_CLASS.low) return 'medium'
  if (deviceClass === DEVICE_CLASS.mid) return 'high'
  return 'ultra'
}

export function initAdaptiveQuality(
  performanceMonitor: PerformanceMonitorApi,
  deviceClass: number,
): AdaptiveQualityApi {
  let currentLevel: QualityLevel = initialQualityForDevice(deviceClass)
  const subscribers = new Set<QualitySubscriber>()

  function notify() {
    const payload = {
      qualityLevel: currentLevel,
      renderScale: QUALITY_CONFIGS[currentLevel].renderScale,
      frameSkipIdle: QUALITY_CONFIGS[currentLevel].frameSkipIdle,
      suggestedPreset: PRESET_FOR_LEVEL[currentLevel],
    }
    for (const fn of subscribers) fn(payload)

    // Also update store quality level
    store.setState({
      qualityLevel: currentLevel,
    })

    // Apply engine-level changes
    const state = store.getState()
    if (state.voroforce) {
      state.voroforce.config.renderScale = QUALITY_CONFIGS[currentLevel].renderScale
      state.voroforce.config.frameSkipCount = QUALITY_CONFIGS[currentLevel].frameSkipIdle
      state.voroforce.config.cells = QUALITY_CONFIGS[currentLevel].cellLimit
    }
  }

  const quality: AdaptiveQualityApi = {
    get qualityLevel() { return currentLevel },
    get cellLimit() { return QUALITY_CONFIGS[currentLevel].cellLimit },
    get pixelSearchRadius() { return QUALITY_CONFIGS[currentLevel].pixelSearchRadius },
    get renderScale() { return QUALITY_CONFIGS[currentLevel].renderScale },
    get postProcessing() { return QUALITY_CONFIGS[currentLevel].postProcessing },
    get noiseEnabled() { return QUALITY_CONFIGS[currentLevel].noiseEnabled },
    get bulgeEnabled() { return QUALITY_CONFIGS[currentLevel].bulgeEnabled },
    get rippleEnabled() { return QUALITY_CONFIGS[currentLevel].rippleEnabled },
    get edgesEnabled() { return QUALITY_CONFIGS[currentLevel].edgesEnabled },
    get mediaEnabled() { return QUALITY_CONFIGS[currentLevel].mediaEnabled },
    get simulationAlpha() { return QUALITY_CONFIGS[currentLevel].simulationAlpha },
    get simulationVelocityDecay() { return QUALITY_CONFIGS[currentLevel].simulationVelocityDecay },
    get frameSkipIdle() { return QUALITY_CONFIGS[currentLevel].frameSkipIdle },
    get suggestedPreset() { return PRESET_FOR_LEVEL[currentLevel] },
    performance: performanceMonitor,
    subscribe: (fn: QualitySubscriber) => {
      subscribers.add(fn)
      return () => subscribers.delete(fn)
    },
  }

  // Wire performance monitor callbacks
  performanceMonitor.subscriptions.set(Symbol('adaptive-quality'), {
    onDecline: () => {
      const lower = nextLowerLevel(currentLevel)
      if (lower) {
        currentLevel = lower
        notify()
      }
    },
    onIncline: () => {
      const higher = nextHigherLevel(currentLevel)
      if (higher) {
        currentLevel = higher
        notify()
      }
    },
    onFallback: () => {
      currentLevel = nextLowerLevel(currentLevel) ?? currentLevel
      notify()
    },
  })

  return quality
}
