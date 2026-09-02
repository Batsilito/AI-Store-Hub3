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

Guest-card `auto` presentation can render PayPal’s hosted form inline with PayPal-controlled language, address fields, country defaults, and layout; use `modal` when the inline fallback does not fit the storefront UI.

**Why:** The merchant cannot fully style or localize PayPal’s hosted guest-card form, and its inline layout can appear visually compressed inside an RTL checkout.

**How to apply:** Keep the required `targetElement`, but start the guest-card session with `presentationMode: "modal"` when advanced inline card fields are not eligible.

The preview workflow and published deployment are separate runtimes. Production PayPal routes and diagnostics do not change until the updated project is published; verify preview routes locally before asking the owner to publish.

**Why:** A production config probe can still show the previous build even when the preview has the corrected route and environment wiring.

**How to apply:** Treat production endpoint results as stale until a publish completes successfully, then recheck the production config endpoint without exposing the client secret.

The canonical Neon order table must contain the PayPal order/capture columns before any server code selects from it; otherwise the shared local-order idempotency lookup fails before PayPal is contacted.

**Why:** PayPal and card checkout both depend on the same local order creation endpoint, so a missing nullable payment column breaks both methods even when SDK eligibility succeeds.

**How to apply:** Keep the additive PayPal schema migration applied to the canonical development database, then publish through the normal production schema process without replacing or resetting existing order data.

Checkout order validation should normalize selected duration labels before comparing them with stored product pricing options.

**Why:** Existing cart entries can retain harmless whitespace differences from product records, and rejecting the whole order makes every payment method appear broken.

**How to apply:** Normalize duration text for server-side price lookup while still requiring the product to be published and in stock.