export const previewForceSimulationStepConfig = {
  parameters: {
    alpha: 0.15,
    velocityDecay: 0.7,
    velocityDecayBase: 0.7,
    velocityDecayTransitionEnterMode: 0.9,
  },
  forces: {
    manageWeights: true,
    primaryCellWeightPushFactorEnabled: true,
    smoothPrimaryCell: true,
    requestMediaVersions: {
      enabled: true,
      // LoveFlix: force media version 3 (individual video thumbnails) for every
      // cell at all zoom levels — see select-force for rationale.
      handleMediaSpeedLimits: false,
      v3ColLevelAdjacencyThreshold: 100000,
      v3RowLevelAdjacencyThreshold: 100000,
      v2ColLevelAdjacencyThreshold: 100000,
      v2RowLevelAdjacencyThreshold: 100000,
    },
    breathing: {
      enabled: true,
    },
    push: {
      strength: 0.1,
      yFactor: 2.5,
      alignmentMaxLevelsX: 40,
      centerXStretchMod: 0.4,
      speedFactor: 1,
    },
    lattice: {
      strength: 0.8,
      yFactor: 3.75,
      xFactor: 1,
      maxLevelsFromPrimary: 30,
    },
    origin: {
      strength: 0.8,
      yFactor: 1.5,
    },
  },
}
