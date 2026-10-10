/**
 * RentDesk is English only (decision 33). Every text that can appear on an
 * invoice or its PDF (company, bank, customer, machine and location details,
 * payment instructions) must use characters the embedded Latin font (Noto Sans)
 * can draw: printable ASCII, line breaks, and the curly quotes, dashes and
 * ellipsis that phone keyboards insert on their own.
 */

export const ENGLISH_ONLY_MESSAGE = "Please use English letters only.";

/** Curly quotes, en and em dash, ellipsis: typed automatically by phone keyboards. */
const TYPOGRAPHIC = "‘’“”–—…";

const ALLOWED_CHAR = new RegExp(`[\\x20-\\x7E\\t\\r\\n${TYPOGRAPHIC}]`, "u");
const ALLOWED_TEXT = new RegExp(`^[\\x20-\\x7E\\t\\r\\n${TYPOGRAPHIC}]*$`, "u");

/** True when every character can be typed on an invoice. */
export function isEnglishText(value: string): boolean {
  return ALLOWED_TEXT.test(value);
}

/** Zod refinement arguments: `schema.refine(...englishOnly)`. */
export const englishOnly = [isEnglishText, ENGLISH_ONLY_MESSAGE] as const;

/**
 * Defence in depth for the PDF renderer (old data, or data written before the
 * rule existed): every unsupported character becomes "?", tabs become spaces,
 * carriage returns are dropped. Returns the text and the characters replaced.
 */
export function toPdfText(value: string): { text: string; replaced: string[] } {
  const replaced: string[] = [];
  let text = "";
  for (const ch of value.replace(/\r\n?/g, "\n")) {
    if (ch === "\t") text += " ";
    else if (ALLOWED_CHAR.test(ch)) text += ch;
    else {
      replaced.push(ch);
      text += "?";
    }
  }
  return { text, replaced };
}
