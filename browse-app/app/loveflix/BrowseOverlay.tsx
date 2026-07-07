// LoveFlix-branded overlay shown over the Voronoi canvas while the couple's
// videos + engine load, plus empty/error states. Pure inline styles so it
// doesn't depend on the upstream Tailwind theme.

import { useEffect, useState } from 'react'
import { store } from '../store'
import { getLoveflixError, loadLoveflixVideos } from './loveflix'

type Status = 'loading' | 'ready' | 'empty' | 'error'

const VOID_BLACK = '#141414'
const CRIMSON = '#e50914'
const GOLD = '#c9a96e'

export function BrowseOverlay() {
  const [status, setStatus] = useState<Status>('loading')
  const [enginePreloaded, setEnginePreloaded] = useState(
    () => store.getState().voroforceMediaPreloaded,
  )

  useEffect(() => {
    let active = true
    loadLoveflixVideos()
      .then((videos) => {
        if (!active) return
        setStatus(videos.length ? 'ready' : 'empty')
      })
      .catch(() => {
        if (active) setStatus('error')
      })
    const unsub = store.subscribe(
      (s) => s.voroforceMediaPreloaded,
      (v) => setEnginePreloaded(v),
    )
    return () => {
      active = false
      unsub()
    }
  }, [])

  // Once we have videos and the engine has revealed, get out of the way.
  const hidden = status === 'ready' && enginePreloaded
  if (hidden) return null

  const spinner = status === 'loading' || (status === 'ready' && !enginePreloaded)

  return (
    <div
      // See BrowseAccessibleNav.tsx for why: the WebGL engine's Space/Enter
      // handler listens on `window` with no target check, so without this a
      // keyboard "Retry" press here would also re-trigger cell selection
      // (and an unrelated /player.html navigation) in the 3D grid underneath.
      onKeyDown={(e) => e.stopPropagation()}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 70,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '20px',
        padding: '24px',
        textAlign: 'center',
        background: VOID_BLACK,
        color: '#fff',
        fontFamily: "'Inter', system-ui, sans-serif",
      }}
    >
      {spinner && (
        <>
          <div
            style={{
              width: 54,
              height: 54,
              borderRadius: '50%',
              border: `4px solid rgba(255,255,255,0.12)`,
              borderTopColor: CRIMSON,
              animation: 'lf-spin 0.9s linear infinite',
            }}
          />
          <div style={{ color: '#a3a3a3', fontSize: 14, letterSpacing: 1 }}>
            Loading your collection…
          </div>
          <style>{'@keyframes lf-spin{to{transform:rotate(360deg)}}'}</style>
        </>
      )}

      {status === 'empty' && (
        <>
          <h1
            style={{
              fontFamily: "'Bebas Neue', sans-serif",
              fontSize: 52,
              letterSpacing: 2,
              lineHeight: 1,
              color: GOLD,
            }}
          >
            No memories yet
          </h1>
          <p style={{ color: '#a3a3a3', fontSize: 15, maxWidth: 420 }}>
            Upload your first video in the Creator Studio and it will appear
            here in your Browse gallery.
          </p>
          <a
            href="/creator.html"
            style={{
              marginTop: 8,
              background: CRIMSON,
              color: '#fff',
              padding: '12px 22px',
              borderRadius: 4,
              fontWeight: 600,
              fontSize: 14,
              textDecoration: 'none',
            }}
          >
            Open Creator Studio
          </a>
        </>
      )}

      {status === 'error' && (
        <>
          <h1
            style={{
              fontFamily: "'Bebas Neue', sans-serif",
              fontSize: 44,
              letterSpacing: 2,
              color: '#fff',
            }}
          >
            Couldn't load your videos
          </h1>
          <p style={{ color: '#a3a3a3', fontSize: 14, maxWidth: 420 }}>
            {getLoveflixError()?.message ?? 'Please try again.'}
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{
              marginTop: 8,
              background: 'transparent',
              color: '#fff',
              border: '1px solid rgba(255,255,255,0.3)',
              padding: '12px 22px',
              borderRadius: 4,
              fontSize: 14,
              cursor: 'pointer',
            }}
          >
            Retry
          </button>
        </>
      )}
    </div>
  )
}
