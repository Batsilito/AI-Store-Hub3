import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { Router, type IRouter, type Request } from "express";
import { rateLimit } from "express-rate-limit";
import { getAuth } from "@clerk/express";
import { and, desc, eq, gte, ilike, inArray, lt, ne, or, sql } from "drizzle-orm";
import {
  analyticsVisitsTable,
  cashbackTransactionsTable,
  customerProfilesTable,
  db,
  orderItemsTable,
  ordersTable,
  productsTable,
  promoCodesTable,
  settingsTable,
} from "@workspace/db";
import {
  CreateOrderBody,
  CreateOrderResponse,
  GetAdminDashboardResponse,
  GetAdminSalesAnalyticsQueryParams,
  GetAdminSalesAnalyticsResponse,
  GetAdminVisitsAnalyticsQueryParams,
  GetAdminVisitsAnalyticsResponse,
  ListAdminOrdersQueryParams,
  ListAdminOrdersResponse,
  ListMyOrdersResponse,
  RecordVisitBody,
  UpdateOrderStatusBody,
  UpdateOrderStatusParams,
  UpdateOrderStatusResponse,
} from "@workspace/api-zod";
import { requireAdmin } from "../middlewares/requireAdmin";
import { referralCodeFor } from "../lib/referrals";
import { confirmOrder } from "../lib/orderCompletion";

const router: IRouter = Router();
const orderStatuses = new Set(["awaiting_payment", "payment_proof_received", "confirmed", "fulfilled", "cancelled"]);
const completedOrderStatuses = new Set(["confirmed", "fulfilled"]);
const analyticsPresets = new Set([
  "today",
  "yesterday",
  "last_week",
  "last_2_weeks",
  "last_month",
  "last_3_months",
  "last_6_months",
  "year",
  "custom",
]);

type ProductRecord = typeof productsTable.$inferSelect;

function mapOrder(
  order: typeof ordersTable.$inferSelect,
  items: Array<typeof orderItemsTable.$inferSelect>,
) {
  return {
    id: order.id,
    orderNumber: /^\d+$/.test(order.orderNumber) ? Number(order.orderNumber) : order.orderNumber,
    customerName: order.customerName,
    customerEmail: order.customerEmail,
    customerPhone: order.customerPhone,
    currency: order.currency,
    subtotal: Number(order.subtotal),
    discount: Number(order.discount),
    total: Number(order.total),
    promoCode: order.promoCode,
    paymentMethod: order.paymentMethod,
    status: order.status,
    items: items.map((item) => ({
      id: item.id,
      productId: item.productId,
      productName: item.productName,
      coverImageUrl: item.coverImageUrl,
      duration: item.duration,
      unitPrice: Number(item.unitPrice),
      quantity: item.quantity,
      lineTotal: Number(item.lineTotal),
    })),
    createdAt: order.createdAt.toISOString(),
    updatedAt: order.updatedAt.toISOString(),
  };
}

async function withItems(orders: Array<typeof ordersTable.$inferSelect>) {
  if (!orders.length) return [];
  const items = await db
    .select()
    .from(orderItemsTable)
    .where(inArray(orderItemsTable.orderId, orders.map((order) => order.id)));
  const grouped = new Map<number, Array<typeof orderItemsTable.$inferSelect>>();
  for (const item of items) {
    const group = grouped.get(item.orderId) ?? [];
    group.push(item);
    grouped.set(item.orderId, group);
  }
  return orders.map((order) => mapOrder(order, grouped.get(order.id) ?? []));
}

export function unitPrice(product: ProductRecord, duration: string, currency: "EGP" | "USD", egpPerUsd = 52): number | null {
  const options = product.pricingOptions ?? [];
  const normalizedDuration = duration.trim().toLowerCase();
  const matched = options.find((option) => option.duration.trim().toLowerCase() === normalizedDuration);
  if (matched) {
    if (currency === "USD") {
      return matched.salePriceUsd ?? matched.priceUsd ?? Math.round((matched.salePrice ?? matched.price) / egpPerUsd * 100) / 100;
    }
    return matched.salePrice ?? matched.price;
  }

  if (product.duration.trim().toLowerCase() !== normalizedDuration) return null;
  if (currency === "USD") return product.salePriceUsd != null ? Number(product.salePriceUsd) : product.priceUsd != null ? Number(product.priceUsd) : Math.round((product.salePrice != null ? Number(product.salePrice) : Number(product.price)) / egpPerUsd * 100) / 100;
  return product.salePrice != null ? Number(product.salePrice) : Number(product.price);
}

function authUserId(req: Request): string | null {
  const auth = getAuth(req);
  return auth?.userId ?? null;
}

function getHeader(req: Request, names: string[]): string | null {
  for (const name of names) {
    const value = req.get(name);
    if (value && /^[A-Za-z]{2}$/.test(value.trim())) return value.trim().toUpperCase();
  }
  return null;
}

function isPrivateOrLocalIp(value: string): boolean {
  const ip = value.trim().replace(/^::ffff:/i, "");
  const ipVersion = isIP(ip);

  if (ipVersion === 4) {
    const octets = ip.split(".").map(Number);
    const [first, second] = octets;
    return first === 10
      || first === 127
      || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && second === 168)
      || (first === 169 && second === 254);
  }

  if (ipVersion === 6) {
    const normalized = ip.toLowerCase();
    return normalized === "::"
      || normalized === "::1"
      || normalized.startsWith("fc")
      || normalized.startsWith("fd")
      || normalized.startsWith("fe8")
      || normalized.startsWith("fe9")
      || normalized.startsWith("fea")
      || normalized.startsWith("feb");
  }

  return true;
}

type AnalyticsRange = {
  preset: string;
  start: Date;
  endExclusive: Date;
  startDate: string;
  endDate: string;
};

function toUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function addUtcDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function formatUtcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || formatUtcDay(date) !== value ? null : date;
}

function resolveAnalyticsRange(query: Request["query"]): AnalyticsRange | null {
  const rawPreset = Array.isArray(query.preset) ? query.preset[0] : query.preset;
  const preset = typeof rawPreset === "string" ? rawPreset : "last_month";
  if (!analyticsPresets.has(preset)) return null;

  if (preset === "custom") {
    const rawStart = Array.isArray(query.startDate) ? query.startDate[0] : query.startDate;
    const rawEnd = Array.isArray(query.endDate) ? query.endDate[0] : query.endDate;
    const start = parseDate(rawStart);
    const end = parseDate(rawEnd);
    if (!start || !end || end < start) return null;
    return {
      preset,
      start,
      endExclusive: addUtcDays(end, 1),
      startDate: formatUtcDay(start),
      endDate: formatUtcDay(end),
    };
  }

  const today = toUtcDay(new Date());
  const tomorrow = addUtcDays(today, 1);
  if (preset === "today") return { preset, start: today, endExclusive: tomorrow, startDate: formatUtcDay(today), endDate: formatUtcDay(today) };
  if (preset === "yesterday") {
    const yesterday = addUtcDays(today, -1);
    return { preset, start: yesterday, endExclusive: today, startDate: formatUtcDay(yesterday), endDate: formatUtcDay(yesterday) };
  }

  const daysByPreset: Record<string, number> = {
    last_week: 7,
    last_2_weeks: 14,
    last_month: 30,
    last_3_months: 90,
    last_6_months: 180,
    year: 365,
  };
  const days = daysByPreset[preset];
  if (!days) return null;
  const start = addUtcDays(today, -(days - 1));
  return { preset, start, endExclusive: tomorrow, startDate: formatUtcDay(start), endDate: formatUtcDay(today) };
}

function normalizeCountryCode(value: string | null | undefined): string | null {
  const countryCode = value?.trim().toUpperCase() ?? "";
  return /^[A-Z]{2}$/.test(countryCode) ? countryCode : null;
}

async function detectCountry(req: Request, clientCountryCode?: string | null): Promise<string> {
  const headerCountry = getHeader(req, [
    "x-replit-user-country",
    "x-replit-geo-country",
    "cf-ipcountry",
    "x-vercel-ip-country",
  ]);
  if (headerCountry) return headerCountry;
  const browserCountry = normalizeCountryCode(clientCountryCode);
  if (browserCountry) return browserCountry;

  const ip = req.ip?.trim() ?? "";
  if (!ip || isPrivateOrLocalIp(ip)) {
    return "UNKNOWN";
  }
  try {
    const response = await fetch(`https://ipwho.is/${encodeURIComponent(ip)}`, { signal: AbortSignal.timeout(1200) });
    if (!response.ok) return "UNKNOWN";
    const result = await response.json() as { success?: boolean; country_code?: string };
    return result.success === false ? "UNKNOWN" : normalizeCountryCode(result.country_code) ?? "UNKNOWN";
  } catch {
    return "UNKNOWN";
  }
}

router.post("/orders", async (req, res): Promise<void> => {
  const customerId = authUserId(req);
  if (!customerId) {
    res.status(401).json({ error: "Sign in is required before placing an order" });
    return;
  }

  const parsed = CreateOrderBody.safeParse(req.body);
  if (!parsed.success) {
    req.log.warn({ errors: parsed.error.message }, "Invalid order input");
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const data = parsed.data;
  if ((data.currency === "USD" && !["paypal", "paylater", "card"].includes(data.paymentMethod ?? "")) || (data.currency === "EGP" && !["instapay", "vodafone"].includes(data.paymentMethod ?? ""))) {
    req.log.warn({
      currency: data.currency,
      paymentMethod: data.paymentMethod,
    }, "Rejected order with incompatible payment method");
    res.status(400).json({ error: "Payment method is not valid for the selected currency" }); return;
  }
  const [rateSetting] = await db.select().from(settingsTable).where(eq(settingsTable.key, "egp_usd_rate")).limit(1);
  const egpPerUsd = rateSetting && Number(rateSetting.value) > 0 ? Number(rateSetting.value) : 52;
  const productIds = [...new Set(data.items.map((item) => item.productId))];
  const products = await db
    .select()
    .from(productsTable)
    .where(and(inArray(productsTable.id, productIds), eq(productsTable.published, true)));
  const productsById = new Map(products.map((product) => [product.id, product]));

  const calculatedItems = data.items.map((requested) => {
    const product = productsById.get(requested.productId);
    const price = product ? unitPrice(product, requested.duration, data.currency, egpPerUsd) : null;
    if (!product || price == null || product.availability === "out_of_stock" || product.availability === "coming_soon") return null;
    return {
      product,
      duration: requested.duration,
      quantity: requested.quantity,
      unitPrice: price,
      lineTotal: price * requested.quantity,
    };
  });

  if (calculatedItems.some((item) => item == null)) {
    req.log.warn({
      currency: data.currency,
      paymentMethod: data.paymentMethod,
      productIds: data.items.map((item) => item.productId),
      durations: data.items.map((item) => item.duration),
    }, "Rejected order with unavailable product selection");
    res.status(400).json({ error: "One or more selected products or durations are no longer available in this currency" });
    return;
  }

  const validItems = calculatedItems as NonNullable<(typeof calculatedItems)[number]>[];
  const subtotal = validItems.reduce((sum, item) => sum + item.lineTotal, 0);
  let discount = 0;
  let promoCode: string | null = null;

  if (data.promoCode?.trim()) {
    const [promo] = await db
      .select()
      .from(promoCodesTable)
      .where(eq(promoCodesTable.code, data.promoCode.trim().toUpperCase()))
      .limit(1);
    const eligibleSubtotal = promo?.applicableProductIds?.length
      ? validItems.filter((item) => promo.applicableProductIds!.includes(item.product.id)).reduce((sum, item) => sum + item.lineTotal, 0)
      : subtotal;
    const applies = promo?.active && eligibleSubtotal > 0;
    if (promo && applies) {
      discount = Math.round(eligibleSubtotal * promo.percentage) / 100;
      promoCode = promo.code;
    }
  }

  const total = Math.max(0, subtotal - discount);
  const cashbackAmount = Math.round((data.cashbackAmount ?? 0) * 100) / 100;
  if (cashbackAmount > total) {
    req.log.warn({
      currency: data.currency,
      cashbackAmount,
      total,
    }, "Rejected order with cashback above total");
    res.status(400).json({ error: "Cashback redemption cannot exceed the order total" });
    return;
  }
  const finalTotal = Math.max(0, total - cashbackAmount);
  let created;
  try {
    created = await db.transaction(async (tx) => {
    await tx.insert(customerProfilesTable).values({
      customerId,
      name: data.customerName.trim(),
      email: data.customerEmail.trim().toLowerCase(),
      referralCode: referralCodeFor(customerId),
    }).onConflictDoUpdate({
      target: customerProfilesTable.customerId,
      set: { name: data.customerName.trim(), email: data.customerEmail.trim().toLowerCase() },
    });
    const [existing] = await tx.select().from(ordersTable).where(and(
      eq(ordersTable.customerId, customerId),
      eq(ordersTable.idempotencyKey, data.idempotencyKey),
    )).limit(1);
    if (existing) {
      const existingItems = await tx.select().from(orderItemsTable).where(eq(orderItemsTable.orderId, existing.id));
      return mapOrder(existing, existingItems);
    }

    const availableCashback = cashbackAmount > 0
      ? await (async () => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`${customerId}:${data.currency}:cashback`}))`);
        return tx.select().from(cashbackTransactionsTable)
        .where(and(
          eq(cashbackTransactionsTable.customerId, customerId),
          eq(cashbackTransactionsTable.currency, data.currency),
          or(
            and(
              eq(cashbackTransactionsTable.type, "credit"),
              eq(cashbackTransactionsTable.status, "available"),
            ),
            and(
              eq(cashbackTransactionsTable.type, "debit"),
              eq(cashbackTransactionsTable.status, "redeemed"),
            ),
          ),
        ))
        .for("update");
      })()
      : [];
    const availableTotal = availableCashback.reduce(
      (sum, transaction) => sum + (transaction.type === "credit" ? Number(transaction.amount) : -Number(transaction.amount)),
      0,
    );
    if (cashbackAmount > availableTotal + 0.001) {
      throw new Error("Cashback redemption exceeds the available balance");
    }

    const [order] = await tx.insert(ordersTable).values({
      // Generated here (not as a column DEFAULT) — see the comment on
      // orderNumber in lib/db/src/schema/orders.ts for why.
      orderNumber: sql`nextval('order_reference_seq')::text`,
      customerId,
      customerName: data.customerName.trim(),
      customerEmail: data.customerEmail.trim().toLowerCase(),
      customerPhone: data.customerPhone.trim(),
      idempotencyKey: data.idempotencyKey,
      currency: data.currency,
      subtotal: String(subtotal),
      discount: String(discount),
      total: String(finalTotal),
      promoCode,
      paymentMethod: data.paymentMethod ?? null,
      referralCode: data.referralCode?.trim().toUpperCase() ?? null,
    }).onConflictDoNothing({
      target: [ordersTable.customerId, ordersTable.idempotencyKey],
    }).returning();

    if (!order) {
      const [concurrentOrder] = await tx.select().from(ordersTable).where(and(
        eq(ordersTable.customerId, customerId),
        eq(ordersTable.idempotencyKey, data.idempotencyKey),
      )).limit(1);
      if (!concurrentOrder) throw new Error("Order idempotency conflict could not be resolved");
      const concurrentItems = await tx.select().from(orderItemsTable)
        .where(eq(orderItemsTable.orderId, concurrentOrder.id));
      return mapOrder(concurrentOrder, concurrentItems);
    }

    const items = await tx.insert(orderItemsTable).values(validItems.map((item) => ({
      orderId: order.id,
      productId: item.product.id,
      productName: item.product.name,
      coverImageUrl: item.product.coverImageUrl,
      duration: item.duration,
      unitPrice: String(item.unitPrice),
      quantity: item.quantity,
      lineTotal: String(item.lineTotal),
    }))).returning();

    if (cashbackAmount > 0) {
      await tx.insert(cashbackTransactionsTable).values({
        customerId,
        orderId: order.id,
        type: "debit",
        status: "redeemed",
        currency: data.currency,
        amount: String(cashbackAmount),
      });
    }

    return mapOrder(order, items);
    });
  } catch (error) {
    if (error instanceof Error && error.message === "Cashback redemption exceeds the available balance") {
      req.log.warn({
        currency: data.currency,
        cashbackAmount,
      }, "Rejected order with insufficient cashback balance");
      res.status(400).json({ error: error.message });
      return;
    }
    throw error;
  }

  res.status(201).json(CreateOrderResponse.parse(created));
});

router.get("/orders/me", async (req, res): Promise<void> => {
  const customerId = authUserId(req);
  if (!customerId) {
    res.status(401).json({ error: "Sign in is required" });
    return;
  }
  const orders = await db.select().from(ordersTable)
    .where(eq(ordersTable.customerId, customerId))
    .orderBy(desc(ordersTable.createdAt));
  res.json(ListMyOrdersResponse.parse(await withItems(orders)));
});

router.get("/admin/orders", requireAdmin, async (req, res): Promise<void> => {
  const query = ListAdminOrdersQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const { search, status } = query.data;
  const conditions = [];
  if (status) conditions.push(eq(ordersTable.status, status));
  if (search?.trim()) {
    const term = `%${search.trim()}%`;
    conditions.push(or(
      ilike(ordersTable.orderNumber, term),
      ilike(ordersTable.customerName, term),
      ilike(ordersTable.customerEmail, term),
      ilike(ordersTable.customerPhone, term),
    ));
  }
  const orders = await db.select().from(ordersTable)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(ordersTable.createdAt));
  res.json(ListAdminOrdersResponse.parse(await withItems(orders)));
});

router.patch("/admin/orders/:id/status", requireAdmin, async (req, res): Promise<void> => {
  const params = UpdateOrderStatusParams.safeParse(req.params);
  const body = UpdateOrderStatusBody.safeParse(req.body);
  if (!params.success || !body.success || !orderStatuses.has(body.data.status)) {
    res.status(400).json({ error: "Invalid order status update" });
    return;
  }
  // All confirmation paths, including PayPal, share the same locked, idempotent
  // transition. The legacy reconciliation below remains responsible for status
  // changes away from completion and safely becomes a no-op for its side effects.
  if (completedOrderStatuses.has(body.data.status)) await confirmOrder(params.data.id);
  let result;
  try {
    result = await db.transaction(async (tx) => {
    const [current] = await tx.select().from(ordersTable)
      .where(eq(ordersTable.id, params.data.id))
      .for("update");
    if (!current) return null;

    const shouldCountAsSold = completedOrderStatuses.has(body.data.status) && !current.countedAsSold;
    const shouldCreateCashback = completedOrderStatuses.has(body.data.status) && !completedOrderStatuses.has(current.status);
    const isLeavingCompleted = completedOrderStatuses.has(current.status) && !completedOrderStatuses.has(body.data.status);
    if (isLeavingCompleted) {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`${current.customerId}:${current.currency}:cashback`}))`);
      const earnedCredits = await tx.select().from(cashbackTransactionsTable)
        .where(and(
          eq(cashbackTransactionsTable.orderId, current.id),
          eq(cashbackTransactionsTable.type, "credit"),
          eq(cashbackTransactionsTable.status, "available"),
        ))
        .for("update");
      for (const earnedCredit of earnedCredits) {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`${earnedCredit.customerId}:${earnedCredit.currency}:cashback`}))`);
        const ledger = await tx.select().from(cashbackTransactionsTable)
          .where(and(
            eq(cashbackTransactionsTable.customerId, earnedCredit.customerId),
            eq(cashbackTransactionsTable.currency, earnedCredit.currency),
            or(
              and(
                eq(cashbackTransactionsTable.type, "credit"),
                eq(cashbackTransactionsTable.status, "available"),
              ),
              and(
                eq(cashbackTransactionsTable.type, "debit"),
                eq(cashbackTransactionsTable.status, "redeemed"),
              ),
            ),
          ))
          .for("update");
        const availableAfterCancellation = ledger.reduce(
          (sum, transaction) => sum + (transaction.type === "credit" ? Number(transaction.amount) : -Number(transaction.amount)),
          0,
        ) - Number(earnedCredit.amount)
          + (earnedCredit.customerId === current.customerId
            ? ledger.filter((transaction) => transaction.orderId === current.id && transaction.type === "debit")
              .reduce((sum, transaction) => sum + Number(transaction.amount), 0)
            : 0);
        if (availableAfterCancellation < -0.001) {
          throw new Error("This order's cashback has already been spent and cannot be cancelled");
        }
      }
    }
    const [order] = await tx.update(ordersTable)
      .set({ status: body.data.status, countedAsSold: current.countedAsSold || shouldCountAsSold })
      .where(eq(ordersTable.id, current.id))
      .returning();
    const items = await tx.select().from(orderItemsTable).where(eq(orderItemsTable.orderId, order.id));

    if (shouldCountAsSold) {
      for (const item of items) {
        await tx.update(productsTable)
          .set({ soldCount: sql`${productsTable.soldCount} + ${item.quantity}` })
          .where(eq(productsTable.id, item.productId));
      }
    }
    // Reconcile cashback every time a completed order is saved, not only when it
    // first enters a completed state. This repairs orders created by an older
    // deployment or orders whose referral profile was created slightly later.
    // Existing pending/available rewards are preserved; only voided rewards are
    // reopened when an order is explicitly moved back to a completed state.
    if (completedOrderStatuses.has(order.status) && Number(order.total) > 0) {
      const purchaseAmount = String(Math.round(Number(order.total) * 5) / 100);
      const [existingPurchaseCredit] = await tx.select().from(cashbackTransactionsTable)
        .where(and(
          eq(cashbackTransactionsTable.orderId, order.id),
          eq(cashbackTransactionsTable.type, "credit"),
          eq(cashbackTransactionsTable.customerId, order.customerId),
          eq(cashbackTransactionsTable.source, "purchase"),
        )).limit(1);

      if (!existingPurchaseCredit) {
        await tx.insert(cashbackTransactionsTable).values({
          customerId: order.customerId,
          orderId: order.id,
          type: "credit",
          status: "pending",
          currency: order.currency,
          amount: purchaseAmount,
          source: "purchase",
        }).onConflictDoNothing({
          target: [cashbackTransactionsTable.orderId, cashbackTransactionsTable.type, cashbackTransactionsTable.customerId],
        });
      } else if (shouldCreateCashback && existingPurchaseCredit.status === "voided") {
        await tx.update(cashbackTransactionsTable)
          .set({ status: "pending", amount: purchaseAmount, currency: order.currency, source: "purchase", approvedAt: null })
          .where(eq(cashbackTransactionsTable.id, existingPurchaseCredit.id));
      }

      if (order.referralCode) {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`referral:first-paid:${order.customerId}`}))`);
        const [referrer] = await tx.select().from(customerProfilesTable)
          .where(eq(customerProfilesTable.referralCode, order.referralCode)).limit(1);
        const [priorPaidOrder] = await tx.select({ id: ordersTable.id }).from(ordersTable)
          .where(and(
            eq(ordersTable.customerId, order.customerId),
            inArray(ordersTable.status, ["confirmed", "fulfilled"]),
            ne(ordersTable.id, order.id),
          )).limit(1);

        const [priorReferralReward] = await tx
          .select({ id: cashbackTransactionsTable.id })
          .from(cashbackTransactionsTable)
          .innerJoin(ordersTable, eq(ordersTable.id, cashbackTransactionsTable.orderId))
          .where(and(
            eq(cashbackTransactionsTable.type, "credit"),
            eq(cashbackTransactionsTable.source, "referral"),
            eq(ordersTable.customerId, order.customerId),
            ne(ordersTable.id, order.id),
          ))
          .limit(1);

        if (referrer && referrer.customerId !== order.customerId && !priorPaidOrder && !priorReferralReward) {
          const [existingReferralCredit] = await tx.select().from(cashbackTransactionsTable)
            .where(and(
              eq(cashbackTransactionsTable.orderId, order.id),
              eq(cashbackTransactionsTable.type, "credit"),
              eq(cashbackTransactionsTable.customerId, referrer.customerId),
              eq(cashbackTransactionsTable.source, "referral"),
            )).limit(1);

          if (!existingReferralCredit) {
            await tx.insert(cashbackTransactionsTable).values({
              customerId: referrer.customerId,
              orderId: order.id,
              type: "credit",
              status: "pending",
              currency: "EGP",
              amount: "50",
              source: "referral",
            }).onConflictDoNothing({
              target: [cashbackTransactionsTable.orderId, cashbackTransactionsTable.type, cashbackTransactionsTable.customerId],
            });
          } else if (shouldCreateCashback && existingReferralCredit.status === "voided") {
            await tx.update(cashbackTransactionsTable)
              .set({ status: "pending", amount: "50", currency: "EGP", source: "referral", approvedAt: null })
              .where(eq(cashbackTransactionsTable.id, existingReferralCredit.id));
          }
        }
      }
    }
    if (isLeavingCompleted) {
      await tx.update(cashbackTransactionsTable)
        .set({ status: "voided" })
        .where(and(
          eq(cashbackTransactionsTable.orderId, order.id),
          eq(cashbackTransactionsTable.type, "credit"),
          inArray(cashbackTransactionsTable.status, ["pending", "available"]),
        ));
      await tx.update(cashbackTransactionsTable)
        .set({ status: "reversed" })
        .where(and(
          eq(cashbackTransactionsTable.orderId, order.id),
          eq(cashbackTransactionsTable.type, "debit"),
          eq(cashbackTransactionsTable.status, "redeemed"),
        ));
    }
    return { order, items };
    });
  } catch (error) {
    if (error instanceof Error && error.message === "This order's cashback has already been spent and cannot be cancelled") {
      res.status(409).json({ error: error.message });
      return;
    }
    throw error;
  }
  if (!result) {
    res.status(404).json({ error: "Order not found" });
    return;
  }
  res.json(UpdateOrderStatusResponse.parse(mapOrder(result.order, result.items)));
});

router.get("/admin/dashboard", requireAdmin, async (_req, res): Promise<void> => {
  const since = new Date();
  since.setDate(since.getDate() - 29);
  const [orderTotals] = await db.select({
    count: sql<number>`count(*)`,
    sales: sql<number>`coalesce(sum(case when ${ordersTable.status} in ('confirmed', 'fulfilled') and ${ordersTable.currency} = 'EGP' then ${ordersTable.total} else 0 end), 0)`,
    salesUsd: sql<number>`coalesce(sum(case when ${ordersTable.status} in ('confirmed', 'fulfilled') and ${ordersTable.currency} = 'USD' then ${ordersTable.total} else 0 end), 0)`,
  }).from(ordersTable);
  const [visitTotals] = await db.select({ count: sql<number>`count(*)` }).from(analyticsVisitsTable);
  const countries = await db.select({
    country: analyticsVisitsTable.countryCode,
    visits: sql<number>`count(*)`,
  }).from(analyticsVisitsTable).groupBy(analyticsVisitsTable.countryCode).orderBy(desc(sql`count(*)`)).limit(8);
  const products = await db.select({
    productId: productsTable.id,
    productName: productsTable.name,
    sold: productsTable.soldCount,
    views: sql<number>`coalesce(count(${analyticsVisitsTable.id}), 0)`,
  }).from(productsTable)
    .leftJoin(analyticsVisitsTable, eq(analyticsVisitsTable.productId, productsTable.id))
    .groupBy(productsTable.id)
    .orderBy(desc(sql`coalesce(count(${analyticsVisitsTable.id}), 0)`))
    .limit(8);
  const visitsByDate = await db.select({
    date: sql<string>`to_char(${analyticsVisitsTable.createdAt}::date, 'YYYY-MM-DD')`,
    visits: sql<number>`count(*)`,
  }).from(analyticsVisitsTable).where(gte(analyticsVisitsTable.createdAt, since))
    .groupBy(sql`${analyticsVisitsTable.createdAt}::date`);
  const ordersByDate = await db.select({
    date: sql<string>`to_char(${ordersTable.createdAt}::date, 'YYYY-MM-DD')`,
    orders: sql<number>`count(*)`,
    sales: sql<number>`coalesce(sum(case when ${ordersTable.status} in ('confirmed', 'fulfilled') and ${ordersTable.currency} = 'EGP' then ${ordersTable.total} else 0 end), 0)`,
  }).from(ordersTable).where(gte(ordersTable.createdAt, since))
    .groupBy(sql`${ordersTable.createdAt}::date`);
  const visitMap = new Map(visitsByDate.map((row) => [row.date, Number(row.visits)]));
  const orderMap = new Map(ordersByDate.map((row) => [row.date, { orders: Number(row.orders), sales: Number(row.sales) }]));
  const dates = new Set([...visitMap.keys(), ...orderMap.keys()]);
  const trends = [...dates].sort().map((date) => ({
    date,
    visits: visitMap.get(date) ?? 0,
    orders: orderMap.get(date)?.orders ?? 0,
    sales: orderMap.get(date)?.sales ?? 0,
  }));
  res.json(GetAdminDashboardResponse.parse({
    totalSales: Number(orderTotals.sales),
    totalSalesUsd: Number(orderTotals.salesUsd),
    totalOrders: Number(orderTotals.count),
    totalVisits: Number(visitTotals.count),
    countries: countries.map((item) => ({ country: item.country === "UNKNOWN" ? "Unknown" : item.country, visits: Number(item.visits) })),
    popularProducts: products.map((item) => ({ productId: item.productId, productName: item.productName, views: Number(item.views), sold: item.sold })),
    trends,
  }));
});

router.get("/admin/analytics/visits", requireAdmin, async (req, res): Promise<void> => {
  // Validate the declared query shape first; dates are parsed separately to
  // enforce YYYY-MM-DD values instead of accepting ambiguous local timestamps.
  const query = GetAdminVisitsAnalyticsQueryParams.safeParse(req.query);
  const range = query.success ? resolveAnalyticsRange(req.query) : null;
  if (!range) {
    res.status(400).json({ error: "Choose a valid date range with an end date on or after the start date" });
    return;
  }
  const rangeCondition = and(
    gte(analyticsVisitsTable.createdAt, range.start),
    lt(analyticsVisitsTable.createdAt, range.endExclusive),
  );
  const [total] = await db.select({ count: sql<number>`count(*)` })
    .from(analyticsVisitsTable)
    .where(rangeCondition);
  const countries = await db.select({
    country: analyticsVisitsTable.countryCode,
    visits: sql<number>`count(*)`,
  }).from(analyticsVisitsTable)
    .where(rangeCondition)
    .groupBy(analyticsVisitsTable.countryCode)
    .orderBy(desc(sql`count(*)`))
    .limit(8);
  const trends = await db.select({
    date: sql<string>`to_char(${analyticsVisitsTable.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`,
    visits: sql<number>`count(*)`,
  }).from(analyticsVisitsTable)
    .where(rangeCondition)
    .groupBy(sql`to_char(${analyticsVisitsTable.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`)
    .orderBy(sql`to_char(${analyticsVisitsTable.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`);

  res.json(GetAdminVisitsAnalyticsResponse.parse({
    range: { preset: range.preset, startDate: range.startDate, endDate: range.endDate },
    totalVisits: Number(total.count),
    countries: countries.map((row) => ({ country: row.country === "UNKNOWN" ? "Unknown" : row.country, visits: Number(row.visits) })),
    trends: trends.map((row) => ({ date: row.date, visits: Number(row.visits), orders: 0, sales: 0, salesUsd: 0 })),
  }));
});

router.get("/admin/analytics/sales", requireAdmin, async (req, res): Promise<void> => {
  const query = GetAdminSalesAnalyticsQueryParams.safeParse(req.query);
  const range = query.success ? resolveAnalyticsRange(req.query) : null;
  if (!range) {
    res.status(400).json({ error: "Choose a valid date range with an end date on or after the start date" });
    return;
  }
  const rangeCondition = and(
    gte(ordersTable.createdAt, range.start),
    lt(ordersTable.createdAt, range.endExclusive),
    inArray(ordersTable.status, [...completedOrderStatuses]),
  );
  const [totals] = await db.select({
    orders: sql<number>`count(*)`,
    sales: sql<number>`coalesce(sum(case when ${ordersTable.currency} = 'EGP' then ${ordersTable.total} else 0 end), 0)`,
    salesUsd: sql<number>`coalesce(sum(case when ${ordersTable.currency} = 'USD' then ${ordersTable.total} else 0 end), 0)`,
  }).from(ordersTable).where(rangeCondition);
  const trends = await db.select({
    date: sql<string>`to_char(${ordersTable.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`,
    orders: sql<number>`count(*)`,
    sales: sql<number>`coalesce(sum(case when ${ordersTable.currency} = 'EGP' then ${ordersTable.total} else 0 end), 0)`,
    salesUsd: sql<number>`coalesce(sum(case when ${ordersTable.currency} = 'USD' then ${ordersTable.total} else 0 end), 0)`,
  }).from(ordersTable)
    .where(rangeCondition)
    .groupBy(sql`to_char(${ordersTable.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`)
    .orderBy(sql`to_char(${ordersTable.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`);

  res.json(GetAdminSalesAnalyticsResponse.parse({
    range: { preset: range.preset, startDate: range.startDate, endDate: range.endDate },
    totalOrders: Number(totals.orders),
    totalSales: Number(totals.sales),
    totalSalesUsd: Number(totals.salesUsd),
    trends: trends.map((row) => ({
      date: row.date,
      visits: 0,
      orders: Number(row.orders),
      sales: Number(row.sales),
      salesUsd: Number(row.salesUsd),
    })),
  }));
});

const analyticsVisitLimiter = rateLimit({
  windowMs: 60_000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
});

router.post("/analytics/visit", analyticsVisitLimiter, async (req, res): Promise<void> => {
  const parsed = RecordVisitBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const data = parsed.data;
  const visitorId = data.visitorId?.slice(0, 96) || `anon-${randomUUID()}`;
  const countryCode = await detectCountry(req, data.countryCode);
  await db.insert(analyticsVisitsTable).values({
    visitorId,
    path: data.path.slice(0, 300),
    productId: data.productId ?? null,
    countryCode,
  });
  if (countryCode !== "UNKNOWN") {
    await db.update(analyticsVisitsTable)
      .set({ countryCode })
      .where(and(
        eq(analyticsVisitsTable.visitorId, visitorId),
        eq(analyticsVisitsTable.countryCode, "UNKNOWN"),
      ));
  }
  res.json({ country: countryCode, currency: countryCode === "EG" ? "EGP" : "USD" });
});

export default router;
