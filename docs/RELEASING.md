# Releasing MarkCopy

How to cut a release and publish to both the VS Code Marketplace and Open VSX. This happens in **two separate phases**: cutting the release in git, and publishing to the registries. They are not the same step (see [Release steps](#release-steps)).

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

## Pre-release checklist

Everything here happens **before** Phase 1 below; nothing in it is destructive, so it can be redone freely until it all passes.

- [ ] `main` is green in CI and your working tree is clean (`git status`).
- [ ] The local gate passes: `npm run lint && npm test && npm run format:check && npm run compile`. (`npm test` is the unit suite and the webview E2E suite together.)
- [ ] Integration tests pass: `npm run test:integration` (on Linux: `xvfb-run -a npm run test:integration`).
- [ ] The manual pass in [docs/TESTING.md](TESTING.md) is done: the ★ smoke rows plus the sections a change touched for a **patch**, the full checklist (including the paste-target pass) for a **minor or major**. Rows marked ☑ are covered by the two commands above and want a glance rather than a careful pass, provided both actually ran green.
- [ ] [CHANGELOG.md](../CHANGELOG.md) `[Unreleased]` matches what actually shipped since the last tag (`git log v<last>..HEAD --oneline` is the ground truth), and user-facing changes are reflected in [README.md](../README.md) and `docs/`.
- [ ] If visuals changed, assets are regenerated and committed: `npm run icon` and `npm run screenshot`.
- [ ] The version bump you intend (patch / minor / major) matches the changelog contents.

## Release steps

Releasing has **two phases**, and it is easy to think you are done after the first. **Phase 1 puts the release in git; Phase 2 is what actually ships it to users.** Pushing a commit or tag does **not** publish anything: there is no CI automation for publishing (`.github/workflows/ci.yml` only builds and tests), so the extension stays at whatever version is currently live on the Marketplace / Open VSX until you run the Phase 2 `publish:` commands by hand. Confirm what is actually live at any time with:

```bash
npx vsce show OwenPKent.markcopy                       # Marketplace
curl -s https://open-vsx.org/api/OwenPKent/markcopy    # Open VSX (see .version)
```

### Phase 1: cut the release in git

1. Start from a clean `main` with green CI and the [pre-release checklist](#pre-release-checklist) done.
2. Bump the version: `npm version patch` (or `minor` / `major`). This updates `package.json` and `package-lock.json`; it also creates a git tag unless you pass `--no-git-tag-version` (useful when you want to tag by hand after the changelog edit).
3. Update [CHANGELOG.md](../CHANGELOG.md): move the `[Unreleased]` entries under a new `[x.y.z] - YYYY-MM-DD` heading and refresh the compare links.
4. Sanity checks: `npm run lint && npm test && npm run format:check && npm run compile`. (CI runs these too, including `prettier --check .` over Markdown, but they are fast locally.)
5. If visuals changed, regenerate assets: `npm run icon` and `npm run screenshot`.
6. Commit, tag, and push:
   ```bash
   git add -A && git commit -m "chore: release x.y.z"
   git tag -a vx.y.z -m vx.y.z   # skip if `npm version` already created the tag
   git push --follow-tags
   ```
   The release now exists in git, but **it is not published**. Nothing is live to users yet.

### Phase 2: publish to the registries

7. Package and smoke-test:
   ```bash
   npm run vsix
   code --install-extension markcopy-<version>.vsix
   ```
   Open a Markdown file, a CSV, and a PDF; confirm the preview, a couple of copy actions, one CSV cell edit, and light/dark. This is a quick re-check of the packaged artifact, not the full manual pass: that already happened in the [pre-release checklist](#pre-release-checklist) (the ★ rows in [docs/TESTING.md](TESTING.md) are the minimum here).
8. Load your tokens (see [Publishing secrets](#publishing-secrets-env)): `set -a; source .env; set +a` (PowerShell users: use the loader in that section).
9. Publish to the Marketplace: `npm run publish:vsce` (reads `VSCE_PAT`; or pass `-- -p <PAT>` inline). The public listing page can 404 for a few minutes to an hour after a publish while it indexes; that is normal, and the version is live once `npx vsce show OwenPKent.markcopy` reports it.
10. Publish to Open VSX: `npm run publish:ovsx` (reads `OVSX_PAT`; or `npx ovsx publish markcopy-<version>.vsix -p <OVSX_TOKEN>`).
11. Cut the GitHub release from the pushed tag, attaching the packaged `.vsix`:
    ```bash
    gh release create v<version> markcopy-<version>.vsix --notes-from-tag
    ```
12. Verify both registries show the new version (Phase 2 is done only when both report it):
    ```bash
    npx vsce show OwenPKent.markcopy
    curl -s https://open-vsx.org/api/OwenPKent/markcopy
    ```

## Notes

- `vscode:prepublish` runs `npm run package` automatically, so `vsce`/`ovsx` always ship a fresh production build.
- The Marketplace and Open VSX both sign extensions server-side on publish; there is no publisher-managed signing key to configure.
- Both registries require a token for this MSA-owned publisher: a Marketplace **PAT** for VS Code and an **Open VSX token** for Open VSX. Keep both out of git via a local `.env` (see [Publishing secrets](#publishing-secrets-env)); `.env` is gitignored and `.vscodeignore` keeps it out of the `.vsix`.
- Truly token-free (Entra ID / OIDC) publishing would require moving the publisher to an organizational Entra tenant with a service principal added as a publisher member. Not worth it for a solo publisher; revisit only if this becomes a CI pipeline.
