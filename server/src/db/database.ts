import { PGlite } from "@electric-sql/pglite";

export interface QueryResult<T = Record<string, unknown>> {
  rows: T[];
  affectedRows?: number;
}

export interface DbClient {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  exec(sql: string): Promise<void>;
  transaction<T>(fn: (tx: DbClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY,
  sku TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  price_cents BIGINT NOT NULL CHECK (price_cents >= 0),
  stock_qty INT NOT NULL CHECK (stock_qty >= 0),
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS orders (
  id SERIAL PRIMARY KEY,
  order_number TEXT NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL UNIQUE,
  subtotal_cents BIGINT NOT NULL CHECK (subtotal_cents >= 0),
  tax_cents BIGINT NOT NULL CHECK (tax_cents >= 0),
  total_cents BIGINT NOT NULL CHECK (total_cents >= 0),
  payment_method TEXT NOT NULL CHECK (payment_method IN ('cash', 'card', 'qr')),
  cash_tendered_cents BIGINT,
  change_cents BIGINT,
  status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('completed', 'voided')),
  sync_status TEXT NOT NULL DEFAULT 'pending' CHECK (sync_status IN ('pending', 'synced', 'failed')),
  external_journal_id TEXT,
  void_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS order_items (
  id SERIAL PRIMARY KEY,
  order_id INT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id INT NOT NULL REFERENCES products(id),
  sku TEXT NOT NULL,
  product_name TEXT NOT NULL,
  quantity INT NOT NULL CHECK (quantity > 0),
  unit_price_cents BIGINT NOT NULL CHECK (unit_price_cents >= 0),
  line_total_cents BIGINT NOT NULL CHECK (line_total_cents >= 0)
);

CREATE TABLE IF NOT EXISTS accounting_outbox (
  id SERIAL PRIMARY KEY,
  order_id INT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN ('accounting.post_sale', 'accounting.reverse_sale')),
  idempotency_key TEXT NOT NULL UNIQUE,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'succeeded', 'dead_letter')),
  attempts INT NOT NULL DEFAULT 0,
  next_retry_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_outbox_due
  ON accounting_outbox (next_retry_at)
  WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS audit_logs (
  id SERIAL PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  actor TEXT NOT NULL DEFAULT 'cashier',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true;
`;

const SEED_PRODUCTS: Array<{
  sku: string;
  name: string;
  category: string;
  priceCents: number;
  stockQty: number;
}> = [
  { sku: "COF-ESP-01", name: "Flat White (Regular)", category: "Espresso Bar", priceCents: 500, stockQty: 45 },
  { sku: "COF-ESP-02", name: "Iced Long Black", category: "Espresso Bar", priceCents: 550, stockQty: 40 },
  { sku: "COF-ESP-03", name: "Oat Latte (Large)", category: "Espresso Bar", priceCents: 650, stockQty: 30 },
  { sku: "COF-FLT-01", name: "Single Origin Batch Brew", category: "Filter Coffee", priceCents: 600, stockQty: 25 },
  { sku: "COF-CLD-01", name: "Cold Brew Can (250ml)", category: "Cold Drinks", priceCents: 620, stockQty: 18 },
  { sku: "BNS-HS-250", name: "House Blend Beans (250g)", category: "Retail Beans", priceCents: 1800, stockQty: 14 },
  { sku: "BNS-SO-250", name: "Ethiopia Single Origin (250g)", category: "Retail Beans", priceCents: 2200, stockQty: 10 },
  { sku: "BNS-HS-1KG", name: "Roaster Espresso Blend (1kg)", category: "Retail Beans", priceCents: 5800, stockQty: 6 },
  { sku: "BAK-CRS-01", name: "Butter Croissant", category: "Bakery", priceCents: 650, stockQty: 12 },
  { sku: "BAK-BAN-01", name: "Toasted Banana Bread", category: "Bakery", priceCents: 700, stockQty: 9 },
];

export async function createDatabase(dataDir?: string): Promise<DbClient> {
  const pg = dataDir ? new PGlite(dataDir) : new PGlite();
  await pg.waitReady;
  await pg.exec(SCHEMA_SQL);

  // Idempotent seed via PostgreSQL ON CONFLICT DO NOTHING
  for (const p of SEED_PRODUCTS) {
    await pg.query(
      `INSERT INTO products (sku, name, category, price_cents, stock_qty)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (sku) DO NOTHING`,
      [p.sku, p.name, p.category, p.priceCents, p.stockQty]
    );
  }

  const wrap = (runner: Pick<PGlite, "query" | "exec">): DbClient => ({
    async query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>> {
      const res = await runner.query<T>(sql, params);
      return { rows: res.rows, affectedRows: res.affectedRows };
    },
    async exec(sql: string): Promise<void> {
      await runner.exec(sql);
    },
    async transaction<T>(fn: (tx: DbClient) => Promise<T>): Promise<T> {
      return pg.transaction(async (trx) => {
        const txClient: DbClient = {
          async query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<R>> {
            const res = await trx.query<R>(sql, params);
            return { rows: res.rows, affectedRows: res.affectedRows };
          },
          async exec(sql: string): Promise<void> {
            await trx.exec(sql);
          },
          async transaction<R>(nested: (inner: DbClient) => Promise<R>): Promise<R> {
            return nested(txClient);
          },
          async close(): Promise<void> {},
        };
        return fn(txClient);
      });
    },
    async close(): Promise<void> {
      await pg.close();
    },
  });

  return wrap(pg);
}
