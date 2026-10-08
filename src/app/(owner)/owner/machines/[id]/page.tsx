import { ArrowLeftRight, Pencil, Undo2, UserPlus } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { setMachineStatusAction } from "@/app/(owner)/owner/machines/actions";
import { Facts } from "@/components/agreements/agreement-display";
import { MachineStatusBadge, MachineTypeBadge } from "@/components/machines/machine-badges";
import { MachineStatusButton } from "@/components/machines/machine-status-dialog";
import { BackLink } from "@/components/portal/back-link";
import { PageHeader } from "@/components/portal/portal-shell";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { uuidSchema } from "@/lib/accounts/schemas";
import { requireUser } from "@/lib/auth/current-user";
import { formatCount, formatDate } from "@/lib/format";
import { getMachine } from "@/lib/machines/queries";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Machine" };

const actionLink = cn(buttonVariants({ variant: "outline" }), "h-12 gap-2 text-base");

export default async function MachineDetailPage({ params, searchParams }: PageProps<"/owner/machines/[id]">) {
  await requireUser("OWNER");
  const { id } = await params;
  if (!uuidSchema.safeParse(id).success) notFound();
  // RLS: another owner's machine is simply "not found".
  const machine = await getMachine(id);
  if (!machine) notFound();
  const { returned } = await searchParams;
  const current = machine.current;
  const past = machine.agreements.filter((a) => a.status === "TERMINATED");

  return (
    <div className="max-w-3xl space-y-5">
      <div>
        <BackLink href="/owner/machines" label="Machines" />
        <PageHeader title={`${machine.brand} ${machine.model}`} description={`Serial number ${machine.serial_no}`} />
        <div className="-mt-3 flex flex-wrap gap-2">
          <MachineTypeBadge type={machine.type} />
          <MachineStatusBadge status={machine.status} />
        </div>
      </div>

      {returned && (
        <p role="status" className="rounded-lg bg-primary/5 px-3 py-2 text-sm">
          The machine was returned and is available again.
        </p>
      )}

      <Card>
        <CardHeader>
          <CardTitle>{current ? "Rented to" : "Not rented"}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {current ? (
            <Facts
              items={[
                ["Customer", <Link key="c" href={`/owner/customers/${current.customer.id}`} className="text-primary hover:underline">{current.customer.name}</Link>],
                ["Location", current.installation_location ?? "—"],
                ["Started", formatDate(current.start_date)],
                ["First billing date", formatDate(current.first_billing_date)],
                ["Agreement", <Link key="a" href={`/owner/agreements/${current.id}`} className="text-primary hover:underline">View terms and history</Link>],
              ]}
            />
          ) : (
            <p className="text-sm text-muted-foreground">
              {machine.status === "AVAILABLE" ? "Assign it to a customer to start billing." : "Set it to Available before assigning it."}
            </p>
          )}
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
            {machine.status === "AVAILABLE" && (
              <Link href={`/owner/machines/${id}/assign`} className={cn(buttonVariants(), "h-12 gap-2 text-base")}>
                <UserPlus className="size-5" aria-hidden /> Assign to a customer
              </Link>
            )}
            {current && (
              <>
                <Link href={`/owner/machines/${id}/return`} className={actionLink}>
                  <Undo2 className="size-5" aria-hidden /> Return
                </Link>
                <Link href={`/owner/machines/${id}/reassign`} className={actionLink}>
                  <ArrowLeftRight className="size-5" aria-hidden /> Reassign
                </Link>
              </>
            )}
            <Link href={`/owner/machines/${id}/edit`} className={actionLink}>
              <Pencil className="size-5" aria-hidden /> Edit details
            </Link>
            {machine.status !== "RENTED" && <MachineStatusButton status={machine.status} action={setMachineStatusAction.bind(null, id)} />}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Details</CardTitle>
        </CardHeader>
        <CardContent>
          <Facts
            items={[
              ["Purchase date", machine.purchase_date ? formatDate(machine.purchase_date) : "—"],
              ["B&W counter maximum", machine.bw_counter_max !== null ? formatCount(machine.bw_counter_max) : "—"],
              ...(machine.type === "COLOUR"
                ? ([["Colour counter maximum", machine.colour_counter_max !== null ? formatCount(machine.colour_counter_max) : "—"]] as [string, string][])
                : []),
              ["Notes", machine.notes ?? "—"],
            ]}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Rental history</CardTitle>
        </CardHeader>
        <CardContent>
          {past.length === 0 ? (
            <p className="text-sm text-muted-foreground">No earlier rentals.</p>
          ) : (
            <ul className="divide-y text-sm">
              {past.map((a) => (
                <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
                  <div>
                    <Link href={`/owner/agreements/${a.id}`} className="font-medium text-primary hover:underline">
                      {a.customer.name}
                    </Link>
                    <p className="text-muted-foreground">
                      {formatDate(a.start_date)} – {a.end_date ? formatDate(a.end_date) : "—"}
                      {a.termination_reason ? ` · ${a.termination_reason}` : ""}
                    </p>
                  </div>
                  <Badge variant="outline">
                    Closing B&W {a.closing_bw_reading !== null ? formatCount(a.closing_bw_reading) : "—"}
                    {a.closing_colour_reading !== null ? `, colour ${formatCount(a.closing_colour_reading)}` : ""}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Meter history</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Confirmed meter readings per cycle will be listed here once billing cycles are in use.
        </CardContent>
      </Card>
    </div>
  );
}
