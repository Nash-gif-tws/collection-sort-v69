import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { useEffect, useMemo, useState } from "react";
import { useFetcher, useLoaderData } from "@remix-run/react";
import {
  Page, Card, Tabs, BlockStack, InlineStack, TextField, Button, Banner, Autocomplete, Icon, Badge
} from "@shopify/polaris";
import { SearchIcon, DeleteIcon } from "@shopify/polaris-icons";
import { authenticate } from "~/shopify.server";

export async function loader({ request }: LoaderFunctionArgs) {
  await authenticate.admin(request);
  const res = await fetch(new URL("/api.features", new URL(request.url)).toString(), {
    headers: { cookie: request.headers.get("cookie") ?? "" },
  });
  const feat = await res.json().catch(()=>({}));
  return json({ features: feat });
}

type PickItem = { label: string; variantId: string; productId: string; };

export default function PackagesPage() {
  const { features } = useLoaderData<typeof loader>();
  const [tab, setTab] = useState(0);

  // ---- Shared search picker (variants) ----
  const [search, setSearch] = useState("");
  const [options, setOptions] = useState<PickItem[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const t = setTimeout(async () => {
      if (!search.trim()) { setOptions([]); return; }
      setLoading(true);
      const r = await fetch(`/api.products.search?q=${encodeURIComponent(search)}`);
      const j = await r.json();
      setOptions((j.items ?? []).map((it:any)=>({ label: it.label, variantId: it.variantId, productId: it.productId })));
      setLoading(false);
    }, 300);
    return () => clearTimeout(t);
  }, [search]);

  // ---- Bundle builder ----
  const [bundleTitle, setBundleTitle] = useState("");
  const [bundleLines, setBundleLines] = useState<{variantId:string; label:string; qty:number}[]>([]);
  const bundleFetcher = useFetcher();

  function addBundleLine(item: PickItem) {
    setBundleLines(prev => [...prev, { variantId: item.variantId, label: item.label, qty: 1 }]);
    setSearch(""); setOptions([]);
  }
  function removeBundleLine(idx:number) {
    setBundleLines(prev => prev.filter((_,i)=>i!==idx));
  }

  async function createBundle() {
    const payload = {
      title: bundleTitle || "Package",
      items: bundleLines.map(l => ({ variantId: l.variantId, quantity: l.qty })),
    };
    bundleFetcher.submit({ __payload: JSON.stringify(payload) }, {
      method: "post",
      action: "/api.bundles.create",
      encType: "application/x-www-form-urlencoded",
    });
  }

  // ---- Combined listing (Plus) ----
  const supportsCL = !!features?.supportsCombinedListings;
  const combinedFetcher = useFetcher();
  const [parentTitle, setParentTitle] = useState("");
  const [optionName, setOptionName] = useState("Style");
  const [optionValues, setOptionValues] = useState("A,B,C");
  const [children, setChildren] = useState<{ childProductId: string; selectedParentOptionValues: {name:string;value:string}[]; label: string }[]>([]);

  function addChildFromVariant(item: PickItem) {
    // Minimal: map each child product to one parent option value (first value)
    const values = optionValues.split(",").map(s=>s.trim()).filter(Boolean);
    const first = values[children.length] || values[0] || "A";
    setChildren(prev => [...prev, {
      childProductId: item.productId,
      selectedParentOptionValues: [{ name: optionName, value: first }],
      label: item.label,
    }]);
    setSearch(""); setOptions([]);
  }
  function removeChild(idx:number) { setChildren(prev => prev.filter((_,i)=>i!==idx)); }

  async function createCombined() {
    const payload = {
      parentTitle: parentTitle || "Joined Listing",
      options: [{ name: optionName, values: optionValues.split(",").map(s=>s.trim()).filter(Boolean) }],
      children,
    };
    combinedFetcher.submit({ __payload: JSON.stringify(payload) }, {
      method: "post",
      action: "/api.combined.create",
      encType: "application/x-www-form-urlencoded",
    });
  }

  return (
    <Page title="Packages & Joined Listings">
      <Tabs tabs={[
        { id: "bundle", content: "Package / Bundle" },
        { id: "joined", content: "Joined Listing", disabled: !supportsCL }
      ]} selected={tab} onSelect={setTab}>
        <div style={{ marginTop: 16 }}>
          {tab === 0 && (
            <Card>
              <BlockStack gap="400">
                <TextField label="Bundle title" value={bundleTitle} onChange={setBundleTitle} autoComplete="off" />

                <Autocomplete
                  options={options}
                  selected={[]}
                  onSelect={(sel) => {
                    const id = sel[0] as string;
                    const item = options.find(o => o.variantId === id);
                    if (item) addBundleLine(item);
                  }}
                  inputValue={search}
                  onInputChange={setSearch}
                  loading={loading}
                  textField={
                    <Autocomplete.TextField
                      label="Add component by search"
                      value={search}
                      onChange={setSearch}
                      prefix={<Icon source={SearchIcon} />}
                      placeholder="Search product or SKU…"
                      autoComplete="off"
                    />
                  }
                />

                {bundleLines.map((l, idx) => (
                  <InlineStack key={idx} gap="200" align="start">
                    <Badge>{l.label}</Badge>
                    <TextField
                      label="Qty"
                      type="number"
                      value={String(l.qty)}
                      onChange={(v)=> setBundleLines(prev => prev.map((x,i)=> i===idx ? {...x, qty: Number(v)||1 } : x))}
                      autoComplete="off"
                    />
                    <Button icon={DeleteIcon} onClick={()=>removeBundleLine(idx)} />
                  </InlineStack>
                ))}

                <InlineStack gap="400">
                  <Button primary onClick={createBundle} disabled={!bundleLines.length || bundleFetcher.state!=="idle"}>
                    {bundleFetcher.state === "submitting" ? "Creating…" : "Create bundle"}
                  </Button>
                </InlineStack>

                {bundleFetcher.data?.error && <Banner tone="critical">{String(bundleFetcher.data.error)}</Banner>}
                {bundleFetcher.data?.ok && <Banner tone="success">Bundle created: {bundleFetcher.data.bundleProductId}</Banner>}
              </BlockStack>
            </Card>
          )}

          {tab === 1 && (
            <Card title="Joined Listing (Shopify Plus)">
              {!supportsCL ? (
                <Banner tone="warning">Your store isn’t on Plus, so native Combined Listings aren’t available. Use a theme app extension fallback to simulate a single PDP.</Banner>
              ) : (
                <BlockStack gap="400">
                  <TextField label="Parent title" value={parentTitle} onChange={setParentTitle} autoComplete="off" />
                  <InlineStack gap="200">
                    <TextField label="Parent option name" value={optionName} onChange={setOptionName} autoComplete="off" />
                    <TextField label="Option values (comma-separated)" value={optionValues} onChange={setOptionValues} autoComplete="off" />
                  </InlineStack>

                  <Autocomplete
                    options={options.map(o=>({ ...o, value: o.productId }))}
                    selected={[]}
                    onSelect={(sel) => {
                      const productId = sel[0] as string;
                      const first = options.find(o => o.productId === productId);
                      if (first) addChildFromVariant(first);
                    }}
                    inputValue={search}
                    onInputChange={setSearch}
                    loading={loading}
                    textField={
                      <Autocomplete.TextField
                        label="Add child product by searching any of its variants"
                        value={search}
                        onChange={setSearch}
                        prefix={<Icon source={SearchIcon} />}
                        placeholder="Search product…"
                        autoComplete="off"
                      />
                    }
                  />

                  {children.map((c, idx) => (
                    <InlineStack key={idx} gap="200" align="start">
                      <Badge>{c.label}</Badge>
                      <Button icon={DeleteIcon} onClick={()=>removeChild(idx)} />
                    </InlineStack>
                  ))}

                  <InlineStack gap="400">
                    <Button primary onClick={createCombined} disabled={!children.length || combinedFetcher.state!=="idle"}>
                      {combinedFetcher.state === "submitting" ? "Creating…" : "Create joined listing"}
                    </Button>
                  </InlineStack>

                  {combinedFetcher.data?.error && <Banner tone="critical">{String(combinedFetcher.data.error)}</Banner>}
                  {combinedFetcher.data?.ok && <Banner tone="success">Created parent: {combinedFetcher.data.parentProductId}</Banner>}
                </BlockStack>
              )}
            </Card>
          )}
        </div>
      </Tabs>
    </Page>
  );
}
