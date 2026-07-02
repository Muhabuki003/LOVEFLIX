import { useEffect, useState, useRef } from 'react'
import { store } from './store'
import { initVoroforce } from './vf'
import { adaptiveQuality } from './vf/integrations/ticker'
import { VOROFORCE_PRESET } from './vf/consts'
import { LOVEFLIX_ENABLED } from './loveflix/loveflix'

export function Voroforce() {
  const [error, setError] = useState<Error | null>(null)
  const adaptiveSubRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    const tryInit = () => {
      try {
        initVoroforce()
      } catch (e) {
        setError(e as Error)
      }
    }

    // attempt initial
    void tryInit()
    const unsub = store.subscribe(
      (s) => s.preset,
      () => {
        setTimeout(() => {
          void tryInit()
        }, 700)
      },
    )

    // Wire adaptive quality into the store and apply preset/scale changes
    // This connects after ticker initializes adaptiveQuality
    const checkInterval = setInterval(() => {
      if (adaptiveQuality) {
        clearInterval(checkInterval)
        adaptiveSubRef.current = adaptiveQuality.subscribe((quality) => {
          const state = store.getState()

          // Update quality level in store
          store.setState({
            qualityLevel: quality.qualityLevel,
          })

          // In LoveFlix mode, never switch to mobile — that preset disables
          // media textures and causes a black screen. Use renderScale/frameSkip only.
          if (quality.qualityLevel === 'low' && state.voroforce && !LOVEFLIX_ENABLED) {
            store.getState().setPreset(state.preset ?? VOROFORCE_PRESET.mobile)
          }

          // When factor is medium but not low, use minimal with reduced cells
          if (quality.qualityLevel === 'medium' && state.voroforce) {
            // Engine-level rate limiting via frameSkip
            const config = state.voroforce.config
            config.frameSkipCount = 1
          }

          // Apply render scale — this is the single biggest perf gain
          if (state.voroforce && quality.renderScale < 1) {
            state.voroforce.config.renderScale = quality.renderScale
          }
        })
      }
    }, 500)

    // WebGL context loss handling — especially important on mobile where the
    // browser can reclaim GPU memory. Prevent the default (so the browser tries
    // to restore) and reinitialize cleanly once the context is back.
    const canvas = document
      .getElementById('voroforce')
      ?.querySelector('canvas') as HTMLCanvasElement | null
    const onLost = (e: Event) => e.preventDefault()
    const onRestored = () => window.location.reload()
    canvas?.addEventListener('webglcontextlost', onLost, false)
    canvas?.addEventListener('webglcontextrestored', onRestored, false)

    return () => {
      clearInterval(checkInterval)
      unsub()
      adaptiveSubRef.current?.()
      canvas?.removeEventListener('webglcontextlost', onLost)
      canvas?.removeEventListener('webglcontextrestored', onRestored)
    }
  }, [])

  if (error) {
    throw error
  }

  return null
}
