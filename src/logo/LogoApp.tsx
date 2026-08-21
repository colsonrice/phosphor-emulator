import { useCallback, useState } from "react";

const siteOrigin = "https://phosphoremulator.com";
const appStoreUrl = "https://apps.apple.com/us/app/phosphor-emulator/id6759676286";

type Asset = {
  id: string;
  name: string;
  file: string;
  alt: string;
  blurb: string;
  dimensions: string;
  weight: string;
  previewClass: string;
};

const assets: Asset[] = [
  {
    id: "badge",
    name: "Badge",
    file: "assets/brand/phosphor-badge.png",
    alt: "Play on Phosphor",
    blurb:
      "The long lockup, for a row of install buttons or a link back to the app. Drawn on a 512px canvas so it lines up with the usual sideload badges at the same height.",
    dimensions: "1521 × 512 PNG",
    weight: "338 KB",
    previewClass: "asset-preview asset-preview-wide",
  },
  {
    id: "icon",
    name: "App icon",
    file: "assets/brand/phosphor-icon.png",
    alt: "Phosphor",
    blurb:
      "The mark on its own, corners already rounded with transparency outside them. Use it wherever the badge is too wide.",
    dimensions: "1024 × 1024 PNG",
    weight: "1.5 MB",
    previewClass: "asset-preview asset-preview-square",
  },
];

type Snippet = "html" | "markdown" | "url";

const snippetLabels: Record<Snippet, string> = {
  html: "HTML",
  markdown: "Markdown",
  url: "Direct link",
};

function snippetFor(asset: Asset, kind: Snippet): string {
  const url = `${siteOrigin}/${asset.file}`;
  if (kind === "url") return url;
  if (kind === "markdown") return `[![${asset.alt}](${url})](${appStoreUrl})`;
  return `<a href="${appStoreUrl}"><img src="${url}" alt="${asset.alt}" height="60"></a>`;
}

/** The async clipboard API rejects when the document is not focused, so fall back. */
function legacyCopy(text: string): boolean {
  const field = document.createElement("textarea");
  field.value = text;
  field.setAttribute("readonly", "");
  field.style.position = "fixed";
  field.style.opacity = "0";
  document.body.appendChild(field);
  field.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  document.body.removeChild(field);
  return ok;
}

function useCopy(): [string | null, (key: string, text: string) => void] {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = useCallback((key: string, text: string) => {
    const flash = () => {
      setCopied(key);
      window.setTimeout(() => { setCopied((c) => (c === key ? null : c)); }, 1800);
    };
    void navigator.clipboard.writeText(text).then(flash, () => {
      if (legacyCopy(text)) flash();
    });
  }, []);
  return [copied, copy];
}

function AssetCard({ asset }: { asset: Asset }) {
  const [kind, setKind] = useState<Snippet>("html");
  const [copied, copy] = useCopy();
  const url = `${siteOrigin}/${asset.file}`;
  const snippet = snippetFor(asset, kind);
  const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function";

  const share = () => {
    if (canShare) {
      void navigator.share({ title: `Phosphor ${asset.name}`, url }).catch(() => {});
      return;
    }
    copy(`${asset.id}-share`, url);
  };

  return (
    <article className="asset-card">
      <div className={asset.previewClass}>
        <img src={asset.file} alt={asset.alt} />
      </div>

      <div className="asset-body">
        <div className="asset-head">
          <h2>{asset.name}</h2>
          <p className="asset-meta">
            <span>{asset.dimensions}</span>
            <i aria-hidden="true">/</i>
            <span>{asset.weight}</span>
          </p>
        </div>
        <p className="asset-blurb">{asset.blurb}</p>

        <div className="asset-actions">
          <a className="btn btn-primary" href={asset.file} download>
            Download
          </a>
          <button type="button" className="btn" onClick={share}>
            {copied === `${asset.id}-share` ? "Link copied" : "Share"}
          </button>
          <button type="button" className="btn" onClick={() => { copy(`${asset.id}-link`, url); }}>
            {copied === `${asset.id}-link` ? "Copied" : "Copy link"}
          </button>
        </div>

        <div className="asset-code">
          <div className="code-tabs" role="tablist" aria-label={`${asset.name} embed format`}>
            {(Object.keys(snippetLabels) as Snippet[]).map((k) => (
              <button
                key={k}
                type="button"
                role="tab"
                aria-selected={kind === k}
                className={kind === k ? "code-tab is-on" : "code-tab"}
                onClick={() => { setKind(k); }}
              >
                {snippetLabels[k]}
              </button>
            ))}
          </div>
          <pre><code>{snippet}</code></pre>
          <button
            type="button"
            className="btn btn-code"
            onClick={() => { copy(`${asset.id}-code`, snippet); }}
          >
            {copied === `${asset.id}-code` ? "Copied" : `Copy ${snippetLabels[kind].toLowerCase()}`}
          </button>
        </div>
      </div>
    </article>
  );
}

export function LogoApp() {
  const [copied, copy] = useCopy();
  const shareLink = () => {
    if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
      void navigator.share({ title: "Phosphor Emulator", url: appStoreUrl }).catch(() => {});
      return;
    }
    copy("store-share", appStoreUrl);
  };

  return (
    <div className="home-site" id="top">
      <div className="ambient-grid" aria-hidden="true" />

      <header className="home-header">
        <a className="home-brand" href="/" aria-label="Phosphor Emulator home">
          <img src="assets/phosphor/app-icon.png" alt="" />
          <span>phosphor<i>_</i></span>
        </a>
        <nav aria-label="Main navigation">
          <a href="/">Home</a>
          <a href="library.html">Mod library</a>
        </nav>
        <span />
      </header>

      <main className="logo-page">
        <section className="logo-intro">
          <p className="logo-kicker">BRAND</p>
          <h1>Phosphor logo files</h1>
          <p className="logo-lede">
            Everything here is free to use to link to Phosphor. Download a file, copy a direct
            link, or take the embed code and drop it straight into a README.
          </p>
        </section>

        <section className="asset-list">
          {assets.map((asset) => <AssetCard key={asset.id} asset={asset} />)}
        </section>

        <section className="link-card">
          <div className="link-head">
            <h2>App Store link</h2>
            <p>The page these logos should point at.</p>
          </div>
          <p className="link-url">{appStoreUrl}</p>
          <div className="asset-actions">
            <a className="btn btn-primary" href={appStoreUrl} target="_blank" rel="noreferrer">
              Open
            </a>
            <button type="button" className="btn" onClick={shareLink}>
              {copied === "store-share" ? "Link copied" : "Share"}
            </button>
            <button type="button" className="btn" onClick={() => { copy("store-link", appStoreUrl); }}>
              {copied === "store-link" ? "Copied" : "Copy link"}
            </button>
          </div>
        </section>

      </main>

      <footer className="logo-footer">
        <span>Phosphor Emulator</span>
        <div>
          <a href={appStoreUrl}>App Store</a>
          <a href="/">Home</a>
          <a href="library.html">Mod library</a>
        </div>
      </footer>
    </div>
  );
}
