import { randomUUID } from "node:crypto";
import { Router, type IRouter, type Request, type Response as ExpressResponse } from "express";
import { getAuth } from "@clerk/express";
import { and, eq, inArray } from "drizzle-orm";
import { cashbackTransactionsTable, db, ordersTable } from "@workspace/db";
import { confirmOrder } from "../lib/orderCompletion";
import { validatePayPalCapture } from "../lib/paypalValidation";

const router: IRouter = Router();
type PayPalPayload = Record<string, any>;
type PayPalCallResult = {
  response: globalThis.Response;
  payload: PayPalPayload;
  paypalDebugId: string | null;
};

class PayPalApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly paypalDebugId: string | null,
    readonly paypalName: string | null,
    readonly details: unknown,
    message: string,
  ) {
    super(message);
    this.name = "PayPalApiError";
  }
}

const environment = () => process.env.PAYPAL_ENV === "live" ? "live" : "sandbox";
const host = () => environment() === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
const configured = () => Boolean(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET);

function requestIdFor(req: Request): string {
  return String(req.id ?? randomUUID());
}

function structuredError(
  req: Request,
  res: ExpressResponse,
  requestId: string,
  status: number,
  code: string,
  message: string,
  paypalDebugId: string | null = null,
): void {
  req.log.error({ requestId, code, paypalDebugId }, "PayPal request failed");
  res.status(status).json({ code, message, paypalDebugId, requestId });
}

function errorFrom(error: unknown): PayPalApiError {
  if (error instanceof PayPalApiError) return error;
  return new PayPalApiError(
    "paypal_internal_error",
    502,
    null,
    null,
    null,
    "PayPal is temporarily unavailable",
  );
}

function safePayPalDetails(payload: PayPalPayload): Array<{ issue: string | null; description: string | null }> {
  return Array.isArray(payload.details)
    ? payload.details.slice(0, 10).map((detail: any) => ({
      issue: typeof detail?.issue === "string" ? detail.issue : null,
      description: typeof detail?.description === "string" ? detail.description : null,
    }))
    : [];
}

function safePayPalBody(payload: PayPalPayload): PayPalPayload {
  const purchaseUnits = Array.isArray(payload.purchase_units)
    ? payload.purchase_units.slice(0, 10).map((unit: any) => ({
      reference_id: typeof unit?.reference_id === "string" ? unit.reference_id : null,
      custom_id: typeof unit?.custom_id === "string" ? unit.custom_id : null,
      amount: unit?.amount && typeof unit.amount === "object"
        ? {
          currency_code: typeof unit.amount.currency_code === "string" ? unit.amount.currency_code : null,
          value: typeof unit.amount.value === "string" ? unit.amount.value : null,
        }
        : null,
      payments: unit?.payments && typeof unit.payments === "object"
        ? {
          captures: Array.isArray(unit.payments.captures)
            ? unit.payments.captures.slice(0, 10).map((capture: any) => ({
              id: typeof capture?.id === "string" ? capture.id : null,
              status: typeof capture?.status === "string" ? capture.status : null,
              amount: capture?.amount && typeof capture.amount === "object"
                ? {
                  currency_code: typeof capture.amount.currency_code === "string" ? capture.amount.currency_code : null,
                  value: typeof capture.amount.value === "string" ? capture.amount.value : null,
                }
                : null,
            }))
            : [],
        }
        : null,
    }))
    : [];
  return {
    id: typeof payload.id === "string" ? payload.id : null,
    status: typeof payload.status === "string" ? payload.status : null,
    intent: typeof payload.intent === "string" ? payload.intent : null,
    name: typeof payload.name === "string" ? payload.name : null,
    message: typeof payload.message === "string" ? payload.message : null,
    debug_id: typeof payload.debug_id === "string" ? payload.debug_id : null,
    details: safePayPalDetails(payload),
    purchase_units: purchaseUnits,
  };
}

async function readPayPalResponse(req: Request, operation: string, response: globalThis.Response): Promise<{
  payload: PayPalPayload;
  paypalDebugId: string | null;
}> {
  const raw = await response.text();
  let payload: PayPalPayload = {};
  try {
    payload = raw ? JSON.parse(raw) as PayPalPayload : {};
  } catch {
    payload = { message: raw.slice(0, 500) };
  }
  const paypalDebugId = response.headers.get("paypal-debug-id");
  const safeBody = safePayPalBody(payload);
  req.log.info({
    paypalOperation: operation,
    status: response.status,
    paypalDebugId,
    errorName: safeBody.name,
    details: safeBody.details,
    debug_id: safeBody.debug_id,
    safeBody,
  }, "PayPal response");
  return { payload, paypalDebugId };
}

async function accessToken(req: Request, requestId: string): Promise<string> {
  if (!configured()) {
    throw new PayPalApiError("paypal_not_configured", 503, null, null, null, "PayPal is temporarily unavailable");
  }
  const basic = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString("base64");
  const response = await fetch(`${host()}/v1/oauth2/token`, { method: "POST", headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" }, body: "grant_type=client_credentials" });
  const { payload, paypalDebugId } = await readPayPalResponse(req, "oauth_token", response);
  const token = typeof payload.access_token === "string" ? payload.access_token : "";
  if (!response.ok || !token) {
    throw new PayPalApiError(
      "paypal_oauth_failed",
      502,
      paypalDebugId,
      typeof payload.name === "string" ? payload.name : null,
      payload.details ?? null,
      "PayPal authentication failed",
    );
  }
  req.log.info({ requestId, paypalOperation: "oauth_token", status: response.status, paypalDebugId }, "PayPal OAuth succeeded");
  return token;
}

async function paypal(req: Request, requestId: string, operation: string, path: string, init: RequestInit = {}): Promise<PayPalCallResult> {
  const token = await accessToken(req, requestId);
  const response = await fetch(`${host()}${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...init.headers } });
  const { payload, paypalDebugId } = await readPayPalResponse(req, operation, response);
  return { response, payload, paypalDebugId };
}

function userId(req: Request) { return getAuth(req)?.userId ?? null; }
function captureFrom(payload: any) { return payload?.purchase_units?.[0]?.payments?.captures?.[0]; }
function usdAmountFromOrder(total: unknown): string {
  const numericTotal = Number(total);
  if (!Number.isFinite(numericTotal) || numericTotal < 0) throw new Error("Invalid stored USD order total");
  const value = numericTotal.toFixed(2);
  if (!/^\d+\.\d{2}$/.test(value)) throw new Error("Invalid stored USD order total");
  return value;
}

router.get("/paypal/config", (_req, res) => res.json({ available: configured(), clientId: process.env.PAYPAL_CLIENT_ID ?? null, environment: environment() }));

router.post("/paypal/orders", async (req, res): Promise<void> => {
  const requestId = requestIdFor(req);
  const customerId = userId(req);
  const localOrderId = Number(req.body?.localOrderId);
  if (!customerId) { structuredError(req, res, requestId, 401, "authentication_required", "Sign in is required"); return; }
  try {
    const [order] = await db.select().from(ordersTable).where(and(eq(ordersTable.id, localOrderId), eq(ordersTable.customerId, customerId))).limit(1);
    if (!order || order.status !== "awaiting_payment" || !["paypal", "paylater", "card"].includes(order.paymentMethod ?? "") || order.currency !== "USD") {
      structuredError(req, res, requestId, 409, "order_not_eligible", "Order is not eligible for PayPal");
      return;
    }
    if (order.paypalOrderId) { res.json({ paypalOrderId: order.paypalOrderId, localOrderId: order.id }); return; }
    const value = usdAmountFromOrder(order.total);
    const createPayload = {
      intent: "CAPTURE",
      purchase_units: [{
        reference_id: String(order.id),
        custom_id: String(order.id),
        amount: { currency_code: "USD", value },
      }],
    };
    req.log.info({ requestId, paypalOperation: "create_order", currency: createPayload.purchase_units[0].amount.currency_code, value }, "PayPal create request");
    const result = await paypal(req, requestId, "create_order", "/v2/checkout/orders", { method: "POST", headers: { "PayPal-Request-Id": `keytopia-create-${order.id}` }, body: JSON.stringify(createPayload) });
    if (!result.response.ok || typeof result.payload.id !== "string" || !result.payload.id) {
      throw new PayPalApiError("paypal_create_order_failed", 502, result.paypalDebugId, typeof result.payload.name === "string" ? result.payload.name : null, result.payload.details ?? null, "PayPal could not create the order");
    }
    const [claimed] = await db.update(ordersTable).set({ paypalOrderId: result.payload.id }).where(and(eq(ordersTable.id, order.id), eq(ordersTable.status, "awaiting_payment"))).returning();
    req.log.info({ requestId, localOrderId: order.id, paypalOrderId: result.payload.id, localOrderStatus: claimed?.status ?? order.status }, "PayPal order ID saved to local order");
    res.json({ paypalOrderId: claimed?.paypalOrderId ?? result.payload.id, localOrderId: order.id });
  } catch (error) {
    const failure = errorFrom(error);
    structuredError(req, res, requestId, failure.status, failure.code, failure.message, failure.paypalDebugId);
  }
});

router.post("/paypal/orders/:paypalOrderId/capture", async (req, res): Promise<void> => {
  const requestId = requestIdFor(req);
  const customerId = userId(req); const id = req.params.paypalOrderId;
  if (!customerId) { structuredError(req, res, requestId, 401, "authentication_required", "Sign in is required"); return; }
  try {
    const [order] = await db.select().from(ordersTable).where(and(eq(ordersTable.paypalOrderId, id), eq(ordersTable.customerId, customerId))).limit(1);
    if (!order) { structuredError(req, res, requestId, 404, "order_not_found", "Order not found"); return; }
    if (order.paypalCaptureId && ["confirmed", "fulfilled"].includes(order.status)) { res.json({ completed: true, orderId: order.id }); return; }
    if (order.status !== "awaiting_payment" || !["paypal", "paylater", "card"].includes(order.paymentMethod ?? "")) { structuredError(req, res, requestId, 409, "order_not_awaiting_payment", "Order is not awaiting PayPal payment"); return; }
    const capturePath = `/v2/checkout/orders/${encodeURIComponent(id)}/capture`;
    req.log.info({ requestId, localOrderId: order.id, paypalOrderId: id, method: "POST", endpoint: capturePath }, "PayPal capture request");
    const result = await paypal(req, requestId, "capture_order", capturePath, { method: "POST", headers: { "PayPal-Request-Id": `keytopia-capture-${order.id}` } });
    const payload = result.payload; const capture = captureFrom(payload);
    const paypalIssue = Array.isArray(payload.details)
      ? payload.details.find((detail: any) => typeof detail?.issue === "string")?.issue
      : undefined;
    if (![200, 201].includes(result.response.status)) {
      const complianceFailure = paypalIssue === "COMPLIANCE_VIOLATION";
      const safeBody = safePayPalBody(payload);
      req.log.error({ requestId, orderId: order.id, paypalOrderId: id, paypalIssue: paypalIssue ?? null, paypalDebugId: result.paypalDebugId, errorName: safeBody.name, details: safeBody.details, debug_id: safeBody.debug_id, safeBody }, "PayPal capture was rejected");
      structuredError(
        req,
        res,
        requestId,
        502,
        complianceFailure ? "paypal_compliance_violation" : "paypal_capture_failed",
        complianceFailure
          ? "PayPal rejected this payment because of a compliance or account restriction"
          : "PayPal could not complete the payment",
        result.paypalDebugId,
      );
      return;
    }
    const amount = capture?.amount;
    const integrityError = validatePayPalCapture({ localOrderId: order.id, ownerId: order.customerId, authenticatedUserId: customerId, orderStatus: order.status, paymentMethod: order.paymentMethod, expectedAmount: usdAmountFromOrder(order.total), paypalCustomId: payload.purchase_units?.[0]?.custom_id, paypalStatus: payload.status, captureStatus: capture?.status, currency: amount?.currency_code, paidAmount: amount?.value, existingCaptureId: order.paypalCaptureId, captureId: capture?.id });
    if (integrityError) {
      req.log.error({ requestId, orderId: order.id, paypalOrderId: id, integrityError, paypalDebugId: result.paypalDebugId }, "PayPal payment integrity check failed");
       structuredError(req, res, requestId, result.response.status === 200 || result.response.status === 201 ? 409 : 502, result.response.status === 200 || result.response.status === 201 ? "paypal_payment_verification_failed" : "paypal_capture_failed", result.response.status === 200 || result.response.status === 201 ? "Payment verification failed" : "PayPal could not complete the payment", result.paypalDebugId);
      return;
    }
    const completed = await confirmOrder(order.id, { paypalOrderId: id, captureId: capture.id, amount: amount.value, paidAt: new Date(capture.create_time ?? Date.now()) });
    req.log.info({ requestId, localOrderId: order.id, paypalOrderId: id, paypalCaptureId: capture.id, paypalStatus: payload.status, captureStatus: capture.status, localOrderStatus: completed?.order?.status ?? null }, "PayPal local order update completed");
    res.json({ completed: true, orderId: order.id });
  } catch (error) {
    const failure = errorFrom(error);
    structuredError(req, res, requestId, failure.status, failure.code, failure.message, failure.paypalDebugId);
  }
});

router.post("/paypal/webhook", async (req, res): Promise<void> => {
  const requestId = requestIdFor(req);
  if (!process.env.PAYPAL_WEBHOOK_ID) { res.status(503).end(); return; }
  try {
    const verify = await paypal(req, requestId, "verify_webhook", "/v1/notifications/verify-webhook-signature", { method: "POST", body: JSON.stringify({ auth_algo: req.get("paypal-auth-algo"), cert_url: req.get("paypal-cert-url"), transmission_id: req.get("paypal-transmission-id"), transmission_sig: req.get("paypal-transmission-sig"), transmission_time: req.get("paypal-transmission-time"), webhook_id: process.env.PAYPAL_WEBHOOK_ID, webhook_event: req.body }) });
    const verification = verify.payload as { verification_status?: string };
    if (!verify.response.ok || verification.verification_status !== "SUCCESS") { res.status(400).json({ error: "Invalid PayPal webhook signature" }); return; }
    const event = req.body as any; const capture = event.resource; const paypalOrderId = capture?.supplementary_data?.related_ids?.order_id;
    if (!paypalOrderId) { res.status(204).end(); return; }
    const [order] = await db.select().from(ordersTable).where(eq(ordersTable.paypalOrderId, paypalOrderId)).limit(1);
    if (!order) { res.status(204).end(); return; }
    if (event.event_type === "PAYMENT.CAPTURE.COMPLETED" && capture.status === "COMPLETED" && capture.amount?.currency_code === "USD" && capture.amount?.value === usdAmountFromOrder(order.total)) await confirmOrder(order.id, { paypalOrderId, captureId: capture.id, amount: capture.amount.value, paidAt: new Date(capture.create_time ?? Date.now()) });
    if (["PAYMENT.CAPTURE.DENIED", "PAYMENT.CAPTURE.REFUNDED", "PAYMENT.CAPTURE.REVERSED"].includes(event.event_type)) await db.transaction(async tx => { const [locked] = await tx.select().from(ordersTable).where(eq(ordersTable.id, order.id)).for("update"); if (!locked || locked.status === "cancelled") return; await tx.update(ordersTable).set({ status: "cancelled" }).where(eq(ordersTable.id, order.id)); await tx.update(cashbackTransactionsTable).set({ status: "voided" }).where(and(eq(cashbackTransactionsTable.orderId, order.id), eq(cashbackTransactionsTable.type, "credit"), inArray(cashbackTransactionsTable.status, ["pending", "available"]))); await tx.update(cashbackTransactionsTable).set({ status: "reversed" }).where(and(eq(cashbackTransactionsTable.orderId, order.id), eq(cashbackTransactionsTable.type, "debit"), eq(cashbackTransactionsTable.status, "redeemed"))); });
    res.status(204).end();
  } catch (error) {
    const failure = errorFrom(error);
    structuredError(req, res, requestId, failure.status, failure.code, failure.message, failure.paypalDebugId);
  }
});

export default router;
