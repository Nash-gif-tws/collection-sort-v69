// app/routes/api.bundles.create.ts
import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "~/shopify.server";

/** ------------ Types for request body ------------ **/
type VariantOptionValue = { optionName?: string; optionId?: string; name: string };
type CreateVariantInput = {
  // Only include if your product actually has options:
  optionValues?: VariantOptionValue[];

  // Money scalar must be a string
  price?: string;

  // SKU must live under inventoryItem
  inventoryItem?: { sku?: string; tracked?: boolean; requiresShipping?: boolean };

  // Set initial stock at create time (later changes use inventoryAdjustQuantities)
  inventoryQuantities?: Array<{ locationId: string; availableQuantity: number }>;

  // For bundles: parent is only purchasable as bundle
  requiresComponents?: boolean;
};

type BundleComponent = { variantId: string; qty: number };

type Body = {
  title: string;

  // Define product options upfront if you want Size/Color etc.
  // Example: [{ name:"Size", values:[{name:"S"}, {name:"M"}] }]
  productOptions?: Array<{ name: string; values: Array<{ name: string }> }>;

  // Preferred field
  createVariants?: CreateVariantInput[];

  // Legacy/alias your UI might send
  variants?: CreateVariantInput[];

  // If you only send top-level price/sku/qty/locationId, we auto-build one variant
  price?: string | number;
  sku?: string;
  qty?: number;
  locationId?: string;

  // Components to attach to the parent bundle variant
  bundleComponents?: BundleComponent[];

  // Which created variant index is the bundle parent (default 0)
  parentIndex?: number;

  // If true, publish to Online Store after create
  autoPublish?: boolean;
};

/** ------------ Remix action ------------ **/
export async function action({ request }: ActionFunctionArgs) {
  try {
    if (request.method !== "POST") {
      return json({ ok: false, error: "Method not allowed" }, { status: 405 });
    }

    const { admin } = await authenticate.admin(request);

    /** ---------- Robust body parsing: JSON or FormData ---------- */
    let body: any = {};
    const contentType = request.headers.get("content-type") || "";

    if (contentType.includes("application/json")) {
      body = await request.json().catch(() => ({}));
    } else if (
      contentType.includes("application/x-www-form-urlencoded") ||
      contentType.includes("multipart/form-data")
    ) {
      const fd = await request.formData();
      // Convert FormData to object
      for (const [k, v] of fd.entries()) {
        body[k] = v;
      }
      // Helper to coerce stringified JSON fields
      const tryParse = (val: any) => {
        if (typeof val !== "string") return val;
        const s = val.trim();
        if (!s) return val;
        try { return JSON.parse(s); } catch { return val; }
      };
      body.productOptions   = tryParse(body.productOptions);
      body.createVariants   = tryParse(body.createVariants);
      body.variants         = tryParse(body.variants);
      body.bundleComponents = tryParse(body.bundleComponents);
      body.autoPublish      = typeof body.autoPublish === "string" ? /^(true|1|yes)$/i.test(body.autoPublish) : !!body.autoPublish;
      body.parentIndex      = body.parentIndex != null ? Number(body.parentIndex) : body.parentIndex;
      body.qty              = body.qty != null ? Number(body.qty) : body.qty;
      // leave price as-is; will be coerced to string later if needed
    } else {
      // Fallback: attempt JSON
      body = await request.json().catch(() => ({}));
    }
    /** ---------- end parsing ---------- */

    // Type hint after parsing
    const b = body as Body;

    /** 0) Basic validation */
    if (!b?.title || typeof b.title !== "string" || !b.title.trim()) {
      return json({ ok: false, error: "Missing title" }, { status: 400 });
    }

    /** 1) Normalize incoming variants
     * Accepts:
     *  - b.createVariants (preferred)
     *  - b.variants (alias)
     *  - OR auto-build one variant from top-level price/sku/qty/locationId
     */
    let createVariants: CreateVariantInput[] =
      Array.isArray(b.createVariants) ? b.createVariants :
      Array.isArray(b.variants)       ? b.variants       : [];

    // Auto-build single variant if none provided but top-level fields exist
    if ((!createVariants || createVariants.length === 0) &&
        (b.price != null || b.sku || b.qty != null)) {
      const priceStr = b.price != null ? String(b.price) : undefined;
      createVariants = [
        {
          price: priceStr,
          inventoryItem: b.sku
            ? { sku: b.sku, tracked: true, requiresShipping: true }
            : undefined,
          inventoryQuantities:
            b.qty != null && b.locationId
              ? [{ locationId: b.locationId, availableQuantity: Number(b.qty) }]
              : undefined,
          requiresComponents: true,
        },
      ];
    }

    if (!Array.isArray(createVariants) || createVariants.length === 0) {
      return json({
        ok: false,
        error:
          "createVariants must be a non-empty array (or provide price/sku/qty/locationId to auto-build one)",
      }, { status: 400 });
    }

    /** 2) Create product (with productOptions if provided) */
    const createRes = await admin.graphql(
      `#graphql
      mutation CreateProduct($product: ProductInput!) {
        productCreate(product: $product) {
          product { id title options { id name } }
          userErrors { field message }
        }
      }`,
      {
        variables: {
          product: b.productOptions
            ? { title: b.title, productOptions: b.productOptions }
            : { title: b.title },
        },
      }
    );
    const createData = await createRes.json();
    const pErr = createData?.data?.productCreate?.userErrors ?? [];
    if (pErr.length) {
      return json({ ok: false, step: "productCreate", errors: pErr }, { status: 400 });
    }
    const productId: string | undefined = createData?.data?.productCreate?.product?.id;
    if (!productId) return json({ ok: false, error: "Product not created" }, { status: 500 });

    /** 3) Bulk create variants
     * IMPORTANT:
     *  - Use `optionValues` (NOT `options`).
     *  - `price` must be a string.
     *  - `sku` must be nested under `inventoryItem.sku`.
     */
    const bulkRes = await admin.graphql(
      `#graphql
      mutation BulkVariants($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
        productVariantsBulkCreate(productId: $productId, vari
