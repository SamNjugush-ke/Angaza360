// The few backend refusals that are not written for a cashier, said in words a cashier can act on.
// Everything else the API says (an insufficient-stock refusal naming the product and what is
// left, a closed period) is already plain and is shown as it is.

// The API words money as shillings ("KES 1,500.00") since T-B-ERR-MONEY-FMT; these read its wording.
const CREDIT_OVER = /^Credit of (KES -?[\d,]+\.\d{2}) exceeds the customer's remaining credit of (KES -?[\d,]+\.\d{2})\.$/;
const TENDER_MISMATCH = /^Tenders total (KES -?[\d,]+\.\d{2}) but the sale total is (KES -?[\d,]+\.\d{2})\.$/;

/** A sale refusal as the cashier should read it. */
export function cashierMessage(message: string): string {
  const credit = CREDIT_OVER.exec(message);
  if (credit) {
    return `This puts ${credit[1] ?? ""} on credit, but the customer has only ${credit[2] ?? ""} of credit left.`;
  }
  const mismatch = TENDER_MISMATCH.exec(message);
  if (mismatch) {
    return `The total changed to ${mismatch[2] ?? ""} (payment entered: ${mismatch[1] ?? ""}). Check the payment and charge again.`;
  }
  return message;
}

/** Whether a refusal means the total the till took payment against is stale. */
export function isTenderMismatch(message: string): boolean {
  return TENDER_MISMATCH.test(message);
}
