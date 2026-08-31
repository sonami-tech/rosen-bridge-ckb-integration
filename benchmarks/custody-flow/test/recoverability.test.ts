import assert from "node:assert/strict";
import test from "node:test";
import {
  runEqualRemainderRecoverabilityProof,
  runOrderQuantumRecoverabilityProof,
  runOrderQuantumNoCleanupRecoverabilityProof,
  runOrderQuantumTriggeredCleanupRecoverabilityProof,
} from "../src/recoverability.ts";

test("bounded xUDT states measure order-quantum recovery", () => {
  const report = runOrderQuantumRecoverabilityProof();
  assert.equal(report.statesEnumerated, 15_876);
  assert.equal(report.acceptedPlans, report.admissiblyPayableStates);
  assert.equal(report.targetRecoverableStates, 7_094);
  assert.equal(report.targetRecoveredPlans, 6_062);
  assert.equal(report.unrecoveredStates, 1_032);
  assert.equal(report.falseNoFitStates, 0, JSON.stringify(report.counterexamples));
  assert.equal(report.invalidPlanStates, 0, JSON.stringify(report.counterexamples));
  assert.equal(report.nonFloorTypedChangeStates, 0);
});

test("bounded xUDT states expose cleanup's recovery contribution", () => {
  const report = runOrderQuantumNoCleanupRecoverabilityProof();
  assert.equal(report.targetRecoverableStates, 7_094);
  assert.equal(report.targetRecoveredPlans, 2_049);
  assert.equal(report.unrecoveredStates, 5_045);
  assert.equal(report.falseNoFitStates, 0, JSON.stringify(report.counterexamples));
  assert.equal(report.invalidPlanStates, 0, JSON.stringify(report.counterexamples));
});

test("triggered cleanup matches eager cleanup in bounded xUDT states", () => {
  const report = runOrderQuantumTriggeredCleanupRecoverabilityProof();
  assert.equal(report.targetRecoverableStates, 7_094);
  assert.equal(report.targetRecoveredPlans, 6_062);
  assert.equal(report.unrecoveredStates, 1_032);
  assert.equal(report.falseNoFitStates, 0, JSON.stringify(report.counterexamples));
  assert.equal(report.invalidPlanStates, 0, JSON.stringify(report.counterexamples));
});

test("bounded xUDT states expose no equal-remainder false no-fit", () => {
  const report = runEqualRemainderRecoverabilityProof();
  assert.ok(report.statesEnumerated > 15_000);
  assert.ok(report.admissiblyPayableStates > 14_000);
  assert.equal(report.acceptedPlans, report.admissiblyPayableStates);
  assert.ok(report.targetRecoverableStates >= report.targetRecoveredPlans);
  assert.ok(report.targetRecoveredPlans > 0);
  assert.equal(
    report.unrecoveredStates,
    report.targetRecoverableStates - report.targetRecoveredPlans,
  );
  assert.equal(report.falseNoFitStates, 0, JSON.stringify(report.counterexamples));
  assert.equal(report.invalidPlanStates, 0, JSON.stringify(report.counterexamples));
  assert.equal(
    report.nonFloorTypedChangeStates,
    0,
    JSON.stringify(report.counterexamples),
  );
});
