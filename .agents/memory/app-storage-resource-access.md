---
name: App Storage resource access
description: Replit App Storage buckets can be configured in environment variables but still unavailable to the current Repl.
---

The presence of App Storage environment variables does not prove that a legacy Google Cloud client or signed-URL sidecar path can access the bucket. A bucket may be visible in App Storage and work through the official `@replit/object-storage` SDK while raw GCS access returns 403 and signed-URL requests return 401.

**Why:** Replit's current App Storage SDK handles the attached bucket's authorization, while older GCS service-account and sidecar signing paths can retain incompatible resource permissions.

**How to apply:** First confirm the bucket is present in App Storage. If the official SDK can list/upload but GCS paths fail, use the SDK for server-mediated upload and download rather than repeatedly changing bucket environment variables.