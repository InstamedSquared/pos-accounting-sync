import fs from "fs";
import path from "path";
import { createDatabase } from "./db/database";
import { createApp } from "./app";
import { MockAccountingApi } from "./services/mockAccountingApi";

const PORT = Number(process.env.PORT ?? 4000);

async function start() {
  const dataDir = path.join(__dirname, "../data/pos-pg");
  fs.mkdirSync(path.dirname(dataDir), { recursive: true });
  const db = await createDatabase(dataDir);
  const accountingApi = new MockAccountingApi();
  const { app } = createApp({ db, accountingApi });

  const server = app.listen(PORT, () => {
    console.log(`POS + Accounting Sync API listening on http://localhost:${PORT}`);
    console.log(`PostgreSQL engine ready (PGlite persistent store: ${dataDir})`);
  });

  const shutdown = async () => {
    server.close();
    await db.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

start().catch((err) => {
  console.error("Failed to start POS server:", err);
  process.exit(1);
});
