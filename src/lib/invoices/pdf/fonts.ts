import { readFile } from "node:fs/promises";
import path from "node:path";

import type { InvoiceFonts } from "./render.ts";

/**
 * Noto Sans Regular and Bold (SIL Open Font License, assets/fonts/OFL.txt),
 * the only fonts on invoice PDFs (decision 33: English only). Read once per
 * server instance. next.config.ts traces assets/fonts into the server bundle.
 */
let cached: Promise<InvoiceFonts> | null = null;

export function loadInvoiceFonts(root = process.cwd()): Promise<InvoiceFonts> {
  cached ??= (async () => {
    const dir = path.join(root, "assets", "fonts");
    const [regular, bold] = await Promise.all([
      readFile(path.join(dir, "NotoSans-Regular.ttf")),
      readFile(path.join(dir, "NotoSans-Bold.ttf")),
    ]);
    return { regular: new Uint8Array(regular), bold: new Uint8Array(bold) };
  })().catch((error: unknown) => {
    cached = null;
    throw error;
  });
  return cached;
}
