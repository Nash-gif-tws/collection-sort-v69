// app/routes/api.bundles.create.ts
import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "~/shopify.server";

/** ---- Types for request body ---- **/
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

/** ---- Remix action ---- **/
export async function action({ request }: ActionFunctionArgs) {
  try {
    if (request.method !== "POST") {
      return json({ ok: false, error: "Method not allowed" }, { status: 405 });
    }

    const { admin } = await authenticate.admin(request);

    // Parse JSON body
    const raw = await request.json().catch(() => ({}));
    const body = raw as Body;

    /** 0) Basic validation */
    if (!body?.title || typeof body.title !== "string" || !body.title.trim()) {
      return json({ ok: false, error: "Missing title" }, { status: 400 });
    }

    /** 1) Normalize incoming variants
     * Accepts:
     *  - body.createVariants (preferred)
     *  - body.variants (alias)
     *  - OR auto-build one variant from top-level price/sku/qty/locationId
     */
    let createVariants: CreateVariantInput[] =
      Array.isArray(body.createVariants) ? body.createVariants :
      Array.isArray(body.variants)       ? body.variants       : [];

    // Auto-build single variant if none provided but top-level fields exist
    if ((!createVariants || createVariants.length === 0) &&
        (body.price != null || body.sku || body.qty != null)) {
      const priceStr = body.price != null ? String(body.price) : undefined;
      createVariants = [
        {
          price: priceStr,
          inventoryItem: body.sku
            ? { sku: body.sku, tracked: true, requiresShipping: true }
            : undefined,
          inventoryQuantities:
            body.qty != null && body.locationId
              ? [{ locationId: body.locationId, availableQuantity: Number(body.qty) }]
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
          product: body.productOptions
            ? { title: body.title, productOptions: body.productOptions }
            : { title: body.title },
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
        productVariantsBulkCreate(productId: $productId, variants: $variants) {
          productVariants { id title selectedOptions { name value } }
          userErrors { field message }
        }
      }`,
      { variables: { productId, variants: createVariants } }
    );
    const bulkData = await bulkRes.json();
    const vErr = bulkData?.data?.productVariantsBulkCreate?.userErrors ?? [];
    if (vErr.length) {
      return json({ ok: false, step: "productVariantsBulkCreate", errors: vErr }, { status: 400 });
    }
    const createdVariants: Array<{ id: string; title: string }> =
      bulkData?.data?.productVariantsBulkCreate?.productVariants ?? [];
    if (!createdVariants.length) {
      return json({ ok: false, error: "No variants created" }, { status: 500 });
    }

    /** 4) Wire bundle components to the chosen parent variant */
    let bundleRelResult: any = null;
    const parentIndex = Number.isInteger(body.parentIndex) ? (body.parentIndex as number) : 0;
    const parentVariantId = createdVariants[parentIndex]?.id;

    if (parentVariantId && Array.isArray(body.bundleComponents) && body.bundleComponents.length > 0) {
      const componentsInput = body.bundleComponents.map((c) => ({
        id: c.variantId,
        quantity: Number(c.qty),
      }));

      const relRes = await admin.graphql(
        `#graphql
        mutation CreateBundleComponents($input: [ProductVariantRelationshipUpdateInput!]!) {
          productVariantRelationshipBulkUpdate(input: $input) {
            parentProductVariants {
              id
              productVariantComponents(first: 50) {
                nodes { id quantity productVariant { id } }
              }
            }
            userErrors { code field message }
          }
        }`,
        {
          variables: {
            input: [
              {
                parentProductVariantId: parentVariantId,
                productVariantRelationshipsToCreate: componentsInput,
              },
            ],
          },
        }
      );
      const relData = await relRes.json();
      const relErr = relData?.data?.productVariantRelationshipBulkUpdate?.userErrors ?? [];
      if (relErr.length) {
        return json({ ok: false, step: "bundleComponents", errors: relErr }, { status: 400 });
      }
      bundleRelResult =
        relData?.data?.productVariantRelationshipBulkUpdate?.parentProductVariants ?? null;
    }

    /** 5) Optional: publish to Online Store */
    let publishResult: any = null;
    if (body.autoPublish) {
      const pubsRes = await admin.graphql(
        `#graphql
        query Publications {
          publications(first: 20) { edges { node { id name } } }
        }`
      );
      const pubsData = await pubsRes.json();
      const pubs: Array<{ id: string; name: string }> =
        pubsData?.data?.publications?.edges?.map((e: any) => e.node) ?? [];
      const onlineStore = pubs.find((p) => /online store/i.test(p.name)) || pubs[0];

      if (onlineStore) {
        const pubRes = await admin.graphql(
          `#graphql
          mutation Publish($id: ID!, $pub: ID!) {
            publishablePublish(id: $id, input: { publicationId: $pub }) {
              publishable { ... on Product { id status } }
              userErrors { field message }
            }
          }`,
          { variables: { id: productId, pub: onlineStore.id } }
        );
        const pubData = await pubRes.json();
        const pubErr = pubData?.data?.publishablePublish?.userErrors ?? [];
        if (pubErr.length) {
          return json({ ok: false, step: "publishablePublish", errors: pubErr }, { status: 400 });
        }
        publishResult = pubData?.data?.publishablePublish?.publishable ?? null;
      }
    }

    /** 6) Done */
    return json(
      {
        ok: true,
        productId,
        variantsCreated: createdVariants,
        bundleParentVariantId: parentVariantId ?? null,
        bundleWiring: bundleRelResult,
        published: publishResult,
      },
      { status: 200 }
    );
  } catch (err: any) {
    return json({ ok: false, error: err?.message || String(err) }, { status: 500 });
  }
}
