Photocopy Rental Management Platform  |  System Requirements and Design

**CIIGUS SOFTWARE**

**Photocopy Machine Rental Management Platform**

System Requirements and Design Document

| **Item** | **Detail** |
| --- | --- |
| **Project** | Photocopy Rental Management Platform (working name: RentDesk) |
| **Prepared by** | Ciigus Software |
| **Version** | 1.1 (Draft for review) |
| **Date** | 5 October 2026 |
| **Changes in 1.1** | Added the ticket-based monthly collection process (Section 5) and handling of negative scenarios (Section 11). |
| **Stakeholders** | Admin (Ciigus), Rental Machine Owners, Customers |

# Contents

- Introduction

- System Overview

- User Roles and Account Management

- Functional Requirements

- Monthly Collection Process (Billing Cycle)

- Meter Reading and Invoicing

- Service Request Management

- Payment Tracking and Reminders

- Notifications

- Reports and Dashboards

- Exception and Negative Scenario Handling

- Data Model

- Non-Functional Requirements

- Suggested Technology Stack

- Implementation Phases

- Assumptions, Risks and Open Questions

# 1. Introduction

## 1.1 Purpose

This document describes the requirements and proposed design of a centralized digital platform for managing photocopy machine rentals. It connects customers and rental machine owners and gives the Admin (Ciigus) control over the whole system.

## 1.2 Background and Problem Statement

Many photocopy machine owners rent their machines to a large number of customers. The current manual process causes several problems:

- Monthly rental payments are hard to track, so some are missed or collected late.

- When a machine breaks down, customers cannot always reach the owner quickly to request repairs.

- Requests for toner, spare parts, and maintenance depend on direct contact with the owner.

- Owners lack a simple view of monthly income, machine usage, outstanding payments, service requests, and toner needs.

## 1.3 Objectives

- Reduce manual work and minimize missed rental payments.

- Let customers report breakdowns and request toner, spare parts, and maintenance directly in the system.

- Run the monthly collection as a ticket-based cycle: meter submission, owner confirmation, payment slip submission, and owner verification.

- Give owners visibility and control over income, usage, outstanding payments, and service workload.

- Give the Admin (Ciigus) tools to onboard, manage, and monitor owners and the overall system.

## 1.4 Scope

**In scope:** account provisioning, customer, machine and agreement management, the ticket-based monthly collection cycle (meter submission, invoice confirmation, payment slip submission, and verification), meter-based invoicing, payment tracking and reminders, service/toner/spare-part requests, notifications, reports, admin management, and handling of exceptions and negative scenarios.

**Out of scope (initial release):** inventory/stock management of toner and spare parts, accounting-system integration, and technician route planning. Online payment gateway integration is optional (Phase 3).

## 1.5 Stakeholders

| **Stakeholder** | **Description** | **Main needs** |
| --- | --- | --- |
| **Admin (Ciigus)** | Platform operator who manages owners and monitors the system. | Onboard owners, control access, monitor activity, support. |
| **Rental Machine Owner** | Business that owns machines and rents them to customers. | Track payments, manage customers and machines, handle requests, view reports. |
| **Customer** | Business or person renting one or more machines from an owner. | Submit meter readings, view invoices, pay on time, request service quickly. |

## 1.6 Definitions

| **Term** | **Meaning** |
| --- | --- |
| **Meter reading** | The copy counter value shown on a machine. Colour machines have a B&W counter and a colour counter. |
| **Monthly commitment** | Fixed monthly charge a customer pays, which includes a set volume of copies. |
| **Included copies** | Number of copies covered by the monthly commitment (separate for B&W and colour). |
| **Excess copies** | Copies above the included volume, charged at the excess rate. |
| **Ticket** | A task or request item sent to the owner (invoice approval or service request). |
| **Billing cycle** | The recurring period (default 30 days) after which a new meter reading, invoice, and payment are due. |
| **Billing cycle ticket** | One ticket per machine per cycle that moves between customer and owner through meter submission, invoice confirmation, payment, and verification. |
| **Payment slip** | Proof of payment (photo or PDF) attached by the customer and checked by the owner. |
| **Tenant** | One owner's isolated set of customers, machines, and data. |

# 2. System Overview

## 2.1 Concept

The platform is a multi-tenant web system. Each owner is a tenant with an isolated set of customers, machines, agreements, invoices, and requests. Ciigus operates the platform above all tenants.

## 2.2 Account Hierarchy

| **Admin (Ciigus)  →  creates Owner  →  creates Customer** There is no public registration. Every account is created by the role above it, and login details are passed to the new user. |
| --- |

## 2.3 Portals

| **Portal** | **Users** | **Key functions** |
| --- | --- | --- |
| **Admin portal** | Ciigus staff | Owner management, system dashboard, settings, audit logs, subscriptions (optional). |
| **Owner portal** | Machine owners and their staff | Customers, machines, agreements, invoice approval tickets, service requests, payments, reports. |
| **Customer portal (mobile-first)** | Renting customers | Enter meter, invoices, payment history, service requests, notifications. |

## 2.4 High-Level Architecture

- **Web front end:** responsive admin and owner portals, plus a mobile-first customer app (PWA) with camera access.

- **Backend API:** authentication, role-based access, billing engine, ticketing, and reporting.

- **Database:** relational database with every record scoped to its owner (tenant).

- **Private file storage:** holds meter photos temporarily (deleted when the owner confirms the invoice) and payment slips (kept as payment proof).

- **Scheduler/job queue:** 30-day cycle ticket creation, stage reminders, escalations, and photo clean-up.

- **Notification services:** email (required), SMS and WhatsApp (recommended), in-app notifications.

# 3. User Roles and Account Management

## 3.1 Roles and Permissions

| **Capability** | **Admin** | **Owner** | **Customer** |
| --- | --- | --- | --- |
| **Create owner accounts** | Yes | No | No |
| **Create customer accounts** | No | Yes (own) | No |
| **Manage machines and agreements** | View (support) | Yes (own) | View own |
| **Enter meter reading** | No | Manual entry if needed | Yes |
| **Review, confirm, or reject meter submissions** | No | Yes | No |
| **Submit payment slip** | No | No | Yes |
| **Verify payments and close tickets** | No | Yes | No |
| **Billing cycle ticket** | Monitor and escalation | Review and close | Submit and pay |
| **Raise service requests** | No | No | Yes |
| **Manage service requests** | No | Yes | Track own |
| **Reports** | System-wide | Own business | Own history |
| **Suspend accounts** | Owners | Own customers | No |

## 3.2 Account Provisioning Flow

- Admin creates an owner account (business name, contact details, status, plan). The system generates a username and temporary password.

- Admin passes the login details to the owner (email/SMS/WhatsApp, or one-time on-screen display).

- Owner logs in and is forced to change the password.

- Owner creates customer accounts and assigns machines and agreements. The system generates customer login details.

- Owner passes the login details to the customer.

- Customer logs in, changes the password, and starts using the portal.

## 3.3 Account Rules

| **Area** | **Rule** |
| --- | --- |
| **Passwords** | Temporary password with forced change at first login; hashed storage (bcrypt/argon2); shown only once; never stored in plain text. |
| **Password reset** | Admin resets owner passwords; owners reset customer passwords. |
| **Status control** | Accounts can be Active, Suspended, or Deactivated. |
| **Cascade** | Suspending an owner also blocks login for all of that owner's customers. |
| **Data isolation** | Owners see only their own data; customers see only their own records. |
| **Login security** | Rate limiting and lockout after repeated failed attempts; optional OTP for owners. |
| **Audit** | Account creation, resets, status changes, and logins are logged with user and time. |

# 4. Functional Requirements

Priority: **Must** = required for release, **Should** = important, **Could** = optional or later.

## 4.1 Authentication and Security (AUTH)

| **ID** | **Requirement** | **Priority** |
| --- | --- | --- |
| AUTH-01 | No public registration; accounts are created only by the role above (Admin → Owner, Owner → Customer). | Must |
| AUTH-02 | System generates username and temporary password when an account is created. | Must |
| AUTH-03 | Users must change the temporary password at first login. | Must |
| AUTH-04 | Passwords are stored only as salted hashes; the temporary password is shown once. | Must |
| AUTH-05 | Parent role can reset a password (Admin for owners, Owner for customers). | Must |
| AUTH-06 | Role-based access control for ADMIN, OWNER, and CUSTOMER. | Must |
| AUTH-07 | Tenant isolation: users access only data permitted for their role and owner. | Must |
| AUTH-08 | Login rate limiting and temporary lockout after repeated failures. | Must |
| AUTH-09 | Secure sessions with expiry; all traffic over HTTPS. | Must |
| AUTH-10 | Suspending an owner blocks that owner's customers from logging in. | Must |
| AUTH-11 | Audit log for account creation, resets, status changes, and logins. | Should |
| AUTH-12 | Optional OTP/two-factor login for Admin and Owner users. | Could |

## 4.2 Admin Portal (ADM)

| **ID** | **Requirement** | **Priority** |
| --- | --- | --- |
| ADM-01 | Create, view, and edit owner accounts (business name, contact person, phone, email, address). | Must |
| ADM-02 | Activate, suspend, or deactivate owners. | Must |
| ADM-03 | Reset owner passwords and deliver credentials. | Must |
| ADM-04 | System dashboard: number of owners, customers, machines, invoices, and open requests. | Should |
| ADM-05 | View audit logs and notification delivery logs. | Should |
| ADM-06 | Configure global settings: default reminder schedule, message templates, branding. | Should |
| ADM-07 | Manage owner subscription plans and platform billing. | Could |
| ADM-08 | Read-only support view of an owner's data (logged). | Could |

## 4.3 Customer Management (CUS)

| **ID** | **Requirement** | **Priority** |
| --- | --- | --- |
| CUS-01 | Owner creates, edits, and views customers (name, business, contact, address, email, phone). | Must |
| CUS-02 | System generates customer login; owner passes it to the customer. | Must |
| CUS-03 | Owner can suspend, reactivate, or deactivate customers and reset passwords. | Must |
| CUS-04 | Customer profile showing machines, agreements, invoices, payments, and requests. | Must |
| CUS-05 | Search and filter customers by name, status, or outstanding balance. | Should |

## 4.4 Machine Management (MAC)

| **ID** | **Requirement** | **Priority** |
| --- | --- | --- |
| MAC-01 | Register machines: brand, model, serial number, type (MONO or COLOUR), purchase date, status. | Must |
| MAC-02 | Assign a machine to a customer with installation location and initial meter readings. | Must |
| MAC-03 | Machine status: Available, Rented, Under Repair, Retired. | Must |
| MAC-04 | Return or reassign a machine and record the closing meter readings. | Must |
| MAC-05 | Machine history: rentals, service, toner, and spare parts. | Should |
| MAC-06 | QR code on each machine that opens a pre-filled service request. | Could |

## 4.5 Rental Agreements (AGR)

| **ID** | **Requirement** | **Priority** |
| --- | --- | --- |
| AGR-01 | Create an agreement: customer, machine, start date, billing day, due days, monthly commitment, included B&W copies, B&W excess rate, and for colour machines the included colour copies and colour excess rate. | Must |
| AGR-02 | Edit or terminate agreements; changes apply from the next billing period and history is kept. | Must |
| AGR-03 | Track agreement end/renewal dates with reminders to the owner. | Should |

## 4.6 Billing Cycle Tickets (TKT)

| **ID** | **Requirement** | **Priority** |
| --- | --- | --- |
| TKT-01 | Every 30 days (configurable per agreement) the system creates a Billing Cycle Ticket for each active machine and sends it to the customer by app notification and email. | Must |
| TKT-02 | One ticket per machine per cycle carries the whole cycle: meter request, review, invoice, payment, and closure. | Must |
| TKT-03 | Ticket statuses: Meter Requested → Pending Owner Review → Awaiting Payment → Payment Submitted → Closed. | Must |
| TKT-04 | Each hand-over sends an app notification and an email to the next responsible person. | Must |
| TKT-05 | Each stage has a deadline, reminders, and escalation (Section 5.4). | Must |
| TKT-06 | Ticket shows the current stage, who must act, due date, and full history. | Must |
| TKT-07 | The next cycle is scheduled from the cycle calendar, not from when the previous ticket closed. | Must |
| TKT-08 | Duplicate tickets for the same agreement and cycle are prevented. | Must |
| TKT-09 | Every ticket action is logged with user, time, and reason. | Must |
| TKT-10 | Owner can cancel or reopen a ticket with a mandatory reason. | Should |
| TKT-11 | Customer and owner can add comments on a ticket. | Should |
| TKT-12 | Tickets are paused for suspended accounts and resume on reactivation. | Should |
| TKT-13 | All negative scenarios in Section 11 end in a defined status with a reason, notification, and audit entry. | Must |

## 4.7 Meter Reading and Invoicing (INV)

| **ID** | **Requirement** | **Priority** |
| --- | --- | --- |
| INV-01 | Customer opens the Meter Requested ticket and taps **Enter meter**, which shows the reading box(es) and a live camera capture section. | Must |
| INV-02 | Mono machine: one reading. Colour machine: B&W reading and colour reading. | Must |
| INV-03 | Photo must be taken with the live camera; gallery or file upload is not available. | Must |
| INV-04 | Validate readings: not lower than the previous reading (per counter), rollover rules applied, one submission per ticket. | Must |
| INV-05 | Backend calculates usage and the invoice amount using the billing rules in Section 6. | Must |
| INV-06 | After Submit a draft invoice is created and the ticket (draft invoice and photo) is sent to the owner by app notification and email. | Must |
| INV-07 | Owner can Confirm or Reject (with a mandatory reason) the submission. | Must |
| INV-08 | Owner can correct a mistyped reading with an audit note; the invoice is recalculated and the customer notified. | Should |
| INV-09 | On confirmation the meter photo is permanently deleted, the invoice is issued, and it is sent to the customer as a ticket by app notification and email (PDF attached). | Must |
| INV-10 | Reading values, confirming user, and timestamps are kept permanently as the audit record. | Must |
| INV-11 | Unique invoice numbers per owner. | Must |
| INV-12 | Owner can enter a reading manually, with a note, when the customer cannot or does not submit. | Should |
| INV-13 | Submissions are idempotent; drafts survive poor connections and retries never create duplicates. | Must |
| INV-14 | Server-side timestamp is recorded for each submission and photo. | Should |

## 4.8 Payments and Payment Slips (PAY)

| **ID** | **Requirement** | **Priority** |
| --- | --- | --- |
| PAY-01 | Invoice statuses: Draft, Awaiting Payment, Payment Submitted, Partially Paid, Paid, Overdue, Disputed, Rejected, Cancelled. | Must |
| PAY-02 | Customer pays outside the system, then opens the invoice ticket, attaches the payment slip, enters amount, date, and reference, and submits. | Must |
| PAY-03 | Slip upload accepts JPG, PNG, or PDF within a size limit and is scanned before storage. | Must |
| PAY-04 | Submitting the slip sends the ticket to the owner by app notification and email. | Must |
| PAY-05 | Owner reviews the slip and can Accept, Reject (with reason), or Accept as partial payment. | Must |
| PAY-06 | When the payment is verified in full the owner closes the ticket and the customer receives a receipt notification. | Must |
| PAY-07 | Owner can record cash or cheque payments manually without a slip. | Must |
| PAY-08 | Payment history per customer and per invoice. | Must |
| PAY-09 | Outstanding payments list with ageing (current, 1-30, 31-60, 60+ days). | Must |
| PAY-10 | Automated payment reminders before the due date, on the due date, and when overdue. | Must |
| PAY-11 | Duplicate slip detection using bank reference and file fingerprint. | Should |
| PAY-12 | Overpayments held as credit and applied to the next invoice or refunded. | Should |
| PAY-13 | Optional late fee after a grace period. | Could |
| PAY-14 | Online payment through a gateway such as PayHere. | Could |

## 4.9 Service Requests (SRV)

| **ID** | **Requirement** | **Priority** |
| --- | --- | --- |
| SRV-01 | Customer raises a request for a machine: Breakdown/Repair, Toner, Spare Part, Maintenance, or Other. | Must |
| SRV-02 | Request fields: machine, type, description, urgency. | Must |
| SRV-03 | Request workflow: New → Acknowledged → Assigned → In Progress → Resolved → Closed (or Cancelled). | Must |
| SRV-04 | Owner acknowledges, assigns to a technician or staff member, and adds notes. | Must |
| SRV-05 | Customer tracks request status and receives notifications on every change. | Must |
| SRV-06 | Toner request records the toner colour(s) needed for colour machines. | Should |
| SRV-07 | Record work done, parts used, and cost on a request. | Should |
| SRV-08 | Escalate to the owner again, then to Admin, when a request is not acknowledged in time. | Should |
| SRV-09 | Customer rating after a request is closed. | Could |

## 4.10 Notifications (NOT)

| **ID** | **Requirement** | **Priority** |
| --- | --- | --- |
| NOT-01 | In-app notification centre for all users. | Must |
| NOT-02 | Email notifications, including invoice emails. | Must |
| NOT-03 | SMS and WhatsApp notifications for reminders and urgent events. | Should |
| NOT-04 | Editable message templates. | Should |
| NOT-05 | Delivery log showing sent, failed, and read status. | Should |

## 4.11 Reports and Dashboards (RPT)

| **ID** | **Requirement** | **Priority** |
| --- | --- | --- |
| RPT-01 | Owner dashboard: income this month, outstanding, overdue, pending approvals, open requests. | Must |
| RPT-02 | Monthly income and sales report. | Must |
| RPT-03 | Machine-wise report: revenue, copies, excess charges, service and toner cost. | Must |
| RPT-04 | Outstanding and ageing report. | Must |
| RPT-05 | Customer-wise report. | Should |
| RPT-06 | Service and toner demand report. | Should |
| RPT-07 | Export reports to PDF and Excel. | Should |
| RPT-08 | Admin report: owner activity and platform usage. | Should |

## 4.12 Customer Portal (CP)

| **ID** | **Requirement** | **Priority** |
| --- | --- | --- |
| CP-01 | Dashboard: rented machines, current balance, next cycle date, open tickets. | Must |
| CP-02 | Ticket inbox showing the current billing cycle ticket, its stage, and what the customer must do next. | Must |
| CP-03 | Enter meter from the ticket: reading box(es) and live camera capture, then Submit. | Must |
| CP-04 | View the confirmed invoice and submit the payment slip with amount, date, and reference. | Must |
| CP-05 | View and download past invoices, receipts, and payment history. | Must |
| CP-06 | Raise a dispute on an invoice and add comments on a ticket. | Should |
| CP-07 | Raise and track service requests. | Must |
| CP-08 | Notification centre and profile with password change. | Must |
| CP-09 | Mobile-first responsive design (installable PWA). | Should |

# 5. Monthly Collection Process (Billing Cycle)

## 5.1 Overview

Rent is collected through one **Billing Cycle Ticket** per machine every 30 days. The ticket moves between the customer and the owner, and every hand-over sends an app notification and an email.

| **System → Customer:** meter request ticket **Customer → Owner:** live meter photo and reading, with the system-calculated invoice **Owner → Customer:** confirmed invoice **Customer → Owner:** payment slip **Owner:** verifies the slip and closes the ticket |
| --- |

## 5.2 Step-by-Step Process

| **Step** | **Who** | **What happens** | **Status after** |
| --- | --- | --- | --- |
| 1 | System | Every 30 days the system creates a ticket for each active machine and sends it to the customer by app notification and email. | Meter Requested |
| 2 | Customer | Opens the ticket, taps **Enter meter**, captures the meter with the live camera, types the current reading (B&W and colour where applicable), and presses Submit. | - |
| 3 | System | Validates the readings, calculates usage and the invoice amount, creates the invoice as a draft, and sends the ticket (draft invoice and meter photo) to the owner by app notification and email. | Pending Owner Review |
| 4 | Owner | Compares the photo with the typed reading and **confirms** the invoice. Negative paths (reject, correct) are in Section 11. | - |
| 5 | System | On confirmation permanently deletes the meter photo, issues the invoice, and sends it to the customer as a ticket by app notification and email. | Awaiting Payment |
| 6 | Customer | Pays the invoice amount outside the system, opens the ticket, **attaches the payment slip**, enters amount, date, and reference, and presses Submit. | - |
| 7 | System | Sends the ticket with the slip to the owner by app notification and email. | Payment Submitted |
| 8 | Owner | Reviews the slip against the payment received. If it is correct, **closes the ticket**. | Closed |
| 9 | System | Sends a receipt notification to the customer, updates balances and reports, and schedules the next cycle. | Closed |

## 5.3 Ticket Statuses

| **Status** | **Meaning** | **Responsible** | **Moves to** |
| --- | --- | --- | --- |
| **Meter Requested** | System asked the customer for the meter reading and photo. | Customer | Pending Owner Review |
| **Pending Owner Review** | Reading, live photo, and draft invoice are with the owner. | Owner | Awaiting Payment (confirm) or Meter Requested (reject) |
| **Awaiting Payment** | Invoice confirmed and sent; customer to pay and submit the slip. | Customer | Payment Submitted |
| **Payment Submitted** | Slip is with the owner for verification. | Owner | Closed, or Awaiting Payment (rejected or partial) |
| **Closed** | Payment verified; cycle complete. | None | Reopened (owner only) |
| **Overdue** | A stage deadline was missed (meter or payment). | Customer or owner | Returns to the normal flow |
| **Partially Paid** | Slip accepted for part of the amount. | Customer | Payment Submitted |
| **Disputed** | Customer disputes the invoice. | Owner | Awaiting Payment or Cancelled |
| **Cancelled** | Ticket voided with a reason. | Owner | None |
| **Reopened** | Closed ticket reopened with a reason. | Owner | Awaiting Payment |

## 5.4 Stage Deadlines, Reminders, and Escalation

Defaults below are configurable. No stage waits without a reminder and an escalation.

| **Stage** | **Deadline** | **Reminders** | **Escalation** |
| --- | --- | --- | --- |
| **Meter Requested** | 5 days from ticket creation | Customer: day 2 and day 4 | Day 5: owner alerted to follow up or enter the reading manually |
| **Pending Owner Review** | 2 days | Owner: 24 and 48 hours | After 3 days: Admin alerted |
| **Awaiting Payment** | 7 days after confirmation | Customer: 3 days before and on the due date | Overdue reminders at 1, 7, and 14 days; weekly summary to owner |
| **Payment Submitted** | 2 days | Owner: 24 and 48 hours | After 3 days: Admin alerted |

## 5.5 Cycle Scheduling Rules

- The first ticket is created 30 days after the agreement start date. Later tickets follow every 30 days from the previous scheduled date, so a delay in one cycle does not shift the next.

- Cycle length is configurable per agreement (default 30 days).

- All schedules and deadlines use Sri Lanka time (Asia/Colombo).

- One ticket per machine per cycle; a customer with several machines receives several tickets.

- No tickets are created for suspended, terminated, or inactive agreements.

- If the previous ticket is still open when the next one is due, the new ticket is still created and the older one is flagged Overdue (see Section 11.6).

## 5.6 Example Timeline

Customer with a colour machine (invoice example from Section 6.3).

| **Day** | **Event** |
| --- | --- |
| **Day 0** | System creates the ticket and notifies the customer. |
| **Day 1** | Customer captures the meter and submits. Draft invoice: Rs. 12,800. Ticket goes to the owner. |
| **Day 2** | Owner confirms. Meter photo is deleted. Invoice ticket goes to the customer. |
| **Day 5** | Customer pays at the bank and submits the slip. Ticket goes to the owner. |
| **Day 6** | Owner verifies the slip and closes the ticket. Receipt sent to the customer. |
| **Day 30** | Next cycle ticket is created. |

# 6. Meter Reading and Invoicing

## 6.1 Workflow

This section details steps 2 to 5 of the monthly collection process in Section 5.

- Customer opens the Meter Requested ticket and taps **Enter meter**.

- Customer captures the meter with the live camera and types the reading (B&W, plus colour for colour machines). Image upload is not available.

- Customer submits. The backend validates the readings, calculates usage and the invoice amount, and creates a draft invoice.

- The ticket (draft invoice and photo) goes to the owner and the status becomes **Pending Owner Review**.

- Owner compares the photo with the typed reading and chooses Confirm, Reject, or Correct.

- On **Confirm**: the meter photo is permanently deleted, the invoice is issued, and it is sent to the customer as a ticket (status Awaiting Payment).

- On **Reject**: the customer is notified with the reason and resubmits. The rejected photo is deleted when the customer resubmits or after a configurable retention period.

- On **Correct**: the owner fixes the reading with an audit note, the invoice is recalculated, and the customer is notified.

## 6.2 Billing Rules

Included copies are separate for B&W and colour. Unused copies on one counter never offset the other counter.

| bw_usage = current_bw − previous_bw colour_usage = current_colour − previous_colour bw_extra = max(0, bw_usage − bw_included) × bw_rate colour_extra = max(0, colour_usage − colour_included) × colour_rate **Invoice amount = monthly_commitment + bw_extra + colour_extra** |
| --- |

Mono machines use only the B&W part of the formula. If usage is within the included volume, the customer pays only the monthly commitment.

## 6.3 Worked Examples

### Colour machine

Monthly commitment Rs. 10,000; included 3,000 B&W and 500 colour copies; excess rate Rs. 2 per B&W copy and Rs. 10 per colour copy.

| **Case** | **B****&****W used** | **Colour used** | **B****&****W extra** | **Colour extra** | **Invoice** |
| --- | --- | --- | --- | --- | --- |
| 1. Within limits | 2,500 | 300 | 0 | 0 | Rs. 10,000 |
| 2. Both exceed | 3,400 | 700 | 400 × 2 = 800 | 200 × 10 = 2,000 | Rs. 12,800 |
| 3. Only colour exceeds | 2,000 | 800 | 0 (no credit) | 300 × 10 = 3,000 | Rs. 13,000 |

### Mono machine

Monthly commitment Rs. 5,000; included 2,000 copies; excess rate Rs. 2.50 per copy.

| **Case** | **Copies used** | **Excess** | **Invoice** |
| --- | --- | --- | --- |
| 1. Within limit | 1,800 | 0 | Rs. 5,000 |
| 2. Above limit | 2,600 | 600 × 2.50 = 1,500 | Rs. 6,500 |

## 6.4 Validation Rules

- Each current reading must be greater than or equal to the previous reading (checked separately for B&W and colour).

- Only one active submission per machine per billing period.

- Warn the owner when usage is unusually high or low compared with previous months.

- The first previous reading is the initial reading entered when the machine is assigned.

- Handle meter rollover or replacement by letting the owner record a new baseline with a note.

- The customer form labels B&W, Colour, and (if shown on the machine) Total counters clearly so that the total is not entered by mistake.

- If a reading covers more than one cycle, included copies are multiplied by the number of cycles covered (see Section 11.6).

## 6.5 Photo Handling

- Captured with the live camera only (browser camera API over HTTPS); no gallery or file picker.

- Stored in private storage with access limited to the owning owner; no public links.

- Attached to the billing cycle ticket and deleted permanently when the owner confirms the invoice.

- Photos of rejected or unconfirmed submissions are auto-purged after a configurable number of days.

- After deletion, only the reading values, approver, and timestamps are kept as the audit record.

## 6.6 Invoice Contents and Statuses

An invoice shows: invoice number, owner and customer details, machine, billing period, previous and current readings, usage per counter, included copies, commitment charge, B&W and colour excess lines (hidden when zero), total, due date, and payment instructions.

| **Invoice status** | **Ticket status** | **Meaning** |
| --- | --- | --- |
| **Draft** | Pending Owner Review | Calculated from the customer's reading; not yet visible to the customer. |
| **Rejected** | Meter Requested | Owner rejected the reading; customer must resubmit. |
| **Awaiting Payment** | Awaiting Payment | Confirmed and sent; payment slip not yet submitted. |
| **Payment Submitted** | Payment Submitted | Slip is waiting for owner verification. |
| **Partially Paid** | Awaiting Payment | Part of the amount accepted; balance remains. |
| **Paid** | Closed | Fully paid and verified. |
| **Overdue** | Overdue | Past the due date and not fully paid. |
| **Disputed** | Disputed | Customer disputes the amount; under owner review. |
| **Cancelled** | Cancelled | Voided by the owner with a reason; a new invoice may be issued. |

# 7. Service Request Management

## 7.1 Request Types

| **Type** | **Typical use** | **Extra details** |
| --- | --- | --- |
| **Breakdown/Repair** | Machine stopped or faulty. | Fault description, urgency. |
| **Toner** | Toner low or empty. | Toner colour(s) for colour machines. |
| **Spare part** | Drum, roller, fuser, or other parts. | Part name or description. |
| **Maintenance** | Routine service or cleaning. | Preferred date. |
| **Other** | Any other service. | Description. |

## 7.2 Workflow

- Customer selects the machine and request type, adds a description and urgency, and submits.

- The owner receives a ticket and a notification.

- Owner acknowledges the request; the customer is notified.

- Owner assigns it to a technician or staff member and sets a planned date if needed.

- Work is carried out; the owner records notes, parts used, and cost.

- Owner marks the request Resolved; the customer confirms and the request is Closed.

## 7.3 Escalation

If a request is not acknowledged within a configurable time (for example 4 hours for urgent breakdowns), the system re-notifies the owner. If it is still not acknowledged after a second period, the Admin is alerted. Escalation times are configurable.

# 8. Payment Tracking and Reminders

## 8.1 Payment Submission and Verification

- After the invoice ticket arrives, the customer pays the amount outside the system (bank transfer, deposit, or another method agreed with the owner).

- The customer opens the ticket, attaches the payment slip (photo or PDF), and enters the amount paid, payment date, and bank reference.

- The ticket goes to the owner with the slip (status Payment Submitted).

- The owner checks the slip against the amount actually received.

- If correct, the owner closes the ticket. If not, the owner rejects it with a reason or accepts it as a partial payment.

- The customer receives a receipt notification when the ticket is closed.

## 8.2 Payment Rules

- Slip files: JPG, PNG, or PDF up to a size limit (for example 5 MB), scanned before storage.

- Payment slips are kept as payment proof, unlike meter photos, which are deleted. The retention period is configurable.

- Partial payments are allowed; the invoice shows the remaining balance and the ticket stays open.

- Overpayments are held as credit and applied to the next invoice or refunded, as the owner decides.

- Duplicate slips are detected using the bank reference and file fingerprint.

- Owners can record cash or cheque payments manually.

- While a slip waits for the owner's verification, the invoice is not treated as overdue.

- Payment history and outstanding balance are visible to both owner and customer.

## 8.3 Payment Reminder Schedule (configurable)

Meter and owner-review reminders are listed in Section 5.4. Payment reminders:

| **Event** | **Timing** | **Recipient** |
| --- | --- | --- |
| **Payment due soon** | 3 days before the due date | Customer |
| **Payment due today** | On the due date | Customer |
| **Payment overdue** | 1, 7, and 14 days after the due date | Customer |
| **Overdue summary** | Weekly | Owner |
| **Late fee (optional)** | Applied after a grace period if the owner enables it | Customer, Owner |

# 9. Notifications

Every ticket hand-over uses app notification and email. SMS and WhatsApp are added where enabled. The in-app ticket is always the source of truth.

| **Event** | **Recipient** | **Channel** |
| --- | --- | --- |
| **Owner or customer account created** | New user | Email / SMS / WhatsApp (credentials) |
| **Meter request ticket created (every 30 days)** | Customer | App notification, email |
| **Meter reading reminder** | Customer | App, email, SMS/WhatsApp |
| **Meter submitted: draft invoice and photo** | Owner | App notification, email |
| **Reading rejected or corrected** | Customer | App notification, email |
| **Invoice confirmed and issued** | Customer | App notification, email (PDF) |
| **Payment slip submitted** | Owner | App notification, email |
| **Payment rejected or accepted as partial** | Customer | App notification, email |
| **Ticket closed (receipt)** | Customer | App notification, email |
| **Payment due and overdue reminders** | Customer | App, email, SMS/WhatsApp |
| **Stage deadline missed or escalated** | Owner, then Admin | App, email, SMS |
| **Dispute raised or resolved** | Owner / Customer | App notification, email |
| **Ticket cancelled or reopened** | Customer | App notification, email |
| **New service request / status change** | Owner / Customer | App, SMS/WhatsApp |
| **Account suspended or reactivated** | Affected user | Email, in-app |

# 10. Reports and Dashboards

## 10.1 Owner Dashboard

- Income this month and comparison with last month.

- Total outstanding and overdue amounts.

- Billing cycle tickets by stage, including pending reviews and overdue stages.

- Open service requests by type and urgency.

- Top machines by revenue and recent payments.

## 10.2 Owner Reports

| **Report** | **Content** |
| --- | --- |
| **Monthly income and sales** | Commitment income, excess income, total invoiced, total collected, by month. |
| **Machine-wise performance** | Revenue, copies (B&W/colour), excess charges, service and toner cost, and profitability per machine. |
| **Customer-wise** | Invoices, payments, balance, and payment behaviour per customer. |
| **Outstanding and ageing** | Unpaid invoices grouped by age. |
| **Service and toner demand** | Request counts by type, machine, and customer; toner needs forecast. |
| **Rental information** | Machines rented vs available, agreement end dates. |
| **Billing cycle status** | Tickets by stage, average time per stage, late submissions, and missed stage deadlines. |

## 10.3 Admin Reports

- Owners, customers, machines, and invoices count over time.

- Owner activity, unresolved tickets, and notification delivery statistics.

- Subscription status per owner (if subscriptions are used).

# 11. Exception and Negative Scenario Handling

Every negative path must end in a defined state. Nothing is left waiting without a reminder, an owner action, or an escalation.

## 11.1 Design Principles

- Every stage has a deadline, reminders, and escalation (Section 5.4).

- No automatic approval: the system never confirms an invoice or a payment by itself.

- The owner can always override with a manual action, recorded with a reason in the audit log.

- Submissions are idempotent: repeated taps or retries never create duplicate invoices or payments.

- Money records are never silently edited or deleted: invoices are cancelled and reissued.

- Every rejection needs a reason and returns the ticket to a clear earlier stage.

- Notifications use fallback channels; the in-app ticket is the source of truth.

## 11.2 Meter Submission Stage

| **Scenario** | **System handling** | **Outcome** |
| --- | --- | --- |
| Customer does not open or submit the ticket | Reminders on day 2 and day 4; ticket marked Overdue and owner alerted on day 5. | Owner waits, enters the reading manually, or issues an estimated invoice (Section 11.6). Next cycle still starts on schedule. |
| Notification not delivered (email bounce, app not installed) | Retries, then the other channel. Failure is logged; owner alerted if all channels fail. | Owner corrects contact details or informs the customer. Ticket stays visible in the portal. |
| Camera permission denied, no camera, or camera error | Step-by-step help to enable the camera. No upload fallback. | Customer asks the owner via a ticket comment; owner enters the reading manually with a note. |
| Photo blurry, dark, or meter not readable | Capture guide and retake option before submit. | If submitted anyway, owner rejects with a reason and the customer retakes the photo. |
| Reading lower than the previous reading | Blocked with a clear error; no invoice is created. | If the meter was replaced or reset, the owner records a new baseline with a note. |
| Reading unusually high or low | Customer is asked to confirm; submission is flagged to the owner. | Owner compares with the photo, then confirms, corrects, or rejects. |
| Counter rolled over (for example 999,999 to 0) | Owner sets the maximum counter value per machine; the system adds the rollover. | Usage is calculated correctly. |
| Typed reading does not match the photo | Owner sees reading and photo side by side. | Owner corrects with a note (customer notified) or rejects. |
| Customer enters the Total counter instead of B&W or Colour | Clear labels and a sample counter image on the form; owner review. | Owner corrects or rejects. |
| Double tap or repeated Submit | Submission is idempotent: one draft invoice per ticket. | Duplicates ignored. |
| Connection lost while submitting | Entry is kept on the device and retried; success is shown only after the server confirms. | No lost or half-saved submissions. |
| Old or non-live photo suspected | Live capture only; server timestamp recorded; owner can compare with earlier months. | Owner rejects suspected cases and may ask for a fresh photo. |
| Customer rents several machines | One ticket per machine. | Each ticket is handled independently. |

## 11.3 Owner Review Stage

| **Scenario** | **System handling** | **Outcome** |
| --- | --- | --- |
| Owner does not review in time | Reminders at 24 and 48 hours; Admin alerted after 3 days; customer sees Pending Owner Review. | Owner acts. The system never confirms automatically. |
| Owner rejects the reading | Reason is mandatory; customer notified; ticket returns to Meter Requested. | Customer resubmits. After 3 rejections (configurable) the owner enters the reading manually. |
| Owner corrects the reading | Invoice recalculated; audit note saved; customer sees old and new values. | Customer may dispute (Section 11.4). |
| Confirmation fails because of a system error | Action is transactional; the photo is deleted only after the invoice is issued. | Owner retries; nothing is lost. |
| Owner account suspended or deactivated mid-cycle | Open tickets pause; customers are informed. | Tickets resume on reactivation; Admin can support. |
| Agreement edited during an open cycle | Changes apply from the next cycle; the open invoice keeps its original terms. | Amounts never change after the customer submitted. |

## 11.4 Invoice and Dispute Stage

| **Scenario** | **System handling** | **Outcome** |
| --- | --- | --- |
| Customer disputes a confirmed invoice | Customer raises a dispute with a reason on the ticket; status Disputed; reminders for this invoice pause. | Owner revises (cancel and reissue, or credit note) or rejects the dispute with an explanation. |
| Calculation or rate error found after confirmation | Owner cancels the invoice with a reason and issues a new one; the old number is voided. | Customer notified; any payment already made is kept as credit. |
| Dispute raised after the meter photo was deleted | Reading values, confirming user, and timestamps remain as the record. | Owner may ask the customer for a fresh meter photo to verify the current reading. |
| Invoice notification not delivered | Retries; the invoice stays in the portal. | Owner can resend. |
| Zero usage in the cycle | Commitment charge applies; flagged as low usage. | Normal flow. |
| Machine returned or agreement ended mid-cycle | Final reading requested; final invoice per the owner's rule; machine set to Available. | Ticket closes after the final payment. |

## 11.5 Payment Stage

| **Scenario** | **System handling** | **Outcome** |
| --- | --- | --- |
| Customer does not pay by the due date | Reminders; invoice becomes Overdue; owner sees it in the overdue list; optional late fee. | Owner follows up; ticket stays open until paid or cancelled. |
| Customer pays but forgets the slip | Reminders to submit the slip. | Owner can record the payment manually after confirming receipt. |
| Slip file invalid, unreadable, or too large | Upload blocked with a clear message. | Customer retries. |
| Slip amount is less than the invoice | Owner accepts as partial payment; balance shown on the ticket. | Ticket stays open; customer pays the balance and submits a new slip. |
| Slip amount is more than the invoice | Excess recorded as credit. | Applied to the next invoice or refunded. |
| Slip details wrong or suspected fake | Owner rejects with a reason; customer notified; status returns to Awaiting Payment. | Customer submits the correct slip; owner may contact the customer directly. |
| Same slip or reference used twice | Duplicate warning shown to the owner. | Owner rejects the duplicate. |
| Owner does not verify the slip in time | Reminders at 24 and 48 hours; Admin alerted after 3 days; invoice not counted overdue while waiting. | Owner verifies; ticket closes. |
| Payment reversed after closing (for example cheque returned) | Owner reopens the ticket with a reason. | Invoice returns to Awaiting Payment or Overdue; customer notified. |
| Payment applied to the wrong invoice | Owner reallocates the payment with a note. | Balances corrected; audit entry. |
| Customer wants to pay before the invoice is confirmed | No payable invoice exists yet. | Customer waits; owner can record an advance payment as credit. |
| Customer pays in cash | Owner records the payment manually and issues a receipt. | Ticket closed after verification. |

## 11.6 Missed and Multi-Cycle Billing

| **Situation** | **Handling** |
| --- | --- |
| **Customer submits after the window but before the next ticket** | Accepted and marked Late; normal invoice. |
| **Customer never submits; owner enters the reading** | Owner enters the reading with a note; normal invoice. |
| **Customer never submits; owner uses estimated billing (if enabled)** | Estimated invoice for the monthly commitment only, marked Estimated. At the next real reading, usage is measured from the last verified reading, included copies are multiplied by the cycles covered, and the estimated charge is credited. |
| **Readings of two cycles combined without an estimate** | One invoice covering both cycles: commitment and included copies multiplied by the number of cycles; flagged to the owner. |
| **Next cycle ticket due while the previous one is open** | New ticket is created anyway; the previous one is flagged Overdue; the new ticket's previous reading is the last verified reading. |

## 11.7 Ticket, Notification, and System Failures

| **Scenario** | **System handling** | **Outcome** |
| --- | --- | --- |
| Ticket stuck in a stage | Stage deadlines trigger reminders and escalation (Section 5.4). | Resolved or escalated; nothing waits silently. |
| Scheduler fails or runs late | Jobs are restartable and catch up; Admin alerted. | No cycle skipped or duplicated. |
| Ticket due for an inactive or terminated agreement | Skipped. | No ticket created. |
| Duplicate ticket for the same cycle | Blocked by a unique rule on agreement and cycle number. | Only one ticket exists. |
| Upload or storage failure | Transaction rolled back; clear error; retry allowed. | No partial invoice or payment. |
| Malicious or oversized slip file | Type and size checks, virus scan, storage outside the public web. | File rejected. |
| User tries to open another tenant's ticket, photo, or slip | Role and tenant checks; short-lived signed links; attempt logged. | Access denied. |
| Owner cancels a ticket created in error | Reason required; customer notified. | Status Cancelled. |
| Owner reopens a closed ticket | Owner only, with a reason. | Audit entry; status Awaiting Payment. |

## 11.8 Account and Agreement Changes

| **Scenario** | **System handling** | **Outcome** |
| --- | --- | --- |
| Customer account suspended | No new tickets; open tickets are frozen; owner can still process them. | Resumes on reactivation. |
| Customer forgets the password | Owner resets it; new temporary password; forced change. | Normal login. |
| Customer changes phone or email | Owner updates details; test notification sent. | Notifications reach the new contact. |
| Machine replaced or swapped | Owner closes the old agreement with a final reading and creates a new one with a new baseline. | Billing continues correctly. |
| Meter replaced or reset | Owner records a new baseline with a note. | Usage continues from the new baseline. |
| Customer leaves with an unpaid balance | Account deactivated; the balance stays on record and in reports. | Owner follows up outside the system. |
| Owner leaves the platform | Admin deactivates the owner; data kept per retention policy; customers informed. | Orderly closure. |

# 12. Data Model

Main entities and key fields. Every owner-related table carries an owner identifier for tenant isolation.

| **Entity** | **Key fields** |
| --- | --- |
| **User** | id, role, username, password_hash, must_change_password, status, created_by, last_login |
| **Owner** | id, user_id, business_name, contact_person, phone, email, address, plan, status |
| **Customer** | id, user_id, owner_id, name, business_name, phone, email, address, status |
| **Machine** | id, owner_id, brand, model, serial_no, type (MONO/COLOUR), status, purchase_date |
| **RentalAgreement** | id, owner_id, customer_id, machine_id, start_date, end_date, billing_day, due_days, monthly_commitment, bw_included, bw_rate, colour_included, colour_rate, status |
| **MeterReading** | id, agreement_id, period, counter_type (BW/COLOUR), previous_value, current_value, submitted_by, submitted_at |
| **MeterPhoto (temporary)** | id, reading_submission_id, storage_key, captured_at, expires_at (deleted on approval) |
| **BillingCycleTicket** | id, owner_id, customer_id, agreement_id, machine_id, cycle_no, cycle_date, status, stage_due_at, escalation_level, invoice_id, closed_at, closed_by |
| **TicketEvent** | id, ticket_id, event_type, from_status, to_status, actor_id, reason, timestamp |
| **Invoice** | id, owner_id, customer_id, agreement_id, ticket_id, invoice_no, type (NORMAL/ESTIMATED), period, status, subtotal, total, due_date, confirmed_by, confirmed_at |
| **InvoiceLine** | id, invoice_id, description, quantity, rate, amount |
| **Payment** | id, invoice_id, amount, date, method, reference, status (SUBMITTED/ACCEPTED/REJECTED/PARTIAL), verified_by, slip_id |
| **PaymentSlip** | id, payment_id, storage_key, file_hash, uploaded_by, uploaded_at, retention_until |
| **Dispute** | id, invoice_id, raised_by, reason, status, resolution, resolved_at |
| **Credit** | id, customer_id, invoice_id, amount, reason, applied_to_invoice_id |
| **ServiceRequest** | id, owner_id, customer_id, machine_id, type, description, urgency, status, assigned_to, cost, created_at, closed_at |
| **RequestStatusHistory** | id, request_id, status, note, changed_by, changed_at |
| **Notification** | id, user_id, event, channel, status, sent_at, read_at |
| **AuditLog** | id, user_id, action, entity, entity_id, details, timestamp |
| **SubscriptionPlan (optional)** | id, name, price, limits |

Core relationships: Owner 1-N Customer; Owner 1-N Machine; Customer 1-N RentalAgreement N-1 Machine; RentalAgreement 1-N BillingCycleTicket; BillingCycleTicket 1-1 Invoice and 1-N TicketEvent; Invoice 1-N Payment; Payment 1-N PaymentSlip; Invoice 1-N Dispute; Customer 1-N ServiceRequest N-1 Machine.

# 13. Non-Functional Requirements

| **Category** | **Requirement** |
| --- | --- |
| **Security** | HTTPS everywhere, hashed passwords, role-based access, tenant isolation, rate limiting, protection against common web attacks (injection, XSS, CSRF). |
| **Privacy** | Meter photos stored privately and deleted when the owner confirms the invoice; payment slips stored privately and kept as proof; personal data collected only as needed; access to data logged. |
| **Performance** | Pages load in under 3 seconds on normal mobile connections; invoice calculation completes within seconds. |
| **Availability** | Target 99.5% uptime; daily automated database backups with tested restore. |
| **Scalability** | Supports many owners and thousands of customers without redesign; background jobs for reminders and emails. |
| **Usability** | Mobile-first customer app with minimal steps for meter entry and service requests; simple language; English first, with Sinhala and Tamil possible later. |
| **Reliability** | Retry for failed notifications; idempotent invoice generation to prevent duplicates. |
| **Data retention** | Meter photos deleted on confirmation; payment slips kept for a configurable period; invoices, readings, payments, and audit records kept permanently. |
| **Time zone** | All schedules, deadlines, and timestamps use Sri Lanka time (Asia/Colombo). |
| **Resilience** | Scheduled jobs are restartable and catch up after downtime; a cycle is never skipped or duplicated. |
| **Auditability** | Permanent record of readings, approvals, payments, and account changes. |
| **Maintainability** | Modular code, API documentation, automated tests for the billing engine. |
| **Compatibility** | Latest versions of Chrome, Safari, Edge, and Firefox; Android and iOS browsers with camera support. |

# 14. Suggested Technology Stack

These are recommendations and can be adjusted to the development team's preference.

| **Layer** | **Suggestion** |
| --- | --- |
| **Front end** | React with Tailwind CSS; customer portal as an installable PWA |
| **Back end** | Node.js (NestJS or Express) or Laravel; REST API with JWT authentication |
| **Database** | PostgreSQL (or MySQL) with tenant-scoped tables |
| **Background jobs** | Cron with BullMQ/Redis (or Laravel queues) for reminders and invoicing prompts |
| **File storage** | Private object storage (for example S3-compatible) with short-lived signed URLs |
| **Email** | Transactional email service (SMTP/SES/SendGrid) with PDF invoice attachments |
| **SMS / WhatsApp** | Local SMS gateway and WhatsApp Business API |
| **Payments (optional)** | PayHere or a similar gateway |
| **Hosting** | Cloud VPS or managed platform with HTTPS, backups, and monitoring |

# 15. Implementation Phases

| **Phase** | **Scope** | **Outcome** |
| --- | --- | --- |
| **Phase 1 (MVP)** | Authentication and account hierarchy; owner, customer, machine, and agreement management; 30-day billing cycle tickets; meter entry with live camera; billing engine; owner review and confirmation; invoice ticket and email; payment slip submission and owner verification; stage reminders and basic escalation; core negative-scenario handling. | Owners can bill and collect payments through tickets. |
| **Phase 2** | Service, toner, and spare-part requests with workflow; notification centre; SMS/WhatsApp; disputes, credit handling, estimated billing, and multi-cycle handling; owner dashboard and reports; full escalation to Admin. | Full service handling, reporting, and exception coverage. |
| **Phase 3** | Admin dashboard and audit tools; subscriptions; online payments; machine QR codes; technician features; advanced analytics and exports; multi-language. | Platform ready to scale commercially. |

# 16. Assumptions, Risks and Open Questions

## 16.1 Assumptions

- Customers have smartphones with a working camera and internet access.

- Each machine shows readable counters for B&W (and colour where applicable).

- Owners are responsible for passing login details to their customers.

- Rates and included volumes are fixed per agreement and change only from the next billing period.

- Customers pay outside the system and submit the payment slip as proof.

- The owner verifies each payment against their own bank account or records before closing the ticket.

## 16.2 Risks and Mitigations

| **Risk** | **Mitigation** |
| --- | --- |
| **Customer enters a wrong reading** | Photo comparison by the owner, validation rules, owner correction with audit note. |
| **Customers do not submit readings** | Reminders, owner alerts, manual entry by owner. |
| **Browser camera not available or blocked** | Clear permission guidance; supported-browser list; fallback of manual owner entry. |
| **Notification delivery failures** | Multiple channels, retries, delivery log. |
| **Credential sharing is insecure** | Forced password change at first login, one-time display, optional OTP. |
| **Meter replaced or reset** | Baseline reset by owner with note and audit record. |
| **Meter photo deleted before a dispute is raised** | Reading values, confirming user, and timestamps are kept; the owner can ask the customer for a fresh meter photo. |
| **Fake or reused payment slips** | Owner verifies against the bank statement; duplicate detection by reference and file fingerprint; rejection with a reason. |
| **Owner or customer ignores a ticket** | Stage deadlines, reminders, and escalation to Admin (Section 5.4). |
| **Customers skip cycles** | Late submission, manual entry, and estimated billing with reconciliation (Section 11.6). |

## 16.3 Open Questions

- Should customers be allowed to attach photos to breakdown or spare-part requests (the no-upload rule currently applies to meter readings)?

- Which payment methods must be supported at launch (cash, bank transfer, online)?

- How are owners charged for the platform (monthly subscription, per customer, or free)?

- Do owners need staff or technician sub-accounts with limited permissions?

- Which languages are required at launch?

- Are late-payment fees or discounts needed?

- How long should rejected or unconfirmed meter photos be retained before deletion?

- Should payment slips be kept after the ticket is closed, and for how long?

- Is estimated billing allowed when a customer does not submit a reading?

- What are the default payment due period (days after confirmation) and the stage deadlines?

- Is a late fee applied to overdue invoices, and after what grace period?

- Is the 30-day cycle fixed for all customers, or can owners choose a monthly calendar date instead?

Ciigus Software  |  Confidential  |  Page

# 17. Additional Requirements (Owner Branding)

| ID | Requirement | Priority |
| --- | --- | --- |
| BRD-01 | After the first password change, the owner must complete a company setup screen (company name, logo, address, phone, email, bank details for invoices) before accessing the dashboard. | Must |
| BRD-02 | Logo is uploaded as JPG/PNG/SVG, validated, resized, and stored privately; shown in the owner portal, the customer portal of that owner's customers, emails, and invoices. | Must |
| BRD-03 | Owner can edit company details and logo later from Settings; changes apply to new invoices only (issued invoices keep their original PDF). | Must |
| BRD-04 | Owner can upload an invoice letterhead (A4 image or 1-page PDF) used as the background of invoice PDFs. | Should |
| BRD-05 | Owner positions the invoice data area on the letterhead (preset layouts or simple drag positioning on a preview); positions are saved per owner. | Should |
| BRD-06 | If no letterhead is uploaded, invoices use the built-in template with the owner's logo and company details. | Must |
| BRD-07 | Owner can preview a sample invoice before saving template changes. | Should |

Note: tenant isolation stays as one shared schema with owner_id + RLS (no per-company schemas).

# 18. Additional Requirements (Client decisions)

Agreed with the client on 9 October 2026 after reviewing `docs/decisions.md`. They also change three earlier rules: billing cycles are **monthly** on the day of the first billing date, using the last day of shorter months without drifting (decision 1; replaces "every 30 days" in 4.6 TKT-01 and 5.5); customer credits are **added automatically** to every new invoice and the owner may remove one before confirming (decision 13; PAY-12); and a proration on return uses the real number of days of that cycle (decision 5).

| ID | Requirement | Priority |
| --- | --- | --- |
| DEP-01 | When assigning a machine, the owner can record money received upfront (optional section): type (security deposit or advance payment), amount, date received (past dates allowed for rentals already running), payment method, reference and note; several entries per agreement. A security deposit is held separately, never as a credit and never applied to normal bills; "Deposit held: Rs. X" is shown on the agreement, the owner's customer profile and the customer's Machines tab. | Must |
| DEP-02 | An advance payment becomes a customer credit (kind Advance) and is taken off the next invoices automatically; the owner sees it in review and can remove it from a draft before confirming (it stays available), recorded in the audit log. | Must |
| DEP-03 | On return the owner sees the deposit held and the unpaid balance and can, in one atomic, audited step: pay the unpaid balance from the deposit (recorded as payments of method "From security deposit" against those invoices), refund the remainder (refund date, method, reference) and keep part of it with a required reason. Pay + refund + keep must always equal the deposit held. The owner may instead keep holding the deposit. | Must |
| DEP-04 | A deposit kept at return can be settled later from the agreement page with the same rules and checks. Returned agreements whose deposit is still held are listed as "Deposits to settle" on the owner dashboard and the customer profile. | Must |
| LATE-01 | Each agreement has a late fee setting: use the owner's default (default), a custom amount, or no late fee. It can be set on the assign form and the agreement page and is kept in the terms history. The effective late fee is the agreement's setting, then the owner's settings, then the platform default; it stays a fixed amount charged once per unpaid invoice after the grace period, never while a slip awaits verification or the invoice is disputed. | Should |
| RET-01 | A machine can be returned (or reassigned) while invoices are unpaid. The owner enters the closing readings; the system creates the final invoice with the billing engine (prorated by the real days of the cycle, or the full month, as the owner chooses) and the machine becomes Available. Unpaid invoices stay on the customer's account; the customer can still sign in, see the balance and upload payment slips. A return is blocked, with a clear message, only while a meter reading is waiting for the owner's review. | Must |
