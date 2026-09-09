import express, { type Express } from "express";
import { readFile } from "node:fs/promises";
import path from "node:path";
import cors from "cors";
import { eq } from "drizzle-orm";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import pinoHttp from "pino-http";
import { clerkMiddleware } from "@clerk/express";
import {
  CLERK_PROXY_PATH,
  clerkProxyMiddleware,
  getClerkProxyHost,
} from "./middlewares/clerkProxyMiddleware";
import router from "./routes";
import { logger } from "./lib/logger";
import { db, pool, productsTable } from "@workspace/db";

const PgSession = connectPgSimple(session);

const app: Express = express();

// Required so express-rate-limit can read X-Forwarded-For correctly behind Replit's proxy.
app.set("trust proxy", 1);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

// Clerk proxy MUST come before body parsers (streams raw bytes)
app.use(CLERK_PROXY_PATH, clerkProxyMiddleware());

// Restrict CORS to the known frontend origins.
// CORS_ORIGIN env var can be a comma-separated list for production.
// Falls back to the Replit dev domain when available, or localhost.
function buildAllowedOrigins(): string[] | RegExp {
  if (process.env.CORS_ORIGIN) {
    return process.env.CORS_ORIGIN.split(",").map((o) => o.trim());
  }
  if (process.env.REPLIT_DEV_DOMAIN) {
    return [
      `https://${process.env.REPLIT_DEV_DOMAIN}`,
      // Also allow the exact proxy origin in local dev
      "http://localhost:80",
      "http://127.0.0.1:80",
    ];
  }
  return ["http://localhost:80", "http://127.0.0.1:80"];
}

app.use(
  cors({
    origin: buildAllowedOrigins(),
    credentials: true,
  }),
);

if (!process.env.SESSION_SECRET) {
  throw new Error("SESSION_SECRET environment variable is required");
}

// connect-pg-simple's createTableIfMissing reads a SQL file from the package
// directory which is unavailable after esbuild bundling. We create the table
// ourselves with a raw query and keep createTableIfMissing: false.
export async function ensureSessionTable(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "user_sessions" (
      "sid"    varchar        NOT NULL COLLATE "default",
      "sess"   json           NOT NULL,
      "expire" timestamp(6)   NOT NULL,
      CONSTRAINT "user_sessions_pkey" PRIMARY KEY ("sid") NOT DEFERRABLE INITIALLY IMMEDIATE
    );
    CREATE INDEX IF NOT EXISTS "IDX_user_sessions_expire" ON "user_sessions" ("expire");
  `);
}

app.use(
  session({
    store: new PgSession({
      pool,
      tableName: "user_sessions",
      createTableIfMissing: false, // we handle this in ensureSessionTable()
    }),
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 8 * 60 * 60 * 1000, // 8 hours
    },
  }),
);

// Keep malformed or unexpectedly large JSON/form requests from consuming
// unbounded memory. The image upload route uses its own tightly limited raw
// body parser because it writes through the Replit App Storage SDK.
app.use(express.json({ limit: "256kb" }));
app.use(express.urlencoded({ extended: true, limit: "256kb" }));

// Clerk auth middleware — after body parsers, before routes. The app uses the
// owner's external Clerk instance, so use its key directly rather than
// deriving a Replit custom-domain key from the incoming host. Preview must use
// the development instance because Clerk production keys reject replit.dev
// origins.
const isProduction = process.env.NODE_ENV === "production";
const clerkPublishableKey = isProduction
  ? process.env.CLERK_PUBLISHABLE_KEY
  : process.env.VITE_CLERK_DEV_PUBLISHABLE_KEY;
const clerkSecretKey = isProduction
  ? process.env.CLERK_SECRET_KEY
  : process.env.CLERK_DEV_SECRET_KEY;

if (!clerkPublishableKey) {
  throw new Error(
    `${isProduction ? "CLERK_PUBLISHABLE_KEY" : "VITE_CLERK_DEV_PUBLISHABLE_KEY"} environment variable is required`,
  );
}

if (!clerkSecretKey) {
  throw new Error(
    `${isProduction ? "CLERK_SECRET_KEY" : "CLERK_DEV_SECRET_KEY"} environment variable is required`,
  );
}

app.use(
  clerkMiddleware({
    publishableKey: clerkPublishableKey,
    secretKey: clerkSecretKey,
  }),
);

app.use("/api", router);

const defaultSocialDescription =
  "اشترك في أشهر برامج الذكاء الاصطناعي، بأرخص الأسعار.";

function slugifyWithLimit(name: string, wordLimit?: number): string {
  const words = name.trim().split(/\s+/);
  const normalized = (wordLimit ? words.slice(0, wordLimit) : words)
    .join(" ")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "");
  return normalized
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "") || "product";
}

function publicProductSlug(name: string, id: number): string {
  return `${slugifyWithLimit(name, 2)}-${id.toString(36)}`;
}

function legacyProductSlugs(name: string, id: number): string[] {
  const suffix = id.toString(36);
  return [
    slugifyWithLimit(name, 6),
    slugifyWithLimit(name),
    "product",
  ].map((slug) => `${slug}-${suffix}`);
}

async function findPublishedProductForSocial(slug: string) {
  const products = await db
    .select({
      id: productsTable.id,
      name: productsTable.name,
      slug: productsTable.slug,
      coverImageUrl: productsTable.coverImageUrl,
      description: productsTable.description,
    })
    .from(productsTable)
    .where(eq(productsTable.published, true));

  if (/^\d+$/.test(slug)) {
    const id = Number(slug);
    return products.find((product) => product.id === id);
  }

  return products.find((product) =>
    product.slug === slug ||
    publicProductSlug(product.name, product.id) === slug ||
    legacyProductSlugs(product.name, product.id).includes(slug),
  );
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function socialText(value: string | null | undefined, fallback: string, maxLength: number): string {
  return (value?.replace(/\s+/g, " ").trim() || fallback).slice(0, maxLength);
}

function setMetaTag(html: string, attribute: "name" | "property", key: string, value: string): string {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const tag = `<meta ${attribute}="${key}" content="${escapeHtml(value)}" />`;
  const existingTag = new RegExp(
    `<meta\\b(?=[^>]*\\b${attribute}=["']${escapedKey}["'])[^>]*>`,
    "i",
  );
  if (existingTag.test(html)) return html.replace(existingTag, tag);
  return html.replace(/<\/head>/i, `  ${tag}\n  </head>`);
}

function setTitle(html: string, title: string): string {
  const tag = `<title>${escapeHtml(title)}</title>`;
  if (/<title\b[^>]*>[\s\S]*?<\/title>/i.test(html)) {
    return html.replace(/<title\b[^>]*>[\s\S]*?<\/title>/i, tag);
  }
  return html.replace(/<\/head>/i, `  ${tag}\n  </head>`);
}

function setCanonicalLink(html: string, url: string): string {
  const tag = `<link rel="canonical" href="${escapeHtml(url)}" />`;
  const existingLink = /<link\b(?=[^>]*\brel=["']canonical["'])[^>]*>/i;
  if (existingLink.test(html)) return html.replace(existingLink, tag);
  return html.replace(/<\/head>/i, `  ${tag}\n  </head>`);
}

async function sendFrontendEntry(req: express.Request, res: express.Response, frontendDist: string): Promise<void> {
  const productPath = /^\/products\/([^/]+)\/?$/.exec(req.path);
  if (!productPath) {
    res.sendFile(path.join(frontendDist, "index.html"));
    return;
  }

  try {
    const slug = decodeURIComponent(productPath[1]);
    const product = await findPublishedProductForSocial(slug);
    if (!product) {
      res.sendFile(path.join(frontendDist, "index.html"));
      return;
    }

    const origin = `${req.protocol}://${req.get("host")}`;
    const pageUrl = new URL(req.originalUrl, origin);
    pageUrl.hash = "";
    const title = `${socialText(product.name, "Keytopia Store", 140)} | Keytopia`;
    const description = socialText(product.description, defaultSocialDescription, 300);
    const imageUrl = product.coverImageUrl
      ? new URL(product.coverImageUrl, origin).toString()
      : new URL("/logo.png", origin).toString();
    let html = await readFile(path.join(frontendDist, "index.html"), "utf8");

    html = setTitle(html, title);
    html = setMetaTag(html, "name", "description", description);
    html = setMetaTag(html, "property", "og:title", title);
    html = setMetaTag(html, "property", "og:description", description);
    html = setMetaTag(html, "property", "og:url", pageUrl.toString());
    html = setMetaTag(html, "property", "og:image", imageUrl);
    html = setMetaTag(html, "property", "og:image:alt", product.name);
    html = setMetaTag(html, "name", "twitter:title", title);
    html = setMetaTag(html, "name", "twitter:description", description);
    html = setMetaTag(html, "name", "twitter:image", imageUrl);
    html = setMetaTag(html, "name", "twitter:image:alt", product.name);
    html = setCanonicalLink(html, pageUrl.toString());

    res.set("Cache-Control", "public, max-age=300, stale-while-revalidate=600");
    res.type("html").send(html);
  } catch (error) {
    req.log?.warn({ error }, "Could not generate product social metadata");
    res.sendFile(path.join(frontendDist, "index.html"));
  }
}

// Production publishes one HTTP process, so serve the built SPA from the API
// server after API routes have had a chance to handle the request.
if (process.env.NODE_ENV === "production") {
  const frontendDist = path.resolve(
    import.meta.dirname,
    "../../keytopia/dist/public",
  );

  app.use(express.static(frontendDist));
  app.use((req, res, next) => {
    if (req.method !== "GET" || req.path.startsWith("/api")) {
      next();
      return;
    }

    void sendFrontendEntry(req, res, frontendDist);
  });
}

export default app;
