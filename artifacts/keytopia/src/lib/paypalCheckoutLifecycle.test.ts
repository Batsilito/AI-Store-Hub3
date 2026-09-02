import assert from "node:assert/strict";
import test from "node:test";
import { createPayPalSessionLifecycle } from "./paypalCheckoutLifecycle.ts";

test("session start resolution does not capture or confirm an order", async () => {
  const events: string[] = [];
  const lifecycle = createPayPalSessionLifecycle({
    onApprove: async () => events.push("capture"),
    onMissingOrderId: () => events.push("missing-order-id"),
    onCancel: () => events.push("cancel"),
    onError: () => events.push("error"),
  });

  await lifecycle.start(async () => events.push("session-resolved"));

  assert.deepEqual(events, ["session-resolved"]);
  assert.equal(lifecycle.isApproved(), false);
});

test("capture starts only after approval provides a PayPal order ID", async () => {
  const capturedOrderIds: string[] = [];
  let missingOrderIdCount = 0;
  const lifecycle = createPayPalSessionLifecycle({
    onApprove: async (paypalOrderId) => capturedOrderIds.push(paypalOrderId),
    onMissingOrderId: () => { missingOrderIdCount += 1; },
    onCancel: () => {},
    onError: () => {},
  });

  await lifecycle.start(async () => {});
  assert.deepEqual(capturedOrderIds, []);

  await lifecycle.callbacks.onApprove({});
  assert.deepEqual(capturedOrderIds, []);
  assert.equal(missingOrderIdCount, 1);

  await lifecycle.callbacks.onApprove({ orderId: "PAYPAL-ORDER-1" });
  assert.deepEqual(capturedOrderIds, ["PAYPAL-ORDER-1"]);
});

test("onCancel after approval cannot overwrite a successful capture", async () => {
  const events: string[] = [];
  const lifecycle = createPayPalSessionLifecycle({
    onApprove: async () => events.push("capture"),
    onMissingOrderId: () => events.push("missing-order-id"),
    onCancel: () => events.push("cancel"),
    onError: () => events.push("error"),
  });

  await lifecycle.callbacks.onApprove({ orderId: "PAYPAL-ORDER-2" });
  lifecycle.callbacks.onCancel({ orderId: "PAYPAL-ORDER-2" });

  assert.deepEqual(events, ["capture"]);
  assert.equal(lifecycle.isApproved(), true);
});