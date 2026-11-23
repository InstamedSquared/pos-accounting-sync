export type PaymentMethod = "cash" | "card" | "qr";

export type FaultMode =
  | "none"
  | "rate_limit_429"
  | "timeout_504_committed"
  | "timeout_504_dropped"
  | "validation_400";

export interface Product {
  id: number;
  sku: string;
  name: string;
  category: string;
  priceCents: number;
  stockQty: number;
  isActive: boolean;
  updatedAt: string;
}

export interface OrderItem {
  id: number;
  productId: number;
  sku: string;
  productName: string;
  quantity: number;
  unitPriceCents: number;
  lineTotalCents: number;
}

export interface Order {
  id: number;
  orderNumber: string;
  idempotencyKey: string;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  paymentMethod: PaymentMethod;
  cashTenderedCents: number | null;
  changeCents: number | null;
  status: "completed" | "voided";
  syncStatus: "pending" | "synced" | "failed";
  externalJournalId: string | null;
  voidReason: string | null;
  createdAt: string;
  items: OrderItem[];
}

export interface OrdersSummary {
  totalOrders: number;
  completedOrders: number;
  voidedOrders: number;
  grossSalesCents: number;
  pendingSyncOrders: number;
}

export interface OutboxJob {
  id: number;
  order_id: number;
  event_type: "accounting.post_sale" | "accounting.reverse_sale";
  idempotency_key: string;
  payload: Record<string, unknown>;
  status: "pending" | "processing" | "succeeded" | "dead_letter";
  attempts: number;
  next_retry_at: string;
  last_error: string | null;
  created_at: string;
}

export interface AccountingJournal {
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

export interface AuditLogEntry {
  id: number;
  entity_type: string;
  entity_id: string;
  action: string;
  actor: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface ReconciliationItem {
  orderNumber: string;
  orderStatus: "completed" | "voided";
  localTotalCents: number;
  ledgerTotalCents: number | null;
  varianceCents: number;
  externalJournalId: string | null;
  status: "matched" | "missing_in_accounting" | "amount_mismatch" | "void_drift";
  detail: string;
}

export interface ReconciliationReport {
  checkedAt: string;
  localCompletedNetCents: number;
  ledgerActiveNetCents: number;
  totalVarianceCents: number;
  summary: {
    totalOrders: number;
    matched: number;
    missingInAccounting: number;
    amountMismatch: number;
    voidDrift: number;
  };
  items: ReconciliationItem[];
}
