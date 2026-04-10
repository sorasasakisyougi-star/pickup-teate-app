import assert from "node:assert/strict";
import test from "node:test";

import { buildPhotoDeleteResponse } from "../../app/api/photos/route.ts";
import { classifyPhotoDeleteResultForRollback } from "../../app/lib/photoRollbackContract.ts";

test("DELETE full success returns requested=deleted and failed=[]", () => {
  const photoPaths = ["pickup-orders/a.jpg", "pickup-orders/b.jpg"];

  const response = buildPhotoDeleteResponse({
    bucket: "order-photos",
    photoPaths,
    deletedPaths: [...photoPaths],
    failedPaths: [],
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.success, true);
  assert.deepEqual(response.body.requested_paths, photoPaths);
  assert.deepEqual(response.body.deleted_paths, photoPaths);
  assert.deepEqual(response.body.failed_paths, []);
  assert.equal(response.body.error, undefined);
});

test("DELETE partial failure returns deleted=success_only, failed=failed_only", () => {
  const photoPaths = ["pickup-orders/a.jpg", "pickup-orders/b.jpg"];

  const response = buildPhotoDeleteResponse({
    bucket: "order-photos",
    photoPaths,
    deletedPaths: ["pickup-orders/a.jpg"],
    failedPaths: ["pickup-orders/b.jpg"],
  });

  assert.equal(response.status, 502);
  assert.equal(response.body.success, false);
  assert.deepEqual(response.body.requested_paths, photoPaths);
  assert.deepEqual(response.body.deleted_paths, ["pickup-orders/a.jpg"]);
  assert.deepEqual(response.body.failed_paths, ["pickup-orders/b.jpg"]);
  assert.equal(response.body.error, "photo_storage_delete_incomplete");
});

test("frontend rollback rejects incomplete response classification", () => {
  assert.throws(
    () =>
      classifyPhotoDeleteResultForRollback(
        {
          requested_paths: ["pickup-orders/a.jpg", "pickup-orders/b.jpg"],
          deleted_paths: ["pickup-orders/a.jpg"],
          failed_paths: [],
        },
        ["pickup-orders/a.jpg", "pickup-orders/b.jpg"],
      ),
    (error) => error instanceof Error && error.message === "photo_delete_incomplete_response",
  );
});

test("frontend rollback accepts valid classified response", () => {
  const result = classifyPhotoDeleteResultForRollback(
    {
      requested_paths: ["pickup-orders/a.jpg", "pickup-orders/b.jpg"],
      deleted_paths: ["pickup-orders/a.jpg"],
      failed_paths: ["pickup-orders/b.jpg"],
    },
    ["pickup-orders/a.jpg", "pickup-orders/b.jpg"],
  );

  assert.deepEqual(result, {
    requested_paths: ["pickup-orders/a.jpg", "pickup-orders/b.jpg"],
    deleted_paths: ["pickup-orders/a.jpg"],
    failed_paths: ["pickup-orders/b.jpg"],
  });
});
