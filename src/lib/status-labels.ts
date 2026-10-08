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
