import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { shopify } from "~/shopify.server";
import { loadCollectionRules, saveCollectionRules, DEFAULT_RULES, type SortRule } from "~/server/strategy.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin } = await shopify.authenticate.admin(request);
  const url = new URL(request.url);
  const collectionId = url.searchParams.get("collectionId");
  if (!collectionId) return json({ ok: false, error: "Missing collectionId" }, { status: 400 });
  const rules = await loadCollectionRules(admin.graphql, collectionId);
  return json({ ok: true, rules, defaults: DEFAULT_RULES });
}

export async function action({ request }: ActionFunctionArgs) {
  const { admin } = await shopify.authenticate.admin(request);
  const body = await request.json().catch(() => ({}));
  const { collectionId, rules } = body || {};
  if (!collectionId || !Array.isArray(rules)) {
    return json({ ok: false, error: "collectionId and rules[] required" }, { status: 400 });
  }
  await saveCollectionRules(admin.graphql, collectionId, rules as SortRule[]);
  return json({ ok: true });
}
