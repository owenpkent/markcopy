// ASCII-only case folding for names that formats compare as bytes.
//
// String.prototype.toLowerCase and toUpperCase fold more than A to Z: the dotless
// i (U+0131) upper-cases to "I", and the Kelvin sign (U+212A) lower-cases to "k".
// A tool that compares names byte by byte (the JDK's zip reader, dpkg, the JAR
// manifest parser) never sees those as the ASCII letter, so a name that only
// matches after Unicode folding must not match here either.

/** Lower case for A to Z only; every other character, including non-ASCII letters, is left alone. */
export const asciiLower = (text: string): string =>
  text.replace(/[A-Z]+/g, (run) => run.toLowerCase());

/**
 * Whether an archive member name is META-INF/MANIFEST.MF as the JDK's zip reader
 * reads it (ZipFile.Source.isMetaName and isManifestName in jdk-21+35: each
 * letter is compared with `| 0x20`, which folds A to Z only).
 */
export const isJarManifestName = (name: string): boolean =>
  name.length === 20 && asciiLower(name) === 'meta-inf/manifest.mf';
