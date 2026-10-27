# Fonts for the video review panel

Roboto (400, 500), Roboto Condensed (700) and Roboto Mono (400, 500), from
https://github.com/alexchunlin/alex-style-guide at commit d1f744f (`fonts/`).
Licensed under the SIL Open Font License 1.1 (see OFL.txt).

Each file is the original TTF subset to Latin (U+0000-00FF, U+2000-206F, U+20AC,
U+2190-21FF, U+25A0-25FF) and converted to WOFF2 with fonttools `pyftsubset`.
They are referenced by `@font-face` in `media/preview.css` and need
`font-src ${webview.cspSource}` in the video viewer's CSP.
