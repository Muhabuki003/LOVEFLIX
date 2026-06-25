// LoveFlix bootstrap: runs before the engine initializes.
//
// Picks a device-tiered cell count, seeds the store so the upstream intro /
// settings gate is fully bypassed (minimal preset, intro marked played), and
// starts loading the couple's videos. None of this is persisted to
// localStorage — the values are fixed for LoveFlix.

import { store } from '../store'
import { DEVICE_CLASS, VOROFORCE_PRESET } from '../vf/consts'
import { estimateDeviceClass } from '../vf/utils/device-class'
import { loadLoveflixVideos } from './loveflix'

// Tiered cell counts (capped well below the upstream 50k for a couple's
// library and for smoothness on mobile).
const CELLS_BY_DEVICE_CLASS: Record<DEVICE_CLASS, number> = {
  [DEVICE_CLASS.high]: 1500,
  [DEVICE_CLASS.mid]: 800,
  [DEVICE_CLASS.low]: 300,
  [DEVICE_CLASS.mobile]: 300,
}

let cells = CELLS_BY_DEVICE_CLASS[DEVICE_CLASS.low]
export const getLoveflixCells = (): number => cells

export const bootstrapLoveflix = async (): Promise<void> => {
  // Start the video fetch immediately (parallel with GPU detection).
  void loadLoveflixVideos().catch(() => {})

  let deviceClass = DEVICE_CLASS.low
  try {
    deviceClass = await estimateDeviceClass()
  } catch {
    deviceClass = DEVICE_CLASS.low
  }
  cells = CELLS_BY_DEVICE_CLASS[deviceClass] ?? CELLS_BY_DEVICE_CLASS[DEVICE_CLASS.low]

  // Seed engine state directly (no persistence) so initVoroforce proceeds and
  // the intro gate (!playedIntro || !preset) is satisfied.
  store.setState({
    preset: VOROFORCE_PRESET.minimal,
    cellLimit: cells as never,
    deviceClass,
    estimatedDeviceClass: deviceClass,
    playedIntro: true,
  })
}
