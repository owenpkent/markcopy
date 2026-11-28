# Cryptographic layer and JS/TS/WASM libraries for an encrypt-then-embed steganography feature (as of late Nov 2026)

Scope note: stego theory, steganalysis and products are covered by other notes. Research budget was limited, so several items are listed under Gaps rather than guessed. Facts marked "page did not state" were not on the fetched page.

## 1. Passphrase KDF: Argon2id, scrypt, PBKDF2 values and libraries

### Takeaway

Use Argon2id with RFC 9106 SECOND RECOMMENDED (t=3, p=4, m=64 MiB) or at least the OWASP minimum (m=19 MiB, t=2, p=1), with a random 128-bit salt stored inside the payload. For a stack that must run in Node 20 and in webviews, hash-wasm (WASM Argon2, 11 kB gz) is the practical choice; node:crypto argon2 only exists from Node 24.7.0, and noble's JS argon2 is unaudited and slow. scrypt and PBKDF2 are the fallbacks.

### Cited Findings

- OWASP Password Storage Cheat Sheet, Argon2id minimum: m=19456 KiB (19 MiB), t=2, p=1. Equivalent listed configurations: m=47104 (46 MiB) t=1 p=1; m=12288 (12 MiB) t=3 p=1; m=9216 (9 MiB) t=4 p=1; m=7168 (7 MiB) t=5 p=1 — [OWASP](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)
- OWASP scrypt (when Argon2id unavailable): minimum N=2^17 (128 MiB), r=8, p=1; alternatives N=2^16 p=2, N=2^15 p=3, N=2^14 p=5, N=2^13 p=10 (all r=8) — [OWASP](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)
- OWASP PBKDF2-HMAC-SHA256: 600,000 iterations (also the FIPS-140 setting) — [OWASP](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)
- RFC 9106 section 4 / 7.4: FIRST RECOMMENDED is Argon2id t=1, p=4, m=2^21 KiB (2 GiB), 128-bit salt, 256-bit tag. SECOND RECOMMENDED (low memory) is Argon2id t=3, p=4, m=2^16 KiB (64 MiB), 128-bit salt, 256-bit tag. "A length of 128 bits [salt] is sufficient for most applications, including key derivation" — [RFC 9106](https://www.rfc-editor.org/rfc/rfc9106.html#section-4)
- Node.js `crypto.argon2(algorithm, parameters, callback)` and `argon2Sync` were added in v24.7.0 (release dated 2025-08-27). Params: message, nonce (min 8 bytes, 16+ random recommended), parallelism, tagLength, memory (KiB blocks), passes; optional secret, associatedData. Algorithms argon2d/argon2i/argon2id. So Node 20 and 22 do NOT have it — [Node docs](https://nodejs.org/api/crypto.html), [Node v24.7.0 notes](https://nodejs.org/en/blog/release/v24.7.0)
- Later Node 24 minors added Argon2 Web Cryptography algorithms (v24.11.0) and fixed Argon2 validation errors/FIPS bypass (v24.20.0), per mirrored release notes (secondary sources) — [Codeberg mirror](https://codeberg.org/woodpecker-plugins/plugin-surge-preview/pulls/188), [GitLab mirror](https://gitlab.com/sylva-projects/sylva-elements/ci-tooling/ci-components/semantic-release/-/merge_requests/5)
- Node `crypto.hkdfSync(digest, ikm, salt, info, keylen)` exists since v15.0.0; info max 1024 bytes; max output 255 x digest size — [Node docs](https://nodejs.org/api/crypto.html)
- Node `crypto.scrypt`/`scryptSync` exist; the defaults (N=16384, r=8, p=1, maxmem 32 MiB) were NOT confirmed on the fetched page (the fetch tool quoted them from general knowledge only) — [Node docs](https://nodejs.org/api/crypto.html)
- @noble/hashes: MIT; exports argon2d/argon2i/argon2id, scrypt, pbkdf2, hkdf (RFC 5869). Argon2 defaults t=3, m=1 GiB, p=1 (maxmem 1 GiB). README: "Argon2 can't be fast in JS, because there is no fast Uint64Array", about 5x slower than native, suggests scrypt instead. Benchmark (Apple M4): argon2id t=1 m=128 MB about 276 ms; scrypt N=2^16 about 0.1 s and 64 MB; scrypt N=2^19 r=8 about 751 ms; pbkdf2-sha256 c=2^18 about 199 ms. sha256 module 2.8 kB gz — [noble-hashes](https://github.com/paulmillr/noble-hashes)
- noble-hashes audit: Cure53, v1.0.0, Jan 2022 (Ethereum Foundation funded); the audit excluded blake3, sha3-addons, sha1 and argon2, so argon2 is unaudited. Maintainer reports AI-assisted self-audits since April 2026. v2 requires Node 20.19+ and is ESM-only; v1 supports Node 14.21+ and CJS — [noble-hashes](https://github.com/paulmillr/noble-hashes)
- hash-wasm: argon2d/i/id (v1.3) with options password, salt, secret, iterations, parallelism, memorySize (KiB), hashLength, outputType; also argon2Verify. gzipped sizes: Argon2 11 kB, scrypt 10 kB, SHA-256 7 kB, BLAKE2b 6 kB; HMAC/PBKDF2 listed without size. Supports Chrome 57+, Safari 11+, Firefox 53+, Node 8+, Deno 1+. Benchmarks cite v4.10.0 (not confirmed as current). No third-party audit mentioned. Licence text was not on the fetched page (not confirmed here; check LICENSE before shipping) — [hash-wasm](https://github.com/Daninet/hash-wasm)

### Inferences

- Single recommended spec for the feature: Argon2id, m=65536 KiB, t=3, p=4 (RFC 9106 second option), 16-byte random salt, 32-byte output, then HKDF-SHA256 (or noble `hkdf`) to split into separate AEAD key, position-permutation seed, and padding/bucket keys with distinct `info` labels. Memory 64 MiB is safe in a webview/WASM; p=4 only helps if the WASM build is multithreaded (hash-wasm planned multithreading per its README "Future plans" but it is not stated as shipped), so effective cost on one thread is the same memory with 4x serial lanes. If single-threaded cost is too slow, fall back to OWASP t=2, m=19 MiB, p=1.
- Because the KDF parameters must not be visible in a no-header payload, they must be fixed constants of the format version (or recovered by trial), not stored in plaintext.
- Since Node 24.7+ is not guaranteed in the VS Code extension host (the task states Node 20), do all KDF work in one WASM library (hash-wasm) shared by host and webview so output is identical.

### Gaps

- Exact current versions (as of Nov 2026) of hash-wasm, @noble/hashes, @noble/ciphers were not retrievable from the pages fetched (no npm page fetched).
- hash-wasm licence type not verified.
- argon2-browser was not researched (the WASM Argon2 reference build); not assessed for maintenance.
- Node scrypt defaults not confirmed from the docs page.
- Which Node major the current VS Code extension host ships in Nov 2026 was not looked up.

## 2. AEAD: AES-256-GCM, XChaCha20-Poly1305, WebCrypto availability, nonces

### Takeaway

XChaCha20-Poly1305 from @noble/ciphers (audited, 24-byte nonce) is the safest default for random nonces and works identically in Node and webviews. AES-256-GCM via WebCrypto/node:crypto is acceptable but with a 12-byte random nonce it has collision limits. Webview secure-context status for `crypto.subtle` was NOT officially confirmed.

### Cited Findings

- @noble/ciphers: MIT; XChaCha20-Poly1305 (`xchacha20poly1305`, 24-byte nonce, 16-byte tag); README: "We suggest to use XChaCha20-Poly1305 because it's very fast and allows random nonces." ChaCha about 3 kB gz; zero runtime dependencies; signed commits and trusted-publishing releases — [noble-ciphers](https://github.com/paulmillr/noble-ciphers)
- noble-ciphers audit: Cure53 audited v1.0.0 in September 2024 (OpenSats funded), everything in scope; AI-assisted self-audits since April 2026. v2: Node 20.19+, ESM-only; v1: Node 14.21+, ESM and CJS — [noble-ciphers](https://github.com/paulmillr/noble-ciphers)
- noble-ciphers AES-GCM: 12-byte nonce; README states about 68 GB max message and 2^32.5 messages per key; random 96-bit nonces carry a collision risk it calls too high; recommends 192-bit nonce algorithms (XChaCha, XSalsa, AES-SIV) for random nonces or key rotation. Its pure-JS AES-GCM is much slower than WebCrypto's (about 95 MiB/s at 1 MB on M4) — [noble-ciphers](https://github.com/paulmillr/noble-ciphers)
- Node `crypto` supports `chacha20-poly1305` (12-byte nonce) among AEAD modes; the fetched page did not mention XChaCha20 — [Node docs](https://nodejs.org/api/crypto.html)
- MDN: Web Crypto is restricted to secure contexts (HTTPS); SubtleCrypto lists AES-GCM/CTR/CBC/KW, ECDSA, ECDH, RSA, HMAC, HKDF, PBKDF2. Argon2 and ChaCha20 are not in the Level 2 list on that page — [MDN Web Crypto API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Crypto_API)
- Evidence on VS Code webviews: a code-server patch to the webview loader throws if `crypto.subtle` is missing ("webviews will not work"), indicating VS Code's own webview host depends on `crypto.subtle`; plain-HTTP non-localhost remote hosts lack it. No official VS Code doc statement that the `vscode-webview` origin is a secure context was found — [code-server webview patch](https://code.morphllm.com/coder/code-server/raw/tag/v4.99.1/patches/webview.diff), [claudeissues report](https://claudeissues.com/issue/88560-bug-vs-code-extension-chat-panel-blank-on-non-secure-http-origins-unguarded-cryp), [VS Code Webview docs](https://code.visualstudio.com/api/extension-guides/webview)

### Inferences

- Pick XChaCha20-Poly1305 (noble) so nonce is random 24 bytes with negligible collision risk; this also avoids depending on `crypto.subtle` in webviews. Doing crypto in the extension host (Node) and passing only bytes to/from webviews is an alternative that sidesteps the webview secure-context question.
- In a no-header design the 24-byte nonce adds 24 bytes of overhead that looks random (good), plus 16-byte tag.

### Gaps

- Whether `window.isSecureContext` is true inside VS Code desktop webviews (and in vscode.dev / code-server) needs a runtime check; no authoritative source found.
- libsodium.js (libsodium-wrappers) not researched (licence ISC, size, maintenance unverified).
- Whether WebCrypto X25519/Ed25519 is available in webviews' Electron Chromium: not verified.

## 3. Making the payload indistinguishable from random

### Takeaway

Design the payload as one blob of uniformly random-looking bytes: salt || nonce || AEAD(ciphertext of [length || data || padding]) with no magic and no plaintext parameters. Public-key mode needs Elligator2-encoded ephemeral keys; noble-curves has no X25519 Elligator2 representative API, and age headers are plainly identifiable.

### Cited Findings

- age format: header starts with the plaintext line `age-encryption.org/v1`; recipient stanzas begin `->` and name types (`X25519`, `scrypt`) in clear; final header line `---` plus base64 HMAC-SHA-256; payload starts with a 16-byte nonce; 64 KiB chunks via ChaCha20-Poly1305. The spec says identifiers in stanzas "sacrifice any chance of ciphertext anonymity and unlinkability" — [age spec C2SP](https://github.com/C2SP/C2SP/blob/main/age.md)
- age scrypt stanza: `scrypt`, 16-byte base64 salt, log2 work factor (spec example 18, no default stated) — [age spec C2SP](https://github.com/C2SP/C2SP/blob/main/age.md)
- typage (`age-encryption` npm): BSD-3-Clause; depends only on noble libs; Web Crypto used when available; Node 20+, Bun, Deno; `setScryptWorkFactor(12)` shown as example. Version and size not stated — [typage](https://github.com/FiloSottile/typage)
- noble-curves: MIT; X25519 `keygen`, `getSharedSecret` (RFC 7748). Audits: v2.3.0 (Aug 2026) Trail of Bits with OpenAI; v1.6.0 Cure53 (Sep 2024); v1.2.0 Kudelski (Sep 2023); v0.7.3 Trail of Bits (Feb 2023). README documents RFC 9380 hash-to-curve but no X25519 Elligator representative encoding; the only Elligator mention is ElligatorSwift (BIP324, secp256k1) in a separate package — [noble-curves](https://github.com/paulmillr/noble-curves)
- Elligator background: roughly half of Curve25519 points have no uniform representative so keygen must retry; private keys must have full entropy because X25519 clamping yields non-uniform representatives (general sources on implementations in Go/Rust, not noble) — [search summary of Go/obfs4 docs](https://pkg.go.dev/github.com/go-i2p/crypto/elligator2), [ImperialViolet Elligator](https://www.imperialviolet.org/2013/12/25/elligator.html)

### Inferences

- Recommended minimal layout (design, not sourced): `salt(16) || nonce(24) || XChaCha20-Poly1305(key_enc, plaintext = len(4) || data || zero padding to bucket)` where total size is rounded to fixed buckets and capacity padding is random. Length lives inside the ciphertext; wrong passphrase gives AEAD failure, which is indistinguishable from "no message here". All needed parameters are format constants.
- Derive embedding permutation seed via HKDF from the Argon2id output with a distinct `info`. Use an independent subkey for stego positions versus encryption.
- Public-key mode is a research risk: to hide the ephemeral key one would need an Elligator2 implementation (Monocypher in C, or WASM-compile it; unverified) since noble-curves lacks it. Passphrase mode should be v1; age as a wrapper is not suitable for covert use because its header is fixed and plaintext.

### Gaps

- Monocypher's Elligator API, version, licence (reportedly public domain/CC0 and BSD-2) and a WASM build were not fetched.
- Whether any npm package implements X25519 Elligator2 was not found.
- Padding-bucket sizing policy: no source; it is a design choice.

## 4. Error correction for lossy channels

### Takeaway

Pure-JS and WASM Reed-Solomon packages exist but are mostly erasure-coding libraries, not byte-error correctors tuned for stego; maintenance is thin. I did not find sourced data on what survives JPEG recompression or chat-app re-encoding.

### Cited Findings

- `@ronomon/reed-solomon` is a native Node addon (MIT), not WASM; Snyk flags it Inactive (no npm releases in 12 months, about 15 weekly downloads) — [Snyk advisor](https://snyk.io/advisor/npm-package/@ronomon/reed-solomon), [search listing](https://www.skypack.dev/view/@ronomon/reed-solomon)
- WASM erasure-coding options: `@subspace/reed-solomon-erasure.wasm` (browser and Node, TS types), `wasm-reed-solomon-erasure` (Rust reed-solomon-erasure compiled to WASM), `@digitaldefiance/reed-solomon-erasure.wasm` — [@subspace readme](https://unpkg.com/@subspace/reed-solomon-erasure.wasm@0.2.5/readme.md), [wasm-reed-solomon-erasure](https://www.npmjs.com/package/wasm-reed-solomon-erasure)
- `reed-solomon` npm: port of Backblaze JavaReedSolomon with optional native binding and JS fallback (erasure coding) — [socket.dev](https://socket.dev/npm/package/reed-solomon/overview/3.0.3)
- conseal (Python) notes its nsF5 "also embeds and extracts real messages with wet-paper codes" — [conseal GitHub](https://github.com/uibk-uncover/conseal)

### Inferences

- Erasure-coding RS libraries (shard-based) need known erasure positions; for a stego channel with random bit/byte errors a classic error-correcting RS(255,k) over GF(256) (Berlekamp-Massey) is what is wanted, and none of the found packages was confirmed to do that. Writing a small RS(255,k) decoder in TS is plausible, but this is unverified engineering judgement.
- The authenticated outer layer should wrap the RS layer: RS encode the ciphertext (so errors are fixed before AEAD verification), which keeps the payload still random-looking because RS parity of random data is random-looking.

### Gaps

- No sourced results on BCH or repetition code libraries in JS.
- No sourced data on survival of spatial LSB or DCT payloads through JPEG recompression, WhatsApp/Telegram/Signal re-encoding; LSB spatial embedding is generally destroyed by re-encoding but no source was fetched here.

## 5. Syndrome-trellis codes and matrix embedding

### Takeaway

No JS/WASM port of STC was found. The Binghamton reference (C++/MATLAB) has no stated licence beyond "available for public use" with a citation request, so it is a reference only. conseal (MPL-2.0, Python with Rust cost backends) does not implement STC, and a Rust STC exists (phasm-core).

### Cited Findings

- Binghamton DDE STC toolbox: C++ and MATLAB implementations, MEX wrappers, multi-layered construction, examples. Page says "This program is available for public use" and asks for credit by citing page or paper; no licence name, redistribution or commercial terms stated — [DDE STC page](https://dde.binghamton.edu/download/syndrome/)
- conseal: MPL-2.0; Python package with Rust backends for HILL, J-UNIWARD, S-UNIWARD, UERD and WOW costs; 13 methods (JPEG: EBS, F5, J-MiPOD, J-UNIWARD, nsF5, UERD; spatial: HILL, HUGO, MiPOD, S-UNIGARD, S-UNIWARD, WOW; LSB). STC is not mentioned. It "simulates the embedding changes", with real embedding and extraction only for nsF5 via wet-paper codes, and is "not a stego system for real-world use" (no encryption, framing or key management) — [conseal GitHub](https://github.com/uibk-uncover/conseal)
- conseal authors: Martin Benes and Benedikt Lorch, University of Innsbruck; J-UNIWARD and nsF5 based on Binghamton MATLAB code; works with jpeglib for DCT access; a paper by Lorch reports an off-by-one error in J-UNIWARD and conseal has both versions — [conseal PyPI/readthedocs search results](https://pypi.org/project/conseal)
- Rust crate `phasm-core` includes an STC module (Filler, Judas, Fridrich 2011 reference; constraint length h typically 7 giving 128 states; Viterbi) — [docs.rs phasm-core](https://docs.rs/phasm-core/0.2.4/phasm_core/stego/stc/)
- `LDPC-JS`: a WASM-compiled LDPC library as a precedent for porting coding C code to WASM — [LDPC-JS](https://www.github.com/danimoh/LDPC-JS)
- My attempt to fetch `pySTC` (martinbenes1996) returned 404; its existence and licence are unverified.

### Inferences

- STC only matters when you have per-element distortion costs (J-UNIWARD style). A simpler first version could use plain matrix embedding (Hamming/F5-style) or wet-paper style coding, avoiding the licence uncertainty; a clean-room STC in TS (Viterbi over 2^h states, h=7..10) is feasible but licensing of ported code needs care (ask the authors, or port from MPL/permissive Rust only after checking phasm-core's licence, which was not checked).

### Gaps

- phasm-core licence, pySTC status, and any STC licence statements in the C++ source were not verified.

## 6. JPEG DCT coefficient access in JS

### Takeaway

jpeg-js and @jsquash only decode to pixels. The only JS found with raw coefficient access are f5stegojs (MIT) and js-steg; Rust `dct-io` could be compiled to WASM. Python references: jpeglib, jpegio.

### Cited Findings

- jpeg-js: API is `decode(buffer, opts)` returning `{width,height,data}` and `encode(imageData, quality)`; no coefficient access documented. Decode builds on jpgjs (Apache 2.0); encoder is an as3corelib port under an Adobe licence with redistribution conditions. Repo shows 92 commits, 26 open issues; synchronous and slow — [jpeg-js](https://github.com/jpeg-js/jpeg-js)
- f5stegojs: MIT; JS F5 port for browsers and Node; reads Huffman baseline and progressive JPEGs down to raw (not dequantized/de-zigzagged) DCT coefficients; writes baseline Huffman only; lets you read/set APPn blocks, comments and trailing data; does NOT encrypt (recommends TweetNaCl first); key is a byte array initialising a coefficient shuffle; not compatible with original F5; marked "still in progress"; version not stated — [f5stegojs README](https://unpkg.com/f5stegojs@0.1.2/README.md)
- js-steg (owencm): JS JPEG steganography library with modified encoder/decoder giving "easy access to the DCT coefficients"; no published npm release — [js-steg](https://github.com/owencm/js-steg)
- `@pinta365/steganography` on JSR: helpers to embed/extract in JPEG quantized coefficients (Bun, browsers) — [JSR docs](https://jsr.io/@pinta365/steganography/doc)
- `dct-io` Rust crate reads and writes quantized DCT coefficients for baseline JPEGs — [docs.rs dct-io](https://docs.rs/crate/dct-io/latest)
- @jsquash/jpeg: my fetch of the repo URL returned 404, so coefficient exposure is unverified (as far as the documented API of jSquash, decode/encode of pixels; not confirmed)
- Python references: conseal uses jpeglib to access DCT coefficients — [conseal GitHub](https://github.com/uibk-uncover/conseal)

### Inferences

- The most realistic route for JPEG-domain embedding in a VS Code extension: either adapt f5stegojs' decoder/encoder (MIT, in-process) or build a small WASM from libjpeg-turbo `jpeg_read_coefficients`/`jpeg_write_coefficients` (public API, lossless re-encode of the same Huffman tables or optimised). Not verified that any existing WASM build exports these.
- Note f5stegojs writes baseline only, so progressive inputs change structure on output.

### Gaps

- No libjpeg-turbo/mozjpeg WASM package confirmed to expose coefficients. @jsquash/jpeg and jpegio/jpeglib licence details not fetched.

## 7. Lossless image I/O in a webview (canvas pitfalls)

### Takeaway

Canvas stores premultiplied alpha and its round trip is not guaranteed to preserve pixel values; so for LSB embedding use a pure decoder/encoder (fast-png, pngjs, UPNG.js) and never route through canvas.

### Cited Findings

- Canvas 2D stores premultiplied pixels while PNG and `getImageData` are unpremultiplied, so exact RGB is lost where alpha < 255; lower alpha means coarser recoverable RGB (at alpha 1 only 0 or 255 recoverable; at alpha 0 RGB collapses) — [dev.to yoya on getImageData premultiplied alpha](https://dev.to/yoya/canvas-getimagedata-premultiplied-alpha-150b)
- The HTML spec does not guarantee `putImageData` then `getImageData` preserves values (only no visible change); browsers round differently — [WHATWG list thread](https://lists.whatwg.org/pipermail/whatwg-whatwg.org/2008-April/056874.html), [Mozilla bug 1613369](https://bugzilla.mozilla.org/show_bug.cgi?id=1613369)
- Recent Firefox 157 report: canvas to PNG to canvas loop drifts ([127,0,0,8] to [159,0,0,8]); Chromium 151 and WebKit 26.5 stable in 50 cycles (single bug report) — [Mozilla bug 2046791 listing/Bug 1613369](https://bugzilla.mozilla.org/show_bug.cgi?id=1613369)
- MDN: `getImageData` accepts `colorSpace` "srgb" or "display-p3" and `pixelFormat` `rgba-unorm8` default; with fingerprinting protection "random subtle noise is introduced" so `putImageData`/`getImageData` "may not round-trip" — [MDN getImageData](https://developer.mozilla.org/en-US/docs/Web/API/CanvasRenderingContext2D/getImageData)

### Inferences

- Decoding via `<img>`/`createImageBitmap` also applies colour management (ICC, gamma chunks) and may alter values; a pure-JS PNG codec gives exact bytes. Opaque (alpha 255) images are less affected, but fingerprinting-protection noise can still corrupt them, so do not rely on canvas.
- Library facts (fast-png, pngjs, UPNG.js size, licences) were not fetched.

### Gaps

- No fetched source on fast-png/pngjs/UPNG.js maintenance or licences.
- No source on colour-management effects specifically (ICC/gAMA) on decode.

## 8. Prior art lessons

### Takeaway

Past tools failed by weak seeds, unauthenticated or optional encryption, visible markers, and key reuse; avoid all of these.

### Cited Findings

- StegCloak: AES-256-CTR encryption (optional, `--nocrypt` disables), optional HMAC integrity (`-i`), no named KDF/salt/IV on README, LZ+Huffman compression before encryption; hides in 6 zero-width Unicode characters; README warns a monitor looking for unusual invisible characters could detect that communication occurred — [StegCloak README](https://github.com/KuroLabs/stegcloak)
- Stegseek: runs all of rockyou.txt (14,344,391 passwords) in under 2 seconds (last entry found in 1.211 s); over 12,000x faster than Stegcracker. Exploits steghide's RNG having only 2^32 possible seeds (CVE-2021-27211); it can detect steghide data and, if embedded without encryption, recover it without any passphrase — [Stegseek](https://github.com/RickdeJager/stegseek)
- CVE-2021-27211: steghide 0.5.1, CWE-335, CVSS 3.x 7.5 per Aqua — [NVD](https://nvd.nist.gov/vuln/detail/CVE-2021-27211), [Aqua](https://avd.aquasec.com/nvd/2021/cve-2021-27211)
- Key reuse: payload location and key search attacks rely on several stego images with the same embedding key; Fridrich et al. 2005 showed key recovery from multiple images; passphrase-derived keys are dictionary-attackable; deep-learning steganalysis exploits reused keys — [IS&T 2016 paper](https://library.imaging.org/ei/articles/28/8/art00011), [arXiv 1511.04855](https://arxiv.org/pdf/1511.04855), [Cisco blog on key leakage through payload metadata](https://blogs.cisco.com/security/steganographic-key-leakage-through-payload-metadata/)

### Inferences

- Rules: always encrypt (no "no-encryption" mode); AEAD not CTR+optional HMAC; per-message random salt in KDF so the same passphrase gives different positions per image; strong Argon2id plus a passphrase-strength warning, since the offline guess oracle is "extract and check AEAD tag".
- A stego attacker can test passphrase guesses offline against a suspect image at Argon2 cost, so cost parameters matter and there is no rate-limiting available.

### Gaps

- Steghide's other design flaws (header known structure, Blowfish/CBC usage) and OpenPuff's design were not researched.
- "Steganography is broken with password reuse" as a single named paper was not found (see sources above for the literature).
