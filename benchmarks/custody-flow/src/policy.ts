import type {
  Cell,
  ChangeOutput,
  ConfirmedInventorySnapshot,
  Payment,
  PolicyLimits,
  PolicyPlan,
} from "./model.ts";

export class CandidateView {
  readonly #cells: Cell[];
  readonly #pageSize: number;
  readonly #candidateLimit: number;
  readonly #pageLimit: number;
  readonly #readCells: Cell[] = [];
  #next = 0;
  #pagesRead = 0;

  constructor(cells: Cell[], limits: PolicyLimits) {
    this.#cells = structuredClone(cells);
    this.#pageSize = limits.pageSize;
    this.#candidateLimit = limits.candidateLimit;
    this.#pageLimit = limits.pageLimit;
  }

  readNextPage(): Cell[] {
    if (
      this.#next >= this.#candidateLimit ||
      this.#pagesRead >= this.#pageLimit
    )
      return [];
    const end = Math.min(
      this.#next + this.#pageSize,
      this.#candidateLimit,
      this.#cells.length,
    );
    const result = this.#cells.slice(this.#next, end);
    this.#next = end;
    this.#pagesRead += 1;
    this.#readCells.push(...result);
    return structuredClone(result);
  }

  get cellsRead(): number {
    return this.#readCells.length;
  }

  get pagesRead(): number {
    return this.#pagesRead;
  }

  get readableCells(): Cell[] {
    return structuredClone(this.#readCells);
  }
}

export class LaneView {
  readonly #cells: Cell[];
  readonly #pageSize: number;
  readonly #scanLimit: number;
  readonly #readCells = new Map<string, Cell>();
  #cellsRead = 0;
  #pagesRead = 0;

  constructor(cells: Cell[], limits: PolicyLimits) {
    this.#cells = structuredClone(cells);
    this.#pageSize = limits.pageSize;
    this.#scanLimit = limits.candidateLimit + 1;
  }

  countUnselected(
    excludedIds: Set<string>,
    maximum: number,
    accepts: (cell: Cell) => boolean = () => true,
  ): number {
    if (!Number.isInteger(maximum) || maximum < 1)
      throw new Error("lane count maximum must be a positive integer");
    let next = 0;
    let count = 0;
    const scanLimit = Math.min(
      this.#cells.length,
      this.#scanLimit + maximum - 1,
    );
    while (next < scanLimit) {
      const end = Math.min(
        next + this.#pageSize,
        scanLimit,
      );
      const page = this.#cells.slice(next, end);
      for (const cell of page) this.#readCells.set(cell.id, cell);
      this.#cellsRead += page.length;
      this.#pagesRead += 1;
      count += page.filter(
        (cell) => !excludedIds.has(cell.id) && accepts(cell),
      ).length;
      if (count >= maximum) return maximum;
      next = end;
    }
    return count;
  }

  takeUnselected(
    excludedIds: Set<string>,
    maximum: number,
    accepts: (cell: Cell) => boolean,
  ): Cell[] {
    if (!Number.isInteger(maximum) || maximum < 1)
      throw new Error("lane take maximum must be a positive integer");
    const result: Cell[] = [];
    const scanLimit = Math.min(
      this.#cells.length,
      this.#scanLimit + maximum - 1,
    );
    for (let next = 0; next < scanLimit && result.length < maximum; ) {
      const end = Math.min(next + this.#pageSize, scanLimit);
      const page = this.#cells.slice(next, end);
      for (const cell of page) this.#readCells.set(cell.id, cell);
      this.#cellsRead += page.length;
      this.#pagesRead += 1;
      result.push(
        ...page.filter(
          (cell) => !excludedIds.has(cell.id) && accepts(cell),
        ).slice(0, maximum - result.length),
      );
      next = end;
    }
    return structuredClone(result);
  }

  get cellsRead(): number {
    return this.#cellsRead;
  }

  get pagesRead(): number {
    return this.#pagesRead;
  }

  get readableCells(): Cell[] {
    return structuredClone([...this.#readCells.values()]);
  }
}

export type PolicyContext = {
  window: number;
  payment: Payment;
  limits: PolicyLimits;
  candidates: CandidateView;
  lanes: { untyped: LaneView; paymentType?: LaneView };
  confirmedInventory?: ConfirmedInventorySnapshot;
  pendingOutputs: ChangeOutput[];
};

export type Policy = {
  id: string;
  inventoryTarget?: (payment: Payment, limits: PolicyLimits) => number;
  validationBoundary?: "damped-quantum" | "equal-remainder" | "order-quantum";
  propose: (context: PolicyContext) => PolicyPlan | undefined;
};
