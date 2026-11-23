import { z } from "zod";

export const PaymentMethodSchema = z.enum(["cash", "card", "qr"]);

export const CheckoutItemSchema = z.object({
  productId: z.number().int().positive(),
  quantity: z.number().int().positive().max(100),
});

export const CheckoutRequestSchema = z.object({
  idempotencyKey: z.string().trim().min(6).max(128),
  paymentMethod: PaymentMethodSchema,
  cashTenderedCents: z.number().int().nonnegative().optional(),
  items: z.array(CheckoutItemSchema).min(1, "Cart must contain at least one item"),
});

export const VoidOrderSchema = z.object({
  reason: z.string().trim().min(3, "Void reason must be at least 3 characters").max(250),
});

export const CreateProductSchema = z.object({
  sku: z
    .string()
    .trim()
    .min(2, "SKU must be at least 2 characters")
    .max(32, "SKU must be 32 characters or fewer")
    .transform((val) => val.toUpperCase()),
  name: z.string().trim().min(2, "Product name must be at least 2 characters").max(100),
  category: z.string().trim().min(2, "Category must be at least 2 characters").max(50),
  priceCents: z.number().int().min(0, "Price cannot be negative").max(10_000_000),
  stockQty: z.number().int().min(0, "Initial stock cannot be negative").max(100_000),
});

export const UpdateProductSchema = z
  .object({
    sku: z
      .string()
      .trim()
      .min(2, "SKU must be at least 2 characters")
      .max(32, "SKU must be 32 characters or fewer")
      .transform((val) => val.toUpperCase())
      .optional(),
    name: z.string().trim().min(2, "Product name must be at least 2 characters").max(100).optional(),
    category: z.string().trim().min(2, "Category must be at least 2 characters").max(50).optional(),
    priceCents: z.number().int().min(0, "Price cannot be negative").max(10_000_000).optional(),
    stockQty: z.number().int().min(0, "Stock cannot be negative").max(100_000).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one field must be provided to update",
  });

export const RestockProductSchema = z.object({
  addQty: z.number().int().min(1).max(500),
});

export const FaultModeSchema = z.enum([
  "none",
  "rate_limit_429",
  "timeout_504_committed",
  "timeout_504_dropped",
  "validation_400",
]);

export const FaultConfigRequestSchema = z.object({
  mode: FaultModeSchema,
  failNextCount: z.number().int().min(0).max(10).default(1),
});

export const SimulateDriftSchema = z.object({
  orderNumber: z.string().trim().min(1),
  deltaCents: z.number().int().refine((v) => v !== 0, "Delta cents must be non-zero"),
});

export type PaymentMethod = z.infer<typeof PaymentMethodSchema>;
export type CreateProductRequest = z.infer<typeof CreateProductSchema>;
export type UpdateProductRequest = z.infer<typeof UpdateProductSchema>;
export type CheckoutRequest = z.infer<typeof CheckoutRequestSchema>;
export type VoidOrderRequest = z.infer<typeof VoidOrderSchema>;
export type FaultMode = z.infer<typeof FaultModeSchema>;
