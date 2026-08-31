import {
  biggestFirstSingleChange,
  largestFirstCanonical,
} from "./policies/biggest-first-single-change.ts";
import { boundedValueQuantum } from "./policies/bounded-value-quantum.ts";
import { remainderPolicies } from "./policies/equal-remainder.ts";
import {
  orderQuantum,
  orderQuantumNoCleanup,
  orderQuantumTriggeredCleanup,
} from "./policies/order-quantum.ts";
import {
  simpleUsefulSplit,
  simpleUsefulSplitExact,
} from "./policies/simple-useful-split.ts";
import { oldestFirstSingleChange } from "./policies/oldest-first-single-change.ts";
import {
  boundedValueLedgerFloorEight,
  boundedValueRepresentativeFloorEight,
  oldestFirstLedgerFloorEight,
  oldestFirstLaneFloorEight,
  oldestFirstLanePreserving,
  oldestFirstRepresentativeFloorEight,
} from "./policies/oldest-first-lane-preserving.ts";

export const eligibleComparisonPolicies = [
  largestFirstCanonical,
  boundedValueQuantum,
  simpleUsefulSplitExact,
  orderQuantum,
  ...remainderPolicies,
  orderQuantumNoCleanup,
  orderQuantumTriggeredCleanup,
];

export const comparisonPolicies = [
  largestFirstCanonical,
  biggestFirstSingleChange,
  oldestFirstSingleChange,
  oldestFirstLanePreserving,
  oldestFirstLaneFloorEight,
  oldestFirstRepresentativeFloorEight,
  oldestFirstLedgerFloorEight,
  boundedValueRepresentativeFloorEight,
  boundedValueLedgerFloorEight,
  boundedValueQuantum,
  simpleUsefulSplitExact,
  orderQuantum,
  ...remainderPolicies,
  simpleUsefulSplit,
  orderQuantumNoCleanup,
  orderQuantumTriggeredCleanup,
];
