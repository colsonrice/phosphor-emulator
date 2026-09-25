const appStoreUrl = "https://apps.apple.com/us/app/phosphor-emulator/id6759676286";
const overlayUrl = "https://github.com/colsonrice/phosphor-emulator/tree/main/engine/overlay";

type Entry = {
  id: string;
  name: string;
  license: string;
  copyright?: string;
  upstream: string;
  shipsIn: string;
  text?: string;
};

const entries: Entry[] = [
  {
    id: "gen1recomp",
    name: "gen1recomp",
    license: "GNU GPL v3 with additional terms (Section 7)",
    copyright: "Copyright 2026 BOIS CLUB GAMES, LLC.",
    upstream: "https://github.com/bryanthaboi/gen1recomp",
    shipsIn: "iPhone and iPad",
  },
  {
    id: "love",
    name: "LÖVE 12.0",
    license:
      "zlib License (its bundled libraries, including FreeType, LuaJIT, ENet, LuaSocket, LZ4, LodePNG, glslang and SPIRV-Cross, under their own terms)",
    copyright: "Copyright (c) 2006-2026 LOVE Development Team.",
    upstream: "https://love2d.org",
    shipsIn: "iPhone and iPad",
    text: "The 2D game framework Gen1Recomp runs on.",
  },
  {
    id: "sdl",
    name: "SDL 3",
    license: "zlib License",
    copyright: "Copyright (C) 1997-2025 Sam Lantinga.",
    upstream: "https://libsdl.org",
    shipsIn: "iPhone and iPad",
  },
  {
    id: "harfbuzz",
    name: "HarfBuzz",
    license: "Old MIT License",
    copyright: "Copyright © 2010-2023 Google, Inc. and contributors.",
    upstream: "https://harfbuzz.github.io",
    shipsIn: "iPhone and iPad",
  },
  {
    id: "ogg-vorbis-theora",
    name: "Ogg, Vorbis and Theora",
    license: "3-Clause BSD License",
    copyright: "Copyright (c) 2002-2020 Xiph.org Foundation.",
    upstream: "https://xiph.org",
    shipsIn: "iPhone and iPad",
  },
  {
    id: "libmodplug",
    name: "libmodplug",
    license: 'Public Domain ("The ModPlug source code is public domain.")',
    upstream: "https://modplug-xmms.sourceforge.net",
    shipsIn: "iPhone and iPad",
  },
  {
    id: "rcheevos",
    name: "rcheevos 12.5.0",
    license: "MIT License",
    copyright: "Copyright (c) 2018 RetroAchievements.org.",
    upstream: "https://github.com/RetroAchievements/rcheevos",
    shipsIn: "iPhone, iPad and Mac",
    text: "RetroAchievements support.",
  },
  {
    id: "dramaticshapevoxelmod",
    name: "DramaticShapeVoxelMod 1.5.4",
    license: "MIT License",
    copyright: "Copyright (c) 2026 DramaticShape.",
    upstream: "https://github.com/DramaticShape/DramaticShapeVoxelMod",
    shipsIn: "iPhone and iPad",
    text: "A bundled Gen1Recomp mod.",
  },
];

function EntryBody({ entry }: { entry: Entry }) {
  if (entry.id === "gen1recomp") {
    return (
      <p>
        The engine behind Gen1Recomp. Phosphor includes it with written permission from BOIS
        CLUB GAMES. Phosphor&apos;s changes to it are published at{" "}
        <a href={overlayUrl}>{overlayUrl}</a>.
      </p>
    );
  }
  if (entry.text) return <p>{entry.text}</p>;
  return null;
}

function LicensesApp() {
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
          <a href="privacy.html">Privacy</a>
        </nav>
        <span />
      </header>

      <main className="legal-main">
        <p className="home-eyebrow legal-kicker">LEGAL</p>
        <h1>Licenses</h1>
        <p>
          Phosphor&apos;s Game Boy, Game Boy Color and Game Boy Advance emulation is written for
          Phosphor. The app also includes the open-source components below. Each keeps its own
          license.
        </p>

        {entries.map((entry) => (
          <article className="license-entry" key={entry.id}>
            <h2>{entry.name}</h2>
            <dl className="license-fields">
              <dt>License</dt>
              <dd>{entry.license}</dd>
              {entry.copyright ? (
                <>
                  <dt>Copyright</dt>
                  <dd>{entry.copyright}</dd>
                </>
              ) : null}
              <dt>Ships in</dt>
              <dd>{entry.shipsIn}</dd>
              <dt>Upstream</dt>
              <dd><a href={entry.upstream}>{entry.upstream}</a></dd>
            </dl>
            <EntryBody entry={entry} />
          </article>
        ))}

        <p className="legal-foot-note">Full license texts are included in the app under Settings, Licenses.</p>
      </main>

      <footer className="home-footer section-shell">
        <div className="home-footer-top">
          <a className="home-brand" href="/"><img src="assets/phosphor/app-icon.png" alt="" /><span>phosphor<i>_</i></span></a>
          <p>Game Boy on Apple, with better controls and just enough glow.</p>
          <div>
            <a href={appStoreUrl}>App Store</a>
            <a href="library.html">Mod library</a>
            <a href="logo.html">Logo</a>
            <a href="privacy.html">Privacy</a>
            <a href="licenses.html">Licenses</a>
            <a href="https://www.squatchcraft.com/phosphor.html">SquatchCraft</a>
          </div>
        </div>
        <div className="home-footer-bottom">
          <span>© 2026 SquatchCraft LLC</span>
          <p>Phosphor does not include games, ROMs, BIOS files, or copyrighted content. Bring your own legally obtained files.</p>
          <span>BUILT WITH A CRT SOUL</span>
        </div>
      </footer>
    </div>
  );
}

export default LicensesApp;
