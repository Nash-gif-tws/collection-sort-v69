// app/routes/api.bundles.create.ts
import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "~/shopify.server";

/** ------------ Types for request body ------------ **/
type VariantOptionValue = { optionName?: string; optionId?: string; name: string };
type CreateVariantInput = {
  optionValues?: VariantOptionValue[];
  price?: string; // must be string
  inventoryItem?: { sku?: string; tracked?: boolean; requiresShipping?: boolean };
  inventoryQuantities?: Array<{ locationId: string; availableQuantity: number }>;
  requiresComponents?: boolean;
};
type BundleComponent = { variantId: string; qty: number };
type Body = {
  title: string;
  productOptions?: Array<{ name: string; values: Array<{ name: string }> }>;
  createVariants?: CreateVariantInput[];
  variants?: CreateVariantInput[];
  price?: string | number;
  sku?: string;
  qty?: number;
  locationId?: string;
  bundleComponents?: BundleComponent[];
  parentIndex?: number;
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
      for (const [k, v] of fd.entries()) {
        body[k] = v;
      }
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
    } else {
      body = await request.json().catch(() => ({}));
    }

    const b = body as Body;

    /** 0) Basic validation */
    if (!b?.title || typeof b.title !== "string" || !b.title.trim()) {
      return json({ ok: false, error: "Missing title" }, { status: 400 });
    }

    /** 1) Normalize incoming variants */
    let createVariants: CreateVariantInput[] =
      Array.isArray(b.createVariants) ? b.createVariants :
      Array.isArray(b.variants)       ? b.variants       : [];

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
        error: "createVariants must be a non-empty array (or provide price/sku/qty/locationId to auto-build one)"
      }, { status: 400 });
    }

    /** 2) Create product */
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

    /** 3) Bulk create variants */
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

    /** 4) Wire bundle components */
    let bundleRelResult: any = null;
    const parentIndex = Number.isInteger(b.parentIndex) ? (b.parentIndex as number) : 0;
    const parentVariantId = createdVariants[parentIndex]?.id;

    if (parentVariantId && Array.isArray(b.bundleComponents) && b.bundleComponents.length > 0) {
      const componentsInput = b.bundleComponents.map((c) => ({
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
    if (b.autoPublish) {
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
