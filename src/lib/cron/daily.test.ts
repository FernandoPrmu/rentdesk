import { describe, expect, it, vi } from "vitest";

import { PLATFORM_DEFAULTS } from "../tickets/deadlines";
import type { Rpc } from "../tickets/transitions";
import { buildEstimate, runDailyJob } from "./daily";
import type { CronTicket } from "./decide";

/**
 * Orchestration with a fake database: batching, the time budget, the run record.
 * The real behaviour against Postgres is in supabase/tests/cron.db.test.ts.
 */

const NOW = new Date("2026-10-10T01:00:00+05:30");
const storage = { removeMeterPhotos: vi.fn(async () => {}) };

function fakeRpc(handlers: Record<string, (args: Record<string, unknown>) => unknown>) {
  const calls: [string, Record<string, unknown>][] = [];
  const rpc: Rpc = async (fn, args) => {
    calls.push([fn, args]);
    if (fn in handlers) return handlers[fn](args);
    if (fn === "rpc_cron_begin_run") return { run_id: "run-1", skipped: false };
    if (fn === "rpc_cron_context") return { admin_ids: ["admin-1"], platform_late_fee: { enabled: false, fee_cents: 0, grace_days: 7 } };
    if (fn.startsWith("rpc_cron_")) return [];
    return {};
  };
  return { rpc, calls };
}

describe("runDailyJob", () => {
  it("records a run with its counts even when there is nothing to do", async () => {
    const { rpc, calls } = fakeRpc({});
    const result = await runDailyJob(rpc, storage, { now: NOW, trigger: "CRON" });
    expect(result.status).toBe("SUCCESS");
    expect(calls.at(-1)).toEqual(["rpc_cron_finish_run", expect.objectContaining({ p_run_id: "run-1", p_status: "SUCCESS", p_remaining: false })]);
  });

  it("does nothing when another run holds the lease", async () => {
    const { rpc, calls } = fakeRpc({ rpc_cron_begin_run: () => ({ run_id: "run-2", skipped: true }) });
    expect((await runDailyJob(rpc, storage, { now: NOW, trigger: "CRON" })).status).toBe("SKIPPED");
    expect(calls).toHaveLength(1);
  });

  it("catches up an agreement several cycles behind, one cycle per call", async () => {
    let next = 1;
    const { rpc, calls } = fakeRpc({
      rpc_cron_due_agreements: () =>
        next <= 3
          ? [{ agreement_id: "00000000-0000-4000-8000-000000000001", owner_id: "00000000-0000-4000-8000-000000000002", customer_id: "00000000-0000-4000-8000-000000000003", next_cycle_no: next, machine_name: "M", serial_no: "S", meter_deadline_days: 5 }]
          : [],
      rpc_open_billing_cycle: (args) => {
        next = (args.p_cycle_no as number) + 1;
        return { ticket_id: `t${args.p_cycle_no}`, replayed: false, flagged_overdue: (args.p_cycle_no as number) > 1 ? [(args.p_cycle_no as number) - 1] : [] };
      },
    });
    const result = await runDailyJob(rpc, storage, { now: NOW, trigger: "CRON" });
    expect(calls.filter(([fn]) => fn === "rpc_open_billing_cycle").map(([, a]) => a.p_cycle_no)).toEqual([1, 2, 3]);
    expect(result.counts).toMatchObject({ opened: 3, flaggedOverdue: 2 });
  });

  it("an agreement that keeps failing is tried once per run, not forever", async () => {
    const due = [{ agreement_id: "00000000-0000-4000-8000-000000000001", owner_id: "00000000-0000-4000-8000-000000000002", customer_id: "00000000-0000-4000-8000-000000000003", next_cycle_no: 1, machine_name: "M", serial_no: "S", meter_deadline_days: 5 }];
    const { rpc } = fakeRpc({
      rpc_cron_due_agreements: () => due,
      rpc_open_billing_cycle: () => {
        throw Object.assign(new Error("boom"), { code: "RD409" });
      },
    });
    const result = await runDailyJob(rpc, storage, { now: NOW, trigger: "CRON" });
    expect(result.status).toBe("PARTIAL");
    expect(result.errors).toEqual([expect.objectContaining({ step: "open", message: "boom" })]);
  });

  it("stops between items when the time budget is spent and says work remains", async () => {
    let t = 0;
    const tickets = Array.from({ length: 5 }, (_, i) => ({ id: `t${i}` }));
    const { rpc, calls } = fakeRpc({ rpc_cron_ticket_candidates: () => tickets });
    const result = await runDailyJob(rpc, storage, { now: NOW, trigger: "CRON", budgetMs: 100, clock: () => (t += 30) });
    expect(result.status).toBe("PARTIAL");
    expect(result.remaining).toBe(true);
    expect(calls.at(-1)).toEqual(["rpc_cron_finish_run", expect.objectContaining({ p_status: "PARTIAL", p_remaining: true })]);
  });

  it("deletes expired photos from storage before marking the rows", async () => {
    let served = false;
    const { rpc, calls } = fakeRpc({
      rpc_cron_expired_photos: () => (served ? [] : ((served = true), [{ id: "p1", storage_path: "o/t/p1.jpg" }])),
      rpc_mark_photos_deleted: () => 1,
    });
    const result = await runDailyJob(rpc, storage, { now: NOW, trigger: "CRON" });
    expect(storage.removeMeterPhotos).toHaveBeenCalledWith(["o/t/p1.jpg"]);
    expect(calls.find(([fn]) => fn === "rpc_mark_photos_deleted")?.[1]).toMatchObject({ p_ids: ["p1"] });
    expect(result.counts.photosDeleted).toBe(1);
  });
});

describe("orphan meter photos (rule 30)", () => {
  it("deletes uploaded photos no submission recorded, one batch per run", async () => {
    const removed: string[][] = [];
    const { rpc } = fakeRpc({ rpc_cron_orphan_photos: () => ["o/t/a.jpg", "o/t/b.jpg"] });
    const result = await runDailyJob(rpc, { removeMeterPhotos: async (p) => void removed.push(p) }, { now: NOW, trigger: "CRON" });
    expect(removed).toEqual([["o/t/a.jpg", "o/t/b.jpg"]]);
    expect(result.counts.photosDeleted).toBe(2);
  });
});

describe("buildEstimate (11.6, rule 13)", () => {
  it("bills the commitment only and takes customer credits off automatically", () => {
    const t = {
      machine_type: "COLOUR",
      commitment_cents: 1_000_000,
      bw_included: 3000,
      bw_rate_cents: 200,
      colour_included: 500,
      colour_rate_cents: 1000,
      credits: [{ id: "00000000-0000-4000-8000-0000000000c1", available_cents: 200_000, kind: "ADVANCE" }],
      settings: PLATFORM_DEFAULTS,
    } as unknown as CronTicket;
    const e = buildEstimate(t);
    expect(e).toMatchObject({ type: "ESTIMATED", cycles_covered: 1, subtotal_cents: 1_000_000, credit_applied_cents: 200_000, total_cents: 800_000 });
    expect(e.lines.map((l) => l.line_type)).toEqual(["COMMITMENT", "CREDIT"]);
    expect(e.calculation).toMatchObject({ type: "ESTIMATED", counters: [] });
  });

  it("makes the pending invoice PDFs last, once each per run; a failure stays pending and is reported", async () => {
    const generate = vi.fn(async (id: string) => {
      if (id === "inv-2") throw new Error("storage down");
      return { status: "CREATED" as const };
    });
    // A failed invoice stays pending, so the database keeps returning it.
    const { rpc, calls } = fakeRpc({ rpc_cron_pending_invoice_pdfs: () => ["inv-1", "inv-2"] });
    const result = await runDailyJob(rpc, storage, { now: NOW, trigger: "CRON" }, { generate });
    expect(generate.mock.calls.map(([id]) => id)).toEqual(["inv-1", "inv-2"]);
    expect(result.counts.pdfs).toBe(1);
    expect(result.status).toBe("PARTIAL");
    expect(result.errors).toEqual([expect.objectContaining({ step: "invoice pdf", id: "inv-2", message: "storage down" })]);
    const steps = calls.map(([fn]) => fn);
    expect(steps.indexOf("rpc_cron_pending_invoice_pdfs")).toBeGreaterThan(steps.indexOf("rpc_cron_overdue_summaries"));
  });

  it("makes pending receipt PDFs after the invoice PDFs, and purges unsent slips", async () => {
    const generateReceipt = vi.fn(async () => ({ status: "CREATED" as const }));
    const removePaymentSlips = vi.fn(async () => {});
    const { rpc, calls } = fakeRpc({ rpc_cron_pending_receipt_pdfs: () => ["rct-1"], rpc_cron_orphan_slips: () => ["o/c/s.jpg"] });
    const result = await runDailyJob(rpc, { ...storage, removePaymentSlips }, { now: NOW, trigger: "CRON" }, { generate: vi.fn(), generateReceipt });
    expect(generateReceipt).toHaveBeenCalledWith("rct-1", NOW);
    expect(removePaymentSlips).toHaveBeenCalledWith(["o/c/s.jpg"]);
    expect(result.counts).toMatchObject({ receiptPdfs: 1, slipsDeleted: 1 });
    const steps = calls.map(([fn]) => fn);
    expect(steps.indexOf("rpc_cron_pending_receipt_pdfs")).toBeGreaterThan(steps.indexOf("rpc_cron_pending_invoice_pdfs"));
  });

  it("without a PDF port the step is skipped", async () => {
    const { rpc, calls } = fakeRpc({});
    await runDailyJob(rpc, storage, { now: NOW, trigger: "CRON" });
    expect(calls.some(([fn]) => fn === "rpc_cron_pending_invoice_pdfs")).toBe(false);
  });
});
