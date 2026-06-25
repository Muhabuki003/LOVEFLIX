// Focused-cell UI for the Browse gallery, fed by the engine:
//   - a floating title that tracks the hovered tile, and
//   - a "little box in the corner" with the video's details.
// Both reflect the cell currently under the cursor. store.film is set by the
// controls integration on 'focused'; the floating title also reads the live
// focused-cell screen position from the voroforce ticker.

import { useEffect, useRef, useState } from 'react'
import { store } from '../store'
import type { Film } from '../vf'
import { formatVideoDate } from './loveflix'

const CRIMSON = '#e50914'
const GOLD = '#c9a96e'

const formatDuration = (seconds: number): string => {
  if (!seconds) return ''
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

export function LoveflixCellInfo() {
  const [film, setFilm] = useState<Film | undefined>(
    () => store.getState().film,
  )

  // Floating title element — positioned imperatively each tick for smoothness.
  const floatRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    return store.subscribe(
      (s) => s.film,
      (f) => setFilm(f),
    )
  }, [])

  // Track the focused cell's screen position and ride it with the title.
  useEffect(() => {
    const onTick = () => {
      const el = floatRef.current
      if (!el) return
      const focused = store.getState().voroforce?.cells?.focused
      if (focused && typeof focused.x === 'number' && typeof focused.y === 'number') {
        // DPR is locked to 1, so cell coords are CSS pixels.
        el.style.transform = `translate(${focused.x}px, ${focused.y}px)`
        el.style.opacity = '1'
      } else {
        el.style.opacity = '0'
      }
    }

    let attached: { ticker: { removeEventListener: (n: string, f: () => void) => void } } | null = null
    const attach = (vf: { ticker?: { addEventListener: (n: string, f: () => void) => void; removeEventListener: (n: string, f: () => void) => void } } | undefined) => {
      if (!vf?.ticker || attached) return
      vf.ticker.addEventListener('tick', onTick)
      attached = vf as never
    }

    attach(store.getState().voroforce as never)
    const unsub = store.subscribe(
      (s) => s.voroforce,
      (vf) => attach(vf as never),
    )
    return () => {
      unsub()
      attached?.ticker.removeEventListener('tick', onTick)
    }
  }, [])

  const video = film?.loveflix
  const visible = Boolean(video)
  const meta = video
    ? [video.category, formatVideoDate(video.date), formatDuration(video.duration_seconds)]
        .filter(Boolean)
        .join('  ·  ')
    : ''

  return (
    <>
      {/* Floating title that rides the hovered tile. */}
      <div
        ref={floatRef}
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          zIndex: 35,
          opacity: 0,
          pointerEvents: 'none',
          willChange: 'transform, opacity',
          transition: 'opacity .25s ease',
        }}
      >
        <div
          style={{
            // Float above the cell and center horizontally on it.
            transform: 'translate(-50%, calc(-100% - 18px))',
            padding: '6px 12px',
            borderRadius: 8,
            background: 'rgba(20,20,20,0.78)',
            backdropFilter: 'blur(6px)',
            WebkitBackdropFilter: 'blur(6px)',
            border: '1px solid rgba(255,255,255,0.1)',
            whiteSpace: 'nowrap',
            color: '#fff',
            fontFamily: "'Bebas Neue', sans-serif",
            fontSize: 26,
            letterSpacing: 1,
            lineHeight: 1,
            textShadow: '0 2px 10px rgba(0,0,0,0.6)',
          }}
        >
          {video?.title || ''}
        </div>
      </div>

      {/* "Little box in the corner" with the focused video's details. */}
      <div
        style={{
          position: 'fixed',
          left: 24,
          bottom: 24,
          zIndex: 40,
          maxWidth: 'min(80vw, 420px)',
          padding: '14px 18px',
          borderRadius: 10,
          background: 'rgba(20,20,20,0.72)',
          backdropFilter: 'blur(10px)',
          WebkitBackdropFilter: 'blur(10px)',
          border: '1px solid rgba(255,255,255,0.08)',
          borderLeft: `3px solid ${CRIMSON}`,
          boxShadow: '0 12px 40px rgba(0,0,0,0.45)',
          color: '#fff',
          fontFamily: "'Inter', system-ui, sans-serif",
          pointerEvents: 'none',
          opacity: visible ? 1 : 0,
          transform: visible ? 'translateY(0)' : 'translateY(8px)',
          transition: 'opacity .35s ease, transform .35s ease',
        }}
      >
        <div
          style={{
            fontFamily: "'Bebas Neue', sans-serif",
            fontSize: 30,
            letterSpacing: 1,
            lineHeight: 1.05,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {video?.title || 'Untitled'}
        </div>
        {meta && (
          <div
            style={{
              marginTop: 6,
              fontSize: 12,
              letterSpacing: 0.5,
              textTransform: 'uppercase',
              color: GOLD,
            }}
          >
            {meta}
          </div>
        )}
        <div style={{ marginTop: 8, fontSize: 11, color: 'rgba(255,255,255,0.55)' }}>
          Click to play
        </div>
      </div>
    </>
  )
}
