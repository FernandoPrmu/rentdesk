import { describe, expect, it } from "vitest";

import {
  barPercents,
  changePercent,
  incomeMonth,
  incomeTotals,
  machineProfit,
  machineTotals,
  marginPercent,
  onTimePercent,
  paymentBehaviour,
  tonerForecast,
  usageSeries,
} from "./maths";
import type { IncomeMonthRow, MachineRow, UsageRow } from "./types";

const month = (over: Partial<IncomeMonthRow> = {}): IncomeMonthRow => ({
  month: "2026-10-01",
  commitment_cents: 0,
  excess_cents: 0,
  other_cents: 0,
  discount_cents: 0,
  invoices: 0,
  payments_cents: 0,
  advances_cents: 0,
  deposits_kept_cents: 0,
  refunds_cents: 0,
  ...over,
});

describe("income (RPT-02, decision 77)", () => {
  it("invoiced = commitment + excess + other charges - discounts", () => {
    // Spec 6.3 colour case 2: Rs. 10,000 commitment + Rs. 2,800 excess; a Rs. 500 dispute credit.
    const m = incomeMonth(month({ commitment_cents: 1_000_000, excess_cents: 280_000, other_cents: 50_000, discount_cents: -50_000 }));
    expect(m.invoiced_cents).toBe(1_280_000);
  });

  it("collected = payments + advances + deposit kept - refunds; a deposit received is not income", () => {
    const m = incomeMonth(month({ payments_cents: 650_000, advances_cents: 200_000, deposits_kept_cents: 30_000, refunds_cents: -50_000 }));
    expect(m.collected_cents).toBe(830_000);
  });

  it("totals add every month, cents stay integers", () => {
    const rows = [
      incomeMonth(month({ month: "2026-09-01", commitment_cents: 1, payments_cents: 3, invoices: 1 })),
      incomeMonth(month({ commitment_cents: 2, payments_cents: 4, refunds_cents: -1, invoices: 2 })),
    ];
    const t = incomeTotals(rows);
    expect(t).toMatchObject({ commitment_cents: 3, payments_cents: 7, refunds_cents: -1, invoiced_cents: 3, collected_cents: 6, invoices: 3 });
    expect(Number.isInteger(t.collected_cents)).toBe(true);
  });

  it("change percent: rounded, signed, null without a base", () => {
    expect(changePercent(1_100_000, 1_000_000)).toBe(10);
    expect(changePercent(900_000, 1_000_000)).toBe(-10);
    expect(changePercent(1, 3)).toBe(-67);
    expect(changePercent(5, 0)).toBeNull();
    expect(changePercent(0, 0)).toBeNull();
  });
});

const machine = (over: Partial<MachineRow> = {}): MachineRow => ({
  id: "m",
  brand: "Canon",
  model: "iR",
  serial_no: "S1",
  type: "MONO",
  status: "RENTED",
  customer: "Perera",
  revenue_cents: 0,
  commitment_cents: 0,
  bw_excess_cents: 0,
  colour_excess_cents: 0,
  other_cents: 0,
  bw_copies: 0,
  colour_copies: 0,
  service_cost_cents: 0,
  toner_cost_cents: 0,
  requests: 0,
  toner_requests: 0,
  ...over,
});

describe("machine profitability (RPT-03, decision 79)", () => {
  it("profit = revenue - service cost, margin one decimal", () => {
    const m = machineProfit(machine({ revenue_cents: 1_280_000, service_cost_cents: 300_000 }));
    expect(m.profit_cents).toBe(980_000);
    expect(m.margin_percent).toBe(76.6);
    expect(m.name).toBe("Canon iR (S1)");
  });

  it("no cost: full margin; no revenue: no margin; cost above revenue: negative", () => {
    expect(machineProfit(machine({ revenue_cents: 500_000 })).margin_percent).toBe(100);
    expect(machineProfit(machine({ service_cost_cents: 10_000 })).margin_percent).toBeNull();
    const loss = machineProfit(machine({ revenue_cents: 100_000, service_cost_cents: 250_000 }));
    expect(loss.profit_cents).toBe(-150_000);
    expect(loss.margin_percent).toBe(-150);
  });

  it("totals and the overall margin", () => {
    const t = machineTotals([
      machineProfit(machine({ revenue_cents: 1_000_000, service_cost_cents: 100_000, bw_copies: 2600 })),
      machineProfit(machine({ revenue_cents: 500_000, service_cost_cents: 400_000, colour_copies: 700 })),
    ]);
    expect(t).toMatchObject({ revenue_cents: 1_500_000, service_cost_cents: 500_000, profit_cents: 1_000_000, bw_copies: 2600, colour_copies: 700 });
    expect(t.margin_percent).toBe(66.7);
    expect(marginPercent(1, 3)).toBe(33.3);
  });
});

describe("payment behaviour (RPT-05)", () => {
  it("on-time percent and label", () => {
    expect(onTimePercent({ paid_bills: 3, paid_on_time: 2 })).toBe(67);
    expect(onTimePercent({ paid_bills: 0, paid_on_time: 0 })).toBeNull();
    expect(paymentBehaviour({ paid_bills: 5, paid_on_time: 4, overdue_cents: 0 })).toBe("GOOD");
    expect(paymentBehaviour({ paid_bills: 5, paid_on_time: 3, overdue_cents: 0 })).toBe("LATE");
    expect(paymentBehaviour({ paid_bills: 5, paid_on_time: 5, overdue_cents: 1 })).toBe("OVERDUE");
    expect(paymentBehaviour({ paid_bills: 0, paid_on_time: 0, overdue_cents: 0 })).toBe("NONE");
  });
});

describe("toner forecast (RPT-06, decision 80)", () => {
  it("average interval after the last request", () => {
    const f = tonerForecast(["2026-07-01", "2026-08-01", "2026-09-01"], "2026-10-12");
    // 62 days over 2 intervals = 31.
    expect(f).toEqual({ everyDays: 31, nextDate: "2026-10-02", inDays: -10 });
  });

  it("order does not matter; needs two requests on different days", () => {
    expect(tonerForecast(["2026-09-01", "2026-07-01"], "2026-09-01")).toEqual({ everyDays: 62, nextDate: "2026-11-02", inDays: 62 });
    expect(tonerForecast(["2026-09-01"], "2026-09-01")).toBeNull();
    expect(tonerForecast(null, "2026-09-01")).toBeNull();
    expect(tonerForecast(["2026-09-01", "2026-09-01"], "2026-09-01")).toBeNull();
  });
});

describe("usage trends", () => {
  const rows: UsageRow[] = [
    { month: "2026-09-01", machine_id: "a", machine: "A", customer_id: "x", customer: "X", bw: 100, colour: 10 },
    { month: "2026-10-01", machine_id: "a", machine: "A", customer_id: "x", customer: "X", bw: 200, colour: 0 },
    { month: "2026-10-01", machine_id: "b", machine: "B", customer_id: "x", customer: "X", bw: 50, colour: 0 },
  ];

  it("per machine, biggest first", () => {
    const s = usageSeries(rows, "machine");
    expect(s.map((x) => x.id)).toEqual(["a", "b"]);
    expect(s[0]).toMatchObject({ totalBw: 300, totalColour: 10, bw: { "2026-09-01": 100, "2026-10-01": 200 } });
  });

  it("per customer sums its machines", () => {
    const [x] = usageSeries(rows, "customer");
    expect(x).toMatchObject({ id: "x", totalBw: 350, bw: { "2026-10-01": 250 } });
  });

  it("bar lengths relative to the largest value", () => {
    expect(barPercents([50, 100, 0])).toEqual([50, 100, 0]);
    expect(barPercents([0, 0])).toEqual([0, 0]);
    expect(barPercents([-50, 100])).toEqual([50, 100]);
  });
});
