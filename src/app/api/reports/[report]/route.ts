import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { todayInColombo } from "@/lib/agreements/cycle-calendar";
import { blockReason } from "@/lib/auth/session-policy";
import { getCurrentUser } from "@/lib/auth/current-user";
import { BRANDING_BUCKET } from "@/lib/branding/files";
import { formatDateTime } from "@/lib/format";
import { loadInvoiceFonts } from "@/lib/invoices/pdf/fonts";
import { isOwnerReport, isReport, REPORT_INFO } from "@/lib/reports/catalogue";
import type { ReportDocument } from "@/lib/reports/document";
import { renderReportPdf } from "@/lib/reports/export/pdf";
import { reportXlsx } from "@/lib/reports/export/xlsx";
import { resolveRange } from "@/lib/reports/period";
import { loadOwnerReport, loadPlatformReport } from "@/lib/reports/queries";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

/**
 * GET /api/reports/{report}?format=pdf|xlsx&range=…[&from&to][&owner=…] — RPT-07.
 * Made on the server with the signed-in user's client, so RLS decides (an owner
 * gets their own tenant; an admin names the owner, which is logged as a support
 * view, decision 81). The same date filters as the screen. Every export is audited.
 */

const query = z.object({
  format: z.enum(["pdf", "xlsx"]),
  owner: z.uuid().optional(),
});

function problem(message: string, status: number) {
  return new NextResponse(message, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
}

async function logoBytes(path: string | null): Promise<Uint8Array | null> {
  if (!path) return null;
  const { data, error } = await createAdminClient().storage.from(BRANDING_BUCKET).download(path);
  if (error) return null;
  return new Uint8Array(await data.arrayBuffer());
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ report: string }> }) {
  const { report } = await params;
  if (!isReport(report)) return problem("Report not found.", 404);
  const sp = request.nextUrl.searchParams;
  const parsed = query.safeParse({ format: sp.get("format"), owner: sp.get("owner") ?? undefined });
  if (!parsed.success) return problem("Choose PDF or Excel.", 400);
  const { format, owner } = parsed.data;

  const user = await getCurrentUser();
  if (!user) return NextResponse.redirect(new URL("/login", request.url), 303);
  if (blockReason(user) || user.must_change_password) return problem("Please sign in again.", 401);

  const now = new Date();
  const today = todayInColombo(now);
  const info = REPORT_INFO[report];
  const range = resolveRange({ range: sp.get("range") ?? undefined, from: sp.get("from") ?? undefined, to: sp.get("to") ?? undefined }, today, info.defaultPreset);
  if (range.error) return problem(range.error, 400);

  const client = await createClient();
  const admin = createAdminClient();
  let doc: ReportDocument;
  let ownerId: string | null = null;

  if (isOwnerReport(report)) {
    if (user.role === "OWNER") {
      if (owner && owner !== user.id) return problem("Report not found.", 404);
      ownerId = user.id;
    } else if (user.role === "ADMIN" && owner) {
      ownerId = owner;
      // ADM-08: an admin export of an owner's report is a support view (who, when, which owner).
      const { error } = await admin.rpc("rpc_log_support_view", {
        p_admin_id: user.id,
        p_owner_id: owner,
        p_path: `/admin/owners/${owner}/support/reports/${report}?export=${format}`,
        p_reason: undefined,
      });
      if (error) return problem(error.code === "RD404" ? "Owner not found." : "Could not open the report.", error.code === "RD404" ? 404 : 500);
    } else {
      return problem("Report not found.", 404);
    }
    doc = (await loadOwnerReport(report, ownerId, range, { client, now, today })).doc;
  } else {
    if (user.role !== "ADMIN") return problem("Report not found.", 404);
    const loaded = await loadPlatformReport(range, { client, now });
    if (!loaded) return problem("Report not found.", 404);
    doc = loaded.doc;
  }

  await admin.rpc("rpc_write_audit", {
    p_actor_id: user.id,
    p_action: "REPORT_EXPORTED",
    p_entity: "reports",
    p_owner_id: ownerId ?? undefined,
    p_details: { report, format, from: range.from, to: range.to },
  });

  const base = `${report}-${info.range ? `${range.from}-to-${range.to}` : today}`;
  if (format === "xlsx") {
    const bytes = await reportXlsx(doc);
    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "content-disposition": `attachment; filename="${base}.xlsx"`,
        "cache-control": "no-store",
      },
    });
  }

  let company = { name: doc.company, address: null as string | null, phone: null as string | null, email: null as string | null };
  let logo: Uint8Array | null = null;
  if (ownerId) {
    const { data: profile } = await client
      .from("owner_company_profiles")
      .select("company_name, address, phone, email, logo_path")
      .eq("owner_id", ownerId)
      .maybeSingle();
    if (profile) {
      company = { name: profile.company_name, address: profile.address, phone: profile.phone, email: profile.email };
      logo = await logoBytes(profile.logo_path);
    }
  }
  const pdf = await renderReportPdf(doc, {
    company,
    assets: { logo, letterhead: null },
    fonts: await loadInvoiceFonts(),
    generatedLabel: formatDateTime(now),
    warn: (m) => console.warn(`[report pdf] ${m}`),
  });
  return new NextResponse(new Uint8Array(pdf.bytes), {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `attachment; filename="${base}.pdf"`,
      "cache-control": "no-store",
    },
  });
}
