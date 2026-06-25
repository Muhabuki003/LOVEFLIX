// "Little box in the corner": a LoveFlix-branded card that shows details of the
// video under the cursor (the focused cell). Mirrors the original hover info,
// but with the couple's video metadata. Subscribes to store.film, which the
// controls integration sets to a Film built from the focused cell's video.

import { useEffect, useState } from 'react'
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

  useEffect(() => {
    return store.subscribe(
      (s) => s.film,
      (f) => setFilm(f),
    )
  }, [])

  const video = film?.loveflix
  const visible = Boolean(video)
  const meta = video
    ? [video.category, formatVideoDate(video.date), formatDuration(video.duration_seconds)]
        .filter(Boolean)
        .join('  ·  ')
    : ''

  return (
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
  )
}
