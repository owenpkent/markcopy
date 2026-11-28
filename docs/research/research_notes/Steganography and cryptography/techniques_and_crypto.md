# Steganography techniques and their combination with cryptography (as of Nov 2026)

Method note: about 12 web searches/fetches, mostly search snippets, not full primary papers. Items marked "background" in Inferences come from the researcher's prior knowledge and were NOT verified this session; the report writer should treat them as unsourced. Several key questions (audio/video, PDF/OOXML structure, KDF numbers, JPEG WASM) got little or no sourced coverage; see Gaps.

## Image steganography (LSB, JPEG DCT, content-adaptive, STC)

### Takeaway

Modern secure image stego is "distortion cost map + syndrome-trellis coding" (S-UNIWARD spatial, J-UNIWARD JPEG). Older F5/nsF5 are detectable by modern features. Payload should scale with the square root of cover size. Robust (recompression-surviving) JPEG stego is still weak.

### Cited Findings

- J-UNIWARD assigns each DCT coefficient an embedding cost from the image's wavelet residual, then a coding method (STC) embeds the payload while minimizing total cost. — [Off-By-One Implementation Error in J-UNIWARD](https://arxiv.org/pdf/2305.19776)
- A 2023 paper reports an off-by-one error in the published J-UNIWARD reference code (both Matlab and C++); S-UNIWARD is unaffected because it does no pre-computation. Matters for anyone porting the reference code to TS. — [arXiv 2305.19776](https://arxiv.org/pdf/2305.19776)
- Square-root law: detectability stays constant if payload is proportional to the square root of the number of pixels. — [Vlasov thesis on empirical validation of the square root law](https://www.cs.ox.ac.uk/people/andrew.ker/docs/vlasov-empirical-validation-square-root-law.pdf)
- Robust-JPEG context: an STC + J-UNIWARD scheme designed to survive recompression was reported as highly detectable, detection error 5% at QF 75 and 0.1 bits per nonzero AC coefficient (bpnzAC). — [Errorless Robust JPEG Steganography](https://arxiv.org/html/2211.04750v2)
- F5 (Westfeld 2001) uses matrix embedding (more bits per embedding change) and decrements coefficient absolute value by 1. Broken in 2002 by Fridrich, Goljan, Hogea via the shrinkage-induced increase in zeros. — [Fridrich et al. 2007 / nsF5 material (UFL)](https://www.cise.ufl.edu/~nemo/tmp/jessica_fraction03.pdf), [Binghamton nsF5 simulator](https://dde.binghamton.edu/download/nsf5simulator)
- nsF5 (2007) uses wet paper codes to avoid shrinkage; still detectable with modern features (PEV-274 etc.); UED improved on it. Binghamton notes original nsF5 embedding-efficiency figures no longer reflect real security, so they simulate with the theoretical bound. — [Binghamton nsF5 simulator](https://dde.binghamton.edu/download/nsf5simulator)
- Robust-to-recompression approaches: lattice embedding (Butora, Puteaux, Bas; errorless but needs the target compressor), sign-based methods that skip sign-flip-prone coefficients, RS-STC (Reed-Solomon plus STC), adaptive RS strength (Adaptive-GMAS), channel matching by re-uploading until coefficients stabilize (behavioral risk), classifier-selected robust blocks. Platforms recompress with fixed quantization tables; actual platform settings were not found. — [arXiv 2211.04750](https://arxiv.org/html/2211.04750v2), [ar5iv 2304.13297](https://ar5iv.labs.arxiv.org/html/2304.13297), [arXiv 2411.13819](https://arxiv.org/html/2411.13819v1), [arXiv 2211.10095](https://arxiv.org/pdf/2211.10095.pdf)

### Inferences

- For a TS build, S-UNIWARD plus an STC encoder (pure integer/dynamic-programming code, no native deps) is the realistic "good" spatial option; J-UNIWARD needs DCT coefficient access (see JS libraries section) and care about the off-by-one bug.
- Background (unverified here): LSB replacement is broken by RS/chi-square/sample-pair analysis; LSB matching (+/-1) is harder to detect; HUGO/WOW/HILL/MiPOD are other cost functions; typical test payloads are 0.1 to 0.4 bpp (spatial) and bpnzAC for JPEG. No numeric detectability table was obtained.

### Gaps

- No primary-source error-rate vs bpp tables for HUGO, WOW, S-UNIWARD, HILL, MiPOD, JSteg, OutGuess; no STC paper (Filler/Judas/Fridrich) fetched (a Scribd copy appeared in results but was not read).
- PNG palette tricks not covered.

## Audio and video

### Takeaway

Not researched with sources in this pass.

### Cited Findings

- None.

### Inferences

- Background (unverified): PCM LSB is trivial in WAV and fragile to any lossy codec; echo hiding and phase coding are classical robust-ish methods; MP3Stego embeds in the inner loop of the encoder. Browser-side WAV LSB is easy in TS; MP3/video embedding needs encoder-level access and is not realistic.

### Gaps

- All of: capacity numbers, MP3Stego details, video motion-vector methods.

## Text and Unicode, linguistic and LLM stego, LLM watermarking

### Takeaway

Unicode invisible-character channels (tags, variation selectors) are trivial to implement and high capacity but are not secret: they are now actively filtered and are a mainstream security concern. LLM-based generative stego has provably secure constructions, but they need explicit next-token distributions and have contested security claims.

### Cited Findings

- Unicode Tags block U+E0000 to U+E007F is a shadow copy of printable ASCII (U+E0041 is "A", U+E0061 is "a"). Riley Goodside publicized tag-based invisible prompts on 2024-01-11; Rehberger's Embrace The Red "ASCII Smuggler" tool (Jan 2024) popularized encode/decode. Rehberger is not the originator per Cisco's account. — [Language Log](https://languagelog.ldc.upenn.edu/nll/?p=66513), [Cisco](https://blogs.cisco.com/?p=468749)
- Microsoft (2026-09-03) reports ASCII smuggling used in high-volume phishing (tag characters inserted between letters to split lure words, peaking at about 2.37 million emails per day per one secondary report) and recommends stripping or normalizing tag characters and invisible code points before keyword/regex/signature detection. — [Microsoft Security Blog](https://www.microsoft.com/en-us/security/blog/2026/09/03/ascii-smuggling/), [hwbusters](https://hwbusters.com/news/ascii-smuggling-jumps-from-ai-attacks-to-spam-and-it-peaked-at-2-37-million-emails-a-day/)
- "Sneaky Bits": ASCII to binary using invisible times U+2062 and invisible plus U+2064 as 0 and 1 (credited to Rehberger by Garak docs). — [Garak reference](https://reference.garak.ai/en/stable/ascii_smuggling.html)
- Variation-selector encoding (Paul Butler): byte b in 0..15 maps to U+FE00+b; bytes 16..255 map to U+E0100+(b-16); append one selector per byte after any base character (not only emoji); decode stops at first non-selector. Survives copy/paste typically; Unicode spec does not address runs of selectors; LLM tokenizers keep them but models rarely decode unaided. This gives 1 byte per code point (about 4 UTF-8 bytes each for the supplementary range, 3 for FE00..FE0F). — [Paul Butler](https://paulbutler.org/2025/smuggling-arbitrary-data-through-an-emoji/)
- Meteor (Kaptchuk, Jois, Green, Rubin, CCS 2021, ePrint 2021/686): provably indistinguishable from honest model output; re-encrypts the message before each sampling instead of updating intervals; later papers criticize capacity (does not use full entropy), probability truncation from limited precision, randomness reuse, and a 2026 paper challenges "provably secure" claims for interval-based schemes. Needs explicit model distributions. — [arXiv 2504.12579](https://arxiv.org/pdf/2504.12579v2), [ePrint 2021/686](https://eprint.iacr.org/2021/686), [arXiv 2604.08052](https://arxiv.org/pdf/2604.08052)
- Minimum entropy coupling (de Witt, Sokota, Kolter, Foerster, Strohmeier, ICLR 2023, arXiv 2210.14889): perfect security (zero KL divergence) for arbitrary covertext distributions; most information-efficient perfectly secure methods are MEC-induced; MEC is NP-hard but approximations run in O(N log N) within about 1 bit of optimal joint entropy; beat arithmetic coding, Meteor, adaptive dynamic grouping on GPT-2, WaveRNN, Image Transformer; CMU reports up to 40% higher efficiency. The iterative iMEC has significant computational cost. — [arXiv 2210.14889](https://arxiv.org/abs/2210.14889), [CMU news](https://www.cs.cmu.edu//news/2023/secure-secret-communications), [arXiv 2604.08052](https://arxiv.org/pdf/2604.08052)
- Newer provably secure schemes: SparSamp (sparse sampling), Shifting-Merging, range-coding scheme (2026), API-only scheme (2025) needing no explicit distributions. — [SparSamp](https://arxiv.org/pdf/2503.19499), [Shifting-Merging](https://arxiv.org/pdf/2501.00786), [arXiv 2604.08052](https://arxiv.org/pdf/2604.08052)
- Kirchenbauer green-list watermark: seed a PRF with the previous token, split vocabulary into green and red lists, add bias delta to green logits; example parameters gamma=0.25, delta=2 on OPT-6.7B. — [arXiv 2301.10226](https://arxiv.org/abs/2301.10226)
- SynthID-Text (Dathathri et al., Nature 2024, vol 634, 818-823): tournament sampling over keyed g-values, deployed in Gemini. Follow-ups: layer-inflation removal attack on mean score (Bayesian score better); SynGuard improves F1 by about 11.1% under paraphrase; a Stanford note found 71.5% vs 86.3% detection power at 5% FPR against Gumbel-style sampling (single project, not a broad benchmark). — [Stanford note](https://web.stanford.edu/~eugenef/notes/CyclicTournaments/), [arXiv 2603.03410](https://arxiv.org/abs/2603.03410), [arXiv 2508.20228](https://arxiv.org/html/2508.20228v2)

### Inferences

- Zero-width and tag/variation-selector channels are fine for "visible to tools, invisible to eyes" payloads (watermarking, tracking, carrying an encrypted blob in a Markdown file), but a defender that normalizes Unicode removes them. Ciphertext in them is detectable as non-text anyway (long runs of invisible code points).
- A faithful LLM-stego implementation in the extension is not realistic (needs a local model plus exact numerics shared by both ends); watermark detectors need the model's tokenizer and keys.
- Background (unverified): zero-width U+200B/200C/200D/FEFF binary encodings, homoglyphs, and SNOW trailing whitespace are standard, low-capacity, brittle to normalization.

### Gaps

- Nature SynthID-Text paper itself and Google's open-source release license not fetched; Kirchenbauer exact z-score detail not fetched; no cited capacity numbers for zero-width/SNOW/homoglyph methods.

## File-format and structural hiding

### Takeaway

Not researched with sources in this pass.

### Cited Findings

- None.

### Inferences

- Background (unverified): data after PNG IEND, JPEG EOI, or ZIP central directory is ignored by most readers and is trivially found by structure scanners; PDF incremental updates, unused objects, OCG layers, embedded files; OOXML custom XML parts, hidden slides, comments, alt text; EXIF/XMP/ID3 fields; ELF/PE overlays. These are concealment-by-obscurity, relevant to MarkCopy's existing PE/package/OOXML readers as things to surface (a "hidden data inspector") more than to build.

### Gaps

- No sources fetched for any of these formats; no polyglot references.

## Cryptographic layer

### Takeaway

Only JS library availability for Argon2id was sourced. Encrypt-then-embed design guidance is background knowledge.

### Cited Findings

- `hash-wasm` exposes `argon2id()` and `argon2Verify()` via WebAssembly (npm i hash-wasm; versions seen 4.12.0 and 4.13.2; license not confirmed in results). A separate `argon2id` npm package is MIT, v1.0.1, little used. `@noble/hashes` computes Argon2id in pure JS (useful when CSP blocks wasm-unsafe-eval). — [hash-wasm README](https://unpkg.com/hash-wasm@4.12.0/README.md), [argon2id on npm](https://npmjs.com/package/argon2id), [mojoauth guide](https://mojoauth.com/security-guides/argon2-in-javascript-in-browser)
- Reed-Solomon is used in robust JPEG stego (RS-STC, Adaptive-GMAS) to survive recompression errors. — [ar5iv 2304.13297](https://ar5iv.labs.arxiv.org/html/2304.13297), [arXiv 2411.13819](https://arxiv.org/html/2411.13819v1)

### Inferences

- Background (unverified): design is passphrase -> Argon2id/scrypt -> key; AEAD (AES-GCM via WebCrypto, available in browsers and Node; ChaCha20-Poly1305 via @noble/ciphers) over the payload; embed ciphertext with no magic header (salt and nonce stored inside the stream, since they are random-looking), positions chosen by a keyed PRNG over the cost-ranked coefficients; wrong passphrase is indistinguishable from "no message" (deniability needs a decoy layer, as in OpenPuff/VeraCrypt hidden volumes). Encryption makes the embedded bits uniform, which is what LSB/STC analysis assumes. Argon2 is not in WebCrypto; PBKDF2 and (in Node) scrypt are. Elligator-style key encoding only matters for public-key stego; not researched.
- Authenticated encryption plus RS error correction conflict: do RS over the ciphertext, then AEAD tag still detects uncorrectable corruption.

### Gaps

- No sourced numbers for Argon2id parameters (OWASP/RFC 9106), WebCrypto support matrix, scrypt/PBKDF2 browser availability, public-key stego or Elligator, OpenPuff internals.

## Robust watermarking, deep-learning marks, C2PA

### Takeaway

TrustMark and Video Seal are MIT-licensed and open, but model inference in a VS Code webview would need ONNX/WASM; C2PA has an official browser SDK (c2pa-web).

### Cited Findings

- Adobe TrustMark: open-source watermarking for arbitrary-resolution images, built for the Content Authenticity Initiative, MIT license for code and models, trained on licensed Adobe Stock images, used to link to durable Content Credentials. — [TrustMark README](https://raw.githubusercontent.com/adobe/trustmark/main/README.md), [TrustMark FAQ](https://opensource.contentauthenticity.org/docs/tm-faq)
- Meta Video Seal (Dec 2024): open video watermark model and code, MIT, uses temporal watermark propagation, resists blur, crop, compression per Meta. Meta Seal umbrella now covers audio, image, video, text (Pixel Seal, Watermark Anything, Omni Seal Bench). TrustMark and Video Seal are not directly compatible. — [Meta Seal](https://facebookresearch.github.io/meta-seal), [Video Seal paper](https://arxiv.org/html/2412.09492v1), [Maginative](https://www.maginative.com/article/meta-releases-video-seal-an-open-source-watermarking-tool-for-ai-video/)
- C2PA in JS: `@contentauth/c2pa-web` (browser, in the contentauth/c2pa-js monorepo) is current; old c2pa-js moved to c2pa-js-legacy and is deprecated; the npm package `c2pa` (0.30.9) is the older line; `c2pa-types` provides TS types; a c2pa-node-v2 package is referenced. — [CAI JS docs](https://opensource.contentauthenticity.org/docs/sdk-repos/c2pa-js/), [c2pa-web docs](https://opensource.contentauthenticity.org/docs/c2pa-js/packages/c2pa-web/), [c2pa-js-legacy](https://github.com/contentauth/c2pa-js-legacy)

### Inferences

- C2PA is signed metadata (stripped by re-encoding, hence CAI pairing it with TrustMark as a durable binding); it is the provenance alternative, not hidden-data stego.
- Background (unverified): DWT-DCT-SVD classical watermarks are implementable in pure TS; HiDDeN, StegaStamp, RivaGAN, Stable Signature need neural nets.

### Gaps

- HiDDeN, StegaStamp, RivaGAN, Stable Signature, Google SynthID image/video not researched; TrustMark ONNX/JS port status not checked; c2pa-web license and size not checked.

## JS/TS and WASM implementation availability

### Takeaway

Only partially answered: Argon2 (hash-wasm, @noble/hashes) and C2PA (c2pa-web) are covered; JPEG coefficient access and STC libraries were not.

### Cited Findings

- See Cryptographic layer and C2PA entries above. No source was found for pure-JS JPEG coefficient access (jpeg-js decodes to pixels only per background knowledge), libjpeg-turbo WASM, or any npm STC/F5/OutGuess port.

### Inferences

- Background (unverified): JPEG coefficient-level work likely needs a custom Huffman-level JPEG parser/writer (lossless re-encode of modified coefficients) written in TS, since common npm JPEG packages operate on pixels. This is the main build cost for J-UNIWARD/nsF5-class methods; spatial PNG stego with S-UNIWARD+STC avoids it.

### Gaps

- Needs a dedicated pass: npm search for jpeg coefficient libraries (e.g. jpeg-coefficients, mozjpeg WASM builds), STC ports, Reed-Solomon packages, and license/maintenance status of each.
