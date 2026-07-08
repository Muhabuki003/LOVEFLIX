// Accessible parallel navigation path for the WebGL voronoi "Browse" grid.
//
// The 3D gallery (#voroforce, mounted outside React in index.html) is a
// canvas-rendered voronoi diagram: it has no DOM nodes per video, so screen
// readers cannot see individual tiles, and a mouse is effectively required to
// reach most tiles (keyboard arrow/space/enter support exists in the engine —
// see voroforce/controls/controls.js onKeyDown — but only once a tile has
// "focus" in the simulation's own sense, which is not the same as DOM focus
// and is never announced to assistive tech).
//
// This component provides a real, operable alternative: a toggle button
// (always visible, reachable via Tab) that reveals a plain, fully accessible
// list of the same videos as real <a> links. Activating a link performs the
// exact same navigation the WebGL engine performs when a cell is selected
// (see app/vf/integrations/controls.ts `selected` handler): a same-origin
// link to /player.html?id=<video id>.
import { useEffect, useRef, useState } from 'react'
import {
  type LoveflixVideo,
  formatVideoDate,
  getLoveflixVideos,
  loadLoveflixVideos,
} from './loveflix'

const VOID_BLACK = '#141414'
const CRIMSON = '#e50914'
const GOLD = '#c9a96e'

export function BrowseAccessibleNav() {
  const [videos, setVideos] = useState<LoveflixVideo[]>(() =>
    getLoveflixVideos(),
  )
  const [open, setOpen] = useState(false)
  const toggleRef = useRef<HTMLButtonElement>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    let active = true
    loadLoveflixVideos()
      .then((v) => {
        if (active) setVideos(v)
      })
      .catch(() => {})
    return () => {
      active = false
    }
  }, [])

  // Basic focus management: move focus into the panel when it opens, and
  // back to the toggle when it closes, so keyboard users land somewhere
  // sensible instead of losing their place.
  useEffect(() => {
    if (open) {
      headingRef.current?.focus()
    } else {
      toggleRef.current?.focus()
    }
  }, [open])

  return (
    // The WebGL engine's keyboard controls (Space/Enter to select the
    // currently-focused voronoi cell, arrow keys to move between cells) are
    // wired via a single `window.addEventListener('keydown', ...)` in
    // voroforce/controls/controls.js with no check on the event target. That
    // means, without this guard, pressing Enter/Space on any control in this
    // accessible UI would *also* re-trigger cell selection in the 3D grid
    // (which navigates to a — likely unrelated — /player.html?id=... URL) at
    // the same time. Stopping propagation here keeps keyboard interaction
    // inside this accessible UI fully self-contained.
    <div onKeyDown={(e) => e.stopPropagation()}>
      <button
        ref={toggleRef}
        type='button'
        aria-pressed={open}
        aria-expanded={open}
        aria-controls='browse-accessible-list'
        onClick={() => setOpen((o) => !o)}
        style={{
          position: 'fixed',
          top: 12,
          left: 12,
          zIndex: 80,
          background: VOID_BLACK,
          color: '#fff',
          border: '1px solid rgba(255,255,255,0.4)',
          borderRadius: 4,
          padding: '8px 14px',
          fontSize: 13,
          fontFamily: "'Inter', system-ui, sans-serif",
          cursor: 'pointer',
        }}
      >
        {open ? 'Close list view' : 'Switch to list view'}
      </button>

      {open && (
        <div
          id='browse-accessible-list'
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 75,
            background: VOID_BLACK,
            color: '#fff',
            overflowY: 'auto',
            padding: '72px 24px 32px',
            fontFamily: "'Inter', system-ui, sans-serif",
          }}
        >
          <h1
            ref={headingRef}
            tabIndex={-1}
            style={{
              fontFamily: "'Bebas Neue', sans-serif",
              fontSize: 32,
              letterSpacing: 1,
              color: GOLD,
              marginBottom: 16,
              outline: 'none',
            }}
          >
            Your videos — list view
          </h1>

          {videos.length === 0 && (
            <p style={{ color: '#a3a3a3' }}>
              No videos to show yet, or your collection is still loading.
            </p>
          )}

          <nav aria-label='Browse videos list'>
            <ul
              style={{
                listStyle: 'none',
                margin: 0,
                padding: 0,
                display: 'flex',
                flexDirection: 'column',
                gap: 2,
                maxWidth: 640,
              }}
            >
              {videos.map((video) => (
                <li key={video.id}>
                  <a
                    href={`/player.html?id=${encodeURIComponent(video.id)}`}
                    style={{
                      display: 'block',
                      padding: '10px 12px',
                      borderRadius: 4,
                      color: '#fff',
                      textDecoration: 'none',
                      borderBottom: '1px solid rgba(255,255,255,0.08)',
                    }}
                    onFocus={(e) => {
                      e.currentTarget.style.outline = `2px solid ${CRIMSON}`
                      e.currentTarget.style.outlineOffset = '2px'
                    }}
                    onBlur={(e) => {
                      e.currentTarget.style.outline = 'none'
                    }}
                  >
                    {video.title || 'Untitled'}
                    {video.category || video.date ? (
                      <span
                        style={{
                          color: '#a3a3a3',
                          fontSize: 12,
                          marginLeft: 8,
                        }}
                      >
                        {[video.category, formatVideoDate(video.date)]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                    ) : null}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        </div>
      )}
    </div>
  )
}
