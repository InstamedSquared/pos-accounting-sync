import { FaultMode } from "../schemas/posSchemas";

export interface AccountingJournalEntry {
  journalId: string;
  orderNumber: string;
  eventType: "sale" | "reversal";
  idempotencyKey: string;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  paymentMethod: string;
  status: "posted" | "reversed";
  postedAt: string;
}

export interface FaultConfig {
  mode: FaultMode;
  remainingFailures: number;
}

export class ExternalAccountingError extends Error {
  public readonly statusCode: number;
  public readonly retryable: boolean;
  public readonly retryAfterSeconds?: number;

  constructor(
    message: string,
    statusCode: number,
    retryable: boolean,
    retryAfterSeconds?: number
  ) {
    super(message);
    this.name = "ExternalAccountingError";
    this.statusCode = statusCode;
    this.retryable = retryable;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * Simulated external accounting ledger (MYOB / Xero style API).
 * Supports realistic failure injection (429, 504 after commit, 504 dropped, 400)
 * and external edit drift simulation to prove reconciliation and idempotency.
 */
export class MockAccountingApi {
  private journals: Map<string, AccountingJournalEntry> = new Map();
  private sequence = 1000;
  private faultConfig: FaultConfig = { mode: "none", remainingFailures: 0 };

  public getFaultConfig(): FaultConfig {
    return { ...this.faultConfig };
  }

  public setFaultConfig(mode: FaultMode, failNextCount: number): FaultConfig {
    this.faultConfig = {
      mode,
      remainingFailures: mode === "none" ? 0 : failNextCount,
    };
    return this.getFaultConfig();
  }

  public listJournals(): AccountingJournalEntry[] {
    return Array.from(this.journals.values()).sort((a, b) =>
      b.postedAt.localeCompare(a.postedAt)
    );
  }

  /**
   * Read-before-retry lookup used after an ambiguous 504 timeout to guarantee
   * a sale or reversal is never double-posted to accounting.
   */
  public async findByIdempotencyKey(
    idempotencyKey: string
  ): Promise<AccountingJournalEntry | null> {
    for (const entry of this.journals.values()) {
      if (entry.idempotencyKey === idempotencyKey) {
        return { ...entry };
      }
    }
    return null;
  }

  public async findSaleByOrderNumber(
    orderNumber: string
  ): Promise<AccountingJournalEntry | null> {
    for (const entry of this.journals.values()) {
      if (entry.orderNumber === orderNumber && entry.eventType === "sale") {
        return { ...entry };
      }
    }
    return null;
  }

  public async postSaleJournal(input: {
    orderNumber: string;
    idempotencyKey: string;
    subtotalCents: number;
    taxCents: number;
    totalCents: number;
    paymentMethod: string;
  }): Promise<AccountingJournalEntry> {
    const activeFault = this.consumeFault();

    if (activeFault === "rate_limit_429") {
      throw new ExternalAccountingError(
        "MYOB/Xero API rate limit exceeded (429 Too Many Requests)",
        429,
        true,
        2
      );
    }
    if (activeFault === "validation_400") {
      throw new ExternalAccountingError(
        "Accounting validation rejected: invalid GL account mapping (400 Bad Request)",
        400,
        false
      );
    }
    if (activeFault === "timeout_504_dropped") {
      throw new ExternalAccountingError(
        "Gateway timeout before accounting write committed (504 Gateway Timeout)",
        504,
        true
      );
    }

    // Create the journal entry (note: for timeout_504_committed, the remote system
    // commits the write BEFORE the network times out — the classic double-post trap!)
    const existing = await this.findByIdempotencyKey(input.idempotencyKey);
    const entry: AccountingJournalEntry = existing ?? {
      journalId: `JRN-${++this.sequence}`,
      orderNumber: input.orderNumber,
      eventType: "sale",
      idempotencyKey: input.idempotencyKey,
      subtotalCents: input.subtotalCents,
      taxCents: input.taxCents,
      totalCents: input.totalCents,
      paymentMethod: input.paymentMethod,
      status: "posted",
      postedAt: new Date().toISOString(),
    };
    this.journals.set(entry.journalId, entry);

    if (activeFault === "timeout_504_committed") {
      throw new ExternalAccountingError(
        "Gateway timeout AFTER remote journal committed (504 Ambiguous Timeout)",
        504,
        true
      );
    }

    return { ...entry };
  }

  public async postReversalJournal(input: {
    orderNumber: string;
    idempotencyKey: string;
    totalCents: number;
  }): Promise<AccountingJournalEntry> {
    const activeFault = this.consumeFault();
    if (activeFault === "rate_limit_429") {
      throw new ExternalAccountingError("Rate limit exceeded (429)", 429, true, 2);
    }
    if (activeFault === "timeout_504_dropped") {
      throw new ExternalAccountingError("Gateway timeout before commit (504)", 504, true);
    }

    const saleEntry = await this.findSaleByOrderNumber(input.orderNumber);
    if (saleEntry) {
      const updatedSale: AccountingJournalEntry = { ...saleEntry, status: "reversed" };
      this.journals.set(updatedSale.journalId, updatedSale);
    }

    const existing = await this.findByIdempotencyKey(input.idempotencyKey);
    const reversal: AccountingJournalEntry = existing ?? {
      journalId: `REV-${++this.sequence}`,
      orderNumber: input.orderNumber,
      eventType: "reversal",
      idempotencyKey: input.idempotencyKey,
      subtotalCents: 0,
      taxCents: 0,
      totalCents: -Math.abs(input.totalCents),
      paymentMethod: "void",
      status: "posted",
      postedAt: new Date().toISOString(),
    };
    this.journals.set(reversal.journalId, reversal);

    if (activeFault === "timeout_504_committed") {
      throw new ExternalAccountingError(
        "Gateway timeout AFTER reversal committed (504 Ambiguous Timeout)",
        504,
        true
      );
    }

    return { ...reversal };
  }

  /**
   * Simulates an accountant manually editing a posted journal directly inside MYOB/Xero
   * so EOD reconciliation can detect and surface the exact discrepancy.
   */
  public simulateExternalAmountDrift(
    orderNumber: string,
    deltaCents: number
  ): AccountingJournalEntry | null {
    for (const entry of this.journals.values()) {
      if (entry.orderNumber === orderNumber && entry.eventType === "sale") {
        const drifted: AccountingJournalEntry = {
          ...entry,
          totalCents: Math.max(0, entry.totalCents + deltaCents),
        };
        this.journals.set(drifted.journalId, drifted);
        return { ...drifted };
      }
    }
    return null;
  }

  public reset(): void {
    this.journals.clear();
    this.sequence = 1000;
    this.faultConfig = { mode: "none", remainingFailures: 0 };
  }

  private consumeFault(): FaultMode {
    if (this.faultConfig.mode === "none" || this.faultConfig.remainingFailures <= 0) {
      return "none";
    }
    const mode = this.faultConfig.mode;
    this.faultConfig.remainingFailures -= 1;
    if (this.faultConfig.remainingFailures <= 0) {
      this.faultConfig.mode = "none";
    }
    return mode;
  }
}
