import fs from "fs";
import path from "path";
import express, { NextFunction, Request, Response } from "express";
import cors from "cors";
import helmet from "helmet";
import { ZodError } from "zod";
import { DbClient } from "./db/database";
import {
  CheckoutRequestSchema,
  CreateProductSchema,
  FaultConfigRequestSchema,
  RestockProductSchema,
  SimulateDriftSchema,
  UpdateProductSchema,
  VoidOrderSchema,
} from "./schemas/posSchemas";
import { MockAccountingApi } from "./services/mockAccountingApi";
import { AppError, PosService } from "./services/posService";

export function createApp(deps: {
  db: DbClient;
  accountingApi: MockAccountingApi;
  staticDir?: string;
}) {
  const app = express();
  const posService = new PosService(deps.db, deps.accountingApi);

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          ...helmet.contentSecurityPolicy.getDefaultDirectives(),
          "style-src": ["'self'", "'unsafe-inline'"],
        },
      },
    })
  );
  app.use(cors());
  app.use(express.json({ limit: "1mb" }));

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, service: "pos-accounting-sync", engine: "PostgreSQL (PGlite)" });
  });

  // Products & Inventory
  app.get("/api/products", async (req, res, next) => {
    try {
      const includeArchived = req.query.includeArchived === "true";
      const products = await posService.listProducts({ includeArchived });
      res.json({ success: true, data: products });
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/products", async (req, res, next) => {
    try {
      const body = CreateProductSchema.parse(req.body);
      const created = await posService.createProduct(body);
      res.status(201).json({ success: true, data: created });
    } catch (err) {
      next(err);
    }
  });

  app.patch("/api/products/:id", async (req, res, next) => {
    try {
      const productId = Number(req.params.id);
      if (!Number.isInteger(productId) || productId <= 0) {
        throw new AppError("Invalid product ID", 400, "INVALID_ID");
      }
      const body = UpdateProductSchema.parse(req.body);
      const updated = await posService.updateProduct(productId, body);
      res.json({ success: true, data: updated });
    } catch (err) {
      next(err);
    }
  });

  app.delete("/api/products/:id", async (req, res, next) => {
    try {
      const productId = Number(req.params.id);
      if (!Number.isInteger(productId) || productId <= 0) {
        throw new AppError("Invalid product ID", 400, "INVALID_ID");
      }
      const result = await posService.deleteProduct(productId);
      res.json({ success: true, ...result });
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/products/:id/restore", async (req, res, next) => {
    try {
      const productId = Number(req.params.id);
      if (!Number.isInteger(productId) || productId <= 0) {
        throw new AppError("Invalid product ID", 400, "INVALID_ID");
      }
      const restored = await posService.restoreProduct(productId);
      res.json({ success: true, data: restored });
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/products/:id/restock", async (req, res, next) => {
    try {
      const productId = Number(req.params.id);
      if (!Number.isInteger(productId) || productId <= 0) {
        throw new AppError("Invalid product ID", 400, "INVALID_ID");
      }
      const body = RestockProductSchema.parse(req.body);
      const updated = await posService.restockProduct(productId, body.addQty);
      res.json({ success: true, data: updated });
    } catch (err) {
      next(err);
    }
  });

  // Orders: Checkout & Void
  app.get("/api/orders", async (_req, res, next) => {
    try {
      const result = await posService.listOrders();
      res.json({ success: true, ...result });
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/orders/checkout", async (req, res, next) => {
    try {
      const body = CheckoutRequestSchema.parse(req.body);
      const result = await posService.checkout(body);
      res.status(result.idempotentReplay ? 200 : 201).json({
        success: true,
        ...result,
      });
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/orders/:id/void", async (req, res, next) => {
    try {
      const orderId = Number(req.params.id);
      if (!Number.isInteger(orderId) || orderId <= 0) {
        throw new AppError("Invalid order ID", 400, "INVALID_ID");
      }
      const body = VoidOrderSchema.parse(req.body);
      const voided = await posService.voidOrder(orderId, body.reason);
      res.json({ success: true, order: voided });
    } catch (err) {
      next(err);
    }
  });

  // Outbox Sync & Fault Simulation
  app.get("/api/sync/outbox", async (_req, res, next) => {
    try {
      const [outbox, journals, auditLogs] = await Promise.all([
        posService.listOutbox(),
        Promise.resolve(deps.accountingApi.listJournals()),
        posService.listAuditLogs(),
      ]);
      res.json({
        success: true,
        faultConfig: deps.accountingApi.getFaultConfig(),
        outbox,
        journals,
        auditLogs,
      });
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/sync/run", async (req, res, next) => {
    try {
      const forceDue = req.body?.forceDue !== false;
      const result = await posService.processOutbox({ forceDue });
      res.json({ success: true, ...result });
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/sync/outbox/:id/requeue", async (req, res, next) => {
    try {
      const outboxId = Number(req.params.id);
      if (!Number.isInteger(outboxId) || outboxId <= 0) {
        throw new AppError("Invalid outbox ID", 400, "INVALID_ID");
      }
      const row = await posService.requeueDeadLetter(outboxId);
      res.json({ success: true, data: row });
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/sync/fault", (req, res, next) => {
    try {
      const body = FaultConfigRequestSchema.parse(req.body);
      const updated = deps.accountingApi.setFaultConfig(body.mode, body.failNextCount);
      res.json({ success: true, faultConfig: updated });
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/sync/simulate-drift", (req, res, next) => {
    try {
      const body = SimulateDriftSchema.parse(req.body);
      const drifted = deps.accountingApi.simulateExternalAmountDrift(
        body.orderNumber,
        body.deltaCents
      );
      if (!drifted) {
        throw new AppError(
          `No posted sale journal found in accounting for ${body.orderNumber}. Run Sync Worker first.`,
          404,
          "JOURNAL_NOT_FOUND"
        );
      }
      res.json({ success: true, journal: drifted });
    } catch (err) {
      next(err);
    }
  });

  // End-of-Day Reconciliation
  app.post("/api/reconcile", async (_req, res, next) => {
    try {
      const report = await posService.runReconciliation();
      res.json({ success: true, report });
    } catch (err) {
      next(err);
    }
  });

  // Serve built React SPA when staticDir exists (single-service cloud deploy)
  if (deps.staticDir && fs.existsSync(deps.staticDir)) {
    const indexHtmlPath = path.join(deps.staticDir, "index.html");
    app.use(express.static(deps.staticDir));
    app.get("*", (req, res, next) => {
      if (req.path.startsWith("/api")) {
        return next();
      }
      if (fs.existsSync(indexHtmlPath)) {
        return res.sendFile(indexHtmlPath);
      }
      return next();
    });
  }

  // Centralized typed error handler
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ZodError) {
      return res.status(400).json({
        success: false,
        code: "VALIDATION_ERROR",
        message: err.issues[0]?.message ?? "Invalid request payload",
        issues: err.issues,
      });
    }
    if (err instanceof AppError) {
      return res.status(err.statusCode).json({
        success: false,
        code: err.code,
        message: err.message,
      });
    }
    console.error("Unhandled API error:", err);
    return res.status(500).json({
      success: false,
      code: "INTERNAL_SERVER_ERROR",
      message: "Unexpected server error",
    });
  });

  return { app, posService };
}
