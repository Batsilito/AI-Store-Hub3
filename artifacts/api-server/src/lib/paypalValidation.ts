export type PayPalCaptureCheck = {
  localOrderId: number; ownerId: string; authenticatedUserId?: string;
  orderStatus: string; paymentMethod: string | null; expectedAmount: string;
  paypalCustomId?: string; paypalStatus?: string; captureStatus?: string;
  currency?: string; paidAmount?: string; existingCaptureId?: string | null; captureId?: string;
};

export function isSuccessfulPayPalCaptureStatus(status: number): boolean {
  return status === 200 || status === 201;
}

/** Pure integrity gate kept separate so every negative case is regression tested. */
export function validatePayPalCapture(input: PayPalCaptureCheck): string | null {
  if (input.authenticatedUserId !== undefined && input.ownerId !== input.authenticatedUserId) return "wrong_user";
  if (input.orderStatus !== "awaiting_payment") return input.existingCaptureId === input.captureId ? null : "wrong_status";
  if (!["paypal", "paylater", "card"].includes(input.paymentMethod ?? "")) return "wrong_method";
  // PayPal's capture response is not guaranteed to echo the custom_id that was
  // sent when the order was created. When it does return the field, keep
  // checking it; when it omits the field, the local paypalOrderId lookup,
  // customer ownership check, amount, currency, and completed statuses still
  // bind this capture to the local order.
  if (input.paypalCustomId != null && input.paypalCustomId !== String(input.localOrderId)) return "wrong_order";
  if (input.paypalStatus !== "COMPLETED" || input.captureStatus !== "COMPLETED") return "not_completed";
  if (input.currency !== "USD") return "wrong_currency";
  if (input.paidAmount !== input.expectedAmount) return "amount_mismatch";
  if (input.existingCaptureId && input.existingCaptureId !== input.captureId) return "duplicate_capture";
  return null;
}
