import { DEFAULT_PROFILE, type BenchmarkProfile } from "./model.ts";

export const comparisonProfiles: BenchmarkProfile[] = [
  structuredClone(DEFAULT_PROFILE),
  {
    ...structuredClone(DEFAULT_PROFILE),
    id: "narrow-candidate-window",
    candidateLimit: 100,
    pageLimit: 1,
  },
  {
    ...structuredClone(DEFAULT_PROFILE),
    id: "slow-confirmation",
    confirmationDelay: 3,
    signingRoundCeiling: 10,
  },
];
