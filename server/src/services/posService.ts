import crypto from "crypto";
import { DbClient } from "../db/database";
import {
  CheckoutRequest,
  CreateProductRequest,
  UpdateProductRequest,
} from "../schemas/posSchemas";
import {
  ExternalAccountingError,
  MockAccountingApi,
} from "./mockAccountingApi";

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;

  constructor(message: string, statusCode = 400, code = "BAD_REQUEST") {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export interface ProductRow {
  id: number;
  sku: string;
  name: string;
  category: string;
  price_cents: string | number;
  stock_qty: number;
  is_active: boolean;
  updated_at: string;
}

export interface OrderRow {
  id: number;
  order_number: string;
  idempotency_key: string;
  subtotal_cents: string | number;
  tax_cents: string | number;
  total_cents: string | number;
  payment_method: "cash" | "card" | "qr";
  cash_tendered_cents: string | number | null;
  change_cents: string | number | null;
  status: "completed" | "voided";
  sync_status: "pending" | "synced" | "failed";
  external_journal_id: string | null;
  void_reason: string | null;
  created_at: string;
}

export interface OrderItemRow {
  id: number;
  order_id: number;
  product_id: number;
  sku: string;
  product_name: string;
  quantity: number;
  unit_price_cents: string | number;
  line_total_cents: string | number;
}

export interface OutboxRow {
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
  updated_at: string;
}

export type ReconciliationItemStatus =
  | "matched"
  | "missing_in_accounting"
  | "amount_mismatch"
  | "void_drift";

export interface ReconciliationItem {
  orderNumber: string;
  orderStatus: "completed" | "voided";
  localTotalCents: number;
  ledgerTotalCents: number | null;
  varianceCents: number;
  externalJournalId: string | null;
  status: ReconciliationItemStatus;
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

const GST_RATE = 0.1; // 10% GST (standard AU/retail tax model)
const MAX_OUTBOX_ATTEMPTS = 5;

export class PosService {
  constructor(
    private readonly db: DbClient,
    private readonly accountingApi: MockAccountingApi
  ) {}

  public async listProducts(options?: { includeArchived?: boolean }) {
    const includeArchived = Boolean(options?.includeArchived);
    const res = await this.db.query<ProductRow>(
      includeArchived
        ? `SELECT id, sku, name, category, price_cents, stock_qty, is_active, updated_at
           FROM products
           ORDER BY is_active DESC, category ASC, name ASC`
        : `SELECT id, sku, name, category, price_cents, stock_qty, is_active, updated_at
           FROM products
           WHERE is_active = true
           ORDER BY category ASC, name ASC`
    );
    return res.rows.map((p) => this.formatProduct(p));
  }

  public async createProduct(input: CreateProductRequest) {
    return this.db.transaction(async (tx) => {
      const existing = await tx.query<{ id: number }>(
        `SELECT id FROM products WHERE sku = $1 LIMIT 1`,
        [input.sku]
      );
      if (existing.rows[0]) {
        throw new AppError(
          `A product with SKU "${input.sku}" already exists`,
          409,
          "DUPLICATE_SKU"
        );
      }

      const res = await tx.query<ProductRow>(
        `INSERT INTO products (sku, name, category, price_cents, stock_qty, is_active)
         VALUES ($1, $2, $3, $4, $5, true)
         RETURNING id, sku, name, category, price_cents, stock_qty, is_active, updated_at`,
        [input.sku, input.name, input.category, input.priceCents, input.stockQty]
      );
      const created = res.rows[0];
      if (!created) {
        throw new AppError("Failed to create product", 500, "PRODUCT_CREATE_FAILED");
      }

      await tx.query(
        `INSERT INTO audit_logs (entity_type, entity_id, action, actor, metadata)
         VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [
          "product",
          String(created.id),
          "product.created",
          "manager",
          JSON.stringify({
            sku: created.sku,
            name: created.name,
            category: created.category,
            priceCents: Number(created.price_cents),
            stockQty: Number(created.stock_qty),
          }),
        ]
      );

      return this.formatProduct(created);
    });
  }

  public async updateProduct(productId: number, input: UpdateProductRequest) {
    return this.db.transaction(async (tx) => {
      const existingRes = await tx.query<ProductRow>(
        `SELECT id, sku, name, category, price_cents, stock_qty, is_active, updated_at
         FROM products
         WHERE id = $1
         LIMIT 1`,
        [productId]
      );
      const existing = existingRes.rows[0];
      if (!existing) {
        throw new AppError("Product not found", 404, "PRODUCT_NOT_FOUND");
      }

      const nextSku = input.sku ?? existing.sku;
      const nextName = input.name ?? existing.name;
      const nextCategory = input.category ?? existing.category;
      const nextPriceCents = input.priceCents ?? Number(existing.price_cents);
      const nextStockQty = input.stockQty ?? Number(existing.stock_qty);

      if (nextSku !== existing.sku) {
        const dup = await tx.query<{ id: number }>(
          `SELECT id FROM products WHERE sku = $1 AND id <> $2 LIMIT 1`,
          [nextSku, productId]
        );
        if (dup.rows[0]) {
          throw new AppError(
            `Another product already uses SKU "${nextSku}"`,
            409,
            "DUPLICATE_SKU"
          );
        }
      }

      const updatedRes = await tx.query<ProductRow>(
        `UPDATE products
         SET sku = $1,
             name = $2,
             category = $3,
             price_cents = $4,
             stock_qty = $5,
             updated_at = now()
         WHERE id = $6
         RETURNING id, sku, name, category, price_cents, stock_qty, is_active, updated_at`,
        [nextSku, nextName, nextCategory, nextPriceCents, nextStockQty, productId]
      );
      const updated = updatedRes.rows[0]!;

      await tx.query(
        `INSERT INTO audit_logs (entity_type, entity_id, action, actor, metadata)
         VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [
          "product",
          String(updated.id),
          "product.updated",
          "manager",
          JSON.stringify({
            before: {
              sku: existing.sku,
              name: existing.name,
              category: existing.category,
              priceCents: Number(existing.price_cents),
              stockQty: Number(existing.stock_qty),
            },
            after: {
              sku: updated.sku,
              name: updated.name,
              category: updated.category,
              priceCents: Number(updated.price_cents),
              stockQty: Number(updated.stock_qty),
            },
          }),
        ]
      );

      return this.formatProduct(updated);
    });
  }

  /**
   * Smart Delete:
   * - If the product has never been sold (0 order_items), hard-deletes it cleanly.
   * - If the product has historical sales, archives (soft-deletes) it so past orders,
   *   receipts, and EOD accounting reconciliation remain 100% intact.
   */
  public async deleteProduct(productId: number) {
    return this.db.transaction(async (tx) => {
      const existingRes = await tx.query<ProductRow>(
        `SELECT id, sku, name, category, price_cents, stock_qty, is_active, updated_at
         FROM products
         WHERE id = $1
         LIMIT 1`,
        [productId]
      );
      const existing = existingRes.rows[0];
      if (!existing) {
        throw new AppError("Product not found", 404, "PRODUCT_NOT_FOUND");
      }

      const usageRes = await tx.query<{ usage_count: string | number }>(
        `SELECT COUNT(*) AS usage_count FROM order_items WHERE product_id = $1`,
        [productId]
      );
      const usageCount = Number(usageRes.rows[0]?.usage_count ?? 0);

      if (usageCount > 0) {
        const archivedRes = await tx.query<ProductRow>(
          `UPDATE products
           SET is_active = false, updated_at = now()
           WHERE id = $1
           RETURNING id, sku, name, category, price_cents, stock_qty, is_active, updated_at`,
          [productId]
        );
        const archived = archivedRes.rows[0]!;

        await tx.query(
          `INSERT INTO audit_logs (entity_type, entity_id, action, actor, metadata)
           VALUES ($1, $2, $3, $4, $5::jsonb)`,
          [
            "product",
            String(archived.id),
            "product.archived",
            "manager",
            JSON.stringify({
              sku: archived.sku,
              name: archived.name,
              orderLinesReferenced: usageCount,
            }),
          ]
        );

        return {
          mode: "archived" as const,
          orderLinesReferenced: usageCount,
          product: this.formatProduct(archived),
        };
      }

      await tx.query(`DELETE FROM products WHERE id = $1`, [productId]);

      await tx.query(
        `INSERT INTO audit_logs (entity_type, entity_id, action, actor, metadata)
         VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [
          "product",
          String(existing.id),
          "product.deleted",
          "manager",
          JSON.stringify({ sku: existing.sku, name: existing.name }),
        ]
      );

      return {
        mode: "deleted" as const,
        orderLinesReferenced: 0,
        product: this.formatProduct(existing),
      };
    });
  }

  public async restoreProduct(productId: number) {
    return this.db.transaction(async (tx) => {
      const res = await tx.query<ProductRow>(
        `UPDATE products
         SET is_active = true, updated_at = now()
         WHERE id = $1
         RETURNING id, sku, name, category, price_cents, stock_qty, is_active, updated_at`,
        [productId]
      );
      const restored = res.rows[0];
      if (!restored) {
        throw new AppError("Product not found", 404, "PRODUCT_NOT_FOUND");
      }

      await tx.query(
        `INSERT INTO audit_logs (entity_type, entity_id, action, actor, metadata)
         VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [
          "product",
          String(restored.id),
          "product.restored",
          "manager",
          JSON.stringify({ sku: restored.sku, name: restored.name }),
        ]
      );

      return this.formatProduct(restored);
    });
  }

  public async restockProduct(productId: number, addQty: number) {
    return this.db.transaction(async (tx) => {
      const res = await tx.query<ProductRow>(
        `UPDATE products
         SET stock_qty = stock_qty + $1, updated_at = now()
         WHERE id = $2
         RETURNING id, sku, name, category, price_cents, stock_qty, is_active, updated_at`,
        [addQty, productId]
      );
      const updated = res.rows[0];
      if (!updated) {
        throw new AppError("Product not found", 404, "PRODUCT_NOT_FOUND");
      }

      await tx.query(
        `INSERT INTO audit_logs (entity_type, entity_id, action, actor, metadata)
         VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [
          "product",
          String(updated.id),
          "inventory.restocked",
          "manager",
          JSON.stringify({ sku: updated.sku, addedQty: addQty, newStockQty: updated.stock_qty }),
        ]
      );

      return this.formatProduct(updated);
    });
  }

  private formatProduct(p: ProductRow) {
    return {
      id: p.id,
      sku: p.sku,
      name: p.name,
      category: p.category,
      priceCents: Number(p.price_cents),
      stockQty: Number(p.stock_qty),
      isActive: Boolean(p.is_active),
      updatedAt: p.updated_at,
    };
  }

  /**
   * Idempotent, ACID checkout:
   * 1. Returns existing order if idempotencyKey was already committed.
   * 2. Atomically checks & deducts inventory (impossible to oversell).
   * 3. Computes subtotal + 10% GST strictly in integer cents.
   * 4. Inserts order, order_items, accounting_outbox job, and audit_log in ONE SQL transaction.
   */
  public async checkout(input: CheckoutRequest) {
    // Idempotency check before opening a write transaction
    const existingRes = await this.db.query<OrderRow>(
      `SELECT * FROM orders WHERE idempotency_key = $1 LIMIT 1`,
      [input.idempotencyKey]
    );
    const existingOrder = existingRes.rows[0];
    if (existingOrder) {
      const itemsRes = await this.db.query<OrderItemRow>(
        `SELECT * FROM order_items WHERE order_id = $1 ORDER BY id ASC`,
        [existingOrder.id]
      );
      return {
        idempotentReplay: true,
        order: this.formatOrder(existingOrder, itemsRes.rows),
      };
    }

    // Merge duplicate product lines in cart so stock checks are exact
    const qtyByProduct = new Map<number, number>();
    for (const item of input.items) {
      qtyByProduct.set(
        item.productId,
        (qtyByProduct.get(item.productId) ?? 0) + item.quantity
      );
    }

    return this.db.transaction(async (tx) => {
      const resolvedItems: Array<{
        productId: number;
        sku: string;
        name: string;
        quantity: number;
        unitPriceCents: number;
        lineTotalCents: number;
      }> = [];

      let subtotalCents = 0;

      for (const [productId, quantity] of qtyByProduct.entries()) {
        // Atomic stock deduction guarded by is_active = true AND stock_qty >= quantity
        const deducted = await tx.query<ProductRow>(
          `UPDATE products
           SET stock_qty = stock_qty - $1, updated_at = now()
           WHERE id = $2 AND is_active = true AND stock_qty >= $1
           RETURNING id, sku, name, category, price_cents, stock_qty, is_active, updated_at`,
          [quantity, productId]
        );
        const product = deducted.rows[0];
        if (!product) {
          const check = await tx.query<ProductRow>(
            `SELECT id, name, stock_qty, is_active FROM products WHERE id = $1`,
            [productId]
          );
          const existingProd = check.rows[0];
          if (!existingProd) {
            throw new AppError(
              `Product #${productId} does not exist`,
              404,
              "PRODUCT_NOT_FOUND"
            );
          }
          if (!existingProd.is_active) {
            throw new AppError(
              `Product "${existingProd.name}" is archived and cannot be sold`,
              409,
              "PRODUCT_ARCHIVED"
            );
          }
          throw new AppError(
            `Insufficient stock for "${existingProd.name}" (available: ${existingProd.stock_qty}, requested: ${quantity})`,
            409,
            "INSUFFICIENT_STOCK"
          );
        }

        const unitPriceCents = Number(product.price_cents);
        const lineTotalCents = unitPriceCents * quantity;
        subtotalCents += lineTotalCents;

        resolvedItems.push({
          productId: product.id,
          sku: product.sku,
          name: product.name,
          quantity,
          unitPriceCents,
          lineTotalCents,
        });
      }

      const taxCents = Math.round(subtotalCents * GST_RATE);
      const totalCents = subtotalCents + taxCents;

      let cashTenderedCents: number | null = null;
      let changeCents: number | null = null;
      if (input.paymentMethod === "cash") {
        cashTenderedCents = input.cashTenderedCents ?? totalCents;
        if (cashTenderedCents < totalCents) {
          throw new AppError(
            `Cash tendered ($${(cashTenderedCents / 100).toFixed(2)}) is less than order total ($${(totalCents / 100).toFixed(2)})`,
            400,
            "INSUFFICIENT_CASH"
          );
        }
        changeCents = cashTenderedCents - totalCents;
      }

      const orderNumber = `POS-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;

      const orderInsert = await tx.query<OrderRow>(
        `INSERT INTO orders (
           order_number, idempotency_key, subtotal_cents, tax_cents, total_cents,
           payment_method, cash_tendered_cents, change_cents, status, sync_status
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'completed', 'pending')
         RETURNING *`,
        [
          orderNumber,
          input.idempotencyKey,
          subtotalCents,
          taxCents,
          totalCents,
          input.paymentMethod,
          cashTenderedCents,
          changeCents,
        ]
      );
      const createdOrder = orderInsert.rows[0];
      if (!createdOrder) {
        throw new AppError("Failed to create order", 500, "ORDER_CREATE_FAILED");
      }

      const insertedItems: OrderItemRow[] = [];
      for (const line of resolvedItems) {
        const lineRes = await tx.query<OrderItemRow>(
          `INSERT INTO order_items (
             order_id, product_id, sku, product_name, quantity, unit_price_cents, line_total_cents
           )
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING *`,
          [
            createdOrder.id,
            line.productId,
            line.sku,
            line.name,
            line.quantity,
            line.unitPriceCents,
            line.lineTotalCents,
          ]
        );
        if (lineRes.rows[0]) {
          insertedItems.push(lineRes.rows[0]);
        }
      }

      // Transactional Outbox Pattern: enqueue accounting journal sync in the SAME SQL transaction
      const outboxKey = `post_sale:${orderNumber}`;
      await tx.query(
        `INSERT INTO accounting_outbox (order_id, event_type, idempotency_key, payload, status)
         VALUES ($1, 'accounting.post_sale', $2, $3::jsonb, 'pending')
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [
          createdOrder.id,
          outboxKey,
          JSON.stringify({
            orderId: createdOrder.id,
            orderNumber,
            subtotalCents,
            taxCents,
            totalCents,
            paymentMethod: input.paymentMethod,
            itemsCount: resolvedItems.length,
          }),
        ]
      );

      await tx.query(
        `INSERT INTO audit_logs (entity_type, entity_id, action, actor, metadata)
         VALUES ('order', $1, 'order.completed', 'cashier', $2::jsonb)`,
        [
          orderNumber,
          JSON.stringify({
            totalCents,
            paymentMethod: input.paymentMethod,
            itemsCount: resolvedItems.length,
          }),
        ]
      );

      return {
        idempotentReplay: false,
        order: this.formatOrder(createdOrder, insertedItems),
      };
    });
  }

  /**
   * Atomically voids a completed order, restores stock to inventory,
   * and enqueues an accounting reversal journal in accounting_outbox.
   */
  public async voidOrder(orderId: number, reason: string) {
    return this.db.transaction(async (tx) => {
      const orderRes = await tx.query<OrderRow>(
        `SELECT * FROM orders WHERE id = $1`,
        [orderId]
      );
      const order = orderRes.rows[0];
      if (!order) {
        throw new AppError("Order not found", 404, "ORDER_NOT_FOUND");
      }
      if (order.status === "voided") {
        throw new AppError("Order is already voided", 409, "ALREADY_VOIDED");
      }

      const itemsRes = await tx.query<OrderItemRow>(
        `SELECT * FROM order_items WHERE order_id = $1 ORDER BY id ASC`,
        [order.id]
      );

      for (const item of itemsRes.rows) {
        await tx.query(
          `UPDATE products SET stock_qty = stock_qty + $1, updated_at = now() WHERE id = $2`,
          [item.quantity, item.product_id]
        );
      }

      const updatedRes = await tx.query<OrderRow>(
        `UPDATE orders
         SET status = 'voided', sync_status = 'pending', void_reason = $1, updated_at = now()
         WHERE id = $2
         RETURNING *`,
        [reason, order.id]
      );
      const voidedOrder = updatedRes.rows[0]!;

      const reversalKey = `reverse_sale:${order.order_number}`;
      await tx.query(
        `INSERT INTO accounting_outbox (order_id, event_type, idempotency_key, payload, status)
         VALUES ($1, 'accounting.reverse_sale', $2, $3::jsonb, 'pending')
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [
          order.id,
          reversalKey,
          JSON.stringify({
            orderId: order.id,
            orderNumber: order.order_number,
            totalCents: Number(order.total_cents),
            reason,
          }),
        ]
      );

      await tx.query(
        `INSERT INTO audit_logs (entity_type, entity_id, action, actor, metadata)
         VALUES ('order', $1, 'order.voided', 'manager', $2::jsonb)`,
        [order.order_number, JSON.stringify({ reason, restoredLines: itemsRes.rows.length })]
      );

      return this.formatOrder(voidedOrder, itemsRes.rows);
    });
  }

  public async listOrders() {
    const [ordersRes, itemsRes, summaryRes] = await Promise.all([
      this.db.query<OrderRow>(`SELECT * FROM orders ORDER BY created_at DESC, id DESC LIMIT 100`),
      this.db.query<OrderItemRow>(`SELECT * FROM order_items ORDER BY id ASC`),
      this.db.query<{
        total_orders: string | number;
        completed_orders: string | number;
        voided_orders: string | number;
        gross_sales_cents: string | number;
        pending_sync_orders: string | number;
      }>(`
        SELECT
          COUNT(*) AS total_orders,
          COUNT(*) FILTER (WHERE status = 'completed') AS completed_orders,
          COUNT(*) FILTER (WHERE status = 'voided') AS voided_orders,
          COALESCE(SUM(total_cents) FILTER (WHERE status = 'completed'), 0) AS gross_sales_cents,
          COUNT(*) FILTER (WHERE sync_status != 'synced') AS pending_sync_orders
        FROM orders
      `),
    ]);

    const itemsByOrder = new Map<number, OrderItemRow[]>();
    for (const item of itemsRes.rows) {
      const list = itemsByOrder.get(item.order_id) ?? [];
      list.push(item);
      itemsByOrder.set(item.order_id, list);
    }

    const s = summaryRes.rows[0];
    return {
      summary: {
        totalOrders: Number(s?.total_orders ?? 0),
        completedOrders: Number(s?.completed_orders ?? 0),
        voidedOrders: Number(s?.voided_orders ?? 0),
        grossSalesCents: Number(s?.gross_sales_cents ?? 0),
        pendingSyncOrders: Number(s?.pending_sync_orders ?? 0),
      },
      orders: ordersRes.rows.map((o) =>
        this.formatOrder(o, itemsByOrder.get(o.id) ?? [])
      ),
    };
  }

  public async listOutbox() {
    const res = await this.db.query<OutboxRow>(
      `SELECT * FROM accounting_outbox ORDER BY id DESC LIMIT 100`
    );
    return res.rows;
  }

  public async listAuditLogs() {
    const res = await this.db.query<{
      id: number;
      entity_type: string;
      entity_id: string;
      action: string;
      actor: string;
      metadata: Record<string, unknown>;
      created_at: string;
    }>(`SELECT * FROM audit_logs ORDER BY id DESC LIMIT 50`);
    return res.rows;
  }

  /**
   * Processes due accounting_outbox rows using:
   * - Atomic row claim (FOR UPDATE SKIP LOCKED inside transaction)
   * - Read-before-retry lookup to prevent double-posting after ambiguous 504 timeouts
   * - Exponential backoff on retryable errors (429/504) and dead-letter on 400 validation errors
   */
  public async processOutbox(options?: { forceDue?: boolean }) {
    const forceDue = Boolean(options?.forceDue);

    // Step 1: Atomically claim due pending jobs using PostgreSQL FOR UPDATE SKIP LOCKED
    const claimed = await this.db.transaction(async (tx) => {
      const dueRes = await tx.query<OutboxRow>(
        forceDue
          ? `SELECT * FROM accounting_outbox
             WHERE status = 'pending'
             ORDER BY id ASC
             LIMIT 20
             FOR UPDATE SKIP LOCKED`
          : `SELECT * FROM accounting_outbox
             WHERE status = 'pending' AND next_retry_at <= now()
             ORDER BY next_retry_at ASC, id ASC
             LIMIT 20
             FOR UPDATE SKIP LOCKED`
      );

      for (const row of dueRes.rows) {
        await tx.query(
          `UPDATE accounting_outbox
           SET status = 'processing', attempts = attempts + 1, updated_at = now()
           WHERE id = $1`,
          [row.id]
        );
      }

      return dueRes.rows.map((r) => ({ ...r, attempts: r.attempts + 1 }));
    });

    const results: Array<{
      outboxId: number;
      eventType: string;
      outcome: "succeeded" | "recovered_idempotent" | "retrying" | "dead_letter";
      journalId?: string;
      error?: string;
    }> = [];

    for (const job of claimed) {
      const payload = job.payload as {
        orderId: number;
        orderNumber: string;
        subtotalCents?: number;
        taxCents?: number;
        totalCents: number;
        paymentMethod?: string;
      };

      try {
        // Read-before-retry guard: if a previous attempt timed out AFTER remote commit,
        // discover the already-posted journal instead of creating a duplicate!
        const alreadyPosted = await this.accountingApi.findByIdempotencyKey(
          job.idempotency_key
        );

        let journal = alreadyPosted;
        let recovered = Boolean(alreadyPosted);

        if (!journal) {
          if (job.event_type === "accounting.post_sale") {
            journal = await this.accountingApi.postSaleJournal({
              orderNumber: payload.orderNumber,
              idempotencyKey: job.idempotency_key,
              subtotalCents: Number(payload.subtotalCents ?? 0),
              taxCents: Number(payload.taxCents ?? 0),
              totalCents: Number(payload.totalCents),
              paymentMethod: String(payload.paymentMethod ?? "card"),
            });
          } else {
            journal = await this.accountingApi.postReversalJournal({
              orderNumber: payload.orderNumber,
              idempotencyKey: job.idempotency_key,
              totalCents: Number(payload.totalCents),
            });
          }
        }

        await this.db.transaction(async (tx) => {
          await tx.query(
            `UPDATE accounting_outbox
             SET status = 'succeeded', last_error = NULL, updated_at = now()
             WHERE id = $1`,
            [job.id]
          );
          await tx.query(
            `UPDATE orders
             SET sync_status = 'synced',
                 external_journal_id = COALESCE($1, external_journal_id),
                 updated_at = now()
             WHERE id = $2`,
            [journal.journalId, job.order_id]
          );
          await tx.query(
            `INSERT INTO audit_logs (entity_type, entity_id, action, actor, metadata)
             VALUES ('outbox', $1, $2, 'sync-worker', $3::jsonb)`,
            [
              String(job.id),
              recovered ? "sync.recovered_idempotent" : "sync.succeeded",
              JSON.stringify({
                orderNumber: payload.orderNumber,
                journalId: journal.journalId,
                attempt: job.attempts,
              }),
            ]
          );
        });

        results.push({
          outboxId: job.id,
          eventType: job.event_type,
          outcome: recovered ? "recovered_idempotent" : "succeeded",
          journalId: journal.journalId,
        });
      } catch (err) {
        const isExt = err instanceof ExternalAccountingError;
        const retryable = isExt ? err.retryable : true;
        const message = err instanceof Error ? err.message : "Unknown sync error";
        const exhausted = !retryable || job.attempts >= MAX_OUTBOX_ATTEMPTS;

        const backoffSeconds = isExt && err.retryAfterSeconds
          ? err.retryAfterSeconds
          : Math.min(60, Math.pow(2, job.attempts) * 2);

        await this.db.transaction(async (tx) => {
          await tx.query(
            `UPDATE accounting_outbox
             SET status = $1,
                 last_error = $2,
                 next_retry_at = now() + ($3 || ' seconds')::interval,
                 updated_at = now()
             WHERE id = $4`,
            [
              exhausted ? "dead_letter" : "pending",
              message,
              String(backoffSeconds),
              job.id,
            ]
          );
          await tx.query(
            `UPDATE orders
             SET sync_status = $1, updated_at = now()
             WHERE id = $2`,
            [exhausted ? "failed" : "pending", job.order_id]
          );
          await tx.query(
            `INSERT INTO audit_logs (entity_type, entity_id, action, actor, metadata)
             VALUES ('outbox', $1, $2, 'sync-worker', $3::jsonb)`,
            [
              String(job.id),
              exhausted ? "sync.dead_letter" : "sync.retry_scheduled",
              JSON.stringify({
                orderNumber: payload.orderNumber,
                attempt: job.attempts,
                error: message,
              }),
            ]
          );
        });

        results.push({
          outboxId: job.id,
          eventType: job.event_type,
          outcome: exhausted ? "dead_letter" : "retrying",
          error: message,
        });
      }
    }

    return {
      processed: results.length,
      results,
    };
  }

  public async requeueDeadLetter(outboxId: number) {
    const res = await this.db.query<OutboxRow>(
      `UPDATE accounting_outbox
       SET status = 'pending', attempts = 0, next_retry_at = now(), last_error = NULL, updated_at = now()
       WHERE id = $1 AND status = 'dead_letter'
       RETURNING *`,
      [outboxId]
    );
    const row = res.rows[0];
    if (!row) {
      throw new AppError("Dead-letter job not found", 404, "OUTBOX_NOT_FOUND");
    }
    return row;
  }

  /**
   * End-of-Day Reconciliation: compares Local Postgres Orders against the External Accounting Ledger
   * and flags missing journals, amount drift, and voided-but-unreversed entries.
   */
  public async runReconciliation(): Promise<ReconciliationReport> {
    const ordersRes = await this.db.query<OrderRow>(
      `SELECT * FROM orders ORDER BY created_at DESC, id DESC`
    );
    const ledgerEntries = this.accountingApi.listJournals();
    const saleJournalByOrder = new Map(
      ledgerEntries
        .filter((j) => j.eventType === "sale")
        .map((j) => [j.orderNumber, j])
    );

    const items: ReconciliationItem[] = [];
    let localCompletedNetCents = 0;
    let ledgerActiveNetCents = 0;
    let matched = 0;
    let missingInAccounting = 0;
    let amountMismatch = 0;
    let voidDrift = 0;

    for (const order of ordersRes.rows) {
      const localCents = Number(order.total_cents);
      const journal = saleJournalByOrder.get(order.order_number) ?? null;

      if (order.status === "completed") {
        localCompletedNetCents += localCents;
      }

      if (journal && journal.status === "posted") {
        ledgerActiveNetCents += journal.totalCents;
      }

      if (order.status === "completed") {
        if (!journal) {
          missingInAccounting += 1;
          items.push({
            orderNumber: order.order_number,
            orderStatus: order.status,
            localTotalCents: localCents,
            ledgerTotalCents: null,
            varianceCents: localCents,
            externalJournalId: null,
            status: "missing_in_accounting",
            detail: "Completed in POS but not yet posted to accounting ledger.",
          });
        } else if (journal.totalCents !== localCents) {
          amountMismatch += 1;
          items.push({
            orderNumber: order.order_number,
            orderStatus: order.status,
            localTotalCents: localCents,
            ledgerTotalCents: journal.totalCents,
            varianceCents: localCents - journal.totalCents,
            externalJournalId: journal.journalId,
            status: "amount_mismatch",
            detail: `POS total ($${(localCents / 100).toFixed(2)}) differs from ledger ($${(journal.totalCents / 100).toFixed(2)}).`,
          });
        } else {
          matched += 1;
          items.push({
            orderNumber: order.order_number,
            orderStatus: order.status,
            localTotalCents: localCents,
            ledgerTotalCents: journal.totalCents,
            varianceCents: 0,
            externalJournalId: journal.journalId,
            status: "matched",
            detail: "POS and accounting ledger match exactly.",
          });
        }
      } else {
        // Voided order
        if (!journal || journal.status === "reversed") {
          matched += 1;
          items.push({
            orderNumber: order.order_number,
            orderStatus: order.status,
            localTotalCents: 0,
            ledgerTotalCents: 0,
            varianceCents: 0,
            externalJournalId: journal?.journalId ?? null,
            status: "matched",
            detail: "Voided order cleanly reversed/excluded in accounting.",
          });
        } else {
          voidDrift += 1;
          items.push({
            orderNumber: order.order_number,
            orderStatus: order.status,
            localTotalCents: 0,
            ledgerTotalCents: journal.totalCents,
            varianceCents: -journal.totalCents,
            externalJournalId: journal.journalId,
            status: "void_drift",
            detail: "Order voided in POS, but sale journal is still active in accounting.",
          });
        }
      }
    }

    const report: ReconciliationReport = {
      checkedAt: new Date().toISOString(),
      localCompletedNetCents,
      ledgerActiveNetCents,
      totalVarianceCents: localCompletedNetCents - ledgerActiveNetCents,
      summary: {
        totalOrders: items.length,
        matched,
        missingInAccounting,
        amountMismatch,
        voidDrift,
      },
      items,
    };

    await this.db.query(
      `INSERT INTO audit_logs (entity_type, entity_id, action, actor, metadata)
       VALUES ('reconciliation', 'eod', 'reconciliation.executed', 'manager', $1::jsonb)`,
      [JSON.stringify(report.summary)]
    );

    return report;
  }

  private formatOrder(order: OrderRow, items: OrderItemRow[]) {
    return {
      id: order.id,
      orderNumber: order.order_number,
      idempotencyKey: order.idempotency_key,
      subtotalCents: Number(order.subtotal_cents),
      taxCents: Number(order.tax_cents),
      totalCents: Number(order.total_cents),
      paymentMethod: order.payment_method,
      cashTenderedCents:
        order.cash_tendered_cents !== null ? Number(order.cash_tendered_cents) : null,
      changeCents: order.change_cents !== null ? Number(order.change_cents) : null,
      status: order.status,
      syncStatus: order.sync_status,
      externalJournalId: order.external_journal_id,
      voidReason: order.void_reason,
      createdAt: order.created_at,
      items: items.map((i) => ({
        id: i.id,
        productId: i.product_id,
        sku: i.sku,
        productName: i.product_name,
        quantity: i.quantity,
        unitPriceCents: Number(i.unit_price_cents),
        lineTotalCents: Number(i.line_total_cents),
      })),
    };
  }
}
