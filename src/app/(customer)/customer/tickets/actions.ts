"use server";

import { refresh } from "next/cache";

import type { ActionResult } from "@/lib/action-result";
import { currentActor } from "@/lib/auth/current-user";
import type { ReadingErrors } from "@/lib/meter/readings";
import { sendCustomerDisputePhoto } from "@/lib/disputes/service";
import { submitCustomerReading } from "@/lib/meter/service";

/**
 * CP-03 / INV-01..06: the customer's meter reading. The photo is already in the
 * ticket's private folder (uploaded by the browser); the key makes a retry or a
 * double tap return the first result (INV-13).
 */
export async function submitMeterReadingAction(input: {
  ticketId: string;
  idempotencyKey: string;
  bw: string;
  colour: string;
  photoPath: string;
  capturedAt: string | null;
}): Promise<ActionResult<{ replayed: boolean }> & { fieldErrors?: ReadingErrors }> {
  const actor = await currentActor("CUSTOMER");
  const result = await submitCustomerReading(actor, input);
  if (result.ok) refresh();
  return result;
}

/** 11.4: the fresh live meter photo the rental company asked for during a dispute. */
export async function sendDisputePhotoAction(input: {
  ticketId: string;
  photoPath: string;
  capturedAt: string | null;
  bw: string;
  colour: string;
}): Promise<ActionResult & { fieldErrors?: Record<string, string> }> {
  const actor = await currentActor("CUSTOMER");
  // No refresh: the photo page would swap the success screen for "no photo needed"; the ticket page loads fresh.
  return sendCustomerDisputePhoto(actor, input);
}
