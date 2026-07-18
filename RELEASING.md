# Releasing MarkCopy

How to cut a release and publish to both the VS Code Marketplace and Open VSX.

## One-time setup

### VS Code Marketplace (publisher `OwenPKent`)

First create the publisher (needed either way):

1. Create the publisher at <https://marketplace.visualstudio.com/manage>. The publisher **ID must equal** `package.json` → `publisher` (`OwenPKent`).

Then pick an authentication method. **Entra ID (preferred — no stored token):**

2. Sign in to Azure locally: `az login` (install the Azure CLI first if needed).
3. Add your Entra identity as a **member** of the `OwenPKent` publisher at <https://marketplace.visualstudio.com/manage> → publisher → **Members**. This is what lets your `az login` account publish.
4. Nothing to store. At release time, publish with `npm run publish:vsce:azure` (see below). `vsce` fetches a short-lived Entra token via `DefaultAzureCredential` — no PAT to keep or rotate.

**PAT (fallback / simplest):**

2. Create an Azure DevOps organization at <https://dev.azure.com>.
3. Create a Personal Access Token (PAT): avatar → **Personal access tokens** → **New Token**, Organization = **All accessible organizations**, Scope = **Marketplace → Manage**. Copy it.
4. Authenticate `vsce` once: `npx vsce login OwenPKent` (paste the PAT).

> Azure is retiring global PATs (around Dec 2026) in favor of Entra ID, so the Entra path is where this is heading. Open VSX (below) still only supports a token — Entra is not an option there.

### Open VSX (for Cursor / VSCodium / Windsurf)

1. Sign in at <https://open-vsx.org> with GitHub and create an access token (user settings).
2. Create the namespace once (must match the publisher): `npx ovsx create-namespace OwenPKent -p <OVSX_TOKEN>`.

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
7. Publish to the Marketplace:
   - Entra ID (preferred): `az login` if your session is stale, then `npm run publish:vsce:azure`.
   - PAT: `npm run publish:vsce` (or `npx vsce publish -p <PAT>`).
8. Publish to Open VSX: `npx ovsx publish -p <OVSX_TOKEN>` (or set `OVSX_PAT` and run `npm run publish:ovsx`).
9. Push the tag and cut a GitHub release:
   ```bash
   git push --follow-tags
   gh release create v<version> --notes-from-tag
   ```

## Notes

- `vscode:prepublish` runs `npm run package` automatically, so `vsce`/`ovsx` always ship a fresh production build.
- The Marketplace and Open VSX both sign extensions server-side on publish; there is no publisher-managed signing key to configure.
- Prefer the Entra ID publish path (`npm run publish:vsce:azure`) so no long-lived token lives on disk. Open VSX still needs a token — keep it out of git via `OVSX_PAT` or `-p` at publish time.
- For automated releases, `--azure-credential` also works with a service principal (env-var credentials) or GitHub Actions OIDC federation, giving a fully secretless CI publish.
