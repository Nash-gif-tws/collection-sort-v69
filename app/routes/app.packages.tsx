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
    return json({
      ok: true,
      features: { bundles: true, combinedListings: true },
    });
  } catch {
    // top-level auth bounce (never inside iframe)
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
  id: string; // variant GID (our search API returns 'id' for variant)
  productId?: string;
  productTitle?: string;
  vendor?: string;
  sku?: string;
  options?: Array<{ name: string; value: string }>;
  label: string;
};

type PickLine = { variantId: string; label: string; qty: number };

export default function PackagesPage() {
  const { features } = useLoaderData<typeof loader>();

  const [tab, setTab] = useState(0); // 0=bundle, 1=joined
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  // Bundle state
  const [bundleTitle, setBundleTitle] = useState("");
  const [q, setQ] = useState("");
  const [results, setResults] = useState<SearchItem[]>([]);
  const [searchBusy, setSearchBusy] = useState(false);
  const [lines, setLines] = useState<PickLine[]>([]);
  const debRef = useRef<number | null>(null);

  // ---- SEARCH ----
  async function runSearch(term: string) {
    if (!term) {
      setResults([]);
      return;
    }
    setSearchBusy(true);
    setMsg(null);
    try {
      // IMPORTANT: route name uses a DOT (products.search)
      const r = await fetch(
        `/api/products.search?q=${encodeURIComponent(term)}&first=10`,
        { credentials: "include" }
      );
      const ct = r.headers.get("content-type") || "";

      if (r.status === 401 && ct.includes("application/json")) {
        const body = await r.json();
        if (body?.reauthUrl) {
          if (window.top === window.self) window.location.href = body.reauthUrl;
          else window.top!.location.href = body.reauthUrl;
          return;
        }
      }

      const data = ct.includes("application/json")
        ? await r.json()
        : { ok: false, error: "Non-JSON response" };

      if (!data.ok) {
        setResults([]);
        setMsg(`Error: ${data.error || "Search failed."}`);
      } else {
        setResults(data.items || []);
      }
    } catch (e: any) {
      setMsg(`Error: ${e?.message || String(e)}`);
      setResults([]);
    } finally {
      setSearchBusy(false);
    }
  }

  // Debounce search calls; do not 'await' inside this callback
  useEffect(() => {
    if (debRef.current) window.clearTimeout(debRef.current);
    debRef.current = window.setTimeout(() => {
      void runSearch(q);
    }, 250);
    return () => {
      if (debRef.current) window.clearTimeout(debRef.current);
    };
  }, [q]);

  function addLine(item: SearchItem) {
    setLines((cur) => {
      const variantId = item.id; // API uses id as variant GID
      if (cur.some((x) => x.variantId === variantId)) return cur;
      return [...cur, { variantId, label: item.label, qty: 1 }];
    });
  }

  function setQty(variantId: string, qtyStr: string) {
    const qty = Math.max(1, parseInt(qtyStr || "1", 10) || 1);
    setLines((cur) => cur.map((l) => (l.variantId === variantId ? { ...l, qty } : l)));
  }

  function removeLine(variantId: string) {
    setLines((cur) => cur.filter((l) => l.variantId !== variantId));
  }

  // ---- CREATE BUNDLE ----
  async function createBundle() {
    setBusy(true);
    setMsg(null);
    try {
      if (!bundleTitle.trim()) throw new Error("Please enter a bundle title");
      if (lines.length === 0) throw new Error("Add at least one component");

      const payload = {
        title: bundleTitle.trim(),
        components: lines.map((l) => ({ variantId: l.variantId, qty: l.qty })),
      };

      const res = await fetch("/api/bundles.create", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const ct = res.headers.get("content-type") || "";
      const text = await res.text();
      const data = ct.includes("application/json")
        ? JSON.parse(text)
        : { ok: false, error: text };

      if (res.status === 401 && (data as any)?.reauthUrl) {
        window.top!.location.href = (data as any).reauthUrl;
        return;
      }

      if (!data.ok) throw new Error(data.error || res.statusText);

      setMsg(
        `Bundle created ✓ productId: ${data.productId}${
          data.capacity ? ` (capacity ${data.capacity})` : ""
        }`
      );
      // Optional reset:
      // setBundleTitle("");
      // setLines([]);
    } catch (e: any) {
      setMsg(`Error: ${e?.message || String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  const tabs = useMemo(
    () => [
      { id: "bundle", content: "Package / Bundle", panelID: "bundle-panel" },
      {
        id: "joined",
        content: "Joined Listing",
        panelID: "joined-panel",
        disabled: false, // keep clickable
      },
    ],
    [features]
  );

  return (
    <Page title="Packages & Joined Listings">
      <Layout>
        <Layout.Section>
          <Card>
            <Tabs tabs={tabs} selected={tab} onSelect={(i) => setTab(i)}>
              {tab === 0 && (
                <div id="bundle-panel" style={{ padding: 16 }}>
                  <BlockStack gap="400">
                    <Text as="p" tone="subdued">
                      Build a bundle by searching variants and adding quantities.
                    </Text>

                    <div style={{ maxWidth: 480 }}>
                      <TextField
                        label="Bundle title"
                        value={bundleTitle}
                        onChange={(v) => setBundleTitle(v)}
                        autoComplete="off"
                        placeholder="e.g. Snowboard + Bindings Bundle"
                      />
                    </div>

                    <InlineStack gap="400" wrap={false} align="start">
                      <div style={{ minWidth: 360 }}>
                        <TextField
                          label="Search products / SKUs"
                          value={q}
                          onChange={(v) => setQ(v)}
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
                                  onChange={(v) => setQty(l.variantId, v)}
                                  autoComplete="off"
                                  min={1}
                                />
                                <Button tone="critical" onClick={() => removeLine(l.variantId)}>
                                  Remove
                                </Button>
                              </InlineStack>
                            </InlineStack>
                          ))}
                          <InlineStack gap="400">
                            <Button
                              primary
                              onClick={createBundle}
                              disabled={busy || !bundleTitle.trim() || lines.length === 0}
                            >
                              {busy ? "Creating…" : "Create bundle"}
                            </Button>
                          </InlineStack>
                        </BlockStack>
                      </Card>
                    )}

                    {msg && (
                      <Banner tone={msg.startsWith("Error") ? "critical" : "success"}>
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
                      Joined listings (Plus): combine multiple child products under
                      one parent. UI coming next.
                    </Text>
                    <Banner tone="info">
                      This tab is enabled. We’ll wire mutations after bundle
                      creation is verified.
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
