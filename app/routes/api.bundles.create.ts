import { json, type ActionFunctionArgs } from "@remix-run/node";
import { prisma } from "~/db.server";
import { requireAdminAndShop } from "~/server/reauth.server";

export async function action({ request }: ActionFunctionArgs) {
  const { shop, admin } = await requireAdminAndShop(request);
  const { title, items, discountType, discountValue } = await request.json();

  if (!title || !Array.isArray(items) || items.length === 0) {
    return json({ ok: false, error: "Missing title or items" }, { status: 400 });
  }

  const create = await admin.graphql(`#graphql
    mutation CreateBundle($input: ProductBundleCreateInput!) {
      productBundleCreate(input: $input) {
        product { id title status }
        userErrors { field message }
      }
    }`,
    {
      variables: {
        input: {
          title,
          status: "ACTIVE",
          components: items.map((it: any) => ({
            variantId: it.variantId,
            quantity: Number(it.quantity || 1),
          })),
        },
      },
    }
  );
  const cj = await create.json();
  const err = cj.data?.productBundleCreate?.userErrors?.[0];
  if (err) return json({ ok: false, error: err.message }, { status: 400 });

  const bundleProductId = cj.data.productBundleCreate.product.id;

  // Persist config
  const b = await prisma.bundleDef.create({
    data: {
      shop,
      title,
      bundleProductId,
      discountType: discountType ?? null,
      discountValue: discountValue ?? null,
      items: {
        createMany: {
          data: items.map((i: any) => ({
            variantId: i.variantId,
            quantity: Number(i.quantity || 1),
          })),
        },
      },
    },
    include: { items: true },
  });

  return json({ ok: true, bundleProductId, bundle: b });
}
