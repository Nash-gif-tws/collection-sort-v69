// app/routes/api.bundles.create.ts
import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "~/shopify.server";

type Component = { variantId: string; qty: number };

// Small helpers
function hasGraphQLErr(o: any) {
  return Array.isArray(o?.errors) && o.errors.length > 0;
}
async function asJson(res: Response) {
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { errors: [{ message: text || "Non-JSON response" }] }; }
}

export async function action({ request }: ActionFunctionArgs) {
  try {
    const { admin } = await authenticate.admin(request);
    if (request.method !== "POST") {
      return json({ ok: false, error: "Method not allowed" }, { status: 405 });
    }

    const body = await request.json().catch(() => ({}));
    const title: string = (body?.title || "").trim();
    const components: Component[] = Array.isArray(body?.components) ? body.components : [];

    if (!title) return json({ ok: false, error: "Title is required" }, { status: 400 });
    if (!components.length) return json({ ok: false, error: "At least one component is required" }, { status: 400 });

    // 1) Compute capacity from inventory
    const variantIds = components.map((c) => c.variantId);

    // Try modern quantities() API
    const invRes = await admin.graphql(
      `#graphql
      query Inv($ids:[ID!]!, $names:[String!]!) {
        nodes(ids:$ids) {
          ... on ProductVariant {
            id
            inventoryItem {
              inventoryLevels(first: 100) {
                edges {
                  node {
                    quantities(names: $names) { name quantity }
                  }
                }
              }
            }
          }
        }
      }`,
      { variables: { ids: variantIds, names: ["available"] } }
    );
    let invJson = await asJson(invRes);

    const availByVariant = new Map<string, number>();

    if (hasGraphQLErr(invJson)) {
      // Fallback for shops/API versions without quantities()
      const fbRes = await admin.graphql(
        `#graphql
        query InvFallback($ids:[ID!]!) {
          nodes(ids:$ids) {
            ... on ProductVariant { id inventoryQuantity }
          }
        }`,
        { variables: { ids: variantIds } }
      );
      const fbJson = await asJson(fbRes);
      if (hasGraphQLErr(fbJson)) {
        const errMsg =
          fbJson.errors?.map((e: any) => e?.message).join("; ") ||
          invJson.errors?.map((e: any) => e?.message).join("; ") ||
          "Unknown inventory error";
        return json({ ok: false, error: errMsg }, { status: 500 });
      }
      for (const n of fbJson?.data?.nodes ?? []) {
        if (!n?.id) continue;
        availByVariant.set(n.id, Number(n.inventoryQuantity ?? 0));
      }
    } else {
      for (const n of invJson?.data?.nodes ?? []) {
        if (!n?.id) continue;
        const total =
          n?.inventoryItem?.inventoryLevels?.edges?.reduce((sum: number, e: any) => {
            const list = e?.node?.quantities ?? [];
            const q = list.find((x: any) => x?.name === "available")?.quantity ?? 0;
            return sum + Number(q || 0);
          }, 0) ?? 0;
        availByVariant.set(n.id, total);
      }
    }

    let capacity: number = components.length ? Number.POSITIVE_INFINITY : 0;
    for (const c of components) {
      const have = Number(availByVariant.get(c.variantId) ?? 0);
      const need = Math.max(1, Number(c.qty) || 1);
      const capThis = Math.floor(have / need);
      capacity = Math.min(capacity, capThis);
    }
    if (capacity === Number.POSITIVE_INFINITY) capacity = 0;

    // 2) Create the product (no variants here)
    const createProdRes = await admin.graphql(
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
            status: "DRAFT", // change to ACTIVE if you want it live immediately
          },
        },
      }
    );
    const createProdJson = await asJson(createProdRes);
    const pUE = createProdJson?.data?.productCreate?.userErrors ?? [];
    if (pUE.length) {
      return json({ ok: false, error: pUE.map((e: any) => e.message).join(", ") }, { status: 400 });
    }
    const productId: string | undefined = createProdJson?.data?.productCreate?.product?.id;
    if (!productId) return json({ ok: false, error: "No productId from productCreate" }, { status: 500 });

    // 3) Create a single shell variant with productVariantsBulkCreate (replacement for productVariantCreate)
    // Keep price at 0.00 if you plan to price bundles dynamically in theme/cart transform.
    const shellPrice = "0.00";

    const bulkCreateRes = await admin.graphql(
      `#graphql
      mutation BulkVarCreate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
        productVariantsBulkCreate(productId: $productId, variants: $variants) {
          product { id }
          productVariants { id }
          userErrors { field message }
        }
      }`,
      {
        variables: {
          productId,
          variants: [
            {
              title: "Default",
              price: shellPrice,
              // If your API version supports it and you want to hide parent on sales channels, try:
              // requiresComponents: true,
            },
          ],
        },
      }
    );
    const bulkCreateJson = await asJson(bulkCreateRes);
    const bUE = bulkCreateJson?.data?.productVariantsBulkCreate?.userErrors ?? [];
    if (bUE.length) {
      return json({ ok: false, error: bUE.map((e: any) => e.message).join(", ") }, { status: 400 });
    }
    const variantId: string | undefined =
      bulkCreateJson?.data?.productVariantsBulkCreate?.productVariants?.[0]?.id;
    if (!variantId) return json({ ok: false, error: "No variantId from productVariantsBulkCreate" }, { status: 500 });

    // 4) Persist bundle definition via metafields (theme/cart transform can read this)
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
      {
        ownerId: productId,
        namespace: "custom",
        key: "bundle_capacity",
        type: "number_integer",
        value: String(Math.max(0, capacity)),
      },
    ];

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
    const mfJson = await asJson(mfRes);
    const mfUE = mfJson?.data?.metafieldsSet?.userErrors ?? [];
    if (mfUE.length) {
      return json({ ok: false, error: mfUE.map((e: any) => e.message).join(", ") }, { status: 400 });
    }

    return json({ ok: true, productId, variantId, capacity });
  } catch (e: any) {
    return json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}
