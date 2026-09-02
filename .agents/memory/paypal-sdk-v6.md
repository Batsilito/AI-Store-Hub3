---
name: PayPal JavaScript SDK v6
description: PayPal v6 checkout and card-field integration constraints verified against current SDK documentation.
---

PayPal JavaScript SDK v6 uses the core Web SDK URL and payment sessions instead of the legacy `sdk/js` loader, `Buttons`, or `CardFields` APIs. The current Card Fields API hosts number, expiry, and CVV components; cardholder name is supplied through the session submit options rather than a hosted name component. Standalone guest card checkout uses the basic-card custom element and the guest payment session.

**Why:** The v5 and v6 APIs expose similar concepts with different initialization, eligibility, callback, and component contracts; mixing them causes checkout controls to appear unavailable or fail at runtime.

**How to apply:** Load v6 components explicitly, check `findEligibleMethods` for `paypal`, `advanced_cards`, and `card`, return `{ orderId }` from the frontend order callback, and keep order creation/capture and secrets on the backend.

For standalone guest-card checkout, pass the actual `<paypal-basic-card-button>` as `targetElement` in the session `start()` options.

**Why:** The SDK can render the button but rejects guest-card startup at runtime when the target element is omitted or points to the container instead of the button.

**How to apply:** Create and append the basic-card button first, then call `start({ presentationMode: "auto", targetElement: basicCardButton }, createOrder())`.

Guest-card `auto` presentation renders PayPal’s hosted form inline with PayPal-controlled language, address fields, country defaults, and layout; the current PayPal environment rejects `modal` for this flow.

**Why:** The merchant cannot fully style or localize PayPal’s hosted guest-card form, and presentation-mode support varies by PayPal integration/environment.

**How to apply:** Keep the required `targetElement` and use `presentationMode: "auto"` for this integration; do not switch to `modal` unless the active PayPal environment explicitly supports it.

PayPal Sandbox can create an order successfully and still reject capture with `COMPLIANCE_VIOLATION`; this is an account or transaction restriction, not proof that the local order payload is invalid.

**Why:** The Orders API validates creation and capture separately, and PayPal applies additional buyer, seller, funding, and compliance checks during capture.

**How to apply:** Leave the local order unconfirmed, show the PayPal debug ID, and test with a valid Sandbox Personal buyer and Sandbox Business merchant account before changing capture code.

The preview workflow and published deployment are separate runtimes. Production PayPal routes and diagnostics do not change until the updated project is published; verify preview routes locally before asking the owner to publish.

**Why:** A production config probe can still show the previous build even when the preview has the corrected route and environment wiring.

**How to apply:** Treat production endpoint results as stale until a publish completes successfully, then recheck the production config endpoint without exposing the client secret.

The canonical Neon order table must contain the PayPal order/capture columns before any server code selects from it; otherwise the shared local-order idempotency lookup fails before PayPal is contacted.

**Why:** PayPal and card checkout both depend on the same local order creation endpoint, so a missing nullable payment column breaks both methods even when SDK eligibility succeeds.

**How to apply:** Keep the additive PayPal schema migration applied to the canonical development database, then publish through the normal production schema process without replacing or resetting existing order data.

Checkout order validation should normalize selected duration labels before comparing them with stored product pricing options.

**Why:** Existing cart entries can retain harmless whitespace differences from product records, and rejecting the whole order makes every payment method appear broken.

**How to apply:** Normalize duration text for server-side price lookup while still requiring the product to be published and in stock.

Pay Later requires a separate v6 eligibility/session path: check `paylater`, read its `productCode` and `countryCode`, configure PayPal's official `paylater-button`, and capture the resulting order server-side. Hide it when PayPal reports the buyer, merchant, currency, or amount is ineligible.

**Why:** Pay Later offers are restricted by market and transaction context; showing a handmade installment promise or bypassing eligibility would violate PayPal's integration and messaging requirements.

**How to apply:** Treat Pay Later as an optional USD payment method backed by the same server-side order and capture validation as PayPal Checkout, without assuming Egypt-based merchants or buyers qualify.

PayPal v6 `paymentSession.start()` resolving only means the hosted flow has returned; it is not payment approval. Capture must begin only from `onApprove(data.orderId)`, while `onCancel` and `onError` remain non-payment paths.

**Why:** The hosted popup can close after review without completing a transaction, and treating `start()` resolution as success can confirm unpaid local orders.

**How to apply:** Keep the session promise and approval callback separate, log both during Sandbox debugging, and require a completed server-side capture before changing the local order to paid.

PayPal customized card fields are eligibility-gated by the merchant/buyer country and currency; Egypt is not listed in the supplied expanded-card country table.

**Why:** Forcing the `advanced_cards` component outside PayPal's eligible regions can produce an empty or unusable card option even when PayPal account checkout works.

**How to apply:** Use `findEligibleMethods` before rendering custom fields, show the PayPal-hosted card path only when PayPal reports it eligible, and explain when neither card path is available.