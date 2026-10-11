import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { DisputePhotoEntry } from "@/components/disputes/dispute-photo-entry";
import { BackLink } from "@/components/portal/back-link";
import { buttonVariants } from "@/components/ui/button";
import { uuidSchema } from "@/lib/accounts/schemas";
import { requireUser } from "@/lib/auth/current-user";
import { getDisputePhotoRequest } from "@/lib/disputes/service";
import { cn } from "@/lib/utils";

import { sendDisputePhotoAction } from "../../actions";

export const metadata: Metadata = { title: "Fresh meter photo" };

/** 11.4: the fresh live meter photo the rental company asked for to check a dispute. */
export default async function DisputePhotoPage({ params }: PageProps<"/customer/tickets/[id]/photo">) {
  const user = await requireUser("CUSTOMER");
  const { id } = await params;
  if (!uuidSchema.safeParse(id).success) notFound();
  const request = await getDisputePhotoRequest(user, id);
  if (!request) notFound();
  return (
    <div className="space-y-5">
      <div>
        <BackLink href={`/customer/tickets/${id}`} label="Ticket" />
        <h1 className="text-2xl font-bold tracking-tight">Fresh meter photo</h1>
        <p className="text-muted-foreground">{request.machine} · for your dispute</p>
      </div>
      {request.open ? (
        <DisputePhotoEntry ticketId={request.ticketId} ownerId={request.ownerId} machineType={request.machineType} note={request.note} action={sendDisputePhotoAction} />
      ) : (
        <div className="space-y-3">
          <p role="status" className="rounded-lg bg-muted px-3 py-2">No photo is needed now.</p>
          <Link href={`/customer/tickets/${id}`} className={cn(buttonVariants({ variant: "outline" }), "h-12 w-full text-base")}>
            Back to the ticket
          </Link>
        </div>
      )}
    </div>
  );
}
