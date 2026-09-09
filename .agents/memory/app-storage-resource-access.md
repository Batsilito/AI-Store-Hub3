---
name: App Storage resource access
description: Replit App Storage buckets can be configured in environment variables but still unavailable to the current Repl.
---

The presence of `DEFAULT_OBJECT_STORAGE_BUCKET_ID`, `PUBLIC_OBJECT_SEARCH_PATHS`, or `PRIVATE_OBJECT_DIR` does not prove that the current Repl is authorized to access the bucket. The App Storage sidecar can return the default bucket ID while rejecting token exchange and signed URL requests with `401 no allowed resources`.

**Why:** Bucket access is controlled by the Replit App Storage resource attachment, separately from application code and environment variable configuration.

**How to apply:** When this error appears, attach the existing bucket to the Repl from App Storage or create a new bucket there, then restart the workflow before changing upload code further.