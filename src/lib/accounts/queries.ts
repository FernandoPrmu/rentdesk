import "server-only";

import type { AccountStatusValue } from "@/lib/accounts/schemas";
import { createClient } from "@/lib/supabase/server";

/**
 * Account lists and details for the admin and owner portals. These run as the
 * signed-in user, so RLS decides what is visible: an admin reads every owner, an
 * owner reads only their own customers (AUTH-07).
 */

export interface AccountFilter {
  q?: string;
  status?: AccountStatusValue;
}

/** Characters that are safe inside a PostgREST `or=(...)` filter value. */
export function searchTerm(q: string | undefined): string | null {
  const cleaned = (q ?? "").replace(/[^\p{L}\p{N} .@+-]/gu, " ").replace(/\s+/g, " ").trim();
  return cleaned.length > 0 ? cleaned.slice(0, 80) : null;
}

const OWNER_COLUMNS =
  "id, business_name, contact_person, phone, email, address, created_at, profile:profiles!owners_id_fkey!inner(username, status, last_login_at, must_change_password)";

export async function listOwners(filter: AccountFilter) {
  const supabase = await createClient();
  let query = supabase.from("owners").select(OWNER_COLUMNS).order("business_name");
  if (filter.status) query = query.eq("profile.status", filter.status);

  const term = searchTerm(filter.q);
  if (term) {
    const like = `%${term}%`;
    // Quoted, so dots and spaces in the term cannot break the or=(...) syntax.
    const quoted = `"${like}"`;
    const { data: byUsername } = await supabase.from("profiles").select("id").eq("role", "OWNER").ilike("username", like).limit(50);
    const ids = (byUsername ?? []).map((r) => r.id);
    const conditions = [`business_name.ilike.${quoted}`, `contact_person.ilike.${quoted}`, `phone.ilike.${quoted}`, `email.ilike.${quoted}`];
    if (ids.length > 0) conditions.push(`id.in.(${ids.join(",")})`);
    query = query.or(conditions.join(","));
  }

  const { data, error } = await query.limit(200);
  if (error) throw new Error(`owners: ${error.message}`);
  return data;
}

export async function getOwner(id: string) {
  const supabase = await createClient();
  const { data, error } = await supabase.from("owners").select(OWNER_COLUMNS).eq("id", id).maybeSingle();
  if (error) throw new Error(`owner: ${error.message}`);
  return data;
}

const CUSTOMER_COLUMNS =
  "id, name, business_name, phone, email, address, created_at, profile:profiles!customers_profile_fkey!inner(username, status, last_login_at, must_change_password)";

export async function listCustomers(filter: AccountFilter) {
  const supabase = await createClient();
  let query = supabase.from("customers").select(CUSTOMER_COLUMNS).order("name");
  if (filter.status) query = query.eq("profile.status", filter.status);

  const term = searchTerm(filter.q);
  if (term) {
    const like = `%${term}%`;
    // Quoted, so dots and spaces in the term cannot break the or=(...) syntax.
    const quoted = `"${like}"`;
    const { data: byUsername } = await supabase.from("profiles").select("id").eq("role", "CUSTOMER").ilike("username", like).limit(50);
    const ids = (byUsername ?? []).map((r) => r.id);
    const conditions = [`name.ilike.${quoted}`, `business_name.ilike.${quoted}`, `phone.ilike.${quoted}`, `email.ilike.${quoted}`];
    if (ids.length > 0) conditions.push(`id.in.(${ids.join(",")})`);
    query = query.or(conditions.join(","));
  }

  const { data, error } = await query.limit(500);
  if (error) throw new Error(`customers: ${error.message}`);
  return data;
}

export async function getCustomer(id: string) {
  const supabase = await createClient();
  const { data, error } = await supabase.from("customers").select(CUSTOMER_COLUMNS).eq("id", id).maybeSingle();
  if (error) throw new Error(`customer: ${error.message}`);
  return data;
}

export type OwnerRow = NonNullable<Awaited<ReturnType<typeof getOwner>>>;
export type CustomerRow = NonNullable<Awaited<ReturnType<typeof getCustomer>>>;
