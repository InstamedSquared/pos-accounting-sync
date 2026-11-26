import fs from "fs";
import path from "path";
import { createDatabase } from "./db/database";
import { createApp } from "./app";
import { MockAccountingApi } from "./services/mockAccountingApi";

const PORT = Number(process.env.PORT ?? 4000);
const HOST = process.env.HOST ?? "0.0.0.0";

async function start() {
  const configuredDir = process.env.PGLITE_DATA_DIR?.trim();
  const useMemory = configuredDir === "memory";
  const dataDir = useMemory
    ? undefined
    : configuredDir || path.join(__dirname, "../data/pos-pg");

  if (dataDir) {
    fs.mkdirSync(path.dirname(dataDir), { recursive: true });
  }

  const db = await createDatabase(dataDir);
  const accountingApi = new MockAccountingApi();
  const staticDir = path.resolve(__dirname, "../../client/dist");
  const { app } = createApp({ db, accountingApi, staticDir });

  const server = app.listen(PORT, HOST, () => {
    console.log(`POS + Accounting Sync listening on http://${HOST}:${PORT}`);
    console.log(
      `PostgreSQL engine ready (PGlite store: ${dataDir ?? "in-memory"})`
    );
    if (fs.existsSync(staticDir)) {
      console.log(`Serving production React frontend from ${staticDir}`);
    }
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
