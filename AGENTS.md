# Working on MarkCopy

MarkCopy is a TypeScript VS Code extension with separate extension-host and
browser webview bundles. Read [CONTRIBUTING](.github/CONTRIBUTING.md) for setup
and [ARCHITECTURE](docs/ARCHITECTURE.md) before changing a feature's host/webview
boundary.

## Code and assets

- `src/extension.ts` owns activation, Markdown/CSV preview lifecycle, and export
  orchestration. Other preview providers live beside it in `src/`.
- `src/webview/` contains browser behavior. `src/previewShell.ts` provides the
  shared Markdown/CSV/Excel shell; PDF, STL, and video have separate viewers.
- `src/xlsx/` reads workbooks; `src/docx/` builds Word documents.
- Edit source files and `media/preview.css`, not generated bundles. `esbuild.js`
  builds the host; `esbuild.web.js` builds webviews and copies KaTeX assets.
- Keep `vscode` external to the host bundle. Preserve CSP, sanitization, and
  host-side validation of webview messages. See [SECURITY](.github/SECURITY.md).

## Validation

- Use `npm ci` for a reproducible install. Change the manifest and lockfile
  together when updating dependencies.
- For code changes, run `npm run lint`, `npm run format:check`, `npm test`, and
  `npm run compile`. Compilation includes type-checking.
- Run `npm run test:integration` for host or manifest changes. On Linux, use
  `xvfb-run -a npm run test:integration` for a virtual display.
- For documentation-only changes, check formatting and local links; a manual
  extension-host run is unnecessary unless the change needs behavior verification.
- Use [TESTING](docs/TESTING.md) for manual coverage of canvas, media playback,
  theme legibility, and paste targets. Automated tests do not prove these work.

## Dependency compatibility

CI uses Node 20, and `engines.vscode` currently starts at VS Code 1.90. Keep
`@types/node` on the host's supported major and `@types/vscode` aligned with the
engine floor. Review `.github/dependabot.yml` before upgrading TypeScript,
jsdom, or Vitest across majors. Do not bypass dependency conflicts with
`--force` or `--legacy-peer-deps`.

The scoped test CLI overrides are documented in [SECURITY](.github/SECURITY.md).
Check `npm audit` after dependency changes and verify both build and integration
CI before merging them.

## Documentation and releases

- Use `rg` for searches and never use em dashes in text or comments.
- Update [COPY-MATRIX](docs/COPY-MATRIX.md) when copy actions or formats change.
  Keep the README, architecture, testing guide, and changelog aligned with
  substantive behavior changes. Record measured results, not assumed coverage.
- Follow [RELEASING](docs/RELEASING.md) for releases. Tag the complete release
  commit after updating the changelog, and publish the smoke-tested VSIX to
  both registries. A push or tag alone does not publish the extension.
- Keep credentials, local configuration, and generated artifacts out of
  commits. Do not add AI authorship trailers or AI session links to published
  commits, PRs, issues, or documentation.
