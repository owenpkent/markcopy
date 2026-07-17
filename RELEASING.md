# Releasing MarkCopy

How to cut a release and publish to both the VS Code Marketplace and Open VSX.

## One-time setup

### VS Code Marketplace (publisher `OwenPKent`)

1. Create an Azure DevOps organization at <https://dev.azure.com>.
2. Create a Personal Access Token (PAT): avatar → **Personal access tokens** → **New Token**, Organization = **All accessible organizations**, Scope = **Marketplace → Manage**. Copy it.
3. Create the publisher at <https://marketplace.visualstudio.com/manage>. The publisher **ID must equal** `package.json` → `publisher` (`OwenPKent`).
4. Authenticate `vsce` once: `npx vsce login OwenPKent` (paste the PAT).

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
7. Publish to the Marketplace: `npm run publish:vsce` (or `npx vsce publish -p <PAT>`).
8. Publish to Open VSX: `npx ovsx publish -p <OVSX_TOKEN>` (or set `OVSX_PAT` and run `npm run publish:ovsx`).
9. Push the tag and cut a GitHub release:
   ```bash
   git push --follow-tags
   gh release create v<version> --notes-from-tag
   ```

## Notes

- `vscode:prepublish` runs `npm run package` automatically, so `vsce`/`ovsx` always ship a fresh production build.
- Keep tokens out of git. Use `vsce login` / `OVSX_PAT`, or pass `-p` at publish time.
- Azure DevOps is retiring global PATs (around Dec 2026) in favor of Microsoft Entra ID; the PAT flow still works today, and `vsce` supports Entra ID tokens when you switch.
