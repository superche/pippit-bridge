export const PIPPIT_RELEASE_EPOCH = 1
export const PIPPIT_MIN_SUPPORTED_RELEASE_EPOCH = 1
export const PIPPIT_RELEASE_EPOCH_HEADER = "x-pippit-release-epoch"

export type ReleaseEpochDecision = "compatible" | "legacy-compatible" | "stale"

export function classifyReleaseEpoch(value: string | undefined, minimum = PIPPIT_MIN_SUPPORTED_RELEASE_EPOCH): ReleaseEpochDecision {
  if (value === undefined) return "legacy-compatible"
  if (!/^\d+$/u.test(value)) return "stale"
  const epoch = Number(value)
  return Number.isSafeInteger(epoch) && epoch >= minimum ? "compatible" : "stale"
}
