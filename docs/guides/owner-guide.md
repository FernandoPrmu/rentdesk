# RentDesk — Owner guide

RentDesk helps you rent out photocopy machines. Every month it asks each customer for a meter reading,
makes the bill, and helps you collect the payment. This guide shows the main jobs, step by step.

Words used in this guide:

- **Ticket**: one month of one machine. It goes from "meter reading" to "bill" to "paid".
- **Agreement**: the rental terms for one machine and one customer (monthly price, free copies, rates).
- **Home**: the first screen after you sign in.
- **More**: on a phone, the last button of the bottom bar opens the other sections. On a computer they are in the menu
  on the left; **Payments** and **Outstanding** are tabs under **Invoices**, and **Approvals** opens from Home or Tickets.

---

## 1. First sign-in

1. Open RentDesk and tap **Sign in**.
2. Type the **username** and **temporary password** that Ciigus gave you.
3. RentDesk asks you to choose a new password. Use at least 10 characters, with a letter and a number.
   Tap **Save new password**.
4. Keep your password private. If you forget it, ask Ciigus to reset it.

Tip: on your phone, install RentDesk so it opens like an app. When the "Install RentDesk on this phone" card
appears, tap **Install** (Android) or follow the steps it shows (iPhone).

## 2. Set up your company (once)

Before anything else, RentDesk shows **Set up your company**. Your customers see these details on their bills.

1. Type your **Company name**, **Address**, **Phone** and **Email**.
2. Under **Bank details for invoices**, type the **Bank**, **Branch**, **Account name** and **Account number**.
   Customers use these to pay you.
3. Optional: add your logo (JPG, PNG or SVG, up to 2 MB).
4. Tap **Save and continue**.

You can change these later in **Settings › Company**. Changes apply to new bills only; bills already sent never change.

Optional: in **Settings › Invoice template** you can upload your own letterhead (A4 picture or a 1-page PDF), move the
area where the bill is printed, and tap **Preview sample invoice** before you save.

## 3. Add a customer

1. Go to **Customers** and tap **New customer**.
2. Type the customer's name, business name, phone, email and address. Use English letters.
3. Leave **Also send the login details by email** on if the customer has an email address.
4. Tap **Save**. RentDesk shows the customer's **username** and **temporary password** once.
5. Give these to the customer (in person, by phone, or the email RentDesk sent). Then tap
   **I have saved these details**.

The customer must choose their own password the first time they sign in.

If a customer forgets their password: open the customer, tap **Reset password**, and give them the new temporary password.

## 4. Add a machine and rent it out

**Register the machine**

1. Go to **Machines** and tap **New machine**.
2. Type the **Brand**, **Model**, **Serial number** and choose the **Type** (black and white, or colour).
3. Optional: the **B&W counter maximum** (the highest number the counter shows before it starts again from 0).
4. Tap **Register machine**.

**Rent it to a customer**

1. Open the machine and tap **Assign machine** (or open the customer and tap **Assign a machine**).
2. Choose the **Customer** and type the **Installation location**.
3. Type the meter numbers the machine shows now (**B&W counter**, and **Colour counter** for colour machines).
4. Fill in the price:
   - **Monthly commitment** (the fixed monthly amount),
   - **Included B&W copies** (copies included in that amount),
   - **B&W excess rate (per copy)** (price of each copy above that), and the colour ones for colour machines.
5. Choose the **First billing date**. RentDesk bills every month on that day.
6. Optional: **Money received upfront** for a security deposit or an advance payment.
7. Tap **Assign machine**.

To change the price later, open the agreement and tap **View terms and history**. A change applies from the next month,
never to a month already running.

## 5. The monthly cycle

RentDesk runs by itself once a day (just after midnight, Sri Lanka time).

1. **On the billing day** it opens a ticket and asks the customer for a meter reading. The customer takes a live photo
   of the meter and types the numbers.
2. **You review the reading.** The **To review** card on your Home shows how many meter readings wait. Tap the number,
   or go to **More › Approvals**.
   - Check the photo against the numbers. Zoom the photo if you need to.
   - If it is right, tap **Confirm invoice**. The bill is sent to the customer by app and email, with a PDF.
     The meter photo is deleted at this moment (the numbers are kept).
   - If the photo is unclear or wrong, tap **Reject** and write why. The customer takes a new photo.
   - If the customer typed a number wrong, use **Correct the reading**, write a note, and confirm.
3. **The customer pays** and sends a payment slip (see section 6).

If the customer does not send a reading, RentDesk reminds them on day 2 and day 4. On day 5 the ticket becomes
**Overdue** and you are told. You can phone the customer, or open the ticket and tap **Enter the reading** to type it
yourself (write a reason).

Tickets that need you are always on **Home** and in **Tickets** (filter by status).

## 6. Payments

**Check a payment slip**

1. The **To review** card on your Home shows how many payment slips wait. Tap the number (or go to **More › Payments**)
   and open a slip.
2. Look at the slip and check that the money really arrived in your bank.
3. Tap one of:
   - **Accept**: the money arrived. The bill is paid and the customer gets a receipt.
   - **Received less**: type the amount that really arrived. The rest stays to pay.
   - **Reject**: write why (for example "Not in our account"). The customer can send it again.

If RentDesk shows **Possible duplicate**, the same slip or bank reference was used before. Check carefully.

**Record cash or a cheque**

1. Go to **More › Payments** and tap **Record a payment** (or do it from the customer's page).
2. Choose the customer and the bills, type the amount, the date and how it was paid.
3. Tap **Record a payment**. A numbered receipt is made.

**Who still owes money**: **More › Outstanding** shows each customer's unpaid bills by age (current, 1-30, 31-60,
60+ days).

**A payment was a mistake** (a cheque bounced, money went to the wrong bill): open the payment and use
**Reverse payment** or **Move to other bills**. Both need a reason.

**A customer disputes a bill**: you are told. Open the ticket. You can **Reject the dispute** (explain why),
**Correct the bill**, **Give a credit**, or **Ask for a fresh meter photo**.

## 7. Service requests

Customers ask for repairs, toner, parts or maintenance from their phone. You are told at once; URGENT and HIGH requests
come first.

1. Go to **Service** and open the request.
2. Tap **Acknowledge** so the customer knows you have seen it.
3. Tap **Assign**, type the **Technician or staff member** and the **Planned visit**.
4. When the work starts, tap **Start work**.
5. When it is done, tap **Resolve**. Type the **Work done**, and if you like the **Parts used** and **Cost to you**
   (the customer never sees your cost). You can also **Charge the customer on the next bill**, or, for a breakdown,
   **Give a discount for the time it was down**.
6. The customer confirms it is fixed and the request closes. If they do not answer, tap **Close request**.

## 8. Reports

Go to **Reports**. Choose the period (this month, last month, last 3 or 12 months, this year, or your own dates).

- **Monthly income**: what you billed and what you collected.
- **Machines**: revenue, copies, service cost and profit per machine.
- **Customers**: what each customer was billed and paid, and how quickly they pay.
- **Outstanding**, **Service and toner**, **Usage trends**, **Rental information**, **Billing cycle status**.

Each report can be downloaded as **PDF** or **Excel**.

## 9. Returning a machine

1. Open the machine and tap **Return machine**.
2. Type the final meter numbers and the reason.
3. RentDesk makes the final bill (for the days used, or a full month, as you choose).
4. If you hold a security deposit, choose how to settle it now (pay unpaid bills, refund, keep with a reason) or
   **Keep holding it, settle later**. Deposits still held are listed under **Deposits to settle** on Home.
5. Tap **Return machine**. The machine is available again.

## 10. If something goes wrong

- **"The connection was slow…"**: read the message. If it says **"Tap the button again: it is never done twice"**,
  just tap again. If it says **"Reload the page to see whether it was saved"**, reload first and check, so nothing is
  done twice.
- **"New version available — tap to refresh"**: tap it. You stay on the same page.
- **"No internet connection"**: check your mobile data or Wi-Fi. The page opens again by itself.
- **Emails**: **Settings › Emails** shows every email and whether it was delivered.
- For anything else, contact Ciigus.
