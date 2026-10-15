/**
 * Install prompt rules (decision 90). Shown only inside the portals (after sign-in,
 * never on /login), at most until it is dismissed or the app is installed, and never
 * when RentDesk already runs as an installed app.
 *   - Android (and desktop Chrome/Edge): the browser's own install dialog, offered
 *     through `beforeinstallprompt`.
 *   - iPhone and iPad: there is no install API, so step-by-step "Add to Home Screen".
 */

export const INSTALL_PROMPT_KEY = "rentdesk:install-prompt";

/** Where the root layout's head script keeps a `beforeinstallprompt` that fired before React. */
export const EARLY_INSTALL_EVENT = "__rentdeskInstallEvent";

/**
 * Inline head script (root layout): Chrome may fire `beforeinstallprompt` before the page
 * has hydrated, when no React listener exists yet and the event would be lost for this
 * page load. This catches it first; the install catcher takes it over when it mounts.
 */
export const CATCH_EARLY_INSTALL_EVENT = `addEventListener("beforeinstallprompt",function(e){e.preventDefault();window.${EARLY_INSTALL_EVENT}=e});`;

export type InstallState = "dismissed" | "installed";

export type InstallPlatform = "prompt" | "ios";

/** iPhone, iPod, or an iPad (iPadOS reports a Mac with a touch screen). */
export function isIos(userAgent: string, maxTouchPoints = 0): boolean {
  if (/iPhone|iPad|iPod/i.test(userAgent)) return true;
  return /Macintosh/i.test(userAgent) && maxTouchPoints > 1;
}

/** Which prompt to show now, if any. */
export function installPlatform(input: {
  userAgent: string;
  maxTouchPoints?: number;
  standalone: boolean;
  stored: string | null;
  hasPromptEvent: boolean;
}): InstallPlatform | null {
  if (input.standalone) return null;
  if (input.stored === "dismissed" || input.stored === "installed") return null;
  if (input.hasPromptEvent) return "prompt";
  if (isIos(input.userAgent, input.maxTouchPoints)) return "ios";
  return null;
}
