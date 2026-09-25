const appStoreUrl = "https://apps.apple.com/us/app/phosphor-emulator/id6759676286";

function PrivacyApp() {
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
          <a href="licenses.html">Licenses</a>
        </nav>
        <span />
      </header>

      <main className="legal-main">
        <p className="home-eyebrow legal-kicker">LEGAL</p>
        <h1>Privacy Policy</h1>

        <h2>Phosphor doesn&apos;t collect any data.</h2>
        <p>
          No accounts, no analytics, no ads, no tracking. Nothing you do in Phosphor is sent to
          us. Your games, saves and settings stay on your device, or in your own iCloud if you
          turn on sync.
        </p>

        <h2>RetroAchievements (optional)</h2>
        <p>
          RetroAchievements is a separate service with its own terms and privacy policy (
          <a href="https://retroachievements.org/terms">https://retroachievements.org/terms</a>).
          If you choose to sign in, Phosphor connects your device directly to
          RetroAchievements:
        </p>
        <ul>
          <li>
            Your username and password go straight to RetroAchievements to sign you in.
            Phosphor never stores your password. It keeps only the sign-in token
            RetroAchievements sends back, in your device&apos;s Keychain, and deletes it when
            you sign out.
          </li>
          <li>
            While you play a supported game, Phosphor sends RetroAchievements a fingerprint of
            the game (a hash, not the game itself), the achievements and leaderboard scores you
            earn, and a short status line about where you are in the game.
          </li>
        </ul>
        <p>None of this passes through us, and we can&apos;t see it. If you never sign in, nothing is sent.</p>

        <h2>Other connections</h2>
        <ul>
          <li>
            The mod list, mods and engine updates download from phosphoremulator.com and
            GitHub, and a few mod preview images come from Imgur. Like any website, those
            servers see your IP address when you download. We receive no logs.
          </li>
          <li>iCloud sync, if you turn it on, keeps your saves in your own iCloud Drive. Apple stores them. We can&apos;t access them.</li>
          <li>Friend Trade sends the Pokémon you choose straight to your friend&apos;s phone over your local Wi-Fi.</li>
        </ul>

        <h2>Retention, servers and your rights</h2>
        <ul>
          <li>Retention: we keep no data about you, because we never receive any.</li>
          <li>Servers: we run no servers that receive your data. Downloads are served by GitHub (United States).</li>
          <li>
            GDPR, CCPA and similar laws: we hold nothing about you, so there is nothing for us
            to access, export or delete. To manage or delete your RetroAchievements data, use
            your RetroAchievements account or contact them.
          </li>
        </ul>

        <p>Phosphor is free. There are no in-app purchases and no paid features.</p>

        <p className="legal-foot-note">Last updated: September 24, 2026. SquatchCraft LLC.</p>
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

export default PrivacyApp;
