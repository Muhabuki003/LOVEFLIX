import { useEffect, useState } from 'react'
import { store } from './store'
import { initVoroforce } from './vf'

export function Voroforce() {
  const [error, setError] = useState<Error | null>(null)

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
      unsub()
      canvas?.removeEventListener('webglcontextlost', onLost)
      canvas?.removeEventListener('webglcontextrestored', onRestored)
    }
  }, [])

  if (error) {
    throw error
  }

  return null
}
