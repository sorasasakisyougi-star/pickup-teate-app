import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server.js";

import { resolvePhotoStorageBucket } from "../../../lib/photoApiConfig.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SUPPORTED_PHOTO_KIND_PATTERN = /^(depart|arrival_[0-7])$/;
const MAX_PHOTO_FILE_BYTES = 8 * 1024 * 1024;
const ALLOWED_IMAGE_CONTENT_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
  "image/gif",
]);

class PhotoUploadConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PhotoUploadConfigError";
  }
}

class PhotoUploadValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PhotoUploadValidationError";
  }
}

function normalizeOrigin(rawOrigin: string) {
  return rawOrigin.trim().replace(/\/+$/, "");
}

function ensureTrustedOrigin(request: Request) {
  const rawOrigin = request.headers.get("origin")?.trim() ?? "";
  if (!rawOrigin) {
    throw new PhotoUploadValidationError("forbidden_origin");
  }

  let requestOrigin = "";
  try {
    requestOrigin = normalizeOrigin(new URL(request.url).origin);
  } catch {
    requestOrigin = "";
  }

  const trustedOrigins = new Set<string>();
  if (requestOrigin) trustedOrigins.add(requestOrigin);
  const appOrigin = process.env.APP_ORIGIN?.trim();
  if (appOrigin) trustedOrigins.add(normalizeOrigin(appOrigin));

  const normalizedOrigin = normalizeOrigin(rawOrigin);
  if (!trustedOrigins.has(normalizedOrigin)) {
    throw new PhotoUploadValidationError("forbidden_origin");
  }
}

function readRequiredPhotoEnv(name: "SUPABASE_SERVICE_ROLE_KEY") {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new PhotoUploadConfigError(`${name} is required`);
  }
  return value;
}

function getPhotoStorageConfig() {
  const supabaseUrl =
    process.env.SUPABASE_URL?.trim() || process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || "";
  if (!supabaseUrl) {
    throw new PhotoUploadConfigError("SUPABASE_URL or NEXT_PUBLIC_SUPABASE_URL is required");
  }

  return {
    supabaseUrl,
    serviceRoleKey: readRequiredPhotoEnv("SUPABASE_SERVICE_ROLE_KEY"),
    bucket: resolvePhotoStorageBucket(process.env.PHOTO_STORAGE_BUCKET),
  };
}

function createPhotoStorageClient() {
  const { supabaseUrl, serviceRoleKey } = getPhotoStorageConfig();
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

type PhotoDeleteRouteDependencies = {
  ensureTrustedOrigin: (request: Request) => void;
  getPhotoStorageConfig: typeof getPhotoStorageConfig;
  createPhotoStorageClient: typeof createPhotoStorageClient;
};

const DEFAULT_PHOTO_DELETE_ROUTE_DEPENDENCIES: PhotoDeleteRouteDependencies = {
  ensureTrustedOrigin,
  getPhotoStorageConfig,
  createPhotoStorageClient,
};

let photoDeleteRouteDependencies: PhotoDeleteRouteDependencies =
  DEFAULT_PHOTO_DELETE_ROUTE_DEPENDENCIES;

export function __setPhotoDeleteRouteDependenciesForTests(
  overrides: Partial<PhotoDeleteRouteDependencies> | null = null,
) {
  photoDeleteRouteDependencies = overrides
    ? {
        ...DEFAULT_PHOTO_DELETE_ROUTE_DEPENDENCIES,
        ...overrides,
      }
    : DEFAULT_PHOTO_DELETE_ROUTE_DEPENDENCIES;
}

type PhotoDeleteResponseBody = {
  success: boolean;
  storage: "supabase-storage";
  bucket: string;
  requested_paths: string[];
  deleted_paths: string[];
  failed_paths: string[];
  removed_paths: string[];
  error?: "photo_storage_delete_incomplete";
};

export function buildPhotoDeleteResponse(params: {
  bucket: string;
  photoPaths: string[];
  deletedPaths: string[];
  failedPaths: string[];
}): { body: PhotoDeleteResponseBody; status: 200 | 502 } {
  const { bucket, photoPaths, deletedPaths, failedPaths } = params;
  const success = failedPaths.length === 0;

  return {
    body: {
      success,
      storage: "supabase-storage",
      bucket,
      requested_paths: photoPaths,
      deleted_paths: deletedPaths,
      failed_paths: failedPaths,
      removed_paths: deletedPaths,
      ...(success ? {} : { error: "photo_storage_delete_incomplete" }),
    },
    status: success ? 200 : 502,
  };
}

function normalizeOptionalStringFormValue(value: FormDataEntryValue | null) {
  if (value == null) return null;
  if (typeof value !== "string") {
    throw new PhotoUploadValidationError("invalid_form_field");
  }
  const normalized = value.trim();
  return normalized || null;
}

function sanitizeOrderId(rawOrderId: string | null) {
  if (!rawOrderId) return null;
  const sanitized = rawOrderId.replace(/[^a-zA-Z0-9_-]/g, "");
  return sanitized || null;
}

function readPhotoKind(rawPhotoKind: FormDataEntryValue | null) {
  const photoKind = normalizeOptionalStringFormValue(rawPhotoKind);
  if (!photoKind || !SUPPORTED_PHOTO_KIND_PATTERN.test(photoKind)) {
    throw new PhotoUploadValidationError("invalid_photo_kind");
  }
  return photoKind;
}

function readPhotoFile(rawPhoto: FormDataEntryValue | null) {
  if (!(rawPhoto instanceof File)) {
    throw new PhotoUploadValidationError("photo_file_required");
  }
  if (!rawPhoto.size) {
    throw new PhotoUploadValidationError("photo_file_required");
  }
  if (!ALLOWED_IMAGE_CONTENT_TYPES.has(rawPhoto.type)) {
    throw new PhotoUploadValidationError("invalid_photo_content_type");
  }
  if (rawPhoto.size > MAX_PHOTO_FILE_BYTES) {
    throw new PhotoUploadValidationError("photo_file_too_large");
  }
  return rawPhoto;
}

function guessFileExtension(file: File) {
  const nameExtension = file.name.split(".").pop()?.trim().toLowerCase();
  if (nameExtension && /^[a-z0-9]+$/.test(nameExtension)) {
    return nameExtension;
  }

  switch (file.type) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "image/heic":
      return "heic";
    case "image/heif":
      return "heif";
    case "image/gif":
      return "gif";
    default:
      return "bin";
  }
}

function buildPhotoObjectPath(params: {
  orderId: string | null;
  photoKind: string;
  extension: string;
}) {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  const prefix = params.orderId
    ? `pickup-orders/${params.orderId}`
    : `pickup-orders/pending/${yyyy}/${mm}/${dd}`;

  return `${prefix}/${Date.now()}-${params.photoKind}-${randomUUID()}.${params.extension}`;
}

async function ensurePhotoBucketReadable(bucket: string) {
  const supabase = createPhotoStorageClient();
  const result = await supabase.storage.listBuckets();
  if (result.error) {
    throw new PhotoUploadConfigError("photo_storage_list_buckets_failed");
  }

  return result.data.some((entry) => entry.name === bucket);
}

type DeletePhotoRequest = {
  photo_paths?: unknown;
};

function parseDeletePhotoPaths(rawBody: unknown) {
  const body = (rawBody ?? {}) as DeletePhotoRequest;
  if (!Array.isArray(body.photo_paths) || body.photo_paths.length === 0) {
    throw new PhotoUploadValidationError("photo_paths_required");
  }

  const normalizedPaths = body.photo_paths
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => Boolean(entry));

  if (normalizedPaths.length === 0) {
    throw new PhotoUploadValidationError("photo_paths_required");
  }

  for (const photoPath of normalizedPaths) {
    if (
      photoPath.includes("..") ||
      photoPath.startsWith("/") ||
      !photoPath.startsWith("pickup-orders/")
    ) {
      throw new PhotoUploadValidationError("invalid_photo_path");
    }
  }

  return Array.from(new Set(normalizedPaths));
}

function splitPhotoPath(photoPath: string) {
  const index = photoPath.lastIndexOf("/");
  if (index <= 0 || index === photoPath.length - 1) {
    throw new PhotoUploadValidationError("invalid_photo_path");
  }
  return {
    folder: photoPath.slice(0, index),
    fileName: photoPath.slice(index + 1),
  };
}

async function deleteAndVerifyPhotoPath(params: {
  supabase: ReturnType<typeof createPhotoStorageClient>;
  bucket: string;
  photoPath: string;
}) {
  const { supabase, bucket, photoPath } = params;
  const removeResult = await supabase.storage.from(bucket).remove([photoPath]);
  if (removeResult.error) {
    console.error("[PhotoRoute] delete failed", {
      bucket,
      photoPath,
      error: removeResult.error,
    });
    return false;
  }

  const { folder, fileName } = splitPhotoPath(photoPath);
  const verifyResult = await supabase.storage.from(bucket).list(folder, {
    limit: 100,
    search: fileName,
  });
  if (verifyResult.error) {
    console.error("[PhotoRoute] delete verify failed", {
      bucket,
      photoPath,
      error: verifyResult.error,
    });
    return false;
  }

  const stillExists = verifyResult.data.some((entry) => entry.name === fileName);
  return !stillExists;
}

export async function GET() {
  try {
    const { bucket } = getPhotoStorageConfig();
    const bucketExists = await ensurePhotoBucketReadable(bucket);

    return NextResponse.json(
      {
        ok: bucketExists,
        storage: "supabase-storage",
        bucket,
        bucketExists,
      },
      { status: bucketExists ? 200 : 502 },
    );
  } catch (error) {
    console.error("[PhotoRoute] health check failed", { error });

    return NextResponse.json(
      {
        ok: false,
        storage: "supabase-storage",
        error: error instanceof Error ? error.message : "photo_storage_unreachable",
      },
      { status: 502 },
    );
  }
}

export async function POST(request: Request) {
  try {
    ensureTrustedOrigin(request);
    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("multipart/form-data")) {
      throw new PhotoUploadValidationError("invalid_content_type");
    }

    const formData = await request.formData();
    const { bucket } = getPhotoStorageConfig();
    const orderId = sanitizeOrderId(normalizeOptionalStringFormValue(formData.get("order_id")));
    const photoKind = readPhotoKind(formData.get("photo_kind"));
    const photo = readPhotoFile(formData.get("photo"));
    const extension = guessFileExtension(photo);
    const photoPath = buildPhotoObjectPath({
      orderId,
      photoKind,
      extension,
    });

    const supabase = createPhotoStorageClient();
    const upload = await supabase.storage.from(bucket).upload(
      photoPath,
      Buffer.from(await photo.arrayBuffer()),
      {
        contentType: photo.type || undefined,
        upsert: false,
      },
    );

    if (upload.error) {
      console.error("[PhotoRoute] upload failed", {
        bucket,
        photoKind,
        photoPath,
        error: upload.error,
      });
      return NextResponse.json(
        {
          success: false,
          error: "photo_storage_upload_failed",
          bucket,
        },
        { status: 502 },
      );
    }

    const photoUrl = supabase.storage.from(bucket).getPublicUrl(photoPath).data.publicUrl;

    return NextResponse.json(
      {
        success: true,
        storage: "supabase-storage",
        bucket,
        photo_kind: photoKind,
        photo_path: photoPath,
        photo_url: photoUrl,
      },
      { status: 200 },
    );
  } catch (error) {
    if (error instanceof PhotoUploadValidationError) {
      const payload: Record<string, unknown> = {
        success: false,
        error: error.message,
      };
      if (error.message === "photo_file_too_large") {
        payload.max_bytes = MAX_PHOTO_FILE_BYTES;
      }
      if (error.message === "invalid_photo_content_type") {
        payload.allowed_types = Array.from(ALLOWED_IMAGE_CONTENT_TYPES.values());
      }

      return NextResponse.json(
        payload,
        { status: 400 },
      );
    }

    if (error instanceof PhotoUploadConfigError) {
      console.error("[PhotoRoute] config error", { error });
      return NextResponse.json(
        {
          success: false,
          error: error.message,
        },
        { status: 500 },
      );
    }

    console.error("[PhotoRoute] upload exception", { error });

    return NextResponse.json(
      {
        success: false,
        error: "photo_upload_failed",
      },
      { status: 502 },
    );
  }
}

export async function DELETE(request: Request) {
  try {
    photoDeleteRouteDependencies.ensureTrustedOrigin(request);
    const body = await request.json().catch(() => {
      throw new PhotoUploadValidationError("invalid_json_body");
    });
    const photoPaths = parseDeletePhotoPaths(body);
    const { bucket } = photoDeleteRouteDependencies.getPhotoStorageConfig();
    const supabase = photoDeleteRouteDependencies.createPhotoStorageClient();

    const deletedPaths: string[] = [];
    const failedPaths: string[] = [];
    for (const photoPath of photoPaths) {
      const deleted = await deleteAndVerifyPhotoPath({
        supabase,
        bucket,
        photoPath,
      });
      if (deleted) {
        deletedPaths.push(photoPath);
      } else {
        failedPaths.push(photoPath);
      }
    }

    const response = buildPhotoDeleteResponse({
      bucket,
      photoPaths,
      deletedPaths,
      failedPaths,
    });

    return NextResponse.json(response.body, { status: response.status });
  } catch (error) {
    if (error instanceof PhotoUploadValidationError) {
      return NextResponse.json(
        {
          success: false,
          error: error.message,
        },
        { status: 400 },
      );
    }

    if (error instanceof PhotoUploadConfigError) {
      return NextResponse.json(
        {
          success: false,
          error: error.message,
        },
        { status: 500 },
      );
    }

    console.error("[PhotoRoute] delete exception", { error });
    return NextResponse.json(
      {
        success: false,
        error: "photo_delete_failed",
      },
      { status: 502 },
    );
  }
}
