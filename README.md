# Phosphor Emulator website

The root page is the public home for Phosphor Emulator. The permission-first
ROM-hack and recomp-mod catalog remains available at `library.html`.

Phosphor Index is a static catalog for redistributable Pokémon ROM-hack patch
files and Gen 1/Gen 2 recomp mods. It does **not** host commercial ROM images.

The site is intentionally data-first: every public release must pass the
checks in `scripts/validate-catalog.mjs`, including a public permission source,
SHA-256 checksum, and `containsRom: false` declaration.

## Local development

```bash
npm install
npm run dev
```

Run `npm test` to validate catalog policy and `npm run build` to make the static
site in `dist/`.

## Private permission desk

The local-only Permission Desk tracks creator outreach without putting private
correspondence or email credentials in the public GitHub Pages bundle. Start the
development server and open `http://localhost:5173/desk.html`, or run:

```bash
npm run dev:desk
```

The desk prepares an explicit redistribution request, opens it in the default
mail client, stores pasted replies and approved scope in browser storage, and
exports private JSON backups. Run `npm run build:desk` for a separate build in
`desk-dist/`; the normal `npm run build` does not publish the desk.

Browser storage is device-local and is not encrypted. Export backups regularly
and keep them private. Automatic inbox syncing requires a private authenticated
backend with the email provider's OAuth flow; credentials must never be added to
the static site.

## Publishing

The workflow at `.github/workflows/pages.yml` builds and publishes both pages to
GitHub Pages whenever `main` or `master` is updated. In the repository settings, set Pages
to use **GitHub Actions** as its source.

See [CONTRIBUTING.md](CONTRIBUTING.md) and [CATALOG_POLICY.md](CATALOG_POLICY.md)
before proposing a release.

## Email-assisted review

The **Add release** link opens the repository's structured issue form after the
site is deployed on GitHub Pages. The review workflow assigns that issue to the
repository owner, which produces a normal GitHub email notification when email
notifications are enabled.

The owner can comment on the issue or reply to the notification email with:

- `/approve` to download and verify the ZIP, add the catalog record, and start
  a Pages deployment.
- `/deny reason` to close the submission with a message explaining why.

Both decisions add a comment to the issue, so the requester receives GitHub's
normal notification. Approval is intentionally limited to ZIP mod archives;
ROM-hack patches remain a manual rights review.
