export type PhotoDeleteResult = {
  requested_paths: string[];
  deleted_paths: string[];
  failed_paths: string[];
};

function normalizePhotoPathArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

export function classifyPhotoDeleteResultForRollback(
  payload: unknown,
  photoPaths: string[],
): PhotoDeleteResult {
  const data =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : null;

  const requestedPaths = normalizePhotoPathArray(data?.requested_paths);
  const deletedPaths = normalizePhotoPathArray(data?.deleted_paths ?? data?.removed_paths);
  const failedPaths = normalizePhotoPathArray(data?.failed_paths);
  const requestedSet = new Set(requestedPaths);
  const deletedSet = new Set(deletedPaths);
  const failedSet = new Set(failedPaths);

  if (requestedPaths.length === 0 && photoPaths.length > 0) {
    throw new Error("photo_delete_incomplete_response");
  }

  for (const photoPath of photoPaths) {
    if (!requestedSet.has(photoPath)) {
      throw new Error("photo_delete_incomplete_response");
    }
  }

  const unclassifiedRollbackPaths = requestedPaths.filter(
    (photoPath) => !deletedSet.has(photoPath) && !failedSet.has(photoPath),
  );
  if (unclassifiedRollbackPaths.length > 0) {
    throw new Error("photo_delete_incomplete_response");
  }

  return {
    requested_paths: requestedPaths.length ? requestedPaths : [...photoPaths],
    deleted_paths: deletedPaths,
    failed_paths: failedPaths,
  };
}
