import assert from "node:assert/strict";
import test from "node:test";
import { isSuccessfulPayPalCaptureStatus, validatePayPalCapture, type PayPalCaptureCheck } from "./paypalValidation.ts";

const valid: PayPalCaptureCheck = { localOrderId: 42, ownerId: "user_1", authenticatedUserId: "user_1", orderStatus: "awaiting_payment", paymentMethod: "paypal", expectedAmount: "9.60", paypalCustomId: "42", paypalStatus: "COMPLETED", captureStatus: "COMPLETED", currency: "USD", paidAmount: "9.60", captureId: "CAP-1" };
test("accepts PayPal capture HTTP 200 responses", () => assert.equal(isSuccessfulPayPalCaptureStatus(200), true));
test("accepts PayPal capture HTTP 201 responses", () => assert.equal(isSuccessfulPayPalCaptureStatus(201), true));
test("rejects non-successful PayPal capture responses", () => assert.equal(isSuccessfulPayPalCaptureStatus(202), false));
test("accepts a completed matching capture", () => assert.equal(validatePayPalCapture(valid), null));
test("accepts PayPal-hosted card captures", () => assert.equal(validatePayPalCapture({ ...valid, paymentMethod: "card" }), null));
test("accepts Pay Later captures", () => assert.equal(validatePayPalCapture({ ...valid, paymentMethod: "paylater" }), null));
test("rejects amount mismatch", () => assert.equal(validatePayPalCapture({ ...valid, paidAmount: "9.61" }), "amount_mismatch"));
test("rejects the wrong Clerk user", () => assert.equal(validatePayPalCapture({ ...valid, authenticatedUserId: "user_2" }), "wrong_user"));
test("rejects a capture reused for another transaction", () => assert.equal(validatePayPalCapture({ ...valid, existingCaptureId: "CAP-OTHER" }), "duplicate_capture"));
test("permits an idempotent repeat after confirmation", () => assert.equal(validatePayPalCapture({ ...valid, orderStatus: "confirmed", existingCaptureId: "CAP-1" }), null));
test("rejects incomplete and non-USD captures", () => { assert.equal(validatePayPalCapture({ ...valid, captureStatus: "DENIED" }), "not_completed"); assert.equal(validatePayPalCapture({ ...valid, currency: "EGP" }), "wrong_currency"); });
