import { Camera, CircleCheck, Clock, Gauge, Receipt, Star, TriangleAlert, Wrench } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { requestTitle } from "@/components/service/service-display";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { requireUser } from "@/lib/auth/current-user";
import { formatDate } from "@/lib/format";
import { formatRupees } from "@/lib/money";
import { customerServiceTasks } from "@/lib/service/queries";
import { listCustomerTicketRows } from "@/lib/tickets/queries";
import { type CustomerTask, customerHome } from "@/lib/tickets/view";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Home" };

/**
 * CP-01 / CP-02: what the customer must do now, from their open billing tickets.
 * One "Enter meter reading" task per machine (the newest ticket, covering every
 * month since the last confirmed reading), one "Pay" task per unpaid bill, and
 * what is waiting for the rental company. Service requests (CP-07): a repair to
 * confirm, a service to rate, and a button to ask for service.
 */
export default async function CustomerHomePage() {
  const user = await requireUser("CUSTOMER");
  const [rows, service] = await Promise.all([listCustomerTicketRows(user.id), customerServiceTasks(user.id)]);
  const { tasks, waiting } = customerHome(rows, new Date());
  const serviceTasks = service.toConfirm.length + service.toRate.length;

  return (
    <div className="space-y-5">
      <div>
        <p className="text-sm text-muted-foreground">Hello, {user.full_name || user.username}</p>
        <h1 className="text-2xl font-bold tracking-tight">What you need to do now</h1>
      </div>

      {service.toConfirm.map((r) => (
        <Card key={r.id} className="border-primary/50" data-testid="task-confirm-fix">
          <CardContent className="space-y-3">
            <div className="flex items-start gap-3">
              <Wrench className="mt-0.5 size-8 shrink-0 text-primary" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="text-lg font-semibold">Is it fixed?</p>
                <p className="text-sm text-muted-foreground">
                  {requestTitle(r)} · {r.machine.name}
                </p>
              </div>
            </div>
            <Link href={`/customer/service/${r.id}`} className={cn(buttonVariants(), "h-12 w-full text-base")}>
              Check and confirm
            </Link>
          </CardContent>
        </Card>
      ))}
      {service.toRate.map((r) => (
        <Link key={r.id} href={`/customer/service/${r.id}`} className="flex min-h-14 items-center gap-3 rounded-xl border bg-background px-4 py-3" data-testid="task-rate">
          <Star className="size-6 shrink-0 text-amber-500" aria-hidden />
          <span className="min-w-0">
            <span className="block font-medium">Rate the service</span>
            <span className="block truncate text-sm text-muted-foreground">
              {requestTitle(r)} · {r.machine.name}
            </span>
          </span>
        </Link>
      ))}

      {tasks.length === 0 && serviceTasks > 0 ? null : tasks.length === 0 ? (
        <Card>
          <CardContent className="flex items-center gap-4 py-2">
            <CircleCheck className="size-10 shrink-0 text-primary" aria-hidden />
            <div>
              <p className="text-lg font-semibold">Nothing right now</p>
              <p className="text-sm text-muted-foreground">When it is time to send your meter reading or pay a bill, it will show here.</p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <ul className="space-y-3" aria-label="Your tasks">
          {tasks.map((t) => (
            <li key={t.ticketId}>
              <TaskCard task={t} />
            </li>
          ))}
        </ul>
      )}

      <Link href="/customer/service/new" className={cn(buttonVariants({ variant: "outline" }), "h-14 w-full gap-2 text-base")} data-testid="home-request-service">
        <Wrench className="size-5" aria-hidden /> Machine problem or toner? Request service
      </Link>

      {waiting.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-lg font-semibold">With your rental company</h2>
          <ul className="divide-y overflow-hidden rounded-xl border bg-background">
            {waiting.map((w) => (
              <li key={w.ticketId}>
                <Link href={`/customer/tickets/${w.ticketId}`} className="flex min-h-14 items-center gap-3 px-4 py-3">
                  <Clock className="size-5 shrink-0 text-muted-foreground" aria-hidden />
                  <div className="min-w-0">
                    <p className="font-medium">{w.label}</p>
                    <p className="truncate text-sm text-muted-foreground">{w.machine}</p>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function TaskCard({ task }: { task: CustomerTask }) {
  if (task.kind === "PHOTO") {
    return (
      <Card data-testid="task-photo">
        <CardContent className="space-y-3">
          <div className="flex items-start gap-3">
            <Camera className="mt-0.5 size-8 shrink-0 text-primary" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="text-lg font-semibold">Send a fresh meter photo</p>
              <p className="text-sm text-muted-foreground">{task.machine} · your rental company needs it to check your dispute</p>
            </div>
          </div>
          <Link href={`/customer/tickets/${task.ticketId}/photo`} className={cn(buttonVariants(), "h-12 w-full text-base")}>
            Take the photo
          </Link>
        </CardContent>
      </Card>
    );
  }
  const meter = task.kind === "METER";
  const Icon = meter ? Gauge : Receipt;
  return (
    <Card className={cn(task.overdue && "border-destructive/50")} data-testid={meter ? "task-meter" : "task-pay"}>
      <CardContent className="space-y-3">
        <div className="flex items-start gap-3">
          <Icon className="mt-0.5 size-8 shrink-0 text-primary" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="text-lg font-semibold">{meter ? "Enter meter reading" : `Pay ${formatRupees(task.amountCents)}`}</p>
            <p className="text-sm text-muted-foreground">
              {task.machine}
              {meter && task.months > 1 ? ` · covers ${task.months} months` : ""}
              {!meter && task.invoiceNo ? ` · bill ${task.invoiceNo}` : ""}
            </p>
            {task.dueDate && (
              <p className="mt-1 text-sm font-medium" data-testid="task-deadline">
                {meter ? "Send by" : "Due"} {formatDate(task.dueDate)}
              </p>
            )}
          </div>
        </div>
        {task.overdue && (
          <p role="alert" className="flex items-center gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive">
            <TriangleAlert className="size-4 shrink-0" aria-hidden />
            {meter ? "This reading is late. Please send it as soon as you can." : "This bill is overdue. Please pay as soon as you can."}
          </p>
        )}
        <Link
          href={meter ? `/customer/tickets/${task.ticketId}/meter` : task.invoiceId ? `/customer/pay?invoice=${task.invoiceId}` : "/customer/pay"}
          className={cn(buttonVariants(), "h-12 w-full text-base")}
        >
          {meter ? "Enter meter reading" : "Pay and send slip"}
        </Link>
      </CardContent>
    </Card>
  );
}
