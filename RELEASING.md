# Releasing MarkCopy

How to cut a release and publish to both the VS Code Marketplace and Open VSX.

## One-time setup

### VS Code Marketplace (publisher `OwenPKent`)

First create the publisher (needed either way):

1. Create the publisher at <https://marketplace.visualstudio.com/manage>. The publisher **ID must equal** `package.json` → `publisher` (`OwenPKent`).

Then authenticate `vsce` with a **Personal Access Token (PAT)**. This publisher is owned by a **personal Microsoft account (MSA)** (`owen.p.kent@gmail.com`), so a PAT is the only working method — the token-free Entra path is rejected (see the warning below).

2. Create an Azure DevOps organization, signed in as the **same account that owns the publisher**. Go to <https://aex.dev.azure.com> → **Create new organization** (accept the defaults; the org name and any project are irrelevant). Note: plain <https://dev.azure.com> often redirects a fresh account to the marketing page and `dev.azure.com/_usersSettings/tokens` 404s until an org exists — `aex.dev.azure.com` is the reliable entry point.
3. Create the PAT: in Azure DevOps, **User Settings** (the gear icon top-right, _not_ the avatar) → **Personal access tokens** → **New Token**. Set **Organization = All accessible organizations**, then click **Show all scopes** and check **Marketplace → Manage**. Create it and copy the token (shown once).
4. Publish with the PAT at release time: `npm run publish:vsce -- -p <PAT>`, or store it once with `npx vsce login OwenPKent` and then just `npm run publish:vsce`.

> ⚠️ **The Entra ID / `--azure-credential` path does NOT work for this publisher — do not waste time on it.** `az login` + `npm run publish:vsce:azure` (and even a hand-minted `az account get-access-token` used as a `--pat`) fail with `InvalidAccessException: "The requested operation is not allowed."`, even with `az login` done and the account as publisher **Owner**. That path requires an _organizational_ Entra identity added to the publisher as a member; a personal MSA and its auto-created "Default Directory" tenant are rejected. This is a known, unresolved vsce limitation ([microsoft/vscode-vsce#976](https://github.com/microsoft/vscode-vsce/issues/976)). The `publish:vsce:azure` script is kept only for a possible future move to a real Entra org tenant.

### Open VSX (for Cursor / VSCodium / Windsurf)

1. Sign in at <https://open-vsx.org> with **GitHub**.
2. **Sign the Eclipse Foundation Publisher Agreement**: avatar → **Settings** → sign the agreement. This is the #1 gotcha — publishing fails until it is signed.
3. Create an access token: avatar → **Settings** → **Access Tokens** → **Generate new token**. Copy it (shown once).
4. Create the namespace once (must match the publisher): `npx ovsx create-namespace OwenPKent -p <OVSX_TOKEN>`. (If it already exists, skip.)

> Open VSX only supports token auth — there is no Entra/OIDC option, so a token is always required here.

### Verified publisher badge (optional)

On <https://marketplace.visualstudio.com/manage>, open the publisher and start **domain verification**: add the DNS TXT record it shows to a domain you control. Once verified, the listing gets the blue verified checkmark.

## Release steps

1. Start from a clean `main` with green CI.
2. Bump the version: `npm version patch` (or `minor` / `major`). This updates `package.json` and creates a git tag.
3. Update [CHANGELOG.md](CHANGELOG.md): move the `[Unreleased]` entries under a new `[x.y.z] - YYYY-MM-DD` heading and refresh the compare links.
4. Sanity checks: `npm run lint && npm test && npm run compile`. (CI covers this, but it is fast locally.)
5. If visuals changed, regenerate assets: `npm run icon` and `npm run screenshot`.
6. Package and smoke-test:
   ```bash
   npm run vsix
   code --install-extension markcopy-<version>.vsix
   ```
   Open a Markdown file and a PDF; confirm the preview, a couple of copy actions, and light/dark.
7. Publish to the Marketplace with your PAT: `npm run publish:vsce -- -p <PAT>` (or `npm run publish:vsce` if you ran `vsce login`). The public listing page can 404 for a few minutes to an hour after a publish while it indexes — that is normal; the version is live once `npx vsce show OwenPKent.markcopy` reports it.
8. Publish to Open VSX from the built VSIX: `npx ovsx publish markcopy-<version>.vsix -p <OVSX_TOKEN>` (or set `OVSX_PAT` and run `npm run publish:ovsx`).
9. Push the tag and cut a GitHub release:
   ```bash
   git push --follow-tags
   gh release create v<version> --notes-from-tag
   ```

## Notes

- `vscode:prepublish` runs `npm run package` automatically, so `vsce`/`ovsx` always ship a fresh production build.
- The Marketplace and Open VSX both sign extensions server-side on publish; there is no publisher-managed signing key to configure.
- Both registries require a token for this MSA-owned publisher: a Marketplace **PAT** for VS Code and an **Open VSX token** for Open VSX. Keep both out of git — pass `-p` at publish time, or use `vsce login` / the `OVSX_PAT` env var.
- Truly token-free (Entra ID / OIDC) publishing would require moving the publisher to an organizational Entra tenant with a service principal added as a publisher member. Not worth it for a solo publisher; revisit only if this becomes a CI pipeline.
