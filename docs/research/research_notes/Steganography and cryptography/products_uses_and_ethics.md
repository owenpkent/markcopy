# Steganography and cryptography: products, uses, and ethics (as of November 2026)

Method note: about 14 web searches and 1 page fetch. Most search results were summaries, not full-page reads. Many numbers are snapshots of unknown date. Items flagged "verify" should be checked at the primary source before the report quotes them.

## 1. Existing tools and their status

### Takeaway

The classic stego tools are old, mostly unmaintained desktop or CLI programs. Steghide is read-only and seeking maintainers. The only text-stego tool with real traction (stegcloak) is a small zero-width npm library. No evidence was found of a maintained, modern, authenticated-encryption stego tool with a good UI, which is the main product gap.

### Cited Findings

- The steghide repo (StefanoDeVuono fork) is read-only, directs issues to a StegHigh org, and says it is "looking for maintainers". It shows 796 stars and 124 forks. Version listed is 0.5.1. — [GitHub steghide](https://github.com/StefanoDeVuono/steghide)
- Steghide encryption is delegated to libmcrypt (many symmetric ciphers), with libmhash deriving the key from the passphrase. Sample output shows "rijndael-128, cbc". Without libmcrypt, data is not encrypted. Embedding is claimed resistant only to first-order statistical tests. — [GitHub steghide](https://github.com/StefanoDeVuono/steghide)
- AlternativeTo marks Steghide as discontinued. OpenStego is Java with password-based encryption (BMP/PNG). OpenPuff is listed as free and open source handling images, MP3/WAV and several video formats with multi-layer encryption. SilentEye is open source, cross-platform, BMP/JPEG/WAV with plug-ins. DeepSound is free but proprietary (audio). — [AlternativeTo Steghide](https://alternativeto.net/software/steghide/), [Wikipedia-mirror tools table](https://ipfs.ssi.eecc.de/ipns/en.wikipedia-on-ipfs.org/wiki/Steganography_tools), [arXiv 2508.19323 tool review](https://arxiv.org/pdf/2508.19323), [AlternativeTo DeepSound](https://alternativeto.net/software/deepsound)
- stegcloak (KuroLabs) is pure JavaScript, compresses and encrypts the secret, then hides it in zero-width characters. MIT license. About 3,845 GitHub stars (older snapshot). npm weekly downloads reported as 362 (npm page) and 629 (Socket), snapshot dates unknown. — [npm](https://npmjs.com/package/stegcloak), [Socket](https://socket.dev/npm/package/stegcloak), [GitHub fork listing](https://github.com/0xflotus/stegcloak)

### Inferences

- Popularity by stars (stegcloak about 3.8k, steghide about 0.8k on one fork) versus weekly downloads (hundreds) suggests curiosity and CTF use, not production use.
- Steghide's known weaknesses from general knowledge (fixed-structure header, no authenticated encryption, JPEG/BMP/WAV/AU only) were NOT verified in this research. Treat as unconfirmed.

### Gaps

- No release dates or last-commit dates for OpenStego, OpenPuff, SilentEye, DeepSound, Stegano (Python), snow. Maintenance status unconfirmed except Steghide.
- Not researched: browser-based stego sites, mobile apps, user complaints.
- Cipher and KDF details for OpenStego, OpenPuff, stegcloak not confirmed.

## 2. Cryptocurrency angle

### Takeaway

Hiding seed phrases in images is widely written up but is security by obscurity with added failure modes (lossy re-save, lost toolchain, two secrets). The serious crypto-and-stego activity is on the attacker side: blockchain-hosted C2 (EtherHiding), image/SVG-hidden payloads, and wallet stealers. A defensive preview or inspection feature has clearer value than a "hide your seed" feature.

### Cited Findings

- Seed-in-photo guidance critiques: steganography is not encryption, so a detected payload can be read; encrypt first if at all; this adds a second key to lose; a lossy re-save of the image can break extraction; heirs may not know the toolchain. Promotional articles claim the opposite and should be discounted. — [Search synthesis from CoinGeek, Pulse, Chain.com, Monero Substack posts](https://coingeek.com/steganography-and-its-applications-in-bitcoin) (Trezor/Ledger official guidance was not retrieved)
- Brain wallets: a 2017 study (Vasek, Bonneau, Castellucci, Keith, Moore) found 884 brain wallets (about $100K) in use 2011 to 2015, and all but 21 were drained, usually within 24 h, often within minutes, by about a dozen competing "drainers". Root cause: unsalted single SHA-256 of a human passphrase. — [UCL paper](https://discovery.ucl.ac.uk/10154816/1/vasekfc16.pdf), [Tripwire](https://www.tripwire.com/state-of-security/research-attackers-drained-103000-out-of-bitcoin-wallets-protected-by-passwords)
- EtherHiding: Google GTIG (blog dated 16 Oct 2025) reported North Korean UNC5342 hiding JavaScript in smart contracts on Ethereum and BNB Smart Chain so the chain acts as a resilient C2. Chain: compromised WordPress sites and fake job interviews, JADESNOW downloader, INVISIBLEFERRET backdoor, aims at crypto theft and espionage. UNC5142 (financially motivated) used it since 2023. One outlet's timing differs (secondary-source discrepancy). — [Google Cloud blog](https://cloud.google.com/blog/topics/threat-intelligence/dprk-adopts-etherhiding), [Infosecurity](https://www.infosecurity-magazine.com/news/nk-hackers-etherhiding-steal-crypto/)
- Bitcoin Core v30 raised the default OP_RETURN relay limit from about 80 bytes (some sources say 83) to 100,000 bytes, so block and transaction size is now the practical cap. Operators can still cap with the deprecated `-datacarriersize`. Critics (e.g. Jimmy Song) predicted more junk data and inscriptions. — [Forklog](https://forklog.com/en/bitcoin-core-developers-release-controversial-update/), [The Block](https://www.theblock.co/post/357594/bitcoin-core-devs-merge-controversial-op_return-policy-change-into-planned-october-release)
- Stego plus Telegram in stealers: Vidar hides Base64 data in JPEG/TXT and exfiltrates via Telegram; North Korea-linked OtterCookie-aligned activity hid payloads in SVG flag images (The Hacker News, 17 Jul 2026, Elastic analysis); PXA Stealer loads a payload from an "images.png" and exfiltrates via Telegram; TeleClip is a Telegram-controlled clipboard hijacker over 23 coins (no stego evidence); OilRig used LSB PNG stego and Telegram. — [SC World Vidar](https://www.scworld.com/brief/vidar-infostealer-evolves-uses-image-files-for-stealthy-attacks), [SentinelOne PXA](https://www.sentinelone.com/?p=128686), [SonicWall TeleClip](https://www.sonicwall.com/blog/teleclip-a-native-64-bit-telegram-rat-with-multi-coin-crypto-clipboard-hijack-and-keylogger), [The Hacker News stego label](https://thehackernews.com/search/label/Steganography?hl=en_US)
- GlassWorm (Koi Security, Oct 2025) used invisible Unicode variation selectors to hide JavaScript in Open VSX and VS Code extensions, reaching 35,800+ installs, stealing npm/GitHub credentials and draining funds from 49 crypto extensions. Later waves occurred. — [Palo Alto](https://www.paloaltonetworks.com/blog/security-operations/glassworm-first-self-propagating-worm-using-invisible-code-hits-openvsx-marketplace/), [BleepingComputer third wave](https://www.bleepingcomputer.com/news/security/glassworm-malware-returns-in-third-wave-of-malicious-vs-code-packages/)

### Inferences

- A feature that detects and decodes hidden payloads (variation selectors, zero-width, tag characters, appended data, SVG scripts) in previewed files maps directly onto documented attacks that target developers' machines and crypto wallets.
- "Encrypt, then Shamir-split, then hide in images" adds fragility to a backup. Any seed-related feature would need strong warnings. SLIP-39 specifics were not researched.

### Gaps

- No search coverage of SLIP-39 (Trezor Shamir backup) or official Trezor/Ledger guidance on stego backups.
- No 2026 on-chain statistics on Ordinals/inscriptions volume; no NFT image stego sources beyond a Chain.com blog.
- Counts for "wallet-stealing malware using stego" in 2026 are anecdotal, not aggregate.

## 3. Legitimate uses: watermarking, provenance, regulation

### Takeaway

Provenance is now a regulated, standards-driven market (C2PA 2.x, EU AI Act Article 50) but real-world durability is weak because metadata is stripped. Per-recipient zero-width fingerprinting is an established but fragile leak-tracing technique.

### Cited Findings

- C2PA: Feb 2026 release of spec 2.3 with a claim of 6,000+ members and affiliates with live applications; deployment guidance dated July 2026 refers to version 2.4; TikTok joined the Steering Committee in July 2026; Google is bringing verification to Gemini, Search, and Chrome; OpenAI announced C2PA conformance. — [C2PA 2.3 launch](https://c2pa.org/the-c2pa-launches-content-credentials-2-3-and-celebrates-5-years-of-impact-across-the-digital-ecosystem/), [CAI State in 2026](https://contentauthenticity.org/blog/the-state-of-content-authenticity-in-2026), [Deployment Guidance PDF](https://c2pa.org/wp-content/uploads/sites/33/2026/07/Content-Credentials-Deployment-Guidance.pdf)
- Caveats: one March 2026 analysis found a wide gap between claimed support and certified conformance and very low user engagement; Nikon Z6 III signing was suspended after a vulnerability and certificates revoked; legacy ITL frozen 1 Jan 2026 in favor of the official C2PA Trust List. — [SoftwareSeni 2026 analysis](https://www.softwareseni.com/c2pa-adoption-in-2026-hardware-platforms-and-verification-reality) (secondary source, verify)
- Metadata stripping: Facebook, Instagram, X, YouTube reportedly strip metadata on upload; C2PA "soft binding" (watermark or perceptual fingerprint plus cloud manifest lookup) is the recovery path; Adobe's open-source TrustMark targets it. Critics note fuzzy fingerprint matching and dependence on a lookup service. — [CAI three pillars](https://contentauthenticity.org/blog/three-pillars-of-provenance), [CAI durable credentials](https://opensource.contentauthenticity.org/docs/durable-cr/), [SoftwareSeni durable](https://softwareseni.com/durable-content-credentials-how-provenance-survives-metadata-stripping)
- EU AI Act Article 50: Code of Practice on Transparency of AI-Generated Content published 10 June 2026 (first draft Dec 2025, second Mar 2026); Commission and AI Board confirmed it as adequate (July 2026); providers generally need multilayered machine-readable marking (one firm reads at least two layers); deployer obligations from 2 Aug 2026; Digital Omnibus defers Art. 50(2) marking for systems already on the market to 2 Dec 2026. Sources conflict slightly on the exact omnibus split, check Commission text. The code is voluntary. — [Commission code page](https://digital-strategy.ec.europa.eu/en/policies/code-practice-ai-generated-content), [Freshfields](https://www.freshfields.com/en/our-thinking/blogs/technology-quotient/eu-ai-act-unpacked-33-the-final-code-of-practice-on-transparency-of-ai-generate-102n4yx), [Faegre Drinker July 2026](https://www.faegredrinker.com/zh/insights/publications/2026/7/eu-ai-act-commission-confirms-transparency-code-of-practice-as-adequate-and-publishes-final-version-of-its-guidelines-on-transparency-obligations)
- SynthID Text is open source (Hugging Face Transformers, Responsible GenAI Toolkit), detector is probabilistic (watermarked / not / uncertain), weak on short or heavily rewritten or translated text, and Google says it does not stop motivated adversaries. SynthID Detector portal covers images, video, audio. — [Google AI docs](https://ai.google.dev/responsible/docs/safeguards/synthid), [eWeek](https://www.eweek.com/news/googles-synthid-detector-goes-public-with-openai-and-nvidia-support/)
- Zero-width fingerprinting: canary traps give each recipient a distinct copy; zero-width characters (e.g. U+200B/U+200C as bits) carry an ID that survives copy-paste; fragile against retyping, normalization, or pipelines that strip the characters; synonym-shuffling is a more robust alternative. — [Wikipedia canary trap](https://EN.wikipedia.com/wiki/Canary_trap), [Hackaday](https://hackaday.com/2018/04/15/hide-secret-messages-in-plain-sight-with-zero-width-characters), [gHacks](https://ghacks.net/2018/04/05/how-to-detect-zero-width-characters-fingerprinting), [arXiv 2603.28655](https://arxiv.org/html/2603.28655v1)

### Inferences

- A "reveal provenance" panel (read C2PA manifest, show soft-binding or watermark presence) fits a file-preview extension and tracks real regulatory demand.
- Zero-width leak tracing is feasible for Markdown/text but weak; document honestly.

### Gaps

- Camera-maker adoption specifics (Leica, Sony, Canon, Google Pixel, Samsung) and Adobe numbers not collected.
- Journalism/activist covert comms under censorship, CTF/education, forensic verification: not researched.
- Exact Article 50 omnibus dates should be confirmed on EUR-Lex.

## 4. AI-related hidden content

### Takeaway

Invisible Unicode and hidden text aimed at LLM agents is a documented, active attack class against coding assistants and VS Code ecosystems. Defenses are detection and normalization, and visual review is explicitly insufficient.

### Cited Findings

- Pillar Security's "Rules File Backdoor" (2025): hidden instructions in rules files using zero-width joiners, bidirectional markers and other invisible characters steer GitHub Copilot and Cursor to generate backdoored code; files spread via repos and templates; recommends auditing for invisible characters and treating AI config files like executable code. — [Pillar Security](https://pillar.security/blog/new-vulnerability-in-github-copilot-and-cursor-how-hackers-can-weaponize-code-agents), [Security Affairs](https://securityaffairs.com/175593/hacking/rules-file-backdoor-ai-code-editors-silent-supply-chain-attacks.html)
- Cloud Security Alliance research note (10 Mar 2026) on Unicode instruction injection in AI skills names the Tags block U+E0000 to U+E007F and zero-width characters, and says visual review is not a reliable defense. — [CSA note](https://labs.cloudsecurityalliance.org/wp-content/uploads/2026/03/CSA_research_note_unicode_instruction_injection_ai_skills_20260310-csa-styled-2.pdf)
- Promptfoo and Knostic also cover invisible-Unicode threats to coding agents. — [Promptfoo](https://www.promptfoo.dev/blog/invisible-unicode-threats/), [Knostic via NHI Mgmt](https://nhimg.org/articles/invisible-unicode-in-ai-coding-agents-is-a-supply-chain-risk/)
- Open-source detector example: anti-trojan-source flags Unicode format and control characters. — [Hacker News GlassWorm](https://thehackernews.com/2025/10/self-spreading-glassworm-infects-vs.html)

### Inferences

- MarkCopy previews Markdown (a common carrier of hidden agent instructions). A "hidden characters" lint in preview (Tags block, variation selectors, zero-width, bidi, HTML comments, off-screen or tiny text) is a defensible, differentiated feature.

### Gaps

- Low-contrast text in images/PDFs aimed at multimodal agents: no sources gathered.
- Vendor responses (GitHub, Cursor) and confirmed in-the-wild exploitation of rules-file backdoors not found.
- AI image-watermark attack robustness research not found.

## 5. Market and audience signal (VS Code Marketplace)

### Takeaway

Invisible-character highlighting exists as small extensions with modest, dated numbers; VS Code itself now highlights uncommon invisible characters. Nobody surfaced offers decode, provenance, or stego inspection in a preview.

### Cited Findings

- "Gremlins tracker" (nhoizey, MIT): author stated in Oct 2020 over 100,000 installs and about 300,000 downloads. No current count was found. VS Code since added built-in highlighting of uncommon invisible characters, which overlaps. — [Author note](https://nicolas-hoizey.com/notes/2020/10/05/1/), [Spectra Assure listing](https://secure.software/vscode/packages/nhoizey/gremlins)
- Malicious-extension context raises scrutiny: BleepingComputer reported malicious VS Code extensions with 229M installs found (headline). — [BleepingComputer](https://www.bleepingcomputer.com/news/security/malicious-vscode-extensions-with-229m-installs-found-on-microsoft-marketplace/)

### Inferences

- Existing extensions mostly highlight or strip. A gap is "decode and explain": show what a hidden payload says, where, and why it is suspicious, inside the preview.

### Gaps

- No current install counts for Gremlins tracker, Highlight Bad Chars, or any VS Code stego extension. Need direct Marketplace and Open VSX pages.

## 6. Legal and ethical boundaries

### Takeaway

Publicly available open-source encryption source is generally outside the EAR, with an email notification only for non-standard cryptography. No law against steganography per se was found or researched. Defensive framing (detect, inspect, verify, mark your own content) is low risk.

### Cited Findings

- 15 CFR 740.13(e) / 734.3(b)(3): publicly available encryption source code under ECCN 5D002 is not subject to the EAR, subject to notification (to BIS and the ENC Coordinator, with the source URL) for source implementing "non-standard cryptography". Standard cryptography needs no email. Corresponding object code is no longer subject to the EAR (2011 rule). Sources are 2000 to 2011 plus a Linux Foundation guidance page, so verify against the live eCFR. — [BIS](https://bis.gov/node/6731), [Federal Register 2011](https://regulations.justia.com/regulations/fedreg/2011/01/07/2010-32803.html), [Linux Foundation guidance](https://bestpractices.linuxfoundation.org/export/non-standard-cryptography.html)

### Inferences

- Using only platform or well-known primitives (WebCrypto, AES-GCM, Argon2/scrypt) keeps the project in "standard cryptography" territory, so likely no notification, but this is not legal advice.

### Gaps

- No sources found on: national laws on steganography use, VS Code Marketplace and Open VSX policies on security or dual-use tooling, EU/UK dual-use rules for crypto, or journalism/activist legal risk. These need a dedicated follow-up.
