# Releasing MarkCopy

How to cut a release and publish to both the VS Code Marketplace and Open VSX.

## One-time setup

### VS Code Marketplace (publisher `OwenPKent`)

First create the publisher (needed either way):

1. Create the publisher at <https://marketplace.visualstudio.com/manage>. The publisher **ID must equal** `package.json` → `publisher` (`OwenPKent`).

Then authenticate `vsce` with a **Personal Access Token (PAT)**. This publisher is owned by a **personal Microsoft account (MSA)** (`owen.p.kent@gmail.com`), so a PAT is the only working method (the token-free Entra path is rejected; see the warning below).

2. Create an Azure DevOps organization, signed in as the **same account that owns the publisher**. Go to <https://aex.dev.azure.com> → **Create new organization** (accept the defaults; the org name and any project are irrelevant). Note: plain <https://dev.azure.com> often redirects a fresh account to the marketing page and `dev.azure.com/_usersSettings/tokens` 404s until an org exists; `aex.dev.azure.com` is the reliable entry point.
3. Create the PAT: in Azure DevOps, **User Settings** (the gear icon top-right, _not_ the avatar) → **Personal access tokens** → **New Token**. Set **Organization = All accessible organizations**, then click **Show all scopes** and check **Marketplace → Manage**. Create it and copy the token (shown once).
4. Publish with the PAT at release time: `npm run publish:vsce -- -p <PAT>`, or store it once with `npx vsce login OwenPKent` and then just `npm run publish:vsce`.

> ⚠️ **The Entra ID / `--azure-credential` path does NOT work for this publisher (do not waste time on it).** `az login` + `npm run publish:vsce:azure` (and even a hand-minted `az account get-access-token` used as a `--pat`) fail with `InvalidAccessException: "The requested operation is not allowed."`, even with `az login` done and the account as publisher **Owner**. That path requires an _organizational_ Entra identity added to the publisher as a member; a personal MSA and its auto-created "Default Directory" tenant are rejected. This is a known, unresolved vsce limitation ([microsoft/vscode-vsce#976](https://github.com/microsoft/vscode-vsce/issues/976)). The `publish:vsce:azure` script is kept only for a possible future move to a real Entra org tenant.

### Open VSX (for Cursor / VSCodium / Windsurf)

1. Sign in at <https://open-vsx.org> with **GitHub**.
2. **Sign the Eclipse Foundation Publisher Agreement**: avatar → **Settings** → sign the agreement. This is the #1 gotcha; publishing fails until it is signed.
3. Create an access token: avatar → **Settings** → **Access Tokens** → **Generate new token**. Copy it (shown once).
4. Create the namespace once (must match the publisher): `npx ovsx create-namespace OwenPKent -p <OVSX_TOKEN>`. (If it already exists, skip.)

> Open VSX only supports token auth: there is no Entra/OIDC option, so a token is always required here.

### Verified publisher badge (optional)

**VS Code Marketplace**: on <https://marketplace.visualstudio.com/manage>, open the publisher and start **domain verification**: add the DNS TXT record it shows to a domain you control. Once verified, the listing gets the blue verified checkmark.

**Open VSX**: verification means claiming ownership of the namespace. File a public issue on [EclipseFdn/open-vsx.org](https://github.com/EclipseFdn/open-vsx.org/issues) using the **"Claim namespace ownership"** template. The strongest evidence tier (Option 1) applies here: the namespace is also a VS Code Marketplace publisher, and the published extension's `package.json` repo is owned by the requesting GitHub account. An Eclipse Foundation admin reviews the issue and tags it `granted`, after which the verified checkmark appears on the listing and namespace members can be managed from the open-vsx.org profile. The claim for `OwenPKent` was filed 2026-07-19 as [EclipseFdn/open-vsx.org#11947](https://github.com/EclipseFdn/open-vsx.org/issues/11947).

## Publishing secrets (`.env`)

Both registries need a token (see [One-time setup](#one-time-setup) for how to mint them). The simplest, repeatable way to hold them is a local `.env` file: `vsce` reads `VSCE_PAT` and `ovsx` reads `OVSX_PAT` from the environment automatically, so once `.env` is loaded the publish commands take no extra flags.

1. Create your `.env` once from the template and paste in the two tokens:
   ```bash
   cp .env.example .env
   # then edit .env and set VSCE_PAT= and OVSX_PAT=
   ```
   `.env` is gitignored (`.env.example` is the committed template). Real tokens never get committed, and `.vscodeignore` keeps `.env*` out of the packaged `.vsix`.

2. Load `.env` into the shell you will publish from. This has to be re-run in each new shell:
   ```bash
   # Git Bash / macOS / Linux
   set -a; source .env; set +a
   ```
   ```powershell
   # PowerShell
   Get-Content .env | ForEach-Object {
     if ($_ -match '^\s*([^#=]+)=(.*)$') {
       [Environment]::SetEnvironmentVariable($matches[1].Trim(), $matches[2].Trim())
     }
   }
   ```

3. Confirm they are set before publishing:
   ```bash
   # Git Bash: should print non-empty values
   echo "vsce=${VSCE_PAT:+set} ovsx=${OVSX_PAT:+set}"
   ```
   ```powershell
   # PowerShell
   "vsce=$([bool]$env:VSCE_PAT) ovsx=$([bool]$env:OVSX_PAT)"
   ```

With `.env` loaded, the publish steps below are just `npm run publish:vsce` and `npm run publish:ovsx` with no `-p` flag. If you would rather not use a file, pass the token inline instead (`npm run publish:vsce -- -p <PAT>`) or run `vsce login` once; the `.env` flow is only a convenience.

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
7. Load your tokens (see [Publishing secrets](#publishing-secrets-env)): `set -a; source .env; set +a`.
8. Publish to the Marketplace: `npm run publish:vsce` (reads `VSCE_PAT`; or pass `-- -p <PAT>` inline). The public listing page can 404 for a few minutes to an hour after a publish while it indexes; that is normal, and the version is live once `npx vsce show OwenPKent.markcopy` reports it.
9. Publish to Open VSX: `npm run publish:ovsx` (reads `OVSX_PAT`; or `npx ovsx publish markcopy-<version>.vsix -p <OVSX_TOKEN>`).
10. Push the tag and cut a GitHub release:
   ```bash
   git push --follow-tags
   gh release create v<version> --notes-from-tag
   ```

## Notes

- `vscode:prepublish` runs `npm run package` automatically, so `vsce`/`ovsx` always ship a fresh production build.
- The Marketplace and Open VSX both sign extensions server-side on publish; there is no publisher-managed signing key to configure.
- Both registries require a token for this MSA-owned publisher: a Marketplace **PAT** for VS Code and an **Open VSX token** for Open VSX. Keep both out of git via a local `.env` (see [Publishing secrets](#publishing-secrets-env)); `.env` is gitignored and `.vscodeignore` keeps it out of the `.vsix`.
- Truly token-free (Entra ID / OIDC) publishing would require moving the publisher to an organizational Entra tenant with a service principal added as a publisher member. Not worth it for a solo publisher; revisit only if this becomes a CI pipeline.
