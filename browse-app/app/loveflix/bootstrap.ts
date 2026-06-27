// LoveFlix bootstrap: runs before the engine initializes.
//
// Picks a device-tiered cell count, seeds the store so the upstream intro /
// settings gate is fully bypassed (minimal preset, intro marked played), and
// starts loading the couple's videos. None of this is persisted to
// localStorage — the values are fixed for LoveFlix.

import { store } from '../store'
import { DEVICE_CLASS, VOROFORCE_MODE, VOROFORCE_PRESET } from '../vf/consts'
import { loadLoveflixVideos } from './loveflix'

// Tiered cell counts. Kept deliberately low: every cell holds its own
// uncompressed thumbnail tile in a GPU texture array, so VRAM ≈
// cells × tileW × tileH × 4. Pushing this too high blows the GPU memory
// budget and the WebGL context is lost (= the "loads then crashes" symptom).
const CELLS_BY_DEVICE_CLASS: Record<DEVICE_CLASS, number> = {
  [DEVICE_CLASS.high]: 800,
  [DEVICE_CLASS.mid]: 450,
  [DEVICE_CLASS.low]: 250,
  [DEVICE_CLASS.mobile]: 200,
}

// Device-tiered render scale. The voronoi fragment shader runs per screen
// pixel, so on a 3× DPR phone an uncapped canvas is ~9× the work — the single
// biggest cause of jank. Capping the pixel ratio is the cheapest large win.
const MAX_PIXEL_RATIO_BY_DEVICE_CLASS: Record<DEVICE_CLASS, number> = {
  [DEVICE_CLASS.high]: 1.5,
  [DEVICE_CLASS.mid]: 1.25,
  [DEVICE_CLASS.low]: 1,
  [DEVICE_CLASS.mobile]: 1,
}

let cells = CELLS_BY_DEVICE_CLASS[DEVICE_CLASS.low]
export const getLoveflixCells = (): number => cells

let pixelRatio = 1
export const getLoveflixPixelRatio = (): number => pixelRatio

export const bootstrapLoveflix = async (): Promise<void> => {
  // Start the video fetch immediately.
  void loadLoveflixVideos().catch(() => {})

  // Locked to the "potato" (low) tier. Testing showed the higher tiers don't
  // change the look — device class is purely an internal performance dial — so
  // we pin the smoothest, lightest setting on every device while keeping the
  // full voronoi effect (the `minimal` preset is unchanged).
  const deviceClass = DEVICE_CLASS.low
  cells = CELLS_BY_DEVICE_CLASS[deviceClass]

  const maxPixelRatio = MAX_PIXEL_RATIO_BY_DEVICE_CLASS[deviceClass]
  const devicePixelRatio =
    typeof window !== 'undefined' && window.devicePixelRatio
      ? window.devicePixelRatio
      : 1
  pixelRatio = Math.min(devicePixelRatio, maxPixelRatio)

  // Seed engine state directly (no persistence) so initVoroforce proceeds and
  // the intro gate (!playedIntro || !preset) is satisfied. Start in preview
  // mode so FilmPreview is visible immediately (no 4-second intro delay).
  store.setState({
    preset: VOROFORCE_PRESET.minimal,
    cellLimit: cells as never,
    deviceClass,
    estimatedDeviceClass: deviceClass,
    playedIntro: true,
    mode: VOROFORCE_MODE.preview,
  })
}
