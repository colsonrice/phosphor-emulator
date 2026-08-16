const appStoreUrl = "https://apps.apple.com/us/app/phosphor-emulator/id6759676286";

const featureCards = [
  {
    number: "01",
    kicker: "TIME CONTROL",
    title: "Missed it? Run it back.",
    copy: "Rewind as you play, drop a save state anywhere, or jump past the slow stuff at up to 15× speed.",
    mark: "↤",
  },
  {
    number: "02",
    kicker: "CRT LOOK",
    title: "The glow is part of the game.",
    copy: "Tune the scanlines, bloom, dot grid, vignette, contrast, and controller colors until the screen feels right.",
    mark: "▥",
  },
  {
    number: "03",
    kicker: "ONE APP",
    title: "Pick up on any screen.",
    copy: "Play on iPhone, iPad, Mac, or Apple Watch. Your battery saves stay in sync with iCloud. Controllers work too.",
    mark: "⌁",
  },
  {
    number: "04",
    kicker: "YOUR GAMES",
    title: "Your library stays yours.",
    copy: "Bring legally obtained GB, GBC, and GBA files through Files, iCloud Drive, or AirDrop. No ads. No account. No tracking.",
    mark: "◎",
  },
];

const screenshots = [
  { src: "assets/phosphor/screenshot-1.png", label: "Library", detail: "Every game, right where you left it." },
  { src: "assets/phosphor/screenshot-3.png", label: "Game mode", detail: "The game gets the whole screen." },
  { src: "assets/phosphor/screenshot-4.png", label: "Skins", detail: "18 ways to change the mood." },
  { src: "assets/phosphor/screenshot-5.png", label: "Trade", detail: "Move data between your own saves." },
  { src: "assets/phosphor/screenshot-6.png", label: "Link cable", detail: "Host or join a nearby player." },
];

function Arrow() {
  return <span aria-hidden="true">↗</span>;
}

function HomeApp() {
  return (
    <div className="home-site" id="top">
      <div className="ambient-grid" aria-hidden="true" />

      <header className="home-header">
        <a className="home-brand" href="#top" aria-label="Phosphor Emulator home">
          <img src="assets/phosphor/app-icon.png" alt="" />
          <span>phosphor<i>_</i></span>
        </a>
        <nav aria-label="Main navigation">
          <a href="#features">Features</a>
          <a href="#screens">Screens</a>
          <a href="library.html">Mod library</a>
        </nav>
        <a className="mini-download" href={appStoreUrl} target="_blank" rel="noreferrer">
          Get the app <Arrow />
        </a>
      </header>

      <main>
        <section className="home-hero" aria-labelledby="home-title">
          <div className="hero-signal" aria-hidden="true">
            <span><i /> ON · CH 03</span>
            <span>SIG ▮▮▮▯ · SCAN ON</span>
          </div>

          <div className="home-hero-copy">
            <p className="home-eyebrow">GB · GBC · GBA ON APPLE</p>
            <h1 id="home-title">
              Classic games.<br />
              <span className="power-line">Dialed in<span className="power-cursor" aria-hidden="true">_</span></span>
            </h1>
            <p className="home-deck">
              Game Boy, Game Boy Color, and Game Boy Advance on iPhone, iPad, Mac, and Apple Watch. Rewind a bad jump, speed through the grind, sync your saves, and make the screen glow.
            </p>
            <div className="hero-actions">
              <a className="primary-action" href={appStoreUrl} target="_blank" rel="noreferrer">
                <span className="apple-mark" aria-hidden="true">●</span>
                <span><small>DOWNLOAD ON THE</small>App Store</span>
                <Arrow />
              </a>
              <a className="secondary-action" href="library.html">Explore mod library <span aria-hidden="true">→</span></a>
            </div>
            <div className="hero-badges" aria-label="Highlights">
              <span><b>FREE</b> FOREVER</span>
              <span><b>PRIVATE</b> BY DEFAULT</span>
              <span><b>NATIVE</b> ON APPLE</span>
            </div>
          </div>

          <div className="hero-device" aria-label="Phosphor Emulator running on iPhone">
            <div className="hero-orbit orbit-one" aria-hidden="true" />
            <div className="hero-orbit orbit-two" aria-hidden="true" />
            <div className="phone-shell">
              <span className="phone-button phone-button-a" aria-hidden="true" />
              <span className="phone-button phone-button-b" aria-hidden="true" />
              <div className="phone-screen">
                <img src="assets/phosphor/screenshot-1.png" alt="Phosphor library screen with import, skins, and resume controls" />
              </div>
            </div>
            <div className="floating-card speed-card" aria-hidden="true">
              <span>FAST FORWARD</span><strong>15×</strong><i>MAX SPEED</i>
            </div>
            <div className="floating-card live-card" aria-hidden="true">
              <span><i /> SYSTEM</span><strong>READY_</strong>
            </div>
          </div>
        </section>

        <section className="signal-strip" aria-label="Core features">
          <div><span>01</span><strong>LIVE REWIND</strong><small>ROLL IT BACK</small></div>
          <div><span>02</span><strong>iCLOUD SAVES</strong><small>PICK UP ANYWHERE</small></div>
          <div><span>03</span><strong>15× SPEED</strong><small>SKIP THE GRIND</small></div>
          <div><span>04</span><strong>ZERO TRACKING</strong><small>YOUR PLAY STAYS YOURS</small></div>
        </section>

        <section className="manifesto section-shell" id="features">
          <div className="section-label"><span>01</span> WHY PHOSPHOR</div>
          <div className="manifesto-grid">
            <h2>It plays like an emulator.<br /><span>It feels like hardware.</span></h2>
            <p>
              Every control and screen effect is tuned to let the app disappear and the game take over. Familiar where it matters. Faster where it helps.
            </p>
          </div>
          <div className="feature-grid">
            {featureCards.map((feature) => (
              <article className="feature-card" key={feature.number}>
                <div className="feature-card-top"><span>{feature.number}</span><i>{feature.mark}</i></div>
                <p>{feature.kicker}</p>
                <h3>{feature.title}</h3>
                <p>{feature.copy}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="mods-feature section-shell" aria-labelledby="mods-title">
          <div className="mods-console">
            <div className="console-top"><span><i /> MOD CHANNEL</span><span>GEN 1 + GEN 2</span></div>
            <div className="console-grid" aria-hidden="true">
              {Array.from({ length: 48 }, (_, index) => <i className={[2, 3, 9, 14, 19, 20, 21, 27, 28, 35, 43].includes(index) ? "lit" : ""} key={index} />)}
            </div>
            <div className="console-readout">
              <p>INDEX ONLINE · CURATED PROJECT SIGNALS</p>
              <strong>45<span>_</span></strong>
            </div>
            <div className="console-foot"><span>15 ROM HACKS</span><span>30 RECOMP MODS</span><span>PERMISSION FIRST</span></div>
          </div>
          <div className="mods-copy">
            <div className="section-label"><span>02</span> MOD LIBRARY</div>
            <h2 id="mods-title">Mods, right where you play.</h2>
            <p>
              Browse compatible Gen 1 and Gen 2 recomp mods in the Phosphor Library. Downloads show up when the creator allows sharing and the file passes our checks.
            </p>
            <ul>
              <li><span>✓</span> Made for Gen 1 and Gen 2 recomp</li>
              <li><span>✓</span> Patches and mods only. Never ROMs.</li>
              <li><span>✓</span> Checked files with clear credits</li>
            </ul>
            <a className="text-action" href="library.html">Browse the Phosphor Library <Arrow /></a>
          </div>
        </section>

        <section className="screens-section" id="screens" aria-labelledby="screens-title">
          <div className="screens-heading section-shell">
            <div>
              <div className="section-label"><span>03</span> INSIDE THE CABINET</div>
              <h2 id="screens-title">See it in action.<br /><span>Glow and all.</span></h2>
            </div>
            <p>Real screens from the app. Swipe through them on mobile.</p>
          </div>
          <div className="screenshot-rail" role="list" aria-label="Phosphor app screenshots">
            {screenshots.map((shot, index) => (
              <figure className={index === 0 ? "screen-card screen-card-featured" : "screen-card"} role="listitem" key={shot.src}>
                <div><img src={shot.src} alt={`${shot.label} screen in Phosphor Emulator`} loading={index < 2 ? "eager" : "lazy"} /></div>
                <figcaption><span>0{index + 1}</span><strong>{shot.label}</strong><small>{shot.detail}</small></figcaption>
              </figure>
            ))}
          </div>
        </section>

        <section className="how-section section-shell" id="how-it-works" aria-labelledby="how-title">
          <div className="how-copy">
            <div className="section-label"><span>04</span> THREE STEPS</div>
            <h2 id="how-title">Three steps.<br />Then game on.</h2>
            <p>Phosphor does not include games. Start with compatible files from your own legally obtained collection.</p>
          </div>
          <ol className="how-steps">
            <li><span>01</span><div><strong>Get Phosphor</strong><p>One app for iPhone, iPad, Mac, and Apple Watch.</p></div></li>
            <li><span>02</span><div><strong>Add your games</strong><p>Import compatible .gb, .gbc, or .gba files with Files, iCloud Drive, or AirDrop.</p></div></li>
            <li><span>03</span><div><strong>Press start</strong><p>Pick a game, sync your saves, and make it yours.</p></div></li>
          </ol>
        </section>

        <section className="final-cta section-shell" aria-labelledby="cta-title">
          <img src="assets/phosphor/app-icon.png" alt="Phosphor Emulator app icon" />
          <div>
            <p className="home-eyebrow">FREE ON THE APP STORE</p>
            <h2 id="cta-title">Your old favorites<br /><span>look good in this light.</span></h2>
          </div>
          <a className="primary-action" href={appStoreUrl} target="_blank" rel="noreferrer">
            <span><small>DOWNLOAD ON THE</small>App Store</span><Arrow />
          </a>
        </section>
      </main>

      <footer className="home-footer section-shell">
        <div className="home-footer-top">
          <a className="home-brand" href="#top"><img src="assets/phosphor/app-icon.png" alt="" /><span>phosphor<i>_</i></span></a>
          <p>Game Boy on Apple, with better controls and just enough glow.</p>
          <div><a href={appStoreUrl}>App Store</a><a href="library.html">Mod library</a><a href="https://www.squatchcraft.com/phosphor.html">SquatchCraft</a></div>
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

export default HomeApp;
