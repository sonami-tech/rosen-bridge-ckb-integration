import {
  materializeChange,
  paymentTokenAmount,
  type Cell,
  type ChangeOutput,
  type PolicyPlan,
} from "../model.ts";
import type { Policy } from "../policy.ts";
import {
  decomposeBoundedValueInputs,
  isPaymentTypeCustody,
  isUntypedCustody,
  orderBoundedValueCells,
} from "../custody-policy.ts";
import {
  constructQuantumMinimalPlan,
  constructQuantumPlan,
} from "../quantum-change.ts";
import {
  maximumQuantumLanes,
  nativeQuantum,
  provisionalInventoryTarget,
  xudtMateQuantum,
} from "../quantum-budget.ts";
import { validateDampedQuantumBoundary } from "../validator.ts";

export const boundedValueQuantum: Policy = {
  id: "bounded-value-damped-quantum",
  inventoryTarget: provisionalInventoryTarget,
  validationBoundary: "damped-quantum",
  propose(context) {
    const visible: Cell[] = [];
    for (;;) {
      const page = context.candidates.readNextPage();
      if (page.length === 0) break;
      visible.push(...page);
    }
    const visibleById = new Map(visible.map((cell) => [cell.id, cell]));
    const isUntyped = (value: Cell | ChangeOutput): boolean =>
      isUntypedCustody(value, context.limits);
    const isPaymentType = (value: Cell | ChangeOutput): boolean =>
      isPaymentTypeCustody(value, context.payment, context.limits);
    const isSelectable = (cell: Cell): boolean =>
      cell.reservedUntil === undefined || cell.reservedUntil <= context.window;
    const order = orderBoundedValueCells(
      visible,
      context.payment,
      context.limits,
    );
    const inventory = context.confirmedInventory;
    if (!inventory) return undefined;
    const generationLimit = maximumQuantumLanes(
      context.payment,
      context.limits,
    );
    let alternateFallback: PolicyPlan | undefined;
    let alternateFallbackComputed = false;
    const findAlternateFallback = (): PolicyPlan | undefined => {
      if (alternateFallbackComputed) return alternateFallback;
      alternateFallbackComputed = true;
      if (context.payment.asset.kind !== "xudt") return undefined;
      const mate = xudtMateQuantum(context.payment, context.limits);
      const typed = order.filter(
        (cell) => isSelectable(cell) && isPaymentType(cell),
      );
      const coveringFrom = (candidates: Cell[]): Cell[] => {
        const covering: Cell[] = [];
        let tokenTotal = 0n;
        for (const cell of candidates) {
          if (tokenTotal >= context.payment.amount) break;
          covering.push(cell);
          tokenTotal += cell.token?.amount ?? 0n;
        }
        return tokenTotal >= context.payment.amount ? covering : [];
      };
      const coverings = [coveringFrom(typed), coveringFrom([...typed].reverse())]
        .filter((covering) => covering.length > 0)
        .filter(
          (covering, index, all) =>
            all.findIndex(
              (other) =>
                other.length === covering.length &&
                other.every(
                  (cell, cellIndex) =>
                    cell.capacity === covering[cellIndex].capacity &&
                    cell.token?.amount === covering[cellIndex].token?.amount,
                ),
            ) === index,
        );
      if (coverings.length === 0) return undefined;
      const fullUntyped = order.filter(
        (cell) => isSelectable(cell) && isUntyped(cell) && cell.capacity >= mate,
      );
      const untypedRepair = order.filter(
        (cell) => isSelectable(cell) && isUntyped(cell) && cell.capacity < mate,
      );
      const trials: Cell[][] = [];
      for (const covering of coverings) {
        const coveringIds = new Set(covering.map((cell) => cell.id));
        const typedRepair = typed.filter(
          (cell) =>
            !coveringIds.has(cell.id) &&
            (cell.token?.amount ?? 0n) < context.payment.amount,
        );
        for (
          let fullCount = 0;
          fullCount <= Math.min(fullUntyped.length, generationLimit);
          fullCount += 1
        )
          for (
            let typedCount = 0;
            typedCount <= Math.min(typedRepair.length, generationLimit);
            typedCount += 1
          )
            for (
              let untypedCount = 0;
              untypedCount <=
                Math.min(untypedRepair.length, generationLimit + 1);
              untypedCount += 1
            )
              trials.push([
                ...covering,
                ...fullUntyped.slice(0, fullCount),
                ...typedRepair.slice(0, typedCount),
                ...untypedRepair.slice(0, untypedCount),
              ]);
      }
      trials.sort((left, right) => left.length - right.length);
      for (const inputs of trials) {
        const plan = constructQuantumMinimalPlan(
          inputs,
          context.payment,
          context.limits,
        );
        if (
          plan &&
          validateDampedQuantumBoundary(
            context.payment,
            inputs,
            materializeChange(
              plan.change,
              context.payment,
              context.limits,
            ),
            context.limits,
            { confirmedInventory: inventory },
          ).length === 0
        ) {
          alternateFallback = plan;
          break;
        }
      }
      return alternateFallback;
    };

    const selected: Cell[] = [];
    for (const cell of order) {
      selected.push(cell);
      const minimal = constructQuantumMinimalPlan(
        selected,
        context.payment,
        context.limits,
      );
      if (!minimal) continue;
      const decomposition = decomposeBoundedValueInputs(
        selected,
        context.payment,
        context.limits,
      );
      const fallback = decomposition.coverPlan
        ? constructQuantumMinimalPlan(
            decomposition.ordered.slice(0, decomposition.coverLength),
            context.payment,
            context.limits,
          )
        : undefined;
      const isBoundaryValid = (candidate: PolicyPlan): boolean => {
        const inputs = candidate.inputIds.flatMap((id) => {
          const input = visibleById.get(id);
          return input ? [input] : [];
        });
        return (
          inputs.length === candidate.inputIds.length &&
          validateDampedQuantumBoundary(
            context.payment,
            inputs,
            materializeChange(
              candidate.change,
              context.payment,
              context.limits,
            ),
            context.limits,
            { confirmedInventory: inventory },
          ).length === 0
        );
      };
      const validFallback = [fallback, minimal].find(
        (candidate): candidate is PolicyPlan =>
          candidate !== undefined && isBoundaryValid(candidate),
      );
      if (minimal.change.length === 0) return minimal;
      if (
        context.payment.asset.kind === "xudt" &&
        validFallback &&
        selected.reduce(
          (sum, cell) => sum + paymentTokenAmount(cell, context.payment),
          0n,
        ) === context.payment.amount
      )
        return validFallback;

      const selectedIds = new Set(selected.map((input) => input.id));
      const target = inventory.target;
      const unresolved =
        inventory.unresolved?.untyped === true ||
        (context.payment.asset.kind === "xudt" &&
          inventory.unresolved?.paymentType === true);
      if (target === 0 || unresolved) {
        if (validFallback) return validFallback;
        return findAlternateFallback();
      }
      const cleanup: Cell[] = [];
      let remainingNativeUseful = 0;
      let remainingTypedUseful = 0;
      let remainingUntypedUseful = 0;
      let desired: number;
      if (context.payment.asset.kind === "native") {
        const quantum = nativeQuantum(context.payment, context.limits);
        const confirmedCells = context.lanes.untyped.countUnselected(
          selectedIds,
          target,
        );
        const confirmedUseful = context.lanes.untyped.countUnselected(
          selectedIds,
          target,
          (candidate) => candidate.capacity >= quantum,
        );
        const pendingCells = context.pendingOutputs.filter(isUntyped);
        const projectedCells = confirmedCells + pendingCells.length;
        const projectedUseful =
          confirmedUseful +
          pendingCells.filter((output) => output.capacity >= quantum).length;
        remainingNativeUseful = projectedUseful;
        desired = target - projectedUseful;
        desired = Math.min(desired, generationLimit);
        if (desired <= 0) {
          if (validFallback) return validFallback;
          return findAlternateFallback();
        }
        const cleanupNeeded = Math.max(
          0,
          projectedCells + desired - target,
        );
        if (cleanupNeeded > 0)
          cleanup.push(
            ...context.lanes.untyped.takeUnselected(
              selectedIds,
              Math.min(cleanupNeeded, generationLimit),
              (candidate) =>
                isSelectable(candidate) && candidate.capacity < quantum,
            ),
          );
        desired = Math.min(
          desired,
          target - projectedCells + cleanup.length,
        );
      } else {
        const mate = xudtMateQuantum(context.payment, context.limits);
        const confirmedTypedCells = context.lanes.paymentType!.countUnselected(
          selectedIds,
          target,
        );
        const confirmedTypedUseful = context.lanes.paymentType!.countUnselected(
          selectedIds,
          target,
          (candidate) =>
            (candidate.token?.amount ?? 0n) >= context.payment.amount,
        );
        const confirmedUntypedCells = context.lanes.untyped.countUnselected(
          selectedIds,
          target,
        );
        const confirmedUntypedUseful = context.lanes.untyped.countUnselected(
          selectedIds,
          target,
          (candidate) => candidate.capacity >= mate,
        );
        const pendingTyped = context.pendingOutputs.filter(isPaymentType);
        const pendingUntyped = context.pendingOutputs.filter(isUntyped);
        const projectedTypedCells = confirmedTypedCells + pendingTyped.length;
        const projectedUntypedCellsValue =
          confirmedUntypedCells + pendingUntyped.length;
        const projectedTypedUseful =
          confirmedTypedUseful +
          pendingTyped.filter(
            (output) =>
              (output.token?.amount ?? 0n) >= context.payment.amount,
          ).length;
        const projectedUntypedUseful =
          confirmedUntypedUseful +
          pendingUntyped.filter((output) => output.capacity >= mate).length;
        remainingTypedUseful = projectedTypedUseful;
        remainingUntypedUseful = projectedUntypedUseful;
        desired = target - Math.min(
          projectedTypedUseful,
          projectedUntypedUseful,
        );
        desired = Math.min(desired, generationLimit);
        if (desired <= 0) {
          if (validFallback) return validFallback;
          return findAlternateFallback();
        }
        const typedCleanupNeeded = Math.max(
          0,
          projectedTypedCells + desired - target,
        );
        if (typedCleanupNeeded > 0)
          cleanup.push(
            ...context.lanes.paymentType!.takeUnselected(
              selectedIds,
              Math.min(typedCleanupNeeded, generationLimit),
              (candidate) =>
                isSelectable(candidate) &&
                (candidate.token?.amount ?? 0n) < context.payment.amount,
              ),
            );
        const typedPaddingNeeded = typedCleanupNeeded - cleanup.length;
        if (typedPaddingNeeded > 0) {
          const padding = order
              .filter(
                (candidate) =>
                  isSelectable(candidate) &&
                  isPaymentType(candidate) &&
                  !selectedIds.has(candidate.id) &&
                  !cleanup.some((input) => input.id === candidate.id),
              )
              .slice(0, typedPaddingNeeded);
          cleanup.push(...padding);
          remainingTypedUseful -= padding.filter(
            (cell) => (cell.token?.amount ?? 0n) >= context.payment.amount,
          ).length;
        }
        const untypedCleanupNeeded = Math.max(
          0,
          projectedUntypedCellsValue + desired - target,
        );
        if (untypedCleanupNeeded > 0)
          cleanup.push(
            ...context.lanes.untyped.takeUnselected(
              selectedIds,
              Math.min(untypedCleanupNeeded, generationLimit),
              (candidate) =>
                isSelectable(candidate) && candidate.capacity < mate,
              ),
            );
        const selectedUntypedCleanup = cleanup.filter(isUntyped).length;
        const untypedPaddingNeeded =
          untypedCleanupNeeded - selectedUntypedCleanup;
        if (untypedPaddingNeeded > 0) {
          const padding = order
              .filter(
                (candidate) =>
                  isSelectable(candidate) &&
                  isUntyped(candidate) &&
                  !selectedIds.has(candidate.id) &&
                  !cleanup.some((input) => input.id === candidate.id),
              )
              .slice(0, untypedPaddingNeeded);
          cleanup.push(...padding);
          remainingUntypedUseful -= padding.filter(
            (cell) => cell.capacity >= mate,
          ).length;
        }
        desired = Math.min(
          desired,
          target - projectedTypedCells + cleanup.filter(isPaymentType).length,
          target - projectedUntypedCellsValue + cleanup.filter(isUntyped).length,
        );
      }
      if (desired <= 0) {
        if (validFallback) return validFallback;
        return findAlternateFallback();
      }
      if (cleanup.length > 0) {
        const selectedCount = selected.length + cleanup.length;
        desired = Math.min(
          desired,
          context.payment.asset.kind === "native"
            ? selectedCount
            : Math.floor(selectedCount / 2),
        );
      }
      if (desired <= 0) {
        if (validFallback) return validFallback;
        return findAlternateFallback();
      }
      let inputs = [...selected, ...cleanup];
      desired = Math.min(
        generationLimit,
        Math.max(
          0,
          target -
            (context.payment.asset.kind === "native"
              ? remainingNativeUseful
              : Math.min(remainingTypedUseful, remainingUntypedUseful)),
        ),
      );
      let shaped = constructQuantumPlan(
        inputs,
        context.payment,
        context.limits,
        desired,
      );
      const generatedLanes = (plan: PolicyPlan | undefined): number =>
        plan
          ? context.payment.asset.kind === "native"
            ? plan.change.length
            : plan.change.filter((output) => output.tokenAmount !== undefined)
                .length
          : 0;
      const inputIds = new Set(inputs.map((input) => input.id));
      const paddingCandidates = order.filter(
        (candidate) => !inputIds.has(candidate.id) && isSelectable(candidate),
      );
      let paddingIndex = 0;
      const addPadding = (): boolean => {
        if (
          inputs.length >= selected.length + generationLimit * 2 ||
          paddingIndex >= paddingCandidates.length
        )
          return false;
        const candidate = paddingCandidates[paddingIndex];
        paddingIndex += 1;
        inputs.push(candidate);
        inputIds.add(candidate.id);
        if (context.payment.asset.kind === "native") {
          if (
            isUntyped(candidate) &&
            candidate.capacity >= nativeQuantum(context.payment, context.limits)
          )
            remainingNativeUseful -= 1;
        } else {
          if (
            isPaymentType(candidate) &&
            (candidate.token?.amount ?? 0n) >= context.payment.amount
          )
            remainingTypedUseful -= 1;
          if (
            isUntyped(candidate) &&
            candidate.capacity >= xudtMateQuantum(context.payment, context.limits)
          )
            remainingUntypedUseful -= 1;
        }
        desired = Math.min(
          generationLimit,
          Math.max(
            0,
            target -
              (context.payment.asset.kind === "native"
                ? remainingNativeUseful
                : Math.min(remainingTypedUseful, remainingUntypedUseful)),
          ),
        );
        shaped = constructQuantumPlan(
          inputs,
          context.payment,
          context.limits,
          desired,
        );
        return true;
      };
      while (generatedLanes(shaped) < desired && addPadding()) {}
      if (!shaped) {
        if (validFallback) return validFallback;
        return findAlternateFallback();
      }
      let violations = validateDampedQuantumBoundary(
        context.payment,
        inputs,
        materializeChange(shaped.change, context.payment, context.limits),
        context.limits,
        { confirmedInventory: context.confirmedInventory },
      );
      while (violations.length > 0 && addPadding()) {
        if (!shaped) continue;
        violations = validateDampedQuantumBoundary(
          context.payment,
          inputs,
          materializeChange(shaped.change, context.payment, context.limits),
          context.limits,
          { confirmedInventory: context.confirmedInventory },
        );
      }
      while (violations.length > 0 && desired > 1) {
        desired -= 1;
        const reduced = constructQuantumPlan(
          inputs,
          context.payment,
          context.limits,
          desired,
        );
        if (!reduced) continue;
        shaped = reduced;
        violations = validateDampedQuantumBoundary(
          context.payment,
          inputs,
          materializeChange(shaped.change, context.payment, context.limits),
          context.limits,
          { confirmedInventory: context.confirmedInventory },
        );
      }
      if (violations.length > 0) {
        if (validFallback) return validFallback;
        return findAlternateFallback();
      }
      return shaped;
    }
    return findAlternateFallback();
  },
};
