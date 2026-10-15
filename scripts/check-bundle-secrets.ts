/**
 * Proves no secret reached the browser (task 12, CLAUDE.md rule 1). Run after
 * `npm run build`: `npm run check:bundle`. Scans every file the browser can download
 * (.next/static and public/, including the service worker) for:
 *   1. the actual values of the server-side secrets in the environment;
 *   2. any JSON Web Token whose payload says role "service_role";
 *   3. the names of server-only environment variables (a sign that server code was bundled);
 *   4. modules that must stay on the server (service-role client, server-only, pg).
 * Exits 1 with the file and the finding; prints only the variable name, never a value.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const SCAN = [join(ROOT, ".next", "static"), join(ROOT, "public")];
const TEXT = /\.(js|mjs|css|html|json|txt|map|webmanifest|svg)$/;

const SECRET_VARS = [
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_DB_URL",
  "CRON_SECRET",
  "RESEND_API_KEY",
  "RESEND_WEBHOOK_SECRET",
  "BREVO_SMTP_PASSWORD",
  "SUPABASE_ACCESS_TOKEN",
];
const SERVER_MARKERS = ["server-only cannot be imported", "createAdminClient", "pg-protocol", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_DB_URL", "CRON_SECRET", "RESEND_API_KEY"];

function files(dir: string): string[] {
  let out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out = out.concat(files(p));
    else if (TEXT.test(name)) out.push(p);
  }
  return out;
}

function serviceRoleJwts(text: string): number {
  let count = 0;
  for (const m of text.matchAll(/eyJ[A-Za-z0-9_-]{8,}\.(eyJ[A-Za-z0-9_-]{8,})\.[A-Za-z0-9_-]{8,}/g)) {
    try {
      const payload = JSON.parse(Buffer.from(m[1], "base64url").toString("utf8")) as { role?: string };
      if (payload.role === "service_role") count++;
    } catch {
      // Not a JWT.
    }
  }
  return count;
}

const secrets = SECRET_VARS.flatMap((name) => {
  const value = process.env[name];
  if (!value || value.length < 8) return [];
  const values = [value];
  // The database password on its own, from postgres://user:password@host/db.
  if (name === "SUPABASE_DB_URL") {
    try {
      const pw = decodeURIComponent(new URL(value).password);
      if (pw.length >= 8) values.push(pw);
    } catch {
      // Not a URL.
    }
  }
  return values.map((v) => ({ name, value: v }));
});

const all = SCAN.flatMap(files);
if (all.length === 0) {
  console.error("check:bundle: nothing to scan. Run `npm run build` first.");
  process.exit(1);
}

const findings: string[] = [];
for (const file of all) {
  const text = readFileSync(file, "utf8");
  const rel = relative(ROOT, file);
  for (const s of secrets) if (text.includes(s.value)) findings.push(`${rel}: the value of ${s.name}`);
  const jwts = serviceRoleJwts(text);
  if (jwts) findings.push(`${rel}: ${jwts} service_role JWT(s)`);
  for (const marker of SERVER_MARKERS) if (text.includes(marker)) findings.push(`${rel}: server-only marker "${marker}"`);
}

console.log(`check:bundle: scanned ${all.length} browser files for ${secrets.length} secret value(s) from the environment, service_role JWTs and ${SERVER_MARKERS.length} server-only markers.`);
if (secrets.length === 0) console.warn("check:bundle: no secret values in the environment; run with --env-file=.env.local to compare real values.");
if (findings.length) {
  for (const f of findings) console.error(`  FOUND ${f}`);
  process.exit(1);
}
console.log("check:bundle: clean.");
