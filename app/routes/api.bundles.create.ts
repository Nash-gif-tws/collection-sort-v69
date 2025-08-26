// app/routes/api.bundles.create.ts
import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "~/shopify.server";

type Component = { variantId: string; qty: number };

export async function action({ request }: ActionFunctionArgs) {
  try {
    const { admin } = await authenticate.admin(request);
    if (request.method !== "POST") {
      return json({ ok: false, error: "Method not allowed" }, { status: 405 });
    }

    const body = await request.json().catch(() => ({}));
    const title: string = (body?.title || "").trim();
    const components: Component[] = Array.isArray(body?.components)
      ? body.components
      : [];

    if (!title) {
      return json({ ok: false, error: "Title is required" }, { status: 400 });
    }
    if (!components.length) {
      return json(
        { ok: false, error: "At least one component is required" },
        { status: 400 }
      );
    }

    // --- 1) Inventory capacity using ProductVariant.inventoryQuantity (total across locations) ---
    const variantIds = components.map((c) => c.variantId);

    const invRes = await admin.graphql(
      `#graphql
      query InvQty($ids:[ID!]!) {
        nodes(ids:$ids) {
          ... on ProductVariant {
            id
            inventoryQuantity
          }
        }
      }`,
      { variables: { ids: variantIds } }
    );

    const invJson = await invRes.json();
    if (Array.isArray(invJson?.errors) && invJson.errors.length) {
      const msg = invJson.errors.map((e: any) => e?.message).join("; ");
      return json({ ok: false, error: msg || "Inventory query failed" }, { status: 400 });
    }

    const availByVariant = new Map<string, number>();
    for (const n of invJson?.data?.nodes ?? []) {
      if (!n?.id) continue;
      availByVariant.set(n.id, Number(n?.inventoryQuantity ?? 0));
    }

    // capacity = min( floor(available / qtyRequired) ) across all components
    let capacity: number | null = null;
    for (const c of components) {
      const have = Number(availByVariant.get(c.variantId) ?? 0);
      const need = Math.max(1, Number(c.qty) || 1);
      const capThis = Math.floor(have / need);
      capacity = capacity === null ? capThis : Math.min(capacity, capThis);
    }
    if (capacity === null) capacity = 0;

    // --- 2) Create product (shell) ---
    const createProductRes = await admin.graphql(
      `#graphql
      mutation CreateProduct($input: ProductInput!) {
        productCreate(input: $input) {
          product { id handle status }
          userErrors { field message }
        }
      }`,
      {
        variables: {
          input: {
            title,
            productType: "Bundle",
            status: "DRAFT", // change to "ACTIVE" when you're ready
          },
        },
      }
    );
    const createProductJson = await createProductRes.json();
    const pErr = createProductJson?.data?.productCreate?.userErrors ?? [];
    if (pErr.length) {
      return json(
        { ok: false, error: pErr.map((e: any) => e.message).join(", ") },
        { status: 400 }
      );
    }
    const productId: string =
      createProductJson?.data?.productCreate?.product?.id;
    if (!productId) {
      return json({ ok: false, error: "No productId from productCreate" }, { status: 500 });
    }

    // --- 3) Create a single shell variant ---
    // Price set to 0.00; the PDP/theme will compute sum of parts at runtime.
    const shellPrice = "0.00";
    const createVarRes = await admin.graphql(
      `#graphql
      mutation CreateVariant($input: ProductVariantInput!) {
        productVariantCreate(input: $input) {
          productVariant { id }
          userErrors { field message }
        }
      }`,
      {
        variables: {
          input: {
            productId,
            title: "Default",
            price: shellPrice,
          },
        },
      }
    );
    const createVarJson = await createVarRes.json();
    const vErr = createVarJson?.data?.productVariantCreate?.userErrors ?? [];
    if (vErr.length) {
      return json(
        { ok: false, error: vErr.map((e: any) => e.message).join(", ") },
        { status: 400 }
      );
    }
    const variantId: string =
      createVarJson?.data?.productVariantCreate?.productVariant?.id;

    // --- 4) Save bundle metafields (components + capacity) on the product ---
    const metafieldValue = JSON.stringify({
      kind: "bundle",
      version: 1,
      components: components.map((c) => ({
        variantId: c.variantId,
        qty: Math.max(1, Number(c.qty) || 1),
      })),
    });

    const mfInputs: any[] = [
      {
        ownerId: productId,
        namespace: "custom",
        key: "bundle_components",
        type: "json",
        value: metafieldValue,
      },
    ];
    mfInputs.push({
      ownerId: productId,
      namespace: "custom",
      key: "bundle_capacity",
      type: "number_integer",
      value: String(capacity),
    });

    const mfRes = await admin.graphql(
      `#graphql
      mutation SaveMF($metafields:[MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields { id key namespace }
          userErrors { field message }
        }
      }`,
      { variables: { metafields: mfInputs } }
    );
    const mfJson = await mfRes.json();
    const mfErr = mfJson?.data?.metafieldsSet?.userErrors ?? [];
    if (mfErr.length) {
      return json(
        { ok: false, error: mfErr.map((e: any) => e.message).join(", ") },
        { status: 400 }
      );
    }

    return json({ ok: true, productId, variantId, capacity });
  } catch (e: any) {
    return json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}
