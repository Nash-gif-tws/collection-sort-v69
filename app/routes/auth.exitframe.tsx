// app/server/strategy.server.ts
import { shopify } from "~/shopify.server";

export type SortRule =
  | "in_stock"
  | "sales_90d"
  | "variants_in_stock"
  | "alpha"
  | "oos_last"
  | "pins_first"; // optional future rule

export const DEFAULT_RULES: SortRule[] = [
  "in_stock",
  "sales_90d",
  "variants_in_stock",
  "alpha",
  "oos_last",
];

export async function loadCollectionRules(client: InstanceType<typeof shopify.api.clients.Graphql>, collectionId: string): Promise<SortRule[]> {
  const q = `#graphql
    query Strategy($id: ID!) {
      collection(id: $id) {
        id
        metafield(namespace: "custom", key: "sort_rules") { value }
      }
    }`;
  const { data } = await client.query({ data: { query: q, variables: { id: collectionId } } });
  const raw = data?.collection?.metafield?.value;
  if (!raw) return DEFAULT_RULES;
  try {
    const parsed = JSON.parse(raw);
    const rules = Array.isArray(parsed?.rules) ? parsed.rules : DEFAULT_RULES;
    // sanitize unknown values
    return rules.filter((r: string) => DEFAULT_RULES.includes(r as SortRule)) as SortRule[];
  } catch {
    return DEFAULT_RULES;
  }
}

export async function saveCollectionRules(client: InstanceType<typeof shopify.api.clients.Graphql>, collectionId: string, rules: SortRule[]) {
  const m = `#graphql
    mutation Save($id: ID!, $value: String!) {
      collectionUpdate(input: {
        id: $id,
        metafields: [{
          namespace: "custom",
          key: "sort_rules",
          type: "json",
          value: $value
        }]
      }) {
        userErrors { field message }
      }
    }`;
  const value = JSON.stringify({ rules });
  const { body } = await client.query({ data: { query: m, variables: { id: collectionId, value } } });
  const errs = (body as any).data?.collectionUpdate?.userErrors ?? [];
  if (errs.length) throw new Error(errs.map((e: any) => e.message).join("; "));
}
