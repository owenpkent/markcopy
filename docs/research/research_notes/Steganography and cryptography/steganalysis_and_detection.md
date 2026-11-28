# Steganalysis and forensic detection of hidden data (state as of November 2026)

Method note: research used web search summaries (about 22 searches); few primary pages were fetched in full. Items marked "unverified" came back from secondary or aggregator sources only. Where a claim is background knowledge I could not source in this session, it is placed under Inferences or Gaps, not Cited Findings.

## 1. Classical statistical steganalysis (chi-square, RS, SPA, WS, JPEG calibration)

### Takeaway

Chi-square, RS, Sample Pairs and Primary Sets target sequential or scattered LSB replacement in pixels; LSB matching (+/-1) and adaptive schemes were designed to evade them. StegExpose fuses the first three with a single 0.2 threshold, which is the only tunable false-positive control documented.

### Cited Findings

- Chi-square attack is a statistical analysis of pairs of values exchanged during LSB embedding; Primary Sets rest on a statistical identity of pixel sets; RS analysis compares counts of regular and singular groups for the LSB and shifted LSB planes. — [StegExpose paper](https://arxiv.org/pdf/1410.6656), [StegExpose repo](https://github.com/b3dk7/StegExpose), [LSB steganalysis overview](https://arxiv.org/pdf/1405.5119)
- StegExpose fuses Sample Pairs (Dumitrescu 2003), RS (Fridrich 2001) and Chi Square (Westfeld). Default fused threshold 0.2; README advises ~0.25 if false positives matter, ~0.15 if false negatives matter. Fast fusion is 3.2x faster than RS alone and 3.5x faster than standard fusion. No per-detector false-positive rates are published in the README. — [StegExpose repo](https://github.com/b3dk7/StegExpose), [paper](https://arxiv.org/pdf/1410.6656)
- StegExpose detector code was borrowed from Hempstalk's Digital Invisible Ink Toolkit (RS, SPA) and Faure's simple-steganography-suite (Primary Sets, chi-square). — [StegExpose paper](https://arxiv.org/pdf/1410.6656)
- LSB matching "has proved much harder to detect than LSB replacement because it does not introduce the same asymmetries" (Ker). Ker's resampling-based detection works much better when covers were stored as JPEG. — [Ker, SPIE 5681](https://medicalimaging.spiedigitallibrary.org/conference-proceedings-of-spie/5681/0000/Resampling-and-the-detection-of-LSB-matching-in-color-bitmaps/10.1117/12.586622.full)
- Weighted-stego (WS) local estimator was extended in 2012 into a hypothesis-testing detector for LSB matching with unknown image parameters. — [Cogranne et al.](https://arxiv.org/pdf/1207.2674)
- A 2026 evaluation of a fuzzy-logic adaptive scheme found chi-square saturated at 100% detection for all methods and payloads, while RS detection was lower for the adaptive method (direct-LSB-style test, not +/-1). Single recent paper, treat with caution. — [arXiv 2603.18105](https://arxiv.org/pdf/2603.18105)

### Inferences

- These tests need decoded pixel arrays (PNG/BMP, or decoded JPEG pixels, which is meaningless for DCT-domain embedding), so cost is O(pixels) and fine for a worker; but results are probabilistic scores, not facts, and a previewer should present them as weak hints at most.
- Smooth synthetic content (screenshots, flat UI, line art, palette PNGs) violates the natural-image assumptions behind chi-square/RS/WS; I expect elevated false positives there, but I found no published rate. Flag as unmeasured.
- No cheap classical test catches LSB matching or adaptive embedding in the wild; any "clean" verdict would be misleading.

### Gaps

- No sourced numeric false-positive rates for chi-square, RS or SPA on photos versus screenshots. Original papers (Westfeld-Pfitzmann 1999, Fridrich-Goljan-Du 2001, Dumitrescu 2003) were not fetched.
- JPEG calibration / histogram attacks (Fridrich calibration, F5 detection): nothing sourced here.

## 2. Rich models and deep learning (SRM, DCTR, GFR, SRNet, ALASKA2)

### Takeaway

SRM+ensemble gives roughly 13 to 20% error on BOSSbase at 0.4 bpp against adaptive schemes; CNNs such as SRNet do better in-distribution, but all are fragile under cover-source mismatch, and none is a sensible default in a previewer. Whether any ships in-browser at small size: I found no sourced example.

### Cited Findings

- SRM+EC error on BOSSbase at 0.4 bpp (0.1 bpp): HUGO 0.13 (0.37); WOW 0.18 (0.39); S-UNIWARD 0.18 (0.40). Numbers aggregated across papers with differing setups. — [arXiv 1612.08882](https://arxiv.org/pdf/1612.08882), [arXiv 1605.07946](https://arxiv.org/pdf/1605.07946)
- One report puts a CNN at 7.4% error at 0.4 bpp S-UNIWARD versus a rich-model 20%. — [arXiv 1605.07946](https://arxiv.org/pdf/1605.07946)
- SRNet (Boroumand, Chen, Fridrich) uses 12 convolution blocks. Unofficial PyTorch port reports paper accuracy 89.77% and reproduces ~89.43% (S-UNIWARD 0.4 bpp); a TF2 port reached only ~83%. Original paper not fetched, so 89.77% is unverified. — [PyTorch SRNet](https://www.github.com/brijeshiitg/Pytorch-implementation-of-SRNet), [TF SRNet](https://github.com/davidggz/SRNet-Tensorflow-Implementation), [survey](https://arxiv.org/pdf/1904.01444)
- ALASKA2 (Kaggle, JPEG, three adaptive algorithms): nearly all top teams fine-tuned ImageNet-pretrained EfficientNets; the winning-team paper (Yousfi, Butora, Khvedchenya, "Improving EfficientNet for JPEG Steganalysis", IH&MMSec 2021) found "surgical modifications" that keep input resolution (e.g., removing first-layer stride) significantly help. Final leaderboard AUC not retrieved. — [ImageNet Pretrained CNNs for JPEG Steganalysis](https://paperswithcode.com/paper/imagenet-pretrained-cnns-for-jpeg), [YassineYousfi/alaska](https://www.github.com/YassineYousfi/alaska), [NSF PAR](https://par.nsf.gov/biblio/10301784)
- Cover-source mismatch: a 2020 systematic review (Mallet, Benes, Cogranne) says even the best deep models are prone to CSM, with 100+ papers on the topic; EUSIPCO 2022 (Giboulot et al.) treats it as a major source of performance loss. An earlier claim (Pibre et al.) that CNNs are naturally robust is contested by later work. — [review/Giboulot](https://eurasip.org/Proceedings/Eusipco/Eusipco2022/pdfs/0001032.pdf), [Pibre et al.](https://arxiv.org/pdf/1511.04855), [IWDW 2019 chapter](https://rd.springer.com/chapter/10.1007/978-3-030-43575-2_6)

### Inferences

- A previewer receives arbitrary sources (phones, screenshots, re-saved web images), the exact CSM setting where these detectors degrade; plus model size and tensor ops make this a poor fit for an automatic check. Recommend not shipping.

### Gaps

- DCTR/GFR numbers, Xu-Net, Ye-Net, Yedroudj-Net figures: not retrieved.
- Any ONNX/WASM or TF.js steganalysis model and its size: none found. Likely none in public use (unverified).

## 3. Practical tools

### Takeaway

CTF-grade tools mostly do brute-force LSB extraction (zsteg), signature carving (binwalk, foremost), metadata dumps (exiftool) and password cracking (stegseek). Aletheia is the only maintained ML-based steganalysis toolbox found.

### Cited Findings

- zsteg: Ruby CLI for PNG and BMP only; tries bit planes, channels, bit order and pixel traversal, then identifies output with `file`; also flags zlib data, OpenStego, Camouflage, LSB with Eratosthenes set. Latest gem 0.2.14 (28 Jan 2026). False positives possible. Licence not confirmed (I believe MIT, unverified). — [linuxlinks](https://www.linuxlinks.com/zsteg-detects-steganographically-hidden-data/), [RubyGems](https://rubygems.org/gems/zsteg), [linuxcommandlibrary](https://linuxcommandlibrary.com/man/zsteg)
- Aletheia (Lerch-Hostalot): Python, MIT, ML-based image steganalysis, JOSS paper published 16 Jan 2024 (DOI 10.21105/joss.05982). — [GitHub](https://github.com/daniellerch/aletheia), [JOSS](https://joss.theoj.org/papers/10.21105/joss.05982)
- Stegseek: steghide cracker, rockyou.txt (14M+ passwords) in about 2 s on an i7-7700HQ; `--seed` mode extracts without a password by trying embedding patterns. GPL-2.0 per a catalogue and GPL-2.0-or-later per AUR (inconsistent; check COPYING). — [GitHub](https://github.com/RickdeJager/stegseek), [AUR](https://aur.archlinux.org/packages/stegseek/)
- Binwalk v3 is a Rust rewrite, MIT, 3.1.0 released 31 Oct 2024. — [lib.rs](https://lib.rs/crates/binwalk), [GitHub](https://github.com/ReFirmLabs/binwalk)
- AperiSolve (Zeecka): web platform running zsteg, steghide, outguess, exiftool, binwalk, foremost, strings, plus bit-plane views for R/G/B/A, around 16 tools; wiki also lists jsteg, pngcheck, stegseek, ImageMagick identify, stegsnow. StegoVeritas not listed as one of its tools. Licence not retrieved. — [AperiSolve](https://github.com/Zeecka/AperiSolve), [linuxlinks](https://www.linuxlinks.com/aperisolve-web-based-steganalysis-platform/)
- StegExpose: Java, see section 1. — [GitHub](https://github.com/b3dk7/StegExpose)

### Gaps

- Licences not verified: zsteg, AperiSolve, StegoVeritas, StegExpose, foremost, exiftool (Perl, Artistic/GPL, from memory), pngcheck, jpeginfo, stegdetect, CyberChef (Apache-2.0, from memory). Verify before reuse.
- stegdetect status (abandoned, ~2004 era, JPEG jsteg/outguess/jphide) not sourced.

## 4. Structural and format anomaly checks (highest-value cheap checks)

### Takeaway

Trailing data, extra revisions and invisible text are deterministic, cheap and have clear semantics, unlike statistical tests. Sourced coverage here is thin on PNG/JPEG/OOXML/PE specifics; PDF revisions and malware-in-image examples are sourced.

### Cited Findings

- PDF: each incremental update ends with its own %%EOF, so counting markers counts revisions; Didier Stevens's `pdfid.py -e` flags them, and removing bytes after the first %%EOF recovers the original. — [SANS ISC diary 25904](https://isc.sans.edu/diary/25904)
- PDF Shadow Attacks (NDSS 2021) use well-formed incremental updates (Hide, Replace, Hide-and-Replace), so they are standard-compliant and not detectable as malformed; iText's stance is to treat all incremental updates as changes. — [NDSS 2021](https://www.ndss-symposium.org/wp-content/uploads/ndss2021_1B-4_24117_paper.pdf), [iText](https://itextpdf.com/blog/technical-notes/investigating-pdf-shadow-attacks-depth-pdf-security-using-itext-part-2)
- Observed image carriers: PNG metadata holding a command that fetches a PHP web shell; JPG with reversed Base64 PE appended (AgentTesla); .NET loader with PNG/BMP resources encoding Lokibot in pixel values; XWorm campaign using "PNGs" that are really Base64+AES blobs, not valid images. Vendor sources (OPSWAT, ANY.RUN via Cybersecurity News); dates unclear. — [OPSWAT](https://www.opswat.com/docs/filescan/datasheet/steganography-analysis), [Cybersecurity News](https://cybersecuritynews.com/new-net-malware-hides-lokibot-malware/), [XWorm in PNGs](https://cybersecuritynews.com/steganography-attacks-xworm-in-pngs/amp/)
- Thumbnail helpers exist: exifr (`exifr.thumbnail`, reads only first bytes, covers JPEG, TIFF, PNG, HEIC) and ExifReader (also extracts embedded thumbnail). — [exifr](https://github.com/MikeKovarik/exifr), [ExifReader](https://npmjs.com/package/exifreader)

### Inferences

- Recommended cheap automatic set (my judgment): bytes after PNG IEND, JPEG EOI, GIF trailer 0x3B, last PDF %%EOF; PDF revision count and /JavaScript, /EmbeddedFile, /OpenAction presence; non-critical unknown PNG chunks and large tEXt/iTXt/zTXt; oversized EXIF/XMP/ICC; magic-byte signatures of ZIP/PE/RAR within trailing data; embedded thumbnail dimension/aspect mismatch. Each reports a fact (offset, size, type) rather than a probability.
- Because exifr, ExifReader and a hand-written chunk walker only need a few hundred lines, no heavy dependency is required; MarkCopy's existing readers (`src/pe/`, `src/ooxml/`) already cover PE overlays and OOXML containers.

### Gaps

- Not researched or not sourced: PNG chunk specification details (critical vs ancillary bit), JPEG APPn/COM abuse, GIF extension blocks, polyglot (GIFAR style) classes, OOXML hidden sheets/slides, `w:vanish`, white-on-white text, customXml, altChunk, PE overlay and resource-section hiding. These are well-known but I did not retrieve sources.
- pdf.js API for xref/incremental update access: search returned nothing; unverified.
- False positives for trailing data: some tools and cameras legitimately append (e.g., MPF/Google motion photos, signed images); not sourced.

## 5. Real-world abuse and incidents

### Takeaway

Invisible Unicode has moved from a 2021 research attack (Trojan Source) to production malware (os-info-checker-es6 in March 2025, GlassWorm from October 2025 through at least April 2026), phishing evasion (Feb to Jun 2026) and AI prompt injection (2024 onward).

### Cited Findings

- Trojan Source (Boucher and Anderson, Cambridge, 1 Nov 2021): bidi controls make code display differently than it compiles; CVE-2021-42574 (bidi), CVE-2021-42694 (homoglyphs); affected C, C++, C#, JS, Java, Rust, Go, Python. NVD CVSS 9.8 questioned by Rapid7. — [trojansource.codes](https://trojansource.codes/), [Rapid7](https://www.rapid7.com/blog/post/2021/11/04/trojan-source-cve-2021-42572/), [Krebs](https://krebsonsecurity.com/2021/11/trojan-source-bug-threatens-the-security-of-all-code/)
- os-info-checker-es6 (npm): first published 19 Mar 2025; hid payload in Variation Selectors Supplement characters U+E0100 to U+E01EF (Veracode: payload bytes encoded in the low byte of each selector with an offset of 0x10); v1.0.8 on 7 May 2025 added Google Calendar short-link C2; ~655 weekly downloads, four dependents (skip-tot, vue-dev-serverr, vue-dummyy, vue-bit); OSV MAL-2025-4013. — [Veracode](https://www.veracode.com/resources/sophisticated-npm-attack-leveraging-unicode-steganography-and-google-calendar-c2), [BleepingComputer](https://www.bleepingcomputer.com/news/security/malicious-npm-package-uses-unicode-steganography-to-evade-detection/), [OSV](https://osv.dev/vulnerability/MAL-2025-4013)
- GlassWorm: Koi Security reported 17 Oct 2025 seven infected Open VSX extensions (CodeJoy flagged first), about 35,800 installs; payload in invisible variation selectors, decoded to Base64 then JS run via eval(); Solana blockchain C2; credential and crypto-wallet theft (49 crypto extensions targeted); self-propagation through stolen OpenVSX/Git credentials. — [Veracode](https://www.veracode.com/blog/glassworm-vs-code-extension), [The Hacker News](https://thehackernews.com/2025/10/self-spreading-glassworm-infects-vs.html), [Palo Alto](https://www.paloaltonetworks.com/blog/security-operations/glassworm-first-self-propagating-worm-using-invisible-code-hits-openvsx-marketplace/), [Endor Labs](https://www.endorlabs.com/learn/invisible-threats-glassworm-unicode-vscode)
- GlassWorm later waves: second wave about 16 days after the 21 Oct declaration of containment (3 extensions, 9,700 downloads); third wave Dec 2025 with 24 packages across Open VSX and VS Marketplace; 30 Jan 2026 four established Open VSX extensions (oorzc) per Socket; a March 2026 wave estimated at 433 items (CSA, wave numbering differs by source); 73 sleeper/impersonation extensions tracked to April 2026 (Socket, CSA). Aikido found invisible-Unicode malware in AI-generated commits. — [BleepingComputer](https://www.bleepingcomputer.com/news/security/glassworm-malware-returns-in-third-wave-of-malicious-vs-code-packages/), [THN Dec 2025](https://thehackernews.com/2025/12/glassworm-returns-with-24-malicious.html), [CSA](https://labs.cloudsecurityalliance.org/research/csa-research-note-glassworm-supply-chain-developer-toolchain/), [CSA v2](https://labs.cloudsecurityalliance.org/research/csa-research-note-glassworm-v2-openvsx-ai-dev-supply-chain-2/), [Palo Alto](https://www.paloaltonetworks.com/blog/?p=371196)
- Unicode Tags (U+E0000 to U+E007F) invisible-text prompt injection: Riley Goodside disclosed 11 Jan 2024; Johann Rehberger built ASCII Smuggler and showed an Aug 2024 Microsoft 365 Copilot exfiltration; Feb 2026 hidden instructions in agent skill markdown files (incl. Claude Code) reported by a CSA note (single source for the Claude Code detail). — [Embrace The Red](https://embracethered.com/blog/posts/2024/hiding-and-finding-text-with-unicode-tags), [Cisco](https://blogs.cisco.com/ai/understanding-and-mitigating-unicode-tag-prompt-injection), [CSA note](https://labs.cloudsecurityalliance.org/research/csa-research-note-unicode-instruction-injection-ai-skills-20/), [AWS](https://aws.amazon.com/blogs/security/defending-llm-applications-against-unicode-character-smuggling)
- Microsoft (3 Sep 2026): phishing campaign hiding Tags-block characters inside finance words to dodge keyword filters; hits rose from 9 Feb 2026, observed to 18 Jun 2026; 148 sender domains via ActiveCampaign; peak reported 2.37M messages per day (secondary); Defender caught >99% by other signals (secondary). Advice: strip or normalise Tags and invisible code points before filters and treat unexpected tags as a strong anomaly. — [Microsoft](https://www.microsoft.com/en-us/security/blog/2026/09/03/ascii-smuggling/), [SC World](https://www.scworld.com/news/ascii-smuggling-challenges-email-phishing-filters-microsoft-warns), [BleepingComputer](https://bleepingcomputer.com/news/security/attackers-conceal-phishing-lures-using-invisible-unicode-characters)

### Inferences

- Code points to flag in a text/Markdown/code preview: bidi controls (U+202A to 202E, 2066 to 2069), zero-width (200B to 200D, 2060, FEFF), Tags (E0000 to E007F), variation selectors and VS supplement (FE00 to FE0F, E0100 to E01EF) when not following an emoji/CJK base. A run of 10+ VS or Tag characters is near-certain smuggling, so the false-positive rate for "long run" rules should be very low. Legitimate use: ZWJ in emoji sequences, FE0F after emoji, ZWNJ in Persian/Indic text, BOM at file start, bidi in genuine RTL text.
- Short single occurrences are common in pasted text; counts and run length matter more than presence.

### Gaps

- SVG and PNG-hidden-JS loaders in npm/VS Code extensions: no incident with date found.
- Koi's own original GlassWorm post, ESET, Kaspersky stegomalware write-ups were not fetched.

## 6. Existing editor and platform protections and remaining gaps

### Takeaway

VS Code and GitHub both highlight bidi and some invisible characters, but it is advisory UI in code editors and file views; nothing covers images, PDFs, Markdown preview rendering or the AI-agent reading path.

### Cited Findings

- VS Code has `editor.unicodeHighlight.invisibleCharacters` and `editor.unicodeHighlight.ambiguousCharacters` (users commonly disable them); highlighting can show despite settings disabled right after startup (VS Code issue #234617). No per-character allow list inside strings was found. Official docs not retrieved; `nonBasicASCII` behaviour unconfirmed. — [Lean Zulip](https://leanprover-community.github.io/archive/stream/113488-general/topic/VSCode.20unicode.20characters.20highlight.20box.html), [Julia Discourse](https://discourse.julialang.org/t/some-unicodes-in-vscodium-editor-have-blocks-around-them/122317.md), [Google AI forum request](https://discuss.ai.google.dev/t/regression-unicode-highlighting-warns-about-en-dash-u-2013-inside-string-literals-with-no-per-character-string-exemption/185741)
- GitHub: bidi warning banner since 31 Oct 2021, extended to hidden Unicode on 1 May 2025 ("This file contains hidden or bidirectional Unicode text..."). — [Changelog 2021](https://github.blog/changelog/2021-10-31-warning-about-bidirectional-unicode-text/), [Changelog 2025](https://github.blog/changelog/2025-05-01-github-now-provides-a-warning-about-hidden-unicode-text), [Stenberg](https://daniel.haxx.se/blog/2025/05/16/detecting-malicious-unicode/)
- Snyk recommends not relying on visual review and suggests anti-trojan-source style scanners. — [Snyk](https://snyk.io/articles/defending-against-glassworm/)
- The GlassWorm campaigns persisted for months after GitHub's May 2025 banner and VS Code's highlighting, i.e. the protections did not stop distribution via marketplace extensions. — see section 5.

### Inferences

- Gaps remaining (my judgment): marketplace-level scanning; Markdown/README rendering; non-code text consumed by AI tools; images and Office/PDF files; Atlassian-style banners exist for bidi only ([Atlassian](https://support.atlassian.com/atlassian-knowledge-base/kb/bidirectional-characters-warning-in-atlassian-products/)).

### Gaps

- ESLint `no-irregular-whitespace` (and `no-misleading-character-class`) behaviour and scope: not sourced; from memory it flags irregular whitespace but not Tags or variation selectors.

## 7. JS/TS libraries

### Takeaway

Metadata and thumbnail extraction have mature browser-capable libraries; chunk, trailer and revision scanning are simple enough to hand-roll over a Uint8Array.

### Cited Findings

- exifr: isomorphic, reads TIFF/EXIF, XMP, ICC, IPTC, JFIF, IHDR; thumbnail helpers; reads only first bytes; newer builds list JPEG, TIFF, PNG, HEIC (package republished under scoped names; verify the maintained fork). — [MikeKovarik/exifr](https://github.com/MikeKovarik/exifr), [@modernized/exifr](https://cdn.jsdelivr.net/npm/@modernized/exifr@8.0.3/README.md)
- ExifReader: browser and Node, extracts embedded thumbnail. — [npm](https://npmjs.com/package/exifreader)
- Python-side references for PDF revision detection: pdfid (Didier Stevens). — [SANS ISC](https://isc.sans.edu/diary/25904)

### Gaps

- pngjs, png-chunks-extract, pdf.js xref/incremental-update access, pdf-lib: searched, nothing returned; not verified.
- Licences and maintenance status of the above not checked.
