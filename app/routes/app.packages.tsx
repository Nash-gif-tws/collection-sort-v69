// app/routes/app.packages.tsx
import type { HeadersFunction, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useEffect, useMemo, useRef, useState } from "react";
import { useLoaderData } from "@remix-run/react";
import { authenticate } from "~/shopify.server";
import {
  Page,
  Layout,
  Card,
  Tabs,
  Text,
  TextField,
  Button,
  Banner,
  InlineStack,
  BlockStack,
  Badge,
  Spinner,
} from "@shopify/polaris";

export const headers: HeadersFunction = () => ({
  "Content-Security-Policy":
    "frame-ancestors https://admin.shopify.com https://*.myshopify.com;",
});

export async function loader({ request }: LoaderFunctionArgs) {
  try {
    await authenticate.admin(request);
    // Force-enable features here so UI never depends on /api/features
    return json({
      ok: true,
      features: { bundles: true, combinedListings: true },
    });
  } catch {
    // ensure top-level auth rather than iframe loop
    const url = new URL(request.url);
    const shop = url.searchParams.get("shop") || "";
    const host = url.searchParams.get("host") || "";
    const qs: string[] = [];
    if (shop) qs.push(`shop=${encodeURIComponent(shop)}`);
    if (host) qs.push(`host=${encodeURIComponent(host)}`);
    const target = `/auth${qs.length ? `?${qs.join("&")}` : ""}`;
    const html = `<!doctype html><html><head><meta charset="utf-8"/></head><body>
<script>
  (function () {
    var target = ${JSON.stringify(target)};
    if (window.top === window.self) { window.location.href = target; }
    else { window.top.location.href = target; }
  })();
</script>
</body></html>`;
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

type SearchItem = {
  id: string;            // variant gid
  productId: string;
  productTitle: string;
  vendor?: string;
  variantId: string;
  variantTitle: string;
  sku?: string;
  options?: Array<{ name: string; value: string }>;
  label: string;
};

type PickLine = { id: string; variantId: string; label: string; qty: number };

export default function PackagesPage() {
  const { features } = useLoaderData<typeof loader>();

  const [tab, setTab] = useState(0); // 0=bundle, 1=joined listing
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // --- Search state (Bundle tab) ---
  const [q, setQ] = useState("");
  const [results, setResults] = useState<SearchItem[]>([]);
  const [searchBusy, setSearchBusy] = useState(false);
  const [lines, setLines] = useState<PickLine[]>([]);

  const debRef = useRef<number | null>(null);

  // Do search against our endpoint; handle auth bounce (401 with JSON) safely
  async function runSearch(term: string) {
    if (!term) {
      setResults([]);
      return;
    }
    setSearchBusy(true);
    setMsg(null);
    try {
      const r = await fetch(`/api/products-search?q=${encodeURIComponent(term)}&first=10`, {
        credentials: "include",
      });
      const ct = r.headers.get("content-type") || "";
      if (r.status === 401) {
        // If our API returns {reauthUrl}, bounce top-level once
        const body = ct.includes("application/json") ? await r.json() : null;
        if (body?.reauthUrl) {
          if (window.top === window.self) window.location.href = body.reauthUrl;
          else window.top!.location.href = body.reauthUrl;
          return;
        }
      }
      const data = ct.includes("application/json") ? await r.json() : { ok: false, items: [] };
      if (!data.ok) {
        setMsg(data.error || "Search failed.");
        setResults([]);
      } else {
        const arr: SearchItem[] = data.items || data.results || data.data || [];
        setResults(arr);
      }
    } catch (e: any) {
      setMsg(e?.message || String(e));
      setResults([]);
    } finally {
      setSearchBusy(false);
    }
  }

  // Debounced search
  useEffect(() => {
    if (debRef.current) window.clearTimeout(debRef.current);
    debRef.current = window.setTimeout(() => runSearch(q), 250);
    return () => {
      if (debRef.current) window.clearTimeout(debRef.current);
    };
  }, [q]);

  function addLine(item: SearchItem) {
    setLines((cur) => {
      if (cur.some((x) => x.variantId === item.variantId)) return cur;
      return [...cur, { id: item.id, variantId: item.variantId, label: item.label, qty: 1 }];
    });
  }

  function setQty(variantId: string, qty: number) {
    setLines((cur) => cur.map((l) => (l.variantId === variantId ? { ...l, qty } : l)));
  }

  function removeLine(variantId: string) {
    setLines((cur) => cur.filter((l) => l.variantId !== variantId));
  }

  async function createBundle() {
    if (!lines.length) {
      setMsg("Add at least one component.");
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch("/api/bundles.create", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          components: lines.map((l) => ({ variantId: l.variantId, quantity: l.qty })),
          title: `Bundle (${new Date().toISOString().slice(0, 10)})`,
        }),
      });
      const data = await r.json().catch(() => ({ ok: false, error: "Bad JSON" }));
      if (data.ok) {
        setMsg(`Bundle created: ${data.productHandle || "success"}`);
        setLines([]);
      } else {
        setMsg(`Error: ${data.error || "Failed to create bundle"}`);
      }
    } catch (e: any) {
      setMsg(`Failed: ${e?.message || String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  // Tabs (force enable combined listings; we can wire real checks later)
  const tabs = useMemo(
    () => [
      { id: "bundle", content: "Package / Bundle", panelID: "bundle-panel" },
      {
        id: "joined",
        content: "Joined Listing",
        panelID: "joined-panel",
        // DO NOT disable; we want it clickable now:
        disabled: false && !features?.combinedListings,
      },
    ],
    [features]
  );

  return (
    <Page title="Packages & Joined Listings">
      <Layout>
        <Layout.Section>
          <Card>
            <Tabs tabs={tabs} selected={tab} onSelect={setTab}>
              {tab === 0 && (
                <div id="bundle-panel" style={{ padding: 16 }}>
                  <BlockStack gap="400">
                    <Text as="p" tone="subdued">
                      Build a bundle by searching variants and adding quantities.
                    </Text>

                    <InlineStack gap="400" wrap={false} align="start">
                      <div style={{ minWidth: 360 }}>
                        <TextField
                          label="Search products / SKUs"
                          value={q}
                          onChange={setQ}
                          autoComplete="off"
                          placeholder="Type title, SKU or vendor…"
                        />
                      </div>
                      {searchBusy && (
                        <InlineStack gap="200" align="center">
                          <Spinner size="small" />
                          <Text as="span">Searching…</Text>
                        </InlineStack>
                      )}
                    </InlineStack>

                    {results.length > 0 && (
                      <Card>
                        <BlockStack gap="200">
                          <Text as="h3" variant="headingSm">
                            Results
                          </Text>
                          {results.slice(0, 12).map((it) => (
                            <InlineStack key={it.id} gap="300" align="space-between">
                              <div>
                                <Text as="span">{it.label}</Text>{" "}
                                {it.sku ? <Badge tone="info">{it.sku}</Badge> : null}
                              </div>
                              <Button onClick={() => addLine(it)}>Add</Button>
                            </InlineStack>
                          ))}
                        </BlockStack>
                      </Card>
                    )}

                    {lines.length > 0 && (
                      <Card>
                        <BlockStack gap="300">
                          <Text as="h3" variant="headingSm">
                            Components
                          </Text>
                          {lines.map((l) => (
                            <InlineStack key={l.variantId} gap="300" align="space-between">
                              <div style={{ maxWidth: "70%" }}>
                                <Text as="span">{l.label}</Text>
                              </div>
                              <InlineStack gap="200" align="center">
                                <TextField
                                  label="Qty"
                                  labelHidden
                                  type="number"
                                  value={String(l.qty)}
                                  onChange={(v) => setQty(l.variantId, Math.max(1, parseInt(v || "1", 10) || 1))}
                                  autoComplete="off"
                                  min={1}
                                  style={{ width: 90 }}
                                />
                                <Button tone="critical" onClick={() => removeLine(l.variantId)}>
                                  Remove
                                </Button>
                              </InlineStack>
                            </InlineStack>
                          ))}
                          <InlineStack gap="400">
                            <Button primary onClick={createBundle} disabled={busy}>
                              {busy ? "Working…" : "Create bundle"}
                            </Button>
                          </InlineStack>
                        </BlockStack>
                      </Card>
                    )}

                    {msg && (
                      <Banner tone={msg.startsWith("Error") || msg.startsWith("Failed") ? "critical" : "success"}>
                        {msg}
                      </Banner>
                    )}
                  </BlockStack>
                </div>
              )}

              {tab === 1 && (
                <div id="joined-panel" style={{ padding: 16 }}>
                  <BlockStack gap="400">
                    <Text as="p" tone="subdued">
                      Joined listings (Plus): combine multiple child products under one parent. UI coming next.
                    </Text>
                    <Banner tone="info">
                      This tab is intentionally enabled. We’ll wire mutations after search & bundle creation are verified.
                    </Banner>
                  </BlockStack>
                </div>
              )}
            </Tabs>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
