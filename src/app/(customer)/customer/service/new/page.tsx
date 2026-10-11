import type { Metadata } from "next";

import { BackLink } from "@/components/portal/back-link";
import { RaiseForm } from "@/components/service/raise-form";
import { todayInColombo } from "@/lib/agreements/cycle-calendar";
import { requireUser } from "@/lib/auth/current-user";
import { getRaiseForm } from "@/lib/service/service";
import { SERVICE_TYPES, type ServiceType } from "@/lib/service/states";

import { raiseServiceAction } from "../actions";

export const metadata: Metadata = { title: "Request service" };

/**
 * SRV-01 / CP-07: raise a service request. `?machine=<id>` picks the machine (from
 * the Machines tab, and later a QR code on the machine, MAC-06); `?type=TONER`
 * picks the type.
 */
export default async function NewServiceRequestPage({ searchParams }: PageProps<"/customer/service/new">) {
  const user = await requireUser("CUSTOMER");
  const params = await searchParams;
  const machine = typeof params.machine === "string" ? params.machine : undefined;
  const type = typeof params.type === "string" && (SERVICE_TYPES as readonly string[]).includes(params.type) ? (params.type as ServiceType) : undefined;
  const form = await getRaiseForm(user);
  return (
    <div className="space-y-5">
      <div>
        <BackLink href="/customer/service" label="My requests" />
        <h1 className="text-2xl font-bold tracking-tight">Request service</h1>
        <p className="text-muted-foreground">Toner, a repair, a part or a service visit.</p>
      </div>
      <RaiseForm
        machines={form.machines}
        ownerId={form.ownerId}
        customerId={user.id}
        initialMachineId={machine}
        initialType={type}
        today={todayInColombo()}
        action={raiseServiceAction}
      />
    </div>
  );
}
