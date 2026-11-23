import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Coffee,
  Minus,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Scale,
  ShoppingCart,
  Trash2,
  Zap,
} from "lucide-react";
import { formatMoney, posApi } from "./api";
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

type TabKey = "pos" | "orders" | "sync";

interface CartItem {
  product: Product;
  quantity: number;
}

const GST_RATE = 0.1;

export default function App() {
  const [activeTab, setActiveTab] = useState<TabKey>("pos");
  const [products, setProducts] = useState<Product[]>([]);
  const [selectedCategory, setSelectedCategory] = useState<string>("All");
  const [cart, setCart] = useState<CartItem[]>([]);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("card");
  const [cashTendered, setCashTendered] = useState<string>("");
  const [checkoutKey, setCheckoutKey] = useState<string>(() => crypto.randomUUID());
  const [lastReceipt, setLastReceipt] = useState<Order | null>(null);

  const [orders, setOrders] = useState<Order[]>([]);
  const [ordersSummary, setOrdersSummary] = useState<OrdersSummary>({
    totalOrders: 0,
    completedOrders: 0,
    voidedOrders: 0,
    grossSalesCents: 0,
    pendingSyncOrders: 0,
  });

  const [outbox, setOutbox] = useState<OutboxJob[]>([]);
  const [journals, setJournals] = useState<AccountingJournal[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLogEntry[]>([]);
  const [faultMode, setFaultMode] = useState<FaultMode>("none");
  const [faultRemaining, setFaultRemaining] = useState<number>(0);
  const [reconciliation, setReconciliation] = useState<ReconciliationReport | null>(null);

  const [busy, setBusy] = useState<boolean>(false);
  const [notice, setNotice] = useState<{ type: "success" | "error"; text: string } | null>(null);

  const [showAddProduct, setShowAddProduct] = useState<boolean>(false);
  const [editingProductId, setEditingProductId] = useState<number | null>(null);
  const [showArchived, setShowArchived] = useState<boolean>(false);
  const [newSku, setNewSku] = useState<string>("");
  const [newName, setNewName] = useState<string>("");
  const [newCategory, setNewCategory] = useState<string>("Espresso Bar");
  const [newPrice, setNewPrice] = useState<string>("");
  const [newStock, setNewStock] = useState<string>("20");

  const loadAll = useCallback(async () => {
    try {
      const [prodRes, ordRes, syncRes] = await Promise.all([
        posApi.getProducts(true),
        posApi.getOrders(),
        posApi.getSyncState(),
      ]);
      setProducts(prodRes.data);
      setOrders(ordRes.orders);
      setOrdersSummary(ordRes.summary);
      setOutbox(syncRes.outbox);
      setJournals(syncRes.journals);
      setAuditLogs(syncRes.auditLogs);
      setFaultMode(syncRes.faultConfig.mode);
      setFaultRemaining(syncRes.faultConfig.remainingFailures);
    } catch (err) {
      setNotice({
        type: "error",
        text: err instanceof Error ? err.message : "Failed to load POS data",
      });
    }
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const activeProducts = useMemo(
    () => products.filter((p) => p.isActive),
    [products]
  );

  const archivedCount = products.length - activeProducts.length;

  const categories = useMemo(() => {
    const set = new Set(activeProducts.map((p) => p.category));
    return ["All", ...Array.from(set)];
  }, [activeProducts]);

  const visibleProducts = useMemo(() => {
    if (selectedCategory === "All") return activeProducts;
    return activeProducts.filter((p) => p.category === selectedCategory);
  }, [activeProducts, selectedCategory]);

  const inventoryProducts = useMemo(
    () => (showArchived ? products : activeProducts),
    [products, activeProducts, showArchived]
  );

  const cartTotals = useMemo(() => {
    const subtotalCents = cart.reduce(
      (sum, c) => sum + c.product.priceCents * c.quantity,
      0
    );
    const taxCents = Math.round(subtotalCents * GST_RATE);
    return {
      subtotalCents,
      taxCents,
      totalCents: subtotalCents + taxCents,
    };
  }, [cart]);

  const cashTenderedCents = useMemo(() => {
    const parsed = parseFloat(cashTendered);
    if (Number.isNaN(parsed) || parsed < 0) return 0;
    return Math.round(parsed * 100);
  }, [cashTendered]);

  const addToCart = (product: Product) => {
    setCart((prev) => {
      const existing = prev.find((c) => c.product.id === product.id);
      if (existing) {
        if (existing.quantity >= product.stockQty) return prev;
        return prev.map((c) =>
          c.product.id === product.id ? { ...c, quantity: c.quantity + 1 } : c
        );
      }
      if (product.stockQty <= 0) return prev;
      return [...prev, { product, quantity: 1 }];
    });
  };

  const updateCartQty = (productId: number, delta: number) => {
    setCart((prev) =>
      prev
        .map((c) => {
          if (c.product.id !== productId) return c;
          const next = Math.min(c.product.stockQty, c.quantity + delta);
          return { ...c, quantity: next };
        })
        .filter((c) => c.quantity > 0)
    );
  };

  const handleCheckout = async () => {
    if (cart.length === 0) return;
    setBusy(true);
    setNotice(null);
    try {
      const res = await posApi.checkout({
        idempotencyKey: checkoutKey,
        paymentMethod,
        ...(paymentMethod === "cash" && cashTendered
          ? { cashTenderedCents }
          : {}),
        items: cart.map((c) => ({ productId: c.product.id, quantity: c.quantity })),
      });
      setLastReceipt(res.order);
      setCart([]);
      setCashTendered("");
      setCheckoutKey(crypto.randomUUID());
      setNotice({
        type: "success",
        text: `Sale ${res.order.orderNumber} completed (${formatMoney(res.order.totalCents)}). Queued in accounting_outbox.`,
      });
      await loadAll();
    } catch (err) {
      setNotice({
        type: "error",
        text: err instanceof Error ? err.message : "Checkout failed",
      });
    } finally {
      setBusy(false);
    }
  };

  const handleVoid = async (order: Order) => {
    const reason = window.prompt(
      `Enter void reason for ${order.orderNumber}:`,
      "Customer changed order"
    );
    if (!reason || reason.trim().length < 3) return;
    setBusy(true);
    try {
      await posApi.voidOrder(order.id, reason.trim());
      setNotice({
        type: "success",
        text: `Order ${order.orderNumber} voided, stock restored, and accounting reversal queued.`,
      });
      await loadAll();
    } catch (err) {
      setNotice({
        type: "error",
        text: err instanceof Error ? err.message : "Void failed",
      });
    } finally {
      setBusy(false);
    }
  };

  const handleRestock = async (product: Product) => {
    setBusy(true);
    try {
      await posApi.restockProduct(product.id, 10);
      setNotice({
        type: "success",
        text: `Restocked +10 units of ${product.name}.`,
      });
      await loadAll();
    } catch (err) {
      setNotice({
        type: "error",
        text: err instanceof Error ? err.message : "Restock failed",
      });
    } finally {
      setBusy(false);
    }
  };

  const resetProductForm = () => {
    setEditingProductId(null);
    setNewSku("");
    setNewName("");
    setNewCategory("Espresso Bar");
    setNewPrice("");
    setNewStock("20");
    setShowAddProduct(false);
  };

  const openAddProductForm = () => {
    setEditingProductId(null);
    setNewSku("");
    setNewName("");
    setNewCategory("Espresso Bar");
    setNewPrice("");
    setNewStock("20");
    setShowAddProduct(true);
  };

  const openEditProductForm = (product: Product) => {
    setEditingProductId(product.id);
    setNewSku(product.sku);
    setNewName(product.name);
    setNewCategory(product.category);
    setNewPrice((product.priceCents / 100).toFixed(2));
    setNewStock(String(product.stockQty));
    setShowAddProduct(true);
  };

  const handleSaveProduct = async (e: FormEvent) => {
    e.preventDefault();
    const parsedPrice = parseFloat(newPrice);
    const parsedStock = parseInt(newStock, 10);

    if (!newSku.trim() || !newName.trim() || !newCategory.trim()) {
      setNotice({ type: "error", text: "SKU, Product Name, and Category are required." });
      return;
    }
    if (Number.isNaN(parsedPrice) || parsedPrice < 0) {
      setNotice({ type: "error", text: "Enter a valid non-negative price (e.g., 6.50)." });
      return;
    }
    if (Number.isNaN(parsedStock) || parsedStock < 0) {
      setNotice({ type: "error", text: "Enter a valid non-negative stock quantity." });
      return;
    }

    setBusy(true);
    setNotice(null);
    try {
      const payload = {
        sku: newSku.trim(),
        name: newName.trim(),
        category: newCategory.trim(),
        priceCents: Math.round(parsedPrice * 100),
        stockQty: parsedStock,
      };

      if (editingProductId !== null) {
        const res = await posApi.updateProduct(editingProductId, payload);
        setCart((prev) =>
          prev
            .map((c) =>
              c.product.id === res.data.id
                ? { product: res.data, quantity: Math.min(c.quantity, res.data.stockQty) }
                : c
            )
            .filter((c) => c.quantity > 0)
        );
        resetProductForm();
        setNotice({
          type: "success",
          text: `Updated "${res.data.name}" (${res.data.sku}) — ${formatMoney(res.data.priceCents)}, stock ${res.data.stockQty}. Past orders remain unchanged.`,
        });
      } else {
        const res = await posApi.createProduct(payload);
        resetProductForm();
        setNotice({
          type: "success",
          text: `Added "${res.data.name}" (${res.data.sku}) at ${formatMoney(res.data.priceCents)} with ${res.data.stockQty} in stock.`,
        });
      }
      await loadAll();
    } catch (err) {
      setNotice({
        type: "error",
        text: err instanceof Error ? err.message : "Failed to save product",
      });
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteProduct = async (product: Product) => {
    const ok = window.confirm(
      `Delete "${product.name}" (${product.sku})?\n\n• If never sold, it will be permanently deleted.\n• If referenced in past orders, it will be archived safely so receipts & EOD reconciliation stay intact.`
    );
    if (!ok) return;

    setBusy(true);
    setNotice(null);
    try {
      const res = await posApi.deleteProduct(product.id);
      setCart((prev) => prev.filter((c) => c.product.id !== product.id));
      if (editingProductId === product.id) {
        resetProductForm();
      }
      setNotice({
        type: "success",
        text:
          res.mode === "deleted"
            ? `Permanently deleted "${product.name}" (${product.sku}).`
            : `Archived "${product.name}" (${product.sku}) — referenced in ${res.orderLinesReferenced} historical order line(s). Hidden from POS Terminal; toggle "Show Archived" to restore anytime.`,
      });
      await loadAll();
    } catch (err) {
      setNotice({
        type: "error",
        text: err instanceof Error ? err.message : "Failed to delete product",
      });
    } finally {
      setBusy(false);
    }
  };

  const handleRestoreProduct = async (product: Product) => {
    setBusy(true);
    setNotice(null);
    try {
      const res = await posApi.restoreProduct(product.id);
      setNotice({
        type: "success",
        text: `Restored "${res.data.name}" (${res.data.sku}) back to the active POS catalog.`,
      });
      await loadAll();
    } catch (err) {
      setNotice({
        type: "error",
        text: err instanceof Error ? err.message : "Failed to restore product",
      });
    } finally {
      setBusy(false);
    }
  };

  const handleApplyFault = async (mode: FaultMode) => {
    setBusy(true);
    try {
      const res = await posApi.setFaultConfig(mode, mode === "none" ? 0 : 1);
      setFaultMode(res.faultConfig.mode);
      setFaultRemaining(res.faultConfig.remainingFailures);
      setNotice({
        type: "success",
        text:
          mode === "none"
            ? "Fault injection cleared (healthy accounting API)."
            : `Next accounting sync call will simulate: ${mode}.`,
      });
    } catch (err) {
      setNotice({
        type: "error",
        text: err instanceof Error ? err.message : "Failed to configure fault",
      });
    } finally {
      setBusy(false);
    }
  };

  const handleRunSync = async () => {
    setBusy(true);
    try {
      const res = await posApi.runSyncWorker();
      const summaryText =
        res.processed === 0
          ? "No pending outbox jobs to process."
          : res.results
              .map((r) => `#${r.outboxId}: ${r.outcome}${r.journalId ? ` (${r.journalId})` : ""}`)
              .join(" • ");
      setNotice({ type: "success", text: `Sync worker ran — ${summaryText}` });
      await loadAll();
    } catch (err) {
      setNotice({
        type: "error",
        text: err instanceof Error ? err.message : "Sync worker failed",
      });
    } finally {
      setBusy(false);
    }
  };

  const handleRequeue = async (jobId: number) => {
    setBusy(true);
    try {
      await posApi.requeueOutbox(jobId);
      setNotice({ type: "success", text: `Dead-letter job #${jobId} requeued.` });
      await loadAll();
    } catch (err) {
      setNotice({
        type: "error",
        text: err instanceof Error ? err.message : "Requeue failed",
      });
    } finally {
      setBusy(false);
    }
  };

  const handleSimulateDrift = async (orderNumber: string) => {
    setBusy(true);
    try {
      await posApi.simulateDrift(orderNumber, -250);
      setNotice({
        type: "success",
        text: `Simulated -$2.50 manual edit in external ledger for ${orderNumber}. Run EOD Reconciliation to detect it.`,
      });
      await loadAll();
    } catch (err) {
      setNotice({
        type: "error",
        text: err instanceof Error ? err.message : "Drift simulation failed",
      });
    } finally {
      setBusy(false);
    }
  };

  const handleReconcile = async () => {
    setBusy(true);
    try {
      const res = await posApi.runReconciliation();
      setReconciliation(res.report);
      setNotice({
        type: "success",
        text: `EOD Reconciliation completed: ${res.report.summary.matched}/${res.report.summary.totalOrders} matched (Variance: ${formatMoney(res.report.totalVarianceCents)}).`,
      });
      await loadAll();
    } catch (err) {
      setNotice({
        type: "error",
        text: err instanceof Error ? err.message : "Reconciliation failed",
      });
    } finally {
      setBusy(false);
    }
  };

  const pendingOutboxCount = outbox.filter((o) => o.status === "pending" || o.status === "dead_letter").length;

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-icon">
            <Coffee size={22} />
          </div>
          <div>
            <h1>RoastLedger POS &amp; Accounting Sync</h1>
            <p>TypeScript • React • Express • PostgreSQL (PGlite) • Outbox &amp; EOD Reconciliation</p>
          </div>
        </div>

        <nav className="tabs">
          <button
            type="button"
            className={`tab-btn ${activeTab === "pos" ? "active" : ""}`}
            onClick={() => setActiveTab("pos")}
          >
            <ShoppingCart size={16} /> POS Terminal
          </button>
          <button
            type="button"
            className={`tab-btn ${activeTab === "orders" ? "active" : ""}`}
            onClick={() => setActiveTab("orders")}
          >
            <CheckCircle2 size={16} /> Orders &amp; Inventory
          </button>
          <button
            type="button"
            className={`tab-btn ${activeTab === "sync" ? "active" : ""}`}
            onClick={() => setActiveTab("sync")}
          >
            <Scale size={16} /> Accounting Sync &amp; Reconciliation
            {pendingOutboxCount > 0 && <span className="pill-count">{pendingOutboxCount}</span>}
          </button>
        </nav>
      </header>

      {notice && (
        <div className={`banner ${notice.type}`}>
          <span>{notice.text}</span>
          <button type="button" onClick={() => setNotice(null)}>
            ✕
          </button>
        </div>
      )}

      {activeTab === "pos" && (
        <div className="pos-grid">
          <section className="card">
            <div className="card-title">
              <h2>Product Catalog (Live PostgreSQL Stock)</h2>
              <button type="button" className="btn btn-outline btn-sm" onClick={() => void loadAll()}>
                <RefreshCw size={14} /> Refresh
              </button>
            </div>

            <div className="category-bar">
              {categories.map((cat) => (
                <button
                  key={cat}
                  type="button"
                  className={`cat-pill ${selectedCategory === cat ? "active" : ""}`}
                  onClick={() => setSelectedCategory(cat)}
                >
                  {cat}
                </button>
              ))}
            </div>

            <div className="product-grid">
              {visibleProducts.map((product) => (
                <button
                  key={product.id}
                  type="button"
                  className="product-card"
                  disabled={product.stockQty <= 0}
                  onClick={() => addToCart(product)}
                >
                  <div className="product-sku">
                    <span>{product.sku}</span>
                    <span>{product.category}</span>
                  </div>
                  <div className="product-name">{product.name}</div>
                  <div className="product-footer">
                    <span className="price">{formatMoney(product.priceCents)}</span>
                    <span
                      className={`badge ${
                        product.stockQty === 0
                          ? "danger"
                          : product.stockQty <= 5
                            ? "warning"
                            : "success"
                      }`}
                    >
                      {product.stockQty} in stock
                    </span>
                  </div>
                </button>
              ))}
            </div>
          </section>

          <aside className="card">
            <div className="card-title">
              <h2>Current Order</h2>
              {cart.length > 0 && (
                <button
                  type="button"
                  className="btn btn-outline btn-sm"
                  onClick={() => setCart([])}
                >
                  <Trash2 size={13} /> Clear
                </button>
              )}
            </div>

            {cart.length === 0 ? (
              <p style={{ color: "var(--muted)", fontSize: "0.88rem", padding: "24px 0" }}>
                Select items from the catalog to start a sale. Checkout runs inside one atomic
                PostgreSQL transaction (inventory deduction + order + accounting outbox).
              </p>
            ) : (
              <div className="cart-list">
                {cart.map((item) => (
                  <div key={item.product.id} className="cart-row">
                    <div>
                      <div style={{ fontWeight: 600, fontSize: "0.88rem" }}>
                        {item.product.name}
                      </div>
                      <div style={{ color: "var(--muted)", fontSize: "0.78rem" }}>
                        {formatMoney(item.product.priceCents)} each
                      </div>
                    </div>
                    <div className="qty-controls">
                      <button
                        type="button"
                        className="icon-btn"
                        aria-label={`Decrease ${item.product.name}`}
                        onClick={() => updateCartQty(item.product.id, -1)}
                      >
                        <Minus size={13} />
                      </button>
                      <span style={{ minWidth: 20, textAlign: "center", fontWeight: 600 }}>
                        {item.quantity}
                      </span>
                      <button
                        type="button"
                        className="icon-btn"
                        aria-label={`Increase ${item.product.name}`}
                        onClick={() => updateCartQty(item.product.id, 1)}
                      >
                        <Plus size={13} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div className="totals">
              <div className="totals-row">
                <span>Subtotal</span>
                <span>{formatMoney(cartTotals.subtotalCents)}</span>
              </div>
              <div className="totals-row">
                <span>GST (10%)</span>
                <span>{formatMoney(cartTotals.taxCents)}</span>
              </div>
              <div className="totals-row grand">
                <span>Total</span>
                <span>{formatMoney(cartTotals.totalCents)}</span>
              </div>
            </div>

            <div className="payment-methods">
              {(["card", "cash", "qr"] as PaymentMethod[]).map((method) => (
                <button
                  key={method}
                  type="button"
                  className={`pay-btn ${paymentMethod === method ? "active" : ""}`}
                  onClick={() => setPaymentMethod(method)}
                >
                  {method.toUpperCase()}
                </button>
              ))}
            </div>

            {paymentMethod === "cash" && (
              <div style={{ marginBottom: 14 }}>
                <label
                  htmlFor="cash-input"
                  style={{ display: "block", fontSize: "0.8rem", color: "var(--muted)", marginBottom: 5 }}
                >
                  Cash Tendered ($)
                </label>
                <input
                  id="cash-input"
                  className="input"
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder={(cartTotals.totalCents / 100).toFixed(2)}
                  value={cashTendered}
                  onChange={(e) => setCashTendered(e.target.value)}
                />
                {cashTenderedCents >= cartTotals.totalCents && cartTotals.totalCents > 0 && (
                  <p style={{ fontSize: "0.82rem", color: "#34d399", marginTop: 6 }}>
                    Change Due: <b>{formatMoney(cashTenderedCents - cartTotals.totalCents)}</b>
                  </p>
                )}
              </div>
            )}

            <button
              type="button"
              className="btn btn-primary"
              style={{ width: "100%" }}
              disabled={busy || cart.length === 0}
              onClick={() => void handleCheckout()}
            >
              <Zap size={16} /> {busy ? "Processing..." : `Complete Sale (${formatMoney(cartTotals.totalCents)})`}
            </button>

            {lastReceipt && (
              <div className="receipt-box">
                <div style={{ fontWeight: 700, marginBottom: 4 }}>
                  Receipt: {lastReceipt.orderNumber}
                </div>
                <div>
                  Paid {formatMoney(lastReceipt.totalCents)} via {lastReceipt.paymentMethod.toUpperCase()}
                  {lastReceipt.changeCents !== null ? ` • Change: ${formatMoney(lastReceipt.changeCents)}` : ""}
                </div>
                <div style={{ color: "var(--muted)", marginTop: 4 }}>
                  Outbox Sync: <b style={{ color: "#fbbf24" }}>{lastReceipt.syncStatus}</b>
                </div>
              </div>
            )}
          </aside>
        </div>
      )}

      {activeTab === "orders" && (
        <div className="stack">
          <div className="kpi-grid">
            <div className="kpi-card">
              <div className="kpi-label">Net Completed Sales</div>
              <div className="kpi-val">{formatMoney(ordersSummary.grossSalesCents)}</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-label">Completed Orders</div>
              <div className="kpi-val">{ordersSummary.completedOrders}</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-label">Voided Orders</div>
              <div className="kpi-val">{ordersSummary.voidedOrders}</div>
            </div>
            <div className="kpi-card">
              <div className="kpi-label">Pending Accounting Sync</div>
              <div className="kpi-val" style={{ color: ordersSummary.pendingSyncOrders > 0 ? "#fbbf24" : "#34d399" }}>
                {ordersSummary.pendingSyncOrders}
              </div>
            </div>
          </div>

          <section className="card">
            <div className="card-title">
              <h2>Recent Orders</h2>
              <button type="button" className="btn btn-outline btn-sm" onClick={() => void loadAll()}>
                <RefreshCw size={14} /> Refresh
              </button>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Order #</th>
                    <th>Items</th>
                    <th>Total (incl. GST)</th>
                    <th>Payment</th>
                    <th>Status</th>
                    <th>Accounting Sync</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {orders.length === 0 ? (
                    <tr>
                      <td colSpan={7} style={{ color: "var(--muted)" }}>
                        No orders yet. Complete a sale in the POS Terminal tab.
                      </td>
                    </tr>
                  ) : (
                    orders.map((order) => (
                      <tr key={order.id}>
                        <td>
                          <b>{order.orderNumber}</b>
                        </td>
                        <td>
                          {order.items.map((i) => `${i.quantity}× ${i.productName}`).join(", ")}
                        </td>
                        <td>{formatMoney(order.totalCents)}</td>
                        <td>{order.paymentMethod.toUpperCase()}</td>
                        <td>
                          <span className={`badge ${order.status === "completed" ? "success" : "danger"}`}>
                            {order.status}
                          </span>
                        </td>
                        <td>
                          <span
                            className={`badge ${
                              order.syncStatus === "synced"
                                ? "success"
                                : order.syncStatus === "failed"
                                  ? "danger"
                                  : "warning"
                            }`}
                          >
                            {order.syncStatus}
                            {order.externalJournalId ? ` (${order.externalJournalId})` : ""}
                          </span>
                        </td>
                        <td>
                          {order.status === "completed" ? (
                            <button
                              type="button"
                              className="btn btn-danger btn-sm"
                              disabled={busy}
                              onClick={() => void handleVoid(order)}
                            >
                              Void Sale
                            </button>
                          ) : (
                            <span style={{ color: "var(--muted)", fontSize: "0.78rem" }}>
                              {order.voidReason}
                            </span>
                          )}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <section className="card">
            <div className="card-title">
              <h2>Inventory Management</h2>
              <div className="control-row">
                {(archivedCount > 0 || showArchived) && (
                  <button
                    type="button"
                    className={`cat-pill ${showArchived ? "active" : ""}`}
                    onClick={() => setShowArchived((prev) => !prev)}
                  >
                    {showArchived
                      ? `Showing Archived (${archivedCount})`
                      : `Show Archived (${archivedCount})`}
                  </button>
                )}
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={() =>
                    showAddProduct && editingProductId === null
                      ? resetProductForm()
                      : openAddProductForm()
                  }
                >
                  <Plus size={14} />{" "}
                  {showAddProduct && editingProductId === null ? "Close Form" : "Add Product"}
                </button>
              </div>
            </div>

            {showAddProduct && (
              <form className="product-form" onSubmit={(e) => void handleSaveProduct(e)}>
                <div
                  style={{
                    fontSize: "0.86rem",
                    fontWeight: 600,
                    marginBottom: 10,
                    color: "#93c5fd",
                  }}
                >
                  {editingProductId !== null
                    ? `Editing Product #${editingProductId}`
                    : "Add New Product"}
                </div>
                <div className="product-form-grid">
                  <div className="field">
                    <label htmlFor="prod-sku">SKU</label>
                    <input
                      id="prod-sku"
                      className="input"
                      type="text"
                      placeholder="COF-ESP-04"
                      required
                      value={newSku}
                      onChange={(e) => setNewSku(e.target.value)}
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="prod-name">Product Name</label>
                    <input
                      id="prod-name"
                      className="input"
                      type="text"
                      placeholder="Iced Caramel Latte"
                      required
                      value={newName}
                      onChange={(e) => setNewName(e.target.value)}
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="prod-cat">Category</label>
                    <input
                      id="prod-cat"
                      className="input"
                      type="text"
                      list="product-categories"
                      placeholder="Espresso Bar"
                      required
                      value={newCategory}
                      onChange={(e) => setNewCategory(e.target.value)}
                    />
                    <datalist id="product-categories">
                      {categories
                        .filter((c) => c !== "All")
                        .map((c) => (
                          <option key={c} value={c} />
                        ))}
                    </datalist>
                  </div>
                  <div className="field">
                    <label htmlFor="prod-price">Price ($)</label>
                    <input
                      id="prod-price"
                      className="input"
                      type="number"
                      min="0"
                      step="0.01"
                      placeholder="6.80"
                      required
                      value={newPrice}
                      onChange={(e) => setNewPrice(e.target.value)}
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="prod-stock">
                      {editingProductId !== null ? "Stock Qty" : "Initial Stock"}
                    </label>
                    <input
                      id="prod-stock"
                      className="input"
                      type="number"
                      min="0"
                      step="1"
                      placeholder="20"
                      required
                      value={newStock}
                      onChange={(e) => setNewStock(e.target.value)}
                    />
                  </div>
                </div>
                <div className="control-row">
                  <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>
                    {editingProductId !== null ? <Pencil size={13} /> : <Plus size={14} />}{" "}
                    {busy
                      ? "Saving..."
                      : editingProductId !== null
                        ? "Update Product"
                        : "Save Product"}
                  </button>
                  <button
                    type="button"
                    className="btn btn-outline btn-sm"
                    onClick={() => resetProductForm()}
                  >
                    Cancel
                  </button>
                </div>
              </form>
            )}
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>SKU</th>
                    <th>Product</th>
                    <th>Category</th>
                    <th>Price</th>
                    <th>Stock Qty</th>
                    <th>Status</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {inventoryProducts.map((p) => (
                    <tr key={p.id} style={p.isActive ? undefined : { opacity: 0.62 }}>
                      <td>{p.sku}</td>
                      <td><b>{p.name}</b></td>
                      <td>{p.category}</td>
                      <td>{formatMoney(p.priceCents)}</td>
                      <td>
                        <span className={`badge ${p.stockQty <= 5 ? "warning" : "success"}`}>
                          {p.stockQty}
                        </span>
                      </td>
                      <td>
                        <span className={`badge ${p.isActive ? "success" : "warning"}`}>
                          {p.isActive ? "Active" : "Archived"}
                        </span>
                      </td>
                      <td>
                        <div className="control-row" style={{ gap: 6 }}>
                          {p.isActive ? (
                            <>
                              <button
                                type="button"
                                className="btn btn-outline btn-sm"
                                disabled={busy}
                                onClick={() => void handleRestock(p)}
                              >
                                +10
                              </button>
                              <button
                                type="button"
                                className="btn btn-outline btn-sm"
                                disabled={busy}
                                onClick={() => openEditProductForm(p)}
                              >
                                <Pencil size={12} /> Edit
                              </button>
                              <button
                                type="button"
                                className="btn btn-danger btn-sm"
                                disabled={busy}
                                onClick={() => void handleDeleteProduct(p)}
                              >
                                <Trash2 size={12} /> Delete
                              </button>
                            </>
                          ) : (
                            <button
                              type="button"
                              className="btn btn-outline btn-sm"
                              disabled={busy}
                              onClick={() => void handleRestoreProduct(p)}
                            >
                              <RotateCcw size={12} /> Restore
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}

      {activeTab === "sync" && (
        <div className="stack">
          <section className="card">
            <div className="card-title">
              <h2>Sync Worker &amp; External Accounting Fault Simulator (MYOB / Xero Pattern)</h2>
              <div className="control-row">
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy}
                  onClick={() => void handleRunSync()}
                >
                  <Zap size={15} /> Run Sync Worker
                </button>
                <button
                  type="button"
                  className="btn btn-outline"
                  disabled={busy}
                  onClick={() => void handleReconcile()}
                >
                  <Scale size={15} /> Run EOD Reconciliation
                </button>
              </div>
            </div>

            <div className="control-row" style={{ marginBottom: 8 }}>
              <span style={{ fontSize: "0.84rem", color: "var(--muted)" }}>
                Inject Next API Fault:
              </span>
              {(
                [
                  ["none", "Healthy (200 OK)"],
                  ["timeout_504_committed", "504 Timeout After Commit (Idempotency Test)"],
                  ["rate_limit_429", "429 Rate Limit (Backoff Test)"],
                  ["validation_400", "400 Bad Request (Dead-Letter Test)"],
                ] as Array<[FaultMode, string]>
              ).map(([mode, label]) => (
                <button
                  key={mode}
                  type="button"
                  className={`cat-pill ${faultMode === mode ? "active" : ""}`}
                  disabled={busy}
                  onClick={() => void handleApplyFault(mode)}
                >
                  {label}
                </button>
              ))}
            </div>
            {faultMode !== "none" && (
              <p style={{ fontSize: "0.82rem", color: "#fbbf24" }}>
                <AlertTriangle size={13} style={{ verticalAlign: "middle", marginRight: 5 }} />
                Active fault: <b>{faultMode}</b> ({faultRemaining} failure remaining)
              </p>
            )}
          </section>

          {reconciliation && (
            <section className="card">
              <div className="card-title">
                <h2>End-of-Day Reconciliation Report (Local Postgres vs. Accounting Ledger)</h2>
                <span
                  className={`badge ${
                    reconciliation.totalVarianceCents === 0 &&
                    reconciliation.summary.missingInAccounting === 0 &&
                    reconciliation.summary.voidDrift === 0
                      ? "success"
                      : "danger"
                  }`}
                >
                  Variance: {formatMoney(reconciliation.totalVarianceCents)}
                </span>
              </div>

              <div className="kpi-grid">
                <div className="kpi-card">
                  <div className="kpi-label">Local POS Net Total</div>
                  <div className="kpi-val">{formatMoney(reconciliation.localCompletedNetCents)}</div>
                </div>
                <div className="kpi-card">
                  <div className="kpi-label">External Ledger Active Total</div>
                  <div className="kpi-val">{formatMoney(reconciliation.ledgerActiveNetCents)}</div>
                </div>
                <div className="kpi-card">
                  <div className="kpi-label">Matched Orders</div>
                  <div className="kpi-val" style={{ color: "#34d399" }}>
                    {reconciliation.summary.matched}
                  </div>
                </div>
                <div className="kpi-card">
                  <div className="kpi-label">Discrepancies</div>
                  <div
                    className="kpi-val"
                    style={{
                      color:
                        reconciliation.summary.missingInAccounting +
                          reconciliation.summary.amountMismatch +
                          reconciliation.summary.voidDrift >
                        0
                          ? "#f87171"
                          : "#34d399",
                    }}
                  >
                    {reconciliation.summary.missingInAccounting +
                      reconciliation.summary.amountMismatch +
                      reconciliation.summary.voidDrift}
                  </div>
                </div>
              </div>

              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Order #</th>
                      <th>POS Status</th>
                      <th>POS Total</th>
                      <th>Ledger Total</th>
                      <th>Reconciliation</th>
                      <th>Detail</th>
                    </tr>
                  </thead>
                  <tbody>
                    {reconciliation.items.map((item) => (
                      <tr key={item.orderNumber}>
                        <td><b>{item.orderNumber}</b></td>
                        <td>{item.orderStatus}</td>
                        <td>{formatMoney(item.localTotalCents)}</td>
                        <td>{item.ledgerTotalCents !== null ? formatMoney(item.ledgerTotalCents) : "—"}</td>
                        <td>
                          <span className={`badge ${item.status === "matched" ? "success" : "danger"}`}>
                            {item.status}
                          </span>
                        </td>
                        <td style={{ color: "var(--muted)" }}>{item.detail}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          <div className="two-col">
            <section className="card">
              <div className="card-title">
                <h2>Transactional Outbox (<code>accounting_outbox</code>)</h2>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>ID</th>
                      <th>Event</th>
                      <th>Status</th>
                      <th>Attempts</th>
                      <th>Last Error / Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {outbox.length === 0 ? (
                      <tr>
                        <td colSpan={5} style={{ color: "var(--muted)" }}>No outbox jobs yet.</td>
                      </tr>
                    ) : (
                      outbox.map((job) => (
                        <tr key={job.id}>
                          <td>#{job.id}</td>
                          <td>{job.event_type}</td>
                          <td>
                            <span
                              className={`badge ${
                                job.status === "succeeded"
                                  ? "success"
                                  : job.status === "dead_letter"
                                    ? "danger"
                                    : "warning"
                              }`}
                            >
                              {job.status}
                            </span>
                          </td>
                          <td>{job.attempts}</td>
                          <td>
                            {job.status === "dead_letter" ? (
                              <div className="control-row">
                                <span style={{ color: "#fca5a5", fontSize: "0.78rem" }}>
                                  {job.last_error}
                                </span>
                                <button
                                  type="button"
                                  className="btn btn-outline btn-sm"
                                  onClick={() => void handleRequeue(job.id)}
                                >
                                  Requeue
                                </button>
                              </div>
                            ) : (
                              <span style={{ color: "var(--muted)", fontSize: "0.78rem" }}>
                                {job.last_error ?? "—"}
                              </span>
                            )}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="card">
              <div className="card-title">
                <h2>External Accounting Ledger (Mock MYOB/Xero)</h2>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Journal</th>
                      <th>Order #</th>
                      <th>Amount</th>
                      <th>Status</th>
                      <th>Test Drift</th>
                    </tr>
                  </thead>
                  <tbody>
                    {journals.length === 0 ? (
                      <tr>
                        <td colSpan={5} style={{ color: "var(--muted)" }}>
                          No journals posted yet. Click &quot;Run Sync Worker&quot;.
                        </td>
                      </tr>
                    ) : (
                      journals.map((j) => (
                        <tr key={j.journalId}>
                          <td><b>{j.journalId}</b></td>
                          <td>{j.orderNumber}</td>
                          <td>{formatMoney(j.totalCents)}</td>
                          <td>
                            <span className={`badge ${j.status === "posted" ? "info" : "warning"}`}>
                              {j.status}
                            </span>
                          </td>
                          <td>
                            {j.eventType === "sale" && j.status === "posted" ? (
                              <button
                                type="button"
                                className="btn btn-outline btn-sm"
                                disabled={busy}
                                onClick={() => void handleSimulateDrift(j.orderNumber)}
                              >
                                Edit -$2.50
                              </button>
                            ) : (
                              "—"
                            )}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </section>
          </div>

          <section className="card">
            <div className="card-title">
              <h2>Immutable Audit Trail (<code>audit_logs</code>)</h2>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Entity</th>
                    <th>Action</th>
                    <th>Actor</th>
                    <th>Metadata</th>
                  </tr>
                </thead>
                <tbody>
                  {auditLogs.slice(0, 12).map((log) => (
                    <tr key={log.id}>
                      <td style={{ color: "var(--muted)" }}>
                        {new Date(log.created_at).toLocaleTimeString()}
                      </td>
                      <td>
                        {log.entity_type} ({log.entity_id})
                      </td>
                      <td><b>{log.action}</b></td>
                      <td>{log.actor}</td>
                      <td style={{ color: "var(--muted)", fontSize: "0.78rem" }}>
                        {JSON.stringify(log.metadata)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
