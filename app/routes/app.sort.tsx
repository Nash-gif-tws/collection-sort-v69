// app/routes/app.sort.tsx
import type { LoaderFunctionArgs, HeadersFunction } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import React, { useMemo, useState, useEffect } from "react";
import { authenticate } from "~/shopify.server";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  InlineStack,
  Text,
  TextField,
  Select,
  Button,
  Spinner,
  Badge,
  Banner,
} from "@shopify/polaris";

type Coll = { id: string; title: string };

export const headers: HeadersFunction = () => ({
  "Content-Security-Policy":
    "frame-ancestors https://admin.shopify.com https://*.myshopify.com;",
});

const COLLECTIONS_QUERY = `#graphql
  query Colls($first: Int!, $after: String) {
    collections(first: $first, after: $after, sortKey: TITLE) {
      edges { cursor node { id title } }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

export async function loader({ request }: LoaderFunctionArgs) {
  try {
    // get Admin GraphQL client
    const { admin } = await authenticate.admin(request);

    // pull first 250 collections (plenty for the picker; you can paginate later)
    const res = await admin.graphql(COLLECTIONS_QUERY, {
      variables: { first: 250 },
    });
    const body = await res.json();
    const edges = body?.data?.collections?.edges ?? [];
    const collections: Coll[] = edges.map((e: any) => e.node);

    return json({ ok: true, collections });
  } catch {
    // No session → ALWAYS do OAuth at TOP level; preserve host & shop
    const url = new URL(request.url);
    const shop = url.searchParams.get("shop") || "";
    const host = url.searchParams.get("host") || "";
    const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"/><meta name="robots" content="noindex"/></head>
<body><script>
  (function () {
    var p = new URLSearchParams(window.location.search);
    var shop = p.get("shop") || ${JSON.stringify(shop)};
    var host = p.get("host") || ${JSON.stringify(host)};
    var qs = [];
    if (shop) qs.push("shop=" + encodeURIComponent(shop));
    if (host) qs.push("host=" + encodeURIComponent(host));
    var target = "/auth" + (qs.length ? "?" + qs.join("&") : "");
    if (window.top === window.self) { window.location.href = target; }
    else { window.top.location.href = target; }
  })();
</script></body></html>`;
    return new Response(html, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy":
          "frame-ancestors https://admin.shopify.com https://*.myshopify.com;",
      },
    });
  }
}

function labelForRule(k: string) {
  switch (k) {
    case "in_stock": return "In-stock first";
    case "sales_90d": return "Best sellers (90d)";
    case "variants_in_stock": return "Most variants in stock";
    case "alpha": return "Title A→Z";
    case "oos_last": return "OOS last";
    default: return k;
  }
}

export default function SortPage() {
  const { collections } = useLoaderData<typeof loader>();
  const [selectedId, setSelectedId] = useState<string>(collections?.[0]?.id ?? "");
  const [search, setSearch] = useState("");
  const [topN, setTopN] = useState<string>("200");
  const [limit, setLimit] = useState<string>("25"); // for Sort ALL
  const [dryRun, setDryRun] = useState<boolean>(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<string[] | null>(null);

  // strategy (rules) state
  const [rules, setRules] = useState<string[]>([]);
  const [savingRules, setSavingRules] = useState(false);

  // load strategy when collection changes
  useEffect(() => {
    if (!selectedId) return;
    (async () => {
      try {
        const r = await fetch(`/api/strategy?collectionId=${encodeURIComponent(selectedId)}`, {
          credentials: "include",
        });
        const j = await r.json();
        if (j?.ok && Array.isArray(j.rules)) setRules(j.rules);
      } catch (e) {
        // ignore load errors in UI
      }
    })();
  }, [selectedId]);

  const options = useMemo(() => {
    const filtered = (collections ?? []).filter((c: Coll) =>
      c.title.toLowerCase().includes(search.toLowerCase())
    );
    return filtered.map((c: Coll) => ({ label: c.title, value: c.id }));
  }, [collections, search]);

  function moveRule(idx: number, dir: -1 | 1) {
    setRules(prev => {
      const next = prev.slice();
      const j = idx + dir;
      if (j < 0 || j >= next.length) return prev;
      [next[idx], next[j]] = [next[j], next[idx]];
      return next;
    });
  }

  async function saveRules() {
    if (!selectedId) return;
    setSavingRules(true);
    try {
      const r = await fetch("/api/strategy", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ collectionId: selectedId, rules }),
      });
      const j = await r.json().catch(() => ({ ok: false, error: "Bad JSON" }));
      setMsg(j.ok ? "Saved sorting rules for this collection." : `Error: ${j.error || "unknown"}`);
    } catch (e: any) {
      setMsg(`Failed: ${e?.message || String(e)}`);
    } finally {
      setSavingRules(false);
    }
  }

  async function runSingle() {
    setBusy(true);
    setMsg(null);
    setPreview(null);
    try {
      const r = await fetch("/api/sort", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          collectionId: selectedId,
          dryRun,
          topN: Number.isFinite(Number(topN)) ? Number(topN) : undefined,
        }),
      });
      const ct = r.headers.get("content-type") || "";
      const text = await r.text();
      const j = ct.includes("application/json")
        ? JSON.parse(text)
        : { ok: false, error: text };
      if (j.ok) {
        if (j.dryRun) {
          setPreview(j.preview || []);
          setMsg(`Dry run: would consider ${j.considered} items. Showing first ${j.preview?.length ?? 0}.`);
        } else {
          setMsg(`Done. Moved ${j.moved} (considered ${j.considered})${j.appliedTopN ? `, Top-N=${j.appliedTopN}` : ""}.`);
        }
      } else {
        setMsg(`Error: ${j.error || "unknown"}`);
      }
    } catch (e: any) {
      setMsg(`Failed: ${e?.message || String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function runAll() {
    setBusy(true);
    setMsg("Running all collections…");
    setPreview(null);
    try {
      const r = await fetch("/api/sort-all", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          limit: Number.isFinite(Number(limit)) ? Number(limit) : 25,
          topN: Number.isFinite(Number(topN)) ? Number(topN) : undefined,
          dryRun,
        }),
      });
      const j = await r.json().catch(() => ({ ok: false, error: "Bad JSON" }));
      setMsg(j.ok ? `All done. Processed ${j.processed}. ${dryRun ? "Dry-run only." : ""}` : `Error: ${j.error || "unknown"}`);
    } catch (e: any) {
      setMsg(`Failed: ${e?.message || String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Page title="Sort a collection">
      <Layout>
        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text as="p">
                Hierarchy: <b>In-stock</b> → <b>Best-selling (90d)</b> → <b>Most variants in stock</b> → <b>OOS last</b>.
              </Text>

              <InlineStack gap="400" wrap={false} align="start">
                <div style={{ minWidth: 320 }}>
                  <TextField
                    label="Search collections"
                    value={search}
                    onChange={setSearch}
                    placeholder="Type to filter by title"
                    autoComplete="off"
                  />
                </div>
                <div style={{ minWidth: 420 }}>
                  <Select
                    label="Choose a collection"
                    options={options.length ? options : [{ label: "No matches", value: "" }]}
                    value={selectedId}
                    onChange={setSelectedId}
                  />
                </div>
              </InlineStack>

              {/* Rules editor */}
              {selectedId && rules?.length > 0 && (
                <Card>
                  <BlockStack gap="200">
                    <Text as="h3" variant="headingSm">Rules order for this collection</Text>
                    <BlockStack gap="150">
                      {rules.map((r, i) => (
                        <InlineStack key={r} align="space-between">
                          <Text>{i + 1}. {labelForRule(r)}</Text>
                          <InlineStack gap="200">
                            <Button size="slim" onClick={() => moveRule(i, -1)} disabled={i === 0}>Up</Button>
                            <Button size="slim" onClick={() => moveRule(i, +1)} disabled={i === rules.length - 1}>Down</Button>
                          </InlineStack>
                        </InlineStack>
                      ))}
                      <InlineStack gap="200">
                        <Button
                          size="slim"
                          onClick={() => setRules(["in_stock","sales_90d","variants_in_stock","alpha","oos_last"])}
                        >
                          Reset to default
                        </Button>
                        <Button primary size="slim" onClick={saveRules} loading={savingRules}>
                          Save rules
                        </Button>
                      </InlineStack>
                    </BlockStack>
                  </BlockStack>
                </Card>
              )}

              <InlineStack gap="400" align="start" wrap={false}>
                <TextField
                  label="Top-N (apply only first N positions)"
                  type="number"
                  value={topN}
                  onChange={setTopN}
                  helpText="Keep small while testing; leave blank for default (500)."
                  autoComplete="off"
                />
                <TextField
                  label="Limit for Sort ALL (collections per run)"
                  type="number"
                  value={limit}
                  onChange={setLimit}
                  helpText="How many collections to process when using Sort ALL."
                  autoComplete="off"
                />
                <Button
                  pressed={dryRun}
                  onClick={() => setDryRun(v => !v)}
                  accessibilityLabel="Toggle dry-run"
                >
                  {dryRun ? "Dry-run: ON" : "Dry-run: OFF"}
                </Button>
              </InlineStack>

              <InlineStack gap="400" align="start">
                <Button primary onClick={runSingle} disabled={!selectedId || busy}>
                  {busy ? (<InlineStack gap="200"><Spinner size="small" /> <span>Working…</span></InlineStack>) : "Run now"}
                </Button>

                <Button onClick={runAll} disabled={busy}>
                  {busy ? "Working…" : `Sort ALL (limit ${limit || "25"})`}
                </Button>

                {selectedId && (
                  <Badge tone="info">
                    {selectedId.replace("gid://shopify/Collection/", "Collection/")}
                  </Badge>
                )}
              </InlineStack>

              {msg && (
                <Banner tone={msg.startsWith("Error") || msg.startsWith("Failed") ? "critical" : "success"}>
                  {msg}
                </Banner>
              )}

              {preview && preview.length > 0 && (
                <Card>
                  <BlockStack gap="200">
                    <Text as="h3" variant="headingSm">Dry-run preview (first {preview.length})</Text>
                    <Text as="p" tone="subdued">
                      Product GIDs (top of list):<br />
                      <code style={{ fontSize: 12, wordBreak: "break-all" }}>{preview.join(", ")}</code>
                    </Text>
                  </BlockStack>
                </Card>
              )}
            </BlockStack>
          </Card>

          {!collections?.length && (
            <Card>
              <Text tone="critical">No collections found. Try another store, or check that your app has read_products scope.</Text>
            </Card>
          )}
        </Layout.Section>
      </Layout>
    </Page>
  );
}
