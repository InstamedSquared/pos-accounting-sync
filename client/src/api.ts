import {
  AccountingJournal,
  AuditLogEntry,
  FaultMode,
  Order,
  OrdersSummary,
  OutboxJob,
  PaymentMethod,
  Product,
  ReconciliationReport,
} from "./types";

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const json = (await res.json()) as { success?: boolean; message?: string } & T;
  if (!res.ok || json.success === false) {
    throw new Error(json.message ?? `Request failed (${res.status})`);
  }
  return json;
}

export const posApi = {
  getProducts: (includeArchived = false) =>
    request<{ data: Product[] }>(
      `/api/products${includeArchived ? "?includeArchived=true" : ""}`
    ),
  createProduct: (payload: {
    sku: string;
    name: string;
    category: string;
    priceCents: number;
    stockQty: number;
  }) =>
    request<{ data: Product }>("/api/products", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  updateProduct: (
    id: number,
    payload: {
      sku?: string;
      name?: string;
      category?: string;
      priceCents?: number;
      stockQty?: number;
    }
  ) =>
    request<{ data: Product }>(`/api/products/${id}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    }),
  deleteProduct: (id: number) =>
    request<{
      mode: "deleted" | "archived";
      orderLinesReferenced: number;
      product: Product;
    }>(`/api/products/${id}`, {
      method: "DELETE",
    }),
  restoreProduct: (id: number) =>
    request<{ data: Product }>(`/api/products/${id}/restore`, {
      method: "POST",
    }),
  restockProduct: (id: number, addQty: number) =>
    request<{ data: Product }>(`/api/products/${id}/restock`, {
      method: "POST",
      body: JSON.stringify({ addQty }),
    }),
  getOrders: () => request<{ summary: OrdersSummary; orders: Order[] }>("/api/orders"),
  checkout: (payload: {
    idempotencyKey: string;
    paymentMethod: PaymentMethod;
    cashTenderedCents?: number;
    items: Array<{ productId: number; quantity: number }>;
  }) =>
    request<{ idempotentReplay: boolean; order: Order }>("/api/orders/checkout", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  voidOrder: (orderId: number, reason: string) =>
    request<{ order: Order }>(`/api/orders/${orderId}/void`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    }),
  getSyncState: () =>
    request<{
      faultConfig: { mode: FaultMode; remainingFailures: number };
      outbox: OutboxJob[];
      journals: AccountingJournal[];
      auditLogs: AuditLogEntry[];
    }>("/api/sync/outbox"),
  runSyncWorker: () =>
    request<{
      processed: number;
      results: Array<{
        outboxId: number;
        eventType: string;
        outcome: string;
        journalId?: string;
        error?: string;
      }>;
    }>("/api/sync/run", {
      method: "POST",
      body: JSON.stringify({ forceDue: true }),
    }),
  requeueOutbox: (id: number) =>
    request<{ data: OutboxJob }>(`/api/sync/outbox/${id}/requeue`, {
      method: "POST",
    }),
  setFaultConfig: (mode: FaultMode, failNextCount: number) =>
    request<{ faultConfig: { mode: FaultMode; remainingFailures: number } }>(
      "/api/sync/fault",
      {
        method: "POST",
        body: JSON.stringify({ mode, failNextCount }),
      }
    ),
  simulateDrift: (orderNumber: string, deltaCents: number) =>
    request<{ journal: AccountingJournal }>("/api/sync/simulate-drift", {
      method: "POST",
      body: JSON.stringify({ orderNumber, deltaCents }),
    }),
  runReconciliation: () =>
    request<{ report: ReconciliationReport }>("/api/reconcile", {
      method: "POST",
    }),
};

export function formatMoney(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  return `${sign}$${(Math.abs(cents) / 100).toFixed(2)}`;
}
