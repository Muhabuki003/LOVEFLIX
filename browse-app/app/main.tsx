import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './app'
import ErrorBoundary from './cmps/common/error-boundary'
import { ThemeProvider } from './cmps/layout'
import { FilmPreview } from './cmps/views/film'
import config from './config'
import { BrowseOverlay } from './loveflix/BrowseOverlay'
import { bootstrapLoveflix } from './loveflix/bootstrap'
import { LOVEFLIX_ENABLED } from './loveflix/loveflix'
import { animateDocTitleSuffix } from './utils/anim'
import { initTelemetry } from './utils/telemetry/init-telemetry'
import { initVoroforce } from './vf'
import { Voroforce } from './voroforce'
import './styles.css'

initTelemetry()

const renderLoveflix = () => {
  // biome-ignore lint/style/noNonNullAssertion: exists
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <ErrorBoundary>
        <ThemeProvider>
          {/* Upstream FilmPreview: exact visual match for the source site —
              large title (LoveFlix: Bebas Neue, all caps) + date line + meta
              badges that ride the neighbor cell above the hovered tile.
              Film.fromLoveflix() maps the video's fields into this card. */}
          <FilmPreview />
          <BrowseOverlay />
        </ThemeProvider>
        <Voroforce />
      </ErrorBoundary>
    </StrictMode>,
  )
}

const renderUpstream = () => {
  const urlParams = new URLSearchParams(window.location.search)
  const disableUIOverrideParam = urlParams.get('disableUI')
  if (!config.disableUI && !disableUIOverrideParam) {
    // biome-ignore lint/style/noNonNullAssertion: exists
    createRoot(document.getElementById('root')!).render(
      <StrictMode>
        <ErrorBoundary>
          <App />
          <Voroforce />
        </ErrorBoundary>
      </StrictMode>,
    )
  } else {
    void initVoroforce({ force: true })
  }
}

window.addEventListener('DOMContentLoaded', () => {
  if (LOVEFLIX_ENABLED) {
    // Pick device tier, seed the store (bypassing the intro/settings gate) and
    // start loading videos, then mount.
    void bootstrapLoveflix().then(renderLoveflix)
  } else {
    renderUpstream()
  }
  animateDocTitleSuffix()
})
