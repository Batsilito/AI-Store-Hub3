import { randomUUID } from 'crypto';
import { Readable } from 'stream';
import { Client as AppStorageClient } from '@replit/object-storage';
import {
  RequestUploadUrlBody,
  RequestUploadUrlResponse,
} from '@workspace/api-zod';
import { raw, Router, type IRouter, type Request, type Response } from 'express';
import { requireAdmin } from '../middlewares/requireAdmin';

import {
  ObjectNotFoundError,
  ObjectStorageService,
} from '../lib/objectStorage';

const router: IRouter = Router();
const objectStorageService = new ObjectStorageService();
const appStorageClient = new AppStorageClient();

const IMAGE_CONTENT_TYPES: Record<string, string> = {
  'image/avif': 'avif',
  'image/gif': 'gif',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

function imageContentType(objectName: string): string {
  const extension = objectName.split('.').pop()?.toLowerCase();
  return Object.entries(IMAGE_CONTENT_TYPES).find(([, ext]) => ext === extension)?.[0]
    ?? 'application/octet-stream';
}

/**
 * Upload product images through the current Replit App Storage SDK.
 *
 * This avoids the legacy GCS signed-URL flow, whose service account can be
 * denied even when the bucket is attached and visible in the App Storage tool.
 */
router.post(
  '/storage/uploads/direct',
  requireAdmin,
  raw({ type: Object.keys(IMAGE_CONTENT_TYPES), limit: '8mb' }),
  async (req: Request, res: Response) => {
    const contentType = req.headers['content-type']?.split(';', 1)[0]?.trim() ?? '';
    const extension = IMAGE_CONTENT_TYPES[contentType];
    if (!extension || !Buffer.isBuffer(req.body) || req.body.length === 0) {
      res.status(400).json({ error: 'Please upload a PNG, JPG, WebP, GIF, or AVIF image.' });
      return;
    }

    const objectName = `uploads/${randomUUID()}.${extension}`;
    const result = await appStorageClient.uploadFromBytes(
      objectName,
      req.body,
      { compress: false },
    );

    if (!result.ok) {
      req.log.error({ err: result.error }, 'Error uploading image to App Storage');
      res.status(result.error.statusCode ?? 500).json({
        error: result.error.message || 'Failed to upload image',
      });
      return;
    }

    res.status(201).json({ objectPath: `/app-objects/${objectName}` });
  },
);

router.get(
  '/storage/app-objects/*filePath',
  async (req: Request, res: Response) => {
    const raw = req.params.filePath;
    const objectName = Array.isArray(raw) ? raw.join('/') : raw;
    if (!objectName || objectName.includes('..') || !objectName.startsWith('uploads/')) {
      res.status(400).json({ error: 'Invalid image path' });
      return;
    }

    const result = await appStorageClient.downloadAsBytes(
      objectName,
      { decompress: false },
    );
    if (!result.ok) {
      if (result.error.statusCode === 404) {
        res.status(404).json({ error: 'File not found' });
        return;
      }
      req.log.error({ err: result.error }, 'Error serving App Storage image');
      res.status(result.error.statusCode ?? 500).json({
        error: result.error.message || 'Failed to serve image',
      });
      return;
    }

    const [bytes] = result.value;
    res.setHeader('Content-Type', imageContentType(objectName));
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('Content-Length', String(bytes.length));
    res.send(bytes);
  },
);

/**
 * POST /storage/uploads/request-url
 *
 * Request a presigned URL for file upload.
 * The client sends JSON metadata (name, size, contentType) — NOT the file.
 * Then uploads the file directly to the returned presigned URL.
 * Requires admin auth — only allowlisted Clerk users may mint upload URLs.
 */
router.post(
  '/storage/uploads/request-url',
  requireAdmin,
  async (req: Request, res: Response) => {
    const parsed = RequestUploadUrlBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Missing or invalid required fields' });
      return;
    }

    try {
      const { name, size, contentType } = parsed.data;

      // Upload goes to the first PUBLIC_OBJECT_SEARCH_PATHS directory so the
      // resulting image is accessible to unauthenticated storefront visitors via
      // GET /storage/public-objects/<servingPath>.
      const { uploadURL, servingPath } =
        await objectStorageService.getPublicUploadURL('uploads');

      res.json(
        RequestUploadUrlResponse.parse({
          uploadURL,
          objectPath: `/public-objects/${servingPath}`,
          metadata: { name, size, contentType },
        }),
      );
    } catch (error) {
      req.log.error({ err: error }, 'Error generating upload URL');
      const message =
        error instanceof Error && error.message.includes('no allowed resources')
          ? 'App Storage is not connected to this Repl. Open App Storage, create a bucket or add the existing bucket to this Repl, then restart the preview.'
          : 'Failed to generate upload URL';
      res.status(message.startsWith('App Storage') ? 503 : 500).json({ error: message });
    }
  },
);

/**
 * GET /storage/public-objects/*
 *
 * Serve public assets from PUBLIC_OBJECT_SEARCH_PATHS.
 * These are unconditionally public — no authentication or ACL checks.
 * IMPORTANT: Always provide this endpoint when object storage is set up.
 */
router.get(
  '/storage/public-objects/*filePath',
  async (req: Request, res: Response) => {
    try {
      const raw = req.params.filePath;
      const filePath = Array.isArray(raw) ? raw.join('/') : raw;
      const file = await objectStorageService.searchPublicObject(filePath);
      if (!file) {
        res.status(404).json({ error: 'File not found' });
        return;
      }

      const response = await objectStorageService.downloadObject(file);

      res.status(response.status);
      response.headers.forEach((value, key) => res.setHeader(key, value));

      if (response.body) {
        const nodeStream = Readable.fromWeb(
          response.body as ReadableStream<Uint8Array>,
        );
        nodeStream.pipe(res);
      } else {
        res.end();
      }
    } catch (error) {
      req.log.error({ err: error }, 'Error serving public object');
      const message =
        error instanceof Error && error.message.includes('no allowed resources')
          ? 'App Storage is not connected to this Repl.'
          : 'Failed to serve public object';
      res.status(message.startsWith('App Storage') ? 503 : 500).json({ error: message });
    }
  },
);

/**
 * GET /storage/objects/*
 *
 * Serve object entities from PRIVATE_OBJECT_DIR.
 * These are served from a separate path from /public-objects and can optionally
 * be protected with authentication or ACL checks based on the use case.
 */
router.get(
  '/storage/objects/*path',
  requireAdmin,
  async (req: Request, res: Response) => {
  try {
    const raw = req.params.path;
    const wildcardPath = Array.isArray(raw) ? raw.join('/') : raw;
    const objectPath = `/objects/${wildcardPath}`;
    const objectFile =
      await objectStorageService.getObjectEntityFile(objectPath);

    const response = await objectStorageService.downloadObject(objectFile);

    res.status(response.status);
    response.headers.forEach((value, key) => res.setHeader(key, value));

    if (response.body) {
      const nodeStream = Readable.fromWeb(
        response.body as ReadableStream<Uint8Array>,
      );
      nodeStream.pipe(res);
    } else {
      res.end();
    }
  } catch (error) {
    if (error instanceof ObjectNotFoundError) {
      req.log.warn({ err: error }, 'Object not found');
      res.status(404).json({ error: 'Object not found' });
      return;
    }
    req.log.error({ err: error }, 'Error serving object');
    res.status(500).json({ error: 'Failed to serve object' });
  }
});

export default router;
