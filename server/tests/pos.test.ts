import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { createDatabase, DbClient } from "../src/db/database";
import { createApp } from "../src/app";
import { MockAccountingApi } from "../src/services/mockAccountingApi";

describe("POS + Inventory + Accounting Sync (PostgreSQL PGlite)", () => {
  let db: DbClient;
  let accountingApi: MockAccountingApi;
  let app: ReturnType<typeof createApp>["app"];

  beforeEach(async () => {
    db = await createDatabase(); // Fast in-memory real PostgreSQL via PGlite
    accountingApi = new MockAccountingApi();
    ({ app } = createApp({ db, accountingApi }));
  });

  afterEach(async () => {
    await db.close();
  });

  it("1. Atomically deducts stock, computes 10% GST in cents, and writes transactional outbox + audit log", async () => {
    const prodRes = await request(app).get("/api/products").expect(200);
    const flatWhite = prodRes.body.data.find((p: { sku: string }) => p.sku === "COF-ESP-01");
    expect(flatWhite).toBeDefined();
    const initialStock = flatWhite.stockQty;

    const checkoutRes = await request(app)
      .post("/api/orders/checkout")
      .send({
        idempotencyKey: "checkout-test-001",
        paymentMethod: "cash",
        cashTenderedCents: 2000,
        items: [{ productId: flatWhite.id, quantity: 2 }],
      })
      .expect(201);

    expect(checkoutRes.body.idempotentReplay).toBe(false);
    expect(checkoutRes.body.order.subtotalCents).toBe(1000);
    expect(checkoutRes.body.order.taxCents).toBe(100);
    expect(checkoutRes.body.order.totalCents).toBe(1100);
    expect(checkoutRes.body.order.changeCents).toBe(900);

    const afterProdRes = await request(app).get("/api/products").expect(200);
    const afterFlatWhite = afterProdRes.body.data.find((p: { sku: string }) => p.sku === "COF-ESP-01");
    expect(afterFlatWhite.stockQty).toBe(initialStock - 2);

    const syncRes = await request(app).get("/api/sync/outbox").expect(200);
    expect(syncRes.body.outbox).toHaveLength(1);
    expect(syncRes.body.outbox[0].status).toBe("pending");
    expect(syncRes.body.auditLogs.length).toBeGreaterThanOrEqual(1);
  });

  it("2. Prevents double-charging on duplicate checkout idempotencyKey without deducting stock twice", async () => {
    const prodRes = await request(app).get("/api/products").expect(200);
    const item = prodRes.body.data[0];
    const startStock = item.stockQty;

    const first = await request(app)
      .post("/api/orders/checkout")
      .send({
        idempotencyKey: "dup-click-key-999",
        paymentMethod: "card",
        items: [{ productId: item.id, quantity: 3 }],
      })
      .expect(201);

    const replay = await request(app)
      .post("/api/orders/checkout")
      .send({
        idempotencyKey: "dup-click-key-999",
        paymentMethod: "card",
        items: [{ productId: item.id, quantity: 3 }],
      })
      .expect(200);

    expect(replay.body.idempotentReplay).toBe(true);
    expect(replay.body.order.orderNumber).toBe(first.body.order.orderNumber);

    const afterRes = await request(app).get("/api/products").expect(200);
    const afterItem = afterRes.body.data.find((p: { id: number }) => p.id === item.id);
    expect(afterItem.stockQty).toBe(startStock - 3);
  });

  it("3. Rejects overselling with 409 and rolls back the entire transaction", async () => {
    const prodRes = await request(app).get("/api/products").expect(200);
    const item1 = prodRes.body.data[0];
    const item2 = prodRes.body.data[1];

    const res = await request(app)
      .post("/api/orders/checkout")
      .send({
        idempotencyKey: "oversell-attempt-001",
        paymentMethod: "card",
        items: [
          { productId: item1.id, quantity: 1 },
          { productId: item2.id, quantity: item2.stockQty + 5 },
        ],
      })
      .expect(409);

    expect(res.body.code).toBe("INSUFFICIENT_STOCK");

    // Verify item1 stock was NOT deducted because the transaction rolled back
    const afterRes = await request(app).get("/api/products").expect(200);
    const afterItem1 = afterRes.body.data.find((p: { id: number }) => p.id === item1.id);
    expect(afterItem1.stockQty).toBe(item1.stockQty);
  });

  it("4. Atomically voids an order, restores stock, and queues accounting reversal", async () => {
    const prodRes = await request(app).get("/api/products").expect(200);
    const item = prodRes.body.data[0];
    const startStock = item.stockQty;

    const checkout = await request(app)
      .post("/api/orders/checkout")
      .send({
        idempotencyKey: "void-flow-001",
        paymentMethod: "qr",
        items: [{ productId: item.id, quantity: 4 }],
      })
      .expect(201);

    await request(app)
      .post(`/api/orders/${checkout.body.order.id}/void`)
      .send({ reason: "Customer cancelled order" })
      .expect(200);

    const afterRes = await request(app).get("/api/products").expect(200);
    const afterItem = afterRes.body.data.find((p: { id: number }) => p.id === item.id);
    expect(afterItem.stockQty).toBe(startStock);

    const syncRes = await request(app).get("/api/sync/outbox").expect(200);
    expect(syncRes.body.outbox.some((j: { event_type: string }) => j.event_type === "accounting.reverse_sale")).toBe(true);
  });

  it("5. Never double-posts to accounting after an ambiguous 504 Timeout After Commit", async () => {
    const prodRes = await request(app).get("/api/products").expect(200);
    const item = prodRes.body.data[0];

    await request(app)
      .post("/api/orders/checkout")
      .send({
        idempotencyKey: "timeout-504-order-001",
        paymentMethod: "card",
        items: [{ productId: item.id, quantity: 2 }],
      })
      .expect(201);

    // Inject 504 timeout AFTER remote accounting writes the journal
    await request(app)
      .post("/api/sync/fault")
      .send({ mode: "timeout_504_committed", failNextCount: 1 })
      .expect(200);

    const attempt1 = await request(app).post("/api/sync/run").send({ forceDue: true }).expect(200);
    expect(attempt1.body.results[0].outcome).toBe("retrying");

    // Second run discovers existing journal via read-before-retry instead of double-posting!
    const attempt2 = await request(app).post("/api/sync/run").send({ forceDue: true }).expect(200);
    expect(attempt2.body.results[0].outcome).toBe("recovered_idempotent");

    const syncState = await request(app).get("/api/sync/outbox").expect(200);
    expect(syncState.body.journals).toHaveLength(1);
    expect(syncState.body.outbox[0].status).toBe("succeeded");
  });

  it("6. EOD Reconciliation accurately detects missing journals and external amount drift", async () => {
    const prodRes = await request(app).get("/api/products").expect(200);
    const item = prodRes.body.data[0];

    const order1 = await request(app)
      .post("/api/orders/checkout")
      .send({
        idempotencyKey: "recon-order-1",
        paymentMethod: "card",
        items: [{ productId: item.id, quantity: 2 }],
      })
      .expect(201);

    // Sync order1, then create unsynced order2
    await request(app).post("/api/sync/run").send({ forceDue: true }).expect(200);

    await request(app)
      .post("/api/orders/checkout")
      .send({
        idempotencyKey: "recon-order-2",
        paymentMethod: "card",
        items: [{ productId: item.id, quantity: 1 }],
      })
      .expect(201);

    // Simulate external manual edit of -$2.50 on order1 in accounting
    await request(app)
      .post("/api/sync/simulate-drift")
      .send({ orderNumber: order1.body.order.orderNumber, deltaCents: -250 })
      .expect(200);

    const reconRes = await request(app).post("/api/reconcile").expect(200);
    expect(reconRes.body.report.summary.amountMismatch).toBe(1);
    expect(reconRes.body.report.summary.missingInAccounting).toBe(1);
    expect(reconRes.body.report.totalVarianceCents).toBeGreaterThan(0);
  });

  it("7. Creates a new product with normalized SKU, logs audit entry, and rejects duplicate SKUs", async () => {
    const createRes = await request(app)
      .post("/api/products")
      .send({
        sku: "cof-esp-04",
        name: "Iced Caramel Latte",
        category: "Espresso Bar",
        priceCents: 680,
        stockQty: 25,
      })
      .expect(201);

    expect(createRes.body.data.sku).toBe("COF-ESP-04");
    expect(createRes.body.data.priceCents).toBe(680);
    expect(createRes.body.data.stockQty).toBe(25);

    // Reject duplicate SKU (case-insensitive via normalization)
    const dupRes = await request(app)
      .post("/api/products")
      .send({
        sku: "COF-ESP-04",
        name: "Duplicate Latte",
        category: "Espresso Bar",
        priceCents: 680,
        stockQty: 10,
      })
      .expect(409);

    expect(dupRes.body.code).toBe("DUPLICATE_SKU");

    // Verify the new product is immediately sellable on POS checkout
    const checkoutRes = await request(app)
      .post("/api/orders/checkout")
      .send({
        idempotencyKey: "new-product-sale-001",
        paymentMethod: "card",
        items: [{ productId: createRes.body.data.id, quantity: 2 }],
      })
      .expect(201);

    expect(checkoutRes.body.order.subtotalCents).toBe(1360);

    const syncRes = await request(app).get("/api/sync/outbox").expect(200);
    expect(
      syncRes.body.auditLogs.some(
        (l: { action: string }) => l.action === "product.created"
      )
    ).toBe(true);
  });

  it("8. Updates a product without changing historical order snapshots and blocks duplicate SKUs", async () => {
    const prodRes = await request(app).get("/api/products").expect(200);
    const flatWhite = prodRes.body.data.find((p: { sku: string }) => p.sku === "COF-ESP-01");
    const otherItem = prodRes.body.data.find((p: { sku: string }) => p.sku === "COF-ESP-02");

    // Record a sale at the original $5.00 price
    const orderBefore = await request(app)
      .post("/api/orders/checkout")
      .send({
        idempotencyKey: "price-snapshot-order-001",
        paymentMethod: "card",
        items: [{ productId: flatWhite.id, quantity: 1 }],
      })
      .expect(201);
    expect(orderBefore.body.order.subtotalCents).toBe(500);

    // Update Flat White price to $5.50 and rename
    const updateRes = await request(app)
      .patch(`/api/products/${flatWhite.id}`)
      .send({ name: "Flat White (Double Shot)", priceCents: 550, stockQty: 60 })
      .expect(200);
    expect(updateRes.body.data.name).toBe("Flat White (Double Shot)");
    expect(updateRes.body.data.priceCents).toBe(550);
    expect(updateRes.body.data.stockQty).toBe(60);

    // Reject changing SKU to an existing product's SKU
    const dupRes = await request(app)
      .patch(`/api/products/${flatWhite.id}`)
      .send({ sku: otherItem.sku })
      .expect(409);
    expect(dupRes.body.code).toBe("DUPLICATE_SKU");

    // Verify historical order still shows original $5.00 snapshot
    const ordersRes = await request(app).get("/api/orders").expect(200);
    const savedOrder = ordersRes.body.orders.find(
      (o: { orderNumber: string }) => o.orderNumber === orderBefore.body.order.orderNumber
    );
    expect(savedOrder.subtotalCents).toBe(500);
    expect(savedOrder.items[0].productName).toBe("Flat White (Regular)");
  });

  it("9. Smart-deletes unsold products permanently, archives sold products safely, and restores them", async () => {
    // Create two fresh products: one unused, one sold
    const unused = await request(app)
      .post("/api/products")
      .send({
        sku: "TMP-DEL-01",
        name: "Temporary Promo Cup",
        category: "Merch",
        priceCents: 1200,
        stockQty: 5,
      })
      .expect(201);

    const sold = await request(app)
      .post("/api/products")
      .send({
        sku: "TMP-ARC-01",
        name: "Seasonal Pumpkin Latte",
        category: "Espresso Bar",
        priceCents: 700,
        stockQty: 10,
      })
      .expect(201);

    // Sell 1 unit of the seasonal product
    await request(app)
      .post("/api/orders/checkout")
      .send({
        idempotencyKey: "archive-guard-sale-001",
        paymentMethod: "card",
        items: [{ productId: sold.body.data.id, quantity: 1 }],
      })
      .expect(201);

    // Deleting unsold product hard-deletes it
    const delUnused = await request(app)
      .delete(`/api/products/${unused.body.data.id}`)
      .expect(200);
    expect(delUnused.body.mode).toBe("deleted");

    // Deleting sold product archives (soft-deletes) it instead of breaking order history
    const delSold = await request(app)
      .delete(`/api/products/${sold.body.data.id}`)
      .expect(200);
    expect(delSold.body.mode).toBe("archived");
    expect(delSold.body.product.isActive).toBe(false);

    // Default active product list excludes both deleted and archived
    const activeList = await request(app).get("/api/products").expect(200);
    expect(activeList.body.data.some((p: { id: number }) => p.id === unused.body.data.id)).toBe(false);
    expect(activeList.body.data.some((p: { id: number }) => p.id === sold.body.data.id)).toBe(false);

    // includeArchived=true still shows the archived product
    const allList = await request(app).get("/api/products?includeArchived=true").expect(200);
    expect(allList.body.data.some((p: { id: number }) => p.id === sold.body.data.id)).toBe(true);

    // Archived product cannot be sold on checkout
    const blockedSale = await request(app)
      .post("/api/orders/checkout")
      .send({
        idempotencyKey: "blocked-archived-sale-001",
        paymentMethod: "card",
        items: [{ productId: sold.body.data.id, quantity: 1 }],
      })
      .expect(409);
    expect(blockedSale.body.code).toBe("PRODUCT_ARCHIVED");

    // Restore makes it active and sellable again
    const restoreRes = await request(app)
      .post(`/api/products/${sold.body.data.id}/restore`)
      .expect(200);
    expect(restoreRes.body.data.isActive).toBe(true);

    await request(app)
      .post("/api/orders/checkout")
      .send({
        idempotencyKey: "restored-sale-001",
        paymentMethod: "card",
        items: [{ productId: sold.body.data.id, quantity: 1 }],
      })
      .expect(201);
  });
});
