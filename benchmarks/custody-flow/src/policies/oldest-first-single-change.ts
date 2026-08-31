import type { Cell } from "../model.ts";
import type { Policy } from "../policy.ts";
import { constructSingleChangePlan } from "../single-change.ts";

export const oldestFirstSingleChange: Policy = {
  id: "oldest-first-single-change",
  propose(context) {
    const selected: Cell[] = [];
    for (;;) {
      const page = context.candidates.readNextPage();
      if (page.length === 0) return undefined;
      for (const cell of page) {
        const relevant =
          cell.token === undefined ||
          (context.payment.asset.kind === "xudt" &&
            cell.token.typeId === context.payment.asset.typeId);
        if (!relevant) continue;
        selected.push(cell);
        const plan = constructSingleChangePlan(
          selected,
          context.payment,
          context.limits,
        );
        if (plan) return plan;
      }
    }
  },
};
