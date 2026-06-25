import { VOROFORCE_MODE } from '../consts'

/**
 * Ultra-optimized mobile preset.
 * Designed for maximum performance on low-end devices:
 * - Only 3,000 cells
 * - No post-processing
 * - No bulge, noise, ripple per-pixel effects
 * - No edges
 * - No media textures (saves 4+ texture sampler lookups per pixel)
 * - Minimal simulation (no breathing, no multi-threading)
 * - Pixel search disabled
 * - Simple distance metric
 */
export default {
  cells: 3000,
  multiThreading: {
    enabled: false,
    renderInParallel: false,
  },
  media: {
    enabled: false,
  },
  controls: {
    debug: false,
    maxSpeed: 8,
    ease: 0.05,
    easePinned: 0.05,
    freezeOnShake: {
      enabled: false,
    },
    freezeOnJolt: {
      enabled: false,
    },
    zoom: {
      enabled: false,
    },
  },
  display: {
    scene: {
      main: {
        defines: {
          BULGE: 0,
          RIPPLE: 0,
          NOISE: 0,
          NOISE_OCTAVE: 0,
          PIXEL_SEARCH: 0,
          PIXEL_SEARCH_RADIUS: 0,
          WEIGHTED_DIST: 1,
          X_DIST_SCALING: 1,
          MEDIA_ENABLED: 0,
          MEDIA_HIDDEN: 1,
          EDGES_VISIBLE: 0,
          EDGE_SMIN_SCALING: 0,
          EDGE_CELL_SCALING: 0,
          POST_UNWEIGHTED_EFFECT: 0,
          MEDIA_GAMMA_CONVERSION_FACTOR: 1,
          DOUBLE_INDEX_POOL: 0,
          DOUBLE_INDEX_POOL_EDGES: 0,
        },
        uniforms: {
          fPixelSearchRadiusMod: {
            transition: true,
            initial: { value: 0 },
            modes: {
              default: { value: 0 },
              [VOROFORCE_MODE.select]: { value: 0 },
            },
          },
          fBorderRoundnessMod: {
            transition: true,
            modes: {
              default: { value: 1 },
              [VOROFORCE_MODE.select]: { value: 1 },
            },
          },
          fBorderThicknessMod: {
            transition: true,
            modes: {
              default: { value: 1.5 },
              [VOROFORCE_MODE.select]: { value: 1.5 },
            },
          },
          fBorderSmoothnessMod: {
            transition: true,
            modes: {
              default: { value: 1 },
              [VOROFORCE_MODE.select]: { value: 0.75 },
            },
          },
          fCenterForceBulgeStrength: {
            transition: true,
            initial: { value: 0 },
            modes: {
              default: { value: 0 },
              [VOROFORCE_MODE.preview]: { value: 0 },
              [VOROFORCE_MODE.select]: { value: 0 },
            },
          },
          fCenterForceBulgeRadius: {
            transition: true,
            initial: { value: 0 },
            modes: {
              default: { value: 0 },
              [VOROFORCE_MODE.preview]: { value: 0 },
              [VOROFORCE_MODE.select]: { value: 0 },
            },
          },
          fWeightOffsetScaleMod: {
            transition: false,
            value: 0,
          },
          fRippleMod: {
            transition: false,
            value: 0,
          },
          fNoiseOctaveMod: {
            transition: false,
            value: 0,
          },
          fNoiseCenterOffsetMod: {
            transition: false,
            value: 0,
          },
          fUnweightedEffectMod: {
            transition: false,
            value: 0,
          },
        },
      },
      post: {
        enabled: false,
      },
    },
  },
  simulation: {
    steps: {
      force: {
        parameters: {
          alpha: 0.08,
          velocityDecay: 0.5,
          velocityDecayBase: 0.5,
          velocityDecayTransitionEnterMode: 0.7,
        },
        forces: {
          manageWeights: false,
          primaryCellWeightPushFactorEnabled: false,
          smoothPrimaryCell: false,
          requestMediaVersions: {
            enabled: false,
          },
          breathing: {
            enabled: false,
          },
          push: {
            strength: 0.1,
            yFactor: 1.5,
          },
          lattice: {
            strength: 0.6,
            yFactor: 1.5,
            xFactor: 1,
            maxLevelsFromPrimary: 10,
          },
          origin: {
            strength: 0.3,
            yFactor: 1,
          },
        },
      },
    },
  },
}
