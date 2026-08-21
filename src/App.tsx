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
  /// The id inside the archive's own manifest. Optional because a ROM hack
  /// patch has no mod manifest to declare one.
  modId?: string;
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

/// Built from what the catalog actually holds, so a tab that would filter to
/// nothing is never drawn. The Gen 2 recomp tab outlived its engine: it was
/// still offered after that engine was retired, and tapping it emptied a page
/// of 266 mods for anyone looking for Gold or Silver, which is precisely the
/// visitor most likely to tap it. Those mods are here; they run on gen1recomp.
const allFilters: Array<{ value: "all" | Category; label: string; short: string }> = [
  { value: "all", label: "Everything", short: "All" },
  { value: "rom-hack", label: "ROM hacks", short: "Patches" },
  { value: "gen1recomp", label: "Gen 1 recomp", short: "Gen 1" },
  { value: "gen2recomp", label: "Gen 2 recomp", short: "Gen 2" },
];

const filters = allFilters.filter((filter) =>
  filter.value === "all"
  || catalogProjects.some((project) => project.compatibility.includes(filter.value as Category)));

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
      // The repo and the mod id are in here because the name on the card is
      // often not the name people know it by. A mod is announced in Discord
      // and on GitHub under its repository, arrives with an id of its own,
      // and lands in the catalog under whatever it calls itself in its
      // manifest: Gen2-3D-Sprites publishes STADIUM2_OVERWORLD_MODELS and is
      // listed as "Stadium 2 Overworld Models". Searching either of the first
      // two found nothing and read as "the mod is not here".
      const modId = "modId" in project ? project.modId : undefined;
      const haystack = [project.title, project.creator, project.target, project.summary,
                        project.homepageUrl, modId]
        .filter(Boolean).join(" ").toLowerCase();
      return matchesCategory && (!needle || haystack.includes(needle));
    });
  }, [category, query]);

  const visibleGroups = useMemo(() => [
    {
      kind: "rom-hack" as const,
      title: "ROM hack patches",
      description: "ROM hacks worth knowing. Open the official project page or grab a cleared patch.",
      projects: visibleProjects.filter((project) => project.kind === "rom-hack"),
    },
    {
      kind: "mod" as const,
      title: "Recomp mods",
      description: "Mods for Gen1Recomp and Gen2Recomp. Cleared files are ready to download.",
      projects: visibleProjects.filter((project) => project.kind === "mod"),
    },
  ].filter((group) => group.projects.length > 0), [visibleProjects]);

  const activeFilter = filters.find((filter) => filter.value === category);
  const emptyHeading = query
    ? "Nothing matched that search."
    : category !== "all"
      ? `No tracked ${activeFilter?.label.toLowerCase()} found.`
      : "Nothing here yet.";
  const emptyDescription = query
    ? "Try a different title or category. You can also add the project you had in mind."
    : "When something lands in this category, it will show up here.";

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
            <p className="eyebrow">ROM HACKS · RECOMP MODS · NO ROMS</p>
            <h1 id="hero-title"><span>phosphor</span><i>_</i><small>index</small></h1>
            <p className="hero-intro">
              Browse ROM hacks and Gen 1 or Gen 2 recomp mods in one place. Cleared files download here. Everything else sends you straight to the creator.
            </p>
            <form className="search-box" onSubmit={searchCatalog} role="search">
              <span aria-hidden="true">⌕</span>
              <label className="sr-only" htmlFor="hero-search">Search the catalog</label>
              <input
                id="hero-search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Find a project..."
              />
              <button type="submit">Search</button>
            </form>
            {/* Counted, not typed. These read 15 / 30 / 07 for months while
                the panel beside them said 266, because they were written once
                and the catalog grows on a push. The third was "Made for Gen 2",
                which counted gen2recomp compatibility and has been 0 since that
                engine was retired -- Gold and Silver run on gen1recomp now, so
                the number said "no Gen 2 support" about a catalog full of it.
                Direct downloads is a real number and the one a visitor is
                actually deciding on. */}
            <div className="hero-notes" aria-label="Archive principles">
              <span><b>{String(romHackCount).padStart(2, "0")}</b> ROM hacks</span>
              <span><b>{String(modCount).padStart(2, "0")}</b> Recomp mods</span>
              <span><b>{String(releases.length).padStart(2, "0")}</b> Direct downloads</span>
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
              <p>LIBRARY STATUS · {catalogProjects.length} PROJECTS</p>
              <strong>{String(romHackCount).padStart(2, "0")} PATCHES<br />{String(modCount).padStart(2, "0")} MODS<span>_</span></strong>
            </div>
            <div className="display-path">
              <span><b>1</b> Source</span><i />
              <span><b>2</b> File check</span><i />
              <span><b>3</b> Download</span>
            </div>
          </div>
        </section>

        <section className="catalog-section" id="browse" aria-labelledby="catalog-title">
          <div className="section-heading">
            <div>
              <p className="section-kicker">{"// Library"}</p>
              <h2 id="catalog-title">browse the library<span>_</span></h2>
            </div>
            <p>{catalogProjects.length} projects · {releases.length} direct downloads</p>
          </div>

          <div className="catalog-counts" aria-label="Catalog totals">
            <div><span>ROM HACKS</span><strong>{String(romHackCount).padStart(2, "0")}</strong><small>projects to explore</small></div>
            <div><span>RECOMP MODS</span><strong>{String(modCount).padStart(2, "0")}</strong><small>across Gen 1 + Gen 2</small></div>
            <div className="count-cleared"><span>DOWNLOADS</span><strong>{String(releases.length).padStart(2, "0")}</strong><small>checked and ready</small></div>
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
                                <div><dt>Source</dt><dd>Official project</dd></div>
                                <div><dt>Download</dt><dd>From creator</dd></div>
                              </>
                            )}
                          </dl>
                          <div className="release-actions">
                            {verified ? <a href={project.fileUrl}>Download <span aria-hidden="true">↓</span></a> : <span>AVAILABLE FROM CREATOR</span>}
                            <a href={project.homepageUrl}>Open project <span aria-hidden="true">↗</span></a>
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
              <p className="section-kicker">{"// Good to know"}</p>
              <h2 id="standards-title">downloads, explained<span>_</span></h2>
            <p>If you can download a file here, the creator allows sharing and the file matches the official release. Otherwise, we link you to the project.</p>
          </div>
          <div className="standard-list">
            <article>
              <span className="standard-number">01</span>
              <div><h3>Shared with permission</h3><p>Every direct download links to an open license or a public note from the creator. Everything else stays on the official project page.</p></div>
              <span className="standard-mark" aria-hidden="true">◎</span>
            </article>
            <article>
              <span className="standard-number">02</span>
              <div><h3>No game files</h3><p>ROM hacks come as patches. Recomp downloads contain mod files, not base-game data.</p></div>
              <span className="standard-mark" aria-hidden="true">◇</span>
            </article>
            <article>
              <span className="standard-number">03</span>
              <div><h3>Checked and traceable</h3><p>Every download includes its version, file size, SHA-256 checksum, target, and official source.</p></div>
              <span className="standard-mark" aria-hidden="true">⌁</span>
            </article>
          </div>
        </section>

        <section className="submit-section" id="submit" aria-labelledby="submit-title">
          <div className="submit-copy">
            <p className="section-kicker">{"// Add a project"}</p>
            <h2 id="submit-title">know a good one<span>?</span></h2>
            <p>Send us the official project page and current release. GitHub will keep you posted while we check it.</p>
            <div className="submission-actions">
              {submissionUrl ? <a className="form-button" href={submissionUrl}>Open submission form ↗</a> : <span className="form-pending">Form activates when the site is connected to GitHub.</span>}
              <button className="copy-button" onClick={copyTemplate} type="button">
                {copied ? "Copied ✓" : "Copy the template"}
              </button>
            </div>
          </div>
          <ol className="submit-steps">
            <li><span>1</span><div><b>Open the form</b><p>Tell us what the project is and where it lives.</p></div></li>
            <li><span>2</span><div><b>Add the details</b><p>Share the release, checksum, target, and permission link if you have them.</p></div></li>
            <li><span>3</span><div><b>We check the file</b><p>We confirm the source, sharing terms, and contents before a download goes live.</p></div></li>
            <li><span>4</span><div><b>Everyone gets the update</b><p>GitHub posts the decision on the issue and lets the requester know.</p></div></li>
          </ol>
        </section>
      </main>

      <footer>
        <a className="brand footer-brand" href="./"><span className="brand-glyph" aria-hidden="true">P<span>_</span></span><span className="brand-name">phosphor<span>_</span></span></a>
        <p>A clean home for ROM hack patches and recomp mods that are okay to share. Not affiliated with Nintendo, The Pokémon Company, or project creators.</p>
        <div><a href="#standards">Catalog policy</a><a href="#submit">Contribute</a><a href="#top">Back to top ↑</a></div>
      </footer>
    </div>
  );
}

export default LibraryApp;
