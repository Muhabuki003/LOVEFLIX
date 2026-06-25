import { mergeConfigs } from '√'
import { getLoveflixCells } from '../../loveflix/bootstrap'
import { LOVEFLIX_ENABLED, thumbUrlForIndex } from '../../loveflix/loveflix'
import baseConfig from '../config'
import presets from '../presets'

import type { THEME } from '../../consts'
import type { StoreState } from '../../store'
import {
  DEFAULT_VOROFORCE_PRESET,
  type VOROFORCE_MODE,
  VOROFORCE_PRESET,
} from '../consts'
import type { VoroforceCell, VoroforceInstance } from '../types'
import type { Film } from './films'
import type { ConfigUniform } from './uniforms'

export type CustomLink = {
  name: string
  baseUrl: string
  slug: boolean
  property: 'title' | 'tmdbId' | 'imdbId'
}

export type UserConfig = {
  cells?: number
  devTools?: boolean
  customLinks?: CustomLink[]
  favorites?: {
    [key: Film['tmdbId']]: {
      cellId: VoroforceCell['id']
      title: Film['title']
      year: Film['year']
      tagline: Film['tagline']
      tmdbId: Film['tmdbId']
      imdbId?: Film['imdbId']
      poster?: Film['poster']
    }
  }
}

const handleCustomLinkParam = (
  customLinkBase64Param: string,
  state: StoreState,
) => {
  const { userConfig, setUserConfig } = state
  try {
    const customLink = JSON.parse(window.atob(customLinkBase64Param))
    userConfig.customLinks = [...(userConfig.customLinks ?? [])]
    const sameNameIndex = userConfig.customLinks.findIndex(
      ({ name }) => name === customLink.name,
    )
    if (sameNameIndex !== -1) {
      userConfig.customLinks[sameNameIndex] = customLink
    } else {
      userConfig.customLinks.push(customLink)
    }
    setUserConfig(userConfig)
    window.history.replaceState({}, document.title, '/')
  } catch (e) {}
}

export const getVoroforceConfig = (state: StoreState) => {
  const { userConfig, preset: initialPreset, cellLimit, mode } = state
  const urlParams = new URLSearchParams(window.location.search)
  const presetOverrideParam = urlParams.get('preset') as VOROFORCE_PRESET
  const cellsOverrideParam = urlParams.get('cells')
  const customLinkBase64Param = urlParams.get('customLinkBase64')

  let preset = initialPreset
  if (presetOverrideParam && VOROFORCE_PRESET[presetOverrideParam]) {
    preset = presetOverrideParam
  }

  if (!preset) preset = DEFAULT_VOROFORCE_PRESET
  // LoveFlix: the preset is fixed (minimal), regardless of any stored value or
  // URL override (except an explicit ?preset for debugging, handled above).
  if (LOVEFLIX_ENABLED && !presetOverrideParam) preset = VOROFORCE_PRESET.minimal

  let config = mergeConfigs(
    baseConfig,
    (presets as unknown as Record<VOROFORCE_PRESET, typeof baseConfig>)[preset],
  )
  if (config.modes?.[mode]) {
    config = mergeConfigs(config, config.modes?.[mode])
  }

  if (customLinkBase64Param) {
    handleCustomLinkParam(customLinkBase64Param, state)
  }

  config.cells = cellsOverrideParam
    ? Number.parseInt(cellsOverrideParam)
    : (cellLimit ?? config.cells)

  if ('devTools' in userConfig) {
    config.devTools.enabled = !!userConfig.devTools
  }

  if (LOVEFLIX_ENABLED) applyLoveflixConfig(config)

  return config
}

// LoveFlix overrides applied to the assembled engine config:
//  - device-tiered cell count,
//  - no preload of the (absent) compressed poster atlases,
//  - the uncompressed-single media version sources textures from the couple's
//    video thumbnails via a per-index function, with the texture-array depth
//    scaled to the cell count to bound GPU memory.
const applyLoveflixConfig = (config: typeof baseConfig) => {
  const cells = getLoveflixCells()
  config.cells = cells

  // Compressed poster atlases are never shipped/used; don't preload them.
  // (empty string is falsy — the engine treats any falsy preload as "none")
  ;(config.media as { preload: unknown }).preload = ''

  const single = (
    config.media.versions as Array<Record<string, unknown>>
  ).find((v) => v.type && v.type !== 'compressed-grid')
  if (single) {
    const capacity =
      (Number(single.virtualCols) || 9) * (Number(single.virtualRows) || 6)
    // enough virtual layers to hold every cell's tile, with a little headroom
    const neededLayers = Math.ceil(cells / capacity) + 2
    single.virtualLayers = Math.max(4, Math.min(48, neededLayers))
    single.layers = Math.max(cells, capacity)
    single.layerSrcFormat = (layerIndex: number) => thumbUrlForIndex(layerIndex)
  }
}

const processVoroforceStageConfigUniforms = (
  stageConfigUniforms: Record<string, ConfigUniform>,
  transitioning: Map<string, ConfigUniform>,
  mode: VOROFORCE_MODE,
  theme: THEME,
) => {
  return new Map<string, ConfigUniform>(
    Object.entries(stageConfigUniforms).map(([key, uniform]) => {
      if (typeof uniform.value === 'undefined') {
        const uniformValue = uniform.modes
          ? typeof uniform.modes?.[mode]?.value !== 'undefined'
            ? uniform.modes[mode].value
            : (uniform.modes?.default?.value ?? 0)
          : typeof uniform.themes?.[theme]?.value !== 'undefined'
            ? uniform.themes[theme].value
            : (uniform.themes?.default?.value ?? 0)

        if (
          uniform.transition &&
          typeof uniform.initial?.value === 'number' &&
          typeof uniformValue === 'number'
        ) {
          uniform.value = uniform.initial.value

          uniform.targetValue = uniformValue
          if (!transitioning.has(key)) {
            transitioning.set(key, uniform)
          }
        } else {
          uniform.value = uniformValue as number
        }
      }
      return [key, uniform]
    }),
  )
}

export const getVoroforceConfigUniforms = (
  config: VoroforceInstance['config'],
  mode: VOROFORCE_MODE,
  theme: THEME,
) => {
  const {
    display: {
      scene: {
        main: { uniforms: mainConfigUniforms = {} },
        post: { uniforms: postConfigUniforms = {} },
      },
    },
  } = config

  const transitioning = new Map<string, ConfigUniform>()

  return {
    main: processVoroforceStageConfigUniforms(
      mainConfigUniforms,
      transitioning,
      mode,
      theme,
    ),
    post: processVoroforceStageConfigUniforms(
      postConfigUniforms,
      transitioning,
      mode,
      theme,
    ),
    transitioning,
  }
}
