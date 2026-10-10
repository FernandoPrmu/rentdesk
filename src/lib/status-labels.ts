/** Plain-language labels for ticket and invoice statuses (spec 5.3, 6.6). */

export const TICKET_STATUS_LABEL: Record<string, string> = {
  METER_REQUESTED: "Meter requested",
  PENDING_OWNER_REVIEW: "Pending owner review",
  AWAITING_PAYMENT: "Awaiting payment",
  PAYMENT_SUBMITTED: "Payment submitted",
  CLOSED: "Closed",
  OVERDUE: "Overdue",
  PARTIALLY_PAID: "Partially paid",
  DISPUTED: "Disputed",
  CANCELLED: "Cancelled",
  REOPENED: "Reopened",
};

export const INVOICE_STATUS_LABEL: Record<string, string> = {
  DRAFT: "Draft",
  AWAITING_PAYMENT: "Awaiting payment",
  PAYMENT_SUBMITTED: "Payment submitted",
  PARTIALLY_PAID: "Partially paid",
  PAID: "Paid",
  OVERDUE: "Overdue",
  DISPUTED: "Disputed",
  REJECTED: "Rejected",
  CANCELLED: "Cancelled",
};

/** How money was paid (payments, refunds, money received upfront). */
export const PAYMENT_METHOD_LABEL: Record<string, string> = {
  BANK_TRANSFER: "Bank transfer",
  DEPOSIT: "Cash deposit at the bank",
  CASH: "Cash",
  CHEQUE: "Cheque",
  ONLINE: "Online payment",
  OTHER: "Other",
  SECURITY_DEPOSIT: "From security deposit",
};

/** LATE-01: the agreement's late fee setting. */
export const LATE_FEE_MODE_LABEL: Record<string, string> = {
  OWNER_DEFAULT: "Use my default",
  CUSTOM: "Custom amount",
  NONE: "No late fee",
};

/** DEP-01/02: money received at assignment. */
export const UPFRONT_TYPE_LABEL: Record<string, string> = {
  SECURITY_DEPOSIT: "Security deposit",
  ADVANCE_PAYMENT: "Advance payment",
};

/** Deposit ledger entries (DEP-03/04). */
export const DEPOSIT_KIND_LABEL: Record<string, string> = {
  RECEIVED: "Received",
  DEDUCTED: "Paid an invoice",
  REFUNDED: "Refunded",
  RETAINED: "Kept",
};

/** Payments (PAY-01..12): the owner's words and the customer's words. */
export const PAYMENT_STATUS_LABEL: Record<string, string> = {
  SUBMITTED: "Waiting for check",
  ACCEPTED: "Accepted",
  PARTIAL: "Part payment",
  REJECTED: "Not accepted",
  REVERSED: "Reversed",
};

export const CUSTOMER_PAYMENT_STATUS_LABEL: Record<string, string> = {
  SUBMITTED: "Being checked",
  ACCEPTED: "Accepted",
  PARTIAL: "Accepted (part)",
  REJECTED: "Not accepted",
  REVERSED: "Reversed",
};

export const CREDIT_KIND_LABEL: Record<string, string> = {
  OVERPAYMENT: "Overpayment",
  ADVANCE: "Advance payment",
  CANCELLED_INVOICE: "Paid on a cancelled invoice",
  ESTIMATE_RECONCILIATION: "Estimate",
  MANUAL: "Credit",
};

export const CREDIT_STATUS_LABEL: Record<string, string> = {
  AVAILABLE: "Available",
  APPLIED: "Used",
  REFUNDED: "Refunded",
  VOID: "Removed",
};

/** What the reference of a payment is called, by method. */
export const REFERENCE_LABEL: Record<string, string> = {
  BANK_TRANSFER: "Bank reference",
  DEPOSIT: "Deposit slip number",
  CHEQUE: "Cheque number",
  OTHER: "Reference",
  CASH: "Receipt book number",
};
