// app/routes/app.sort.tsx
import type { LoaderFunctionArgs, HeadersFunction } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import React, { useMemo, useState } from "react";
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

export const headers: HeadersFunction = () => ({
  // Allow Shopify Admin to embed this page
  "Content-Security-Policy":
    "frame-ancestors https://admin.shopify.com https://*.myshopify.com;",
});

export async function loader({ request }: LoaderFunctionArgs) {
  try {
    // If there is a valid admin session, proceed to render.
    await authenticate.admin(request);
    // Keep the shape your component expects
    return json({ ok: true, collections: null });
  } catch {
    // No session → ALWAYS do OAuth at the TOP level (never inside the Admin iframe)
    const url = new URL(request.url);
    const shop = url.searchParams.get("shop") || "";
    const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"/><meta name="robots" content="noindex"/></head>
<body>
<script>
  (function () {
    var params = new URLSearchParams(window.location.search);
    var shop = params.get("shop") || ${JSON.stringify(shop)};
    var target = "/auth?shop=" + encodeURIComponent(shop);
    // Always top-level navigation to avoid "accounts.shopify.com refused to connect"
    if (window.top === window.self) {
      window.location.href = target;     // top-level
    } else {
      window.top.location.href = target; // break out of iframe/admin shell
    }
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

  const options = useMemo(() => {
    const filtered = (collections ?? []).filter((c: any) =>
      c.title.toLowerCase().includes(search.toLowerCase())
    );
    return filtered.map((c: any) => ({ label: c.title, value: c.id }));
  }, [collections, search]);

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
          setMsg(
            `Dry run: would consider ${j.considered} items. Showing first ${
              j.preview?.length ?? 0
            }.`
          );
        } else {
          setMsg(
            `Done. Moved ${j.moved} (considered ${j.considered})${
              j.appliedTopN ? `, Top-N=${j.appliedTopN}` : ""
            }.`
          );
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
      if (j.ok) {
        setMsg(`All done. Processed ${j.processed}. ${dryRun ? "Dry-run only." : ""}`);
      } else {
        setMsg(`Error: ${j.error || "unknown"}`);
      }
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
                Hierarchy: <b>In-stock</b> → <b>Best-selling (90d)</b> →{" "}
                <b>Most variants in stock</b> → <b>OOS last</b>.
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
                  onClick={() => setDryRun((v) => !v)}
                  accessibilityLabel="Toggle dry-run"
                >
                  {dryRun ? "Dry-run: ON" : "Dry-run: OFF"}
                </Button>
              </InlineStack>

              <InlineStack gap="400" align="start">
                <Button primary onClick={runSingle} disabled={!selectedId || busy}>
                  {busy ? (
                    <InlineStack gap="200">
                      <Spinner size="small" /> <span>Working…</span>
                    </InlineStack>
                  ) : (
                    "Run now"
                  )}
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
                <Banner
                  tone={
                    msg.startsWith("Error") || msg.startsWith("Failed") ? "critical" : "success"
                  }
                >
                  {msg}
                </Banner>
              )}

              {preview && preview.length > 0 && (
                <Card>
                  <BlockStack gap="200">
                    <Text as="h3" variant="headingSm">
                      Dry-run preview (first {preview.length})
                    </Text>
                    <Text as="p" tone="subdued">
                      Product GIDs (top of list):<br />
                      <code style={{ fontSize: 12, wordBreak: "break-all" }}>
                        {preview.join(", ")}
                      </code>
                    </Text>
                  </BlockStack>
                </Card>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}