import { useState, useMemo } from "react";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import {
  Page, Layout, Card, Text, TextField, Button,
  Select, InlineStack, Banner, BlockStack, Badge, Spinner
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";

type Coll = { id: string; title: string };

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin } = await authenticate.admin(request);
  // fetch a small list to choose from (title + id)
  const resp = await admin.graphql(`#graphql
    { collections(first: 50) { edges { node { id title } } } }`);
  const data = await resp.json() as any;
  const list: Coll[] =
    (data?.data?.collections?.edges ?? []).map((e: any) => e.node);
  return json({ collections: list });
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
    const filtered = (collections ?? []).filter((c: Coll) =>
      c.title.toLowerCase().includes(search.toLowerCase())
    );
    return filtered.map((c: Coll) => ({ label: c.title, value: c.id }));
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
      const j = ct.includes("application/json") ? JSON.parse(text) : { ok: false, error: text };
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
                    options={options.length ? options : [{label:"No matches", value:""}]}
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
        </Layout.Section>
      </Layout>
    </Page>
  );
}
