import { FormEvent, useMemo, useState } from "react";
import projectsData from "./data/projects.json";
import releasesData from "./data/releases.json";

type Category = "rom-hack" | "gen1recomp" | "gen2recomp";

type Release = {
  id: string;
  title: string;
  creator: string;
  version: string;
  releaseDate: string;
  category: Category;
  compatibility: Category[];
  target: string;
  summary: string;
  fileUrl: string;
  fileName: string;
  fileSize: string;
  sha256: string;
  homepageUrl: string;
  permission: "open-license" | "author-approved";
  license: string;
  licenseIncluded: boolean;
  permissionEvidenceUrl: string;
  containsRom: false;
  images: Array<{
    url: string;
    sourceUrl: string;
    permissionEvidenceUrl: string;
    kind: "creator-art" | "in-game-capture";
  }>;
};

type ReviewStatus = "permission-needed" | "permission-queued" | "archive-review";

type DiscoveryProject = {
  id: string;
  title: string;
  creator: string;
  kind: "rom-hack" | "mod";
  category: Category;
  compatibility: Category[];
  target: string;
  summary: string;
  homepageUrl: string;
  reviewStatus: ReviewStatus;
};

type VerifiedProject = Release & {
  kind: "rom-hack" | "mod";
  reviewStatus: "verified";
};

type CatalogProject = VerifiedProject | DiscoveryProject;

const releases = releasesData as Release[];
const discoveryProjects = projectsData as DiscoveryProject[];
const verifiedProjects: VerifiedProject[] = releases.map((release) => ({
  ...release,
  kind: release.category === "rom-hack" ? "rom-hack" : "mod",
  reviewStatus: "verified",
}));
const catalogProjects: CatalogProject[] = [...verifiedProjects, ...discoveryProjects];
const romHackCount = catalogProjects.filter((project) => project.kind === "rom-hack").length;
const modCount = catalogProjects.filter((project) => project.kind === "mod").length;
const gen2Count = catalogProjects.filter((project) => project.kind === "mod" && project.compatibility.includes("gen2recomp")).length;

const reviewLabels: Record<ReviewStatus, string> = {
  "permission-needed": "Permission needed",
  "permission-queued": "Outreach queued",
  "archive-review": "Archive review",
};

const filters: Array<{ value: "all" | Category; label: string; short: string }> = [
  { value: "all", label: "Everything", short: "All" },
  { value: "rom-hack", label: "ROM hacks", short: "Patches" },
  { value: "gen1recomp", label: "Gen 1 recomp", short: "Gen 1" },
  { value: "gen2recomp", label: "Gen 2 recomp", short: "Gen 2" },
];

const submissionTemplate = `# Phosphor Index submission

Project title:
Creator / team:
Version:
Release date (YYYY-MM-DD):
Category: ROM hack | Gen 1 recomp | Gen 2 recomp
Compatible channels:
Target game / recomp:
Summary:
Project homepage:
Release file URL:
File format and size:
SHA-256:
Public redistribution permission URL:
Permission type: open license | explicit author approval
License / approval name:
Contains a commercial ROM: no
Optional image source and permission URL:
Notes:`;

function categoryLabel(category: Category) {
  return filters.find((filter) => filter.value === category)?.label ?? category;
}

function getSubmissionUrl() {
  if (typeof window === "undefined") return null;
  let repository = import.meta.env.VITE_GITHUB_REPOSITORY?.trim();
  if (!repository && window.location.hostname.endsWith(".github.io")) {
    const owner = window.location.hostname.split(".")[0];
    const project = window.location.pathname.split("/").filter(Boolean)[0] || `${owner}.github.io`;
    repository = `${owner}/${project}`;
  }
  if (!repository) return null;
  const normalized = repository.replace(/^https:\/\/github\.com\//, "").replace(/\/$/, "");
  return `https://github.com/${normalized}/issues/new?template=release-submission.yml`;
}

export function LibraryApp() {
  const [category, setCategory] = useState<"all" | Category>("all");
  const [query, setQuery] = useState("");
  const [copied, setCopied] = useState(false);
  const submissionUrl = getSubmissionUrl();

  const visibleProjects = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return catalogProjects.filter((project) => {
      const matchesCategory = category === "all" || project.compatibility.includes(category);
      const haystack = `${project.title} ${project.creator} ${project.target} ${project.summary}`.toLowerCase();
      return matchesCategory && (!needle || haystack.includes(needle));
    });
  }, [category, query]);

  const visibleGroups = useMemo(() => [
    {
      kind: "rom-hack" as const,
      title: "ROM hack patches",
      description: "Official projects tracked while exact patch-file redistribution permission is reviewed.",
      projects: visibleProjects.filter((project) => project.kind === "rom-hack"),
    },
    {
      kind: "mod" as const,
      title: "Recomp mods",
      description: "Gen1Recomp and Gen2Recomp mods, with downloads enabled only after license and archive checks.",
      projects: visibleProjects.filter((project) => project.kind === "mod"),
    },
  ].filter((group) => group.projects.length > 0), [visibleProjects]);

  const activeFilter = filters.find((filter) => filter.value === category);
  const emptyHeading = query
    ? "No matching signal found."
    : category !== "all"
      ? `No tracked ${activeFilter?.label.toLowerCase()} found.`
      : "The library is powered on.";
  const emptyDescription = query
    ? "Try another title or category, or help add the project you were looking for."
    : "No project in this channel has entered the discovery or verified-download index yet.";

  function searchCatalog(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    document.getElementById("browse")?.scrollIntoView({ behavior: "smooth" });
  }

  async function copyTemplate() {
    await navigator.clipboard.writeText(submissionTemplate);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2200);
  }

  return (
    <div className="site-shell">
      <header className="topbar">
        <a className="brand" href="./" aria-label="Phosphor Emulator home">
          <span className="brand-glyph" aria-hidden="true">P<span>_</span></span>
          <span className="brand-name">phosphor<span>_</span></span>
          <span className="brand-muted">{"// INDEX"}</span>
        </a>
        <nav aria-label="Primary navigation">
          <a href="./">Home</a>
          <a href="#browse">Library</a>
          <a href="#standards">Protocol</a>
        </nav>
        <a className="header-cta" href={submissionUrl ?? "#submit"}><span aria-hidden="true">＋</span> Add release</a>
      </header>

      <main id="top">
        <section className="hero" aria-labelledby="hero-title">
          <div className="hero-copy">
            <div className="signal-row" aria-hidden="true">
              <span><i /> ON&nbsp;&nbsp;·&nbsp;&nbsp;CH 01</span>
              <span>SIG ▮▮▮▯&nbsp;&nbsp; SCAN ON</span>
            </div>
            <p className="eyebrow">Cathode · Ray · Archive</p>
            <h1 id="hero-title"><span>phosphor</span><i>_</i><small>index</small></h1>
            <p className="hero-intro">
              A permission-first index tracking Pokémon ROM-hack patches and Gen 1/Gen 2 recomp mods. Browse every official project signal; downloads activate only after creator approval, provenance, and file-integrity checks.
            </p>
            <form className="search-box" onSubmit={searchCatalog} role="search">
              <span aria-hidden="true">⌕</span>
              <label className="sr-only" htmlFor="hero-search">Search the catalog</label>
              <input
                id="hero-search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="search library..."
              />
              <button type="submit">Scan</button>
            </form>
            <div className="hero-notes" aria-label="Archive principles">
              <span><b>15</b> ROM hacks tracked</span>
              <span><b>30</b> Recomp mods tracked</span>
              <span><b>07</b> Gen 2 signals</span>
            </div>
          </div>

          <div className="index-display" aria-label={`Index status: ${romHackCount} ROM hacks and ${modCount} recomp mods tracked`}>
            <div className="display-bar">
              <span>PHOSPHOR · INDEX · CRT</span>
              <span className="display-live">● READY</span>
            </div>
            <div className="display-grid" aria-hidden="true">
              {Array.from({ length: 63 }, (_, index) => (
                <i className={
                  [60,61].includes(index)
                    ? "alert"
                    : [1,2,3,4,10,14,19,23,28,29,30,31,37,46,55].includes(index)
                      ? "on"
                      : ""
                } key={index} />
              ))}
            </div>
            <div className="display-readout">
              <p>INDEX STATUS · {catalogProjects.length} SIGNALS</p>
              <strong>{String(romHackCount).padStart(2, "0")} PATCHES<br />{String(modCount).padStart(2, "0")} MODS<span>_</span></strong>
            </div>
            <div className="display-path">
              <span><b>1</b> Permission</span><i />
              <span><b>2</b> Hash</span><i />
              <span><b>3</b> Live</span>
            </div>
          </div>
        </section>

        <section className="catalog-section" id="browse" aria-labelledby="catalog-title">
          <div className="section-heading">
            <div>
              <p className="section-kicker">{"// Library"}</p>
              <h2 id="catalog-title">project signals<span>_</span></h2>
            </div>
            <p>{catalogProjects.length} tracked · {releases.length} downloads cleared</p>
          </div>

          <div className="catalog-counts" aria-label="Catalog totals">
            <div><span>ROM HACKS</span><strong>{String(romHackCount).padStart(2, "0")}</strong><small>official projects</small></div>
            <div><span>RECOMP MODS</span><strong>{String(modCount).padStart(2, "0")}</strong><small>across Gen 1 + Gen 2</small></div>
            <div className="count-gen2"><span>GEN 2</span><strong>{String(gen2Count).padStart(2, "0")}</strong><small>compatible signals</small></div>
            <div className="count-cleared"><span>CLEARED</span><strong>{String(releases.length).padStart(2, "0")}</strong><small>verified downloads</small></div>
          </div>

          <div className="catalog-tools">
            <div className="filter-tabs" role="group" aria-label="Filter releases by category">
              {filters.map((filter) => (
                <button
                  className={category === filter.value ? "active" : ""}
                  key={filter.value}
                  onClick={() => setCategory(filter.value)}
                  type="button"
                >
                  <span className="full-label">{filter.label}</span>
                  <span className="short-label">{filter.short}</span>
                </button>
              ))}
            </div>
            <label className="catalog-search">
              <span className="sr-only">Filter releases</span>
              <span aria-hidden="true">⌕</span>
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter releases" />
            </label>
          </div>

          {visibleGroups.length > 0 ? (
            <div className="catalog-groups">
              {visibleGroups.map((group) => (
                <section className="catalog-group" aria-labelledby={`${group.kind}-title`} key={group.kind}>
                  <div className="catalog-group-heading">
                    <div><p>{group.kind === "rom-hack" ? "PATCH CHANNEL" : "MOD CHANNEL"}</p><h3 id={`${group.kind}-title`}>{group.title}<span>_</span></h3></div>
                    <div><strong>{String(group.projects.length).padStart(2, "0")}</strong><p>{group.description}</p></div>
                  </div>
                  <div className="release-grid">
                    {group.projects.map((project) => {
                      const verified = project.reviewStatus === "verified";
                      return (
                        <article className={`release-card ${verified ? "verified-card" : "discovery-card"}`} key={project.id}>
                          <div className="release-card-top">
                            <span>{project.compatibility.map(categoryLabel).join(" + ")}</span>
                            {verified ? (
                              <a href={project.permissionEvidenceUrl}>✓ {project.license} verified ↗</a>
                            ) : project.reviewStatus !== "permission-needed" ? (
                              <span className={`review-badge ${project.reviewStatus}`}>{reviewLabels[project.reviewStatus]}</span>
                            ) : null}
                          </div>
                          <h3>{project.title}</h3>
                          <p className="release-byline">by {project.creator}{verified ? ` · ${project.version}` : ""}</p>
                          <p>{project.summary}</p>
                          <dl>
                            <div><dt>Target</dt><dd>{project.target}</dd></div>
                            {verified ? (
                              <>
                                <div><dt>File</dt><dd>{project.fileSize}</dd></div>
                                <div><dt>SHA-256</dt><dd title={project.sha256}>{project.sha256.slice(0, 10)}…</dd></div>
                              </>
                            ) : (
                              <>
                                <div><dt>Listing</dt><dd>Official source</dd></div>
                                <div><dt>Mirror</dt><dd>Not enabled</dd></div>
                              </>
                            )}
                          </dl>
                          <div className="release-actions">
                            {verified ? <a href={project.fileUrl}>Download file <span aria-hidden="true">↓</span></a> : <span>REVIEW IN PROGRESS</span>}
                            <a href={project.homepageUrl}>Official project <span aria-hidden="true">↗</span></a>
                          </div>
                        </article>
                      );
                    })}
                  </div>
                </section>
              ))}
            </div>
          ) : (
            <div className="empty-index">
              <div className="empty-symbol" aria-hidden="true"><span /><span /><span /></div>
              <p className="empty-code">SIGNAL_000 · NO CARRIER</p>
              <h3>{emptyHeading}</h3>
              <p>{emptyDescription}</p>
              <a href="#submit">Submit the first release <span aria-hidden="true">→</span></a>
            </div>
          )}
        </section>

        <section className="standards-section" id="standards" aria-labelledby="standards-title">
          <div className="standards-lead">
              <p className="section-kicker">{"// Protocol"}</p>
              <h2 id="standards-title">clear provenance<span>_</span></h2>
            <p>Discovery and distribution are separate signals. Every project may be indexed from its official page, but a file becomes downloadable only after permission and integrity review.</p>
          </div>
          <div className="standard-list">
            <article>
              <span className="standard-number">01</span>
              <div><h3>Downloads have a paper trail</h3><p>Green verified cards link to an open license or public creator statement that covers redistribution. Pending cards link out only.</p></div>
              <span className="standard-mark" aria-hidden="true">◎</span>
            </article>
            <article>
              <span className="standard-number">02</span>
              <div><h3>No commercial ROMs</h3><p>ROM hacks are distributed as patch files. Recomp uploads contain only approved mod files—not base-game data.</p></div>
              <span className="standard-mark" aria-hidden="true">◇</span>
            </article>
            <article>
              <span className="standard-number">03</span>
              <div><h3>Every file is fingerprinted</h3><p>Versioned releases include a SHA-256 checksum, exact file size, target, and canonical source page.</p></div>
              <span className="standard-mark" aria-hidden="true">⌁</span>
            </article>
          </div>
        </section>

        <section className="submit-section" id="submit" aria-labelledby="submit-title">
          <div className="submit-copy">
            <p className="section-kicker">{"// Uplink"}</p>
            <h2 id="submit-title">send a new signal<span>_</span></h2>
            <p>Submit through GitHub with the exact release and permission evidence. You’ll receive status updates on the issue while the archive owner reviews it.</p>
            <div className="submission-actions">
              {submissionUrl ? <a className="form-button" href={submissionUrl}>Open submission form ↗</a> : <span className="form-pending">Form activates when the site is connected to GitHub.</span>}
              <button className="copy-button" onClick={copyTemplate} type="button">
                {copied ? "Template copied ✓" : "Copy submission template"}
              </button>
            </div>
          </div>
          <ol className="submit-steps">
            <li><span>1</span><div><b>Requester opens the form</b><p>GitHub records the file, checksum, license, target, and public permission evidence.</p></div></li>
            <li><span>2</span><div><b>You receive an email</b><p>The new issue is assigned to the repository owner so GitHub sends its normal notification.</p></div></li>
            <li><span>3</span><div><b>Reply with a decision</b><p>Reply to the email or issue with <code>/approve</code> or <code>/deny reason</code>.</p></div></li>
            <li><span>4</span><div><b>Publish or respond</b><p>Approval verifies the archive and deploys it. Either decision posts back to the requester.</p></div></li>
          </ol>
        </section>
      </main>

      <footer>
        <a className="brand footer-brand" href="./"><span className="brand-glyph" aria-hidden="true">P<span>_</span></span><span className="brand-name">phosphor<span>_</span></span></a>
        <p>A community archive for patches and mods with verifiable redistribution permission. Not affiliated with Nintendo, The Pokémon Company, or project creators.</p>
        <div><a href="#standards">Catalog policy</a><a href="#submit">Contribute</a><a href="#top">Back to top ↑</a></div>
      </footer>
    </div>
  );
}

export default LibraryApp;
