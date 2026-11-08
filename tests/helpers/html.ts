/**
 * The text of an HTML fragment with its tags taken out.
 *
 * A character scan rather than a `/<[^>]*>/g` replace: a single regex pass
 * leaves `<<b>script>` as `<script>`, and the code scanner flags the pattern as
 * an incomplete sanitizer even in a test helper.
 */
export function stripTags(html: string): string {
  let out = '';
  let inTag = false;
  for (const ch of html) {
    if (inTag) {
      if (ch === '>') {
        inTag = false;
      }
    } else if (ch === '<') {
      inTag = true;
    } else {
      out += ch;
    }
  }
  return out;
}
