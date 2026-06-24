# Batch 1:1 Square Image Redraw Design

## Goal

Add a new left-navigation module named "方图重绘" for batch redrawing uploaded ecommerce images into natural 1:1 square compositions.

The feature must support 1 to 100 images per batch. Images that are already 1:1 must not call AI. They stay visible in the batch and are included in the final zip under `skipped-originals/`.

The AI prompt is based on the user's approved direction:

```text
Redraw the uploaded image into a perfect 1:1 square format.

Keep the original subject, clothing, composition, lighting, colors, textures, and visual style unchanged.

Extend or intelligently reconstruct the missing areas if necessary to fit the square canvas.

Do not crop important elements.
Do not cut off the model, clothing, accessories, or product.

Maintain:
- original outfit details
- fabric texture
- colors and patterns
- lighting and shadows
- photography style
- commercial quality

The final image should look like the original image was naturally photographed in a 1:1 square composition.

High-end ecommerce photography, ultra realistic, Pinterest advertising quality.
```

## Scope

In scope:

- Add a new sidebar tab and page for batch 1:1 redraw.
- Accept 1 to 100 uploaded images per batch.
- Detect existing 1:1 images before AI calls and skip them.
- Re-check image dimensions on the backend.
- Process non-square images through the same image-generation path used by detail-page generation.
- Persist batch and item status in SQLite.
- Save generated images under `backend/static/outputs/square-redraw/<batch_id>/`.
- Poll backend progress from the frontend.
- Retry failed items without reprocessing successful or skipped items.
- Export the batch as one zip file.

Out of scope for the first version:

- Processing more than 100 images in one batch.
- Multi-user queue isolation.
- Pause/resume controls.
- A separate worker process or external queue.
- Per-image manual prompt editing.
- Direct upload to Pinterest, WordPress, or cloud storage.

## Architecture

Add a standalone feature boundary instead of extending the image translation module.

Frontend:

- Add `frontend/js/square_redraw.js`.
- Add a new `view-square-redraw` section in `frontend/index.html`.
- Add a sidebar tab with a clear label such as "方图重绘".
- Reuse existing utility functions from `frontend/js/utils.js`.
- Reuse the application's existing visual language and card patterns.

Backend:

- Add `backend/services/square_redraw_service.py`.
- Add request/response models to `backend/models/request.py` only where typed request validation helps.
- Add API routes in `backend/main.py`.
- Keep core batch logic in the service file, not in route handlers.
- Reuse `AIService.generate_content` for AI calls.

Storage:

- Extend SQLite with two tables:
  - `square_redraw_batches`
  - `square_redraw_items`
- Save image files to the existing static directory, not to the database.

## AI Generation Path

The redraw logic must follow the detail-page image generation behavior:

- Use the configured `IMAGE_MODEL` exposed by `/config`.
- Route AI calls through the backend proxy/service layer.
- Use `AIService.generate_content`.
- Use `responseModalities: ["IMAGE"]`.
- Use `imageConfig.aspectRatio = "1:1"`.
- Use the same configured concurrency and stagger settings as detail-page generation:
  - `FRONTEND_CONCURRENCY_LIMIT`
  - `FRONTEND_STAGGER_DELAY`

The service should not implement an HTML/CSS fallback image. A fallback placeholder is useful for detail pages, but it is not useful as a product image output. Failed items should remain failed and be retryable.

## Data Model

`square_redraw_batches` fields:

- `id`
- `created_at`
- `updated_at`
- `status`: `queued`, `running`, `done`, `failed`, `canceled`
- `total_count`
- `queued_count`
- `running_count`
- `done_count`
- `failed_count`
- `skipped_count`
- `output_dir`
- `zip_path`

`square_redraw_items` fields:

- `id`
- `batch_id`
- `source_filename`
- `source_mime_type`
- `source_width`
- `source_height`
- `status`: `queued`, `running`, `done`, `failed`, `skipped_square`, `canceled`
- `retry_count`
- `source_url`
- `output_url`
- `error_message`
- `created_at`
- `updated_at`

The implementation can compute counts from item rows instead of storing every count if that is simpler and reliable. The API response should still return summarized counts.

## Backend API

Create batch:

```http
POST /api/square-redraw/batches
```

Request shape:

```json
{
  "images": [
    {
      "filename": "dress-001.jpg",
      "image_data": "data:image/jpeg;base64,...",
      "width": 900,
      "height": 1200
    }
  ]
}
```

Rules:

- Reject empty batches.
- Reject batches with more than 100 images.
- Accept only `data:image/...;base64,...`.
- Frontend dimensions are advisory only. Backend must re-read dimensions.
- Already-square images are saved as original files and marked `skipped_square`.

Get batch:

```http
GET /api/square-redraw/batches/{batch_id}
```

Return batch status, summary counts, and item rows.

Retry failed:

```http
POST /api/square-redraw/batches/{batch_id}/retry-failed
```

Only `failed` items are reset and reprocessed. `done` and `skipped_square` items are never repeated.

Download zip:

```http
GET /api/square-redraw/batches/{batch_id}/download
```

Return one zip file. The frontend must not trigger one download per image.

## Zip Output

The zip structure is fixed:

```text
square-redraw-<batch_id>.zip
  redrawn/
    dress-001-square.png
    dress-002-square.png
  skipped-originals/
    square-image-001.jpg
  manifest.json
```

`manifest.json` includes:

- original filename
- original dimensions
- status
- retry count
- output relative path
- error message, when present

The zip should include:

- All `done` AI redraw outputs under `redrawn/`.
- All `skipped_square` original images under `skipped-originals/`.
- Failed items only in `manifest.json`, not as image files.

## Frontend UX

Page structure:

- Top toolbar:
  - Upload images
  - Start 1:1 redraw
  - Retry failed
  - Download zip
- Batch summary:
  - Total
  - To redraw
  - Skipped 1:1
  - Success
  - Failed
  - Running
- Status filter:
  - All
  - Pending
  - Success
  - Failed
  - Skipped
- Item cards:
  - Source thumbnail
  - Filename
  - Original dimensions
  - Status badge
  - Generated preview or error message

Interaction rules:

- Uploading 1 image is valid.
- Uploading 100 images is valid.
- Uploading more than 100 images is blocked with a clear toast.
- The frontend reads natural image width and height before submission.
- 1:1 images show "已是 1:1，跳过" immediately.
- If all uploaded images are 1:1, the user can still create/download a batch zip containing `skipped-originals/`, or the UI may offer a direct "打包原图" path. The first implementation should prefer creating a batch for consistent history and manifest behavior.
- The page polls `GET /api/square-redraw/batches/{id}` while a batch is running.
- The zip download button is enabled when at least one item is `done` or `skipped_square`.
- There are no per-image download buttons.

## Error Handling

Frontend:

- Show a toast when no images are selected.
- Show a toast when more than 100 images are selected.
- Show per-item errors from the backend.
- Keep existing batch results visible if a new request fails.
- Stop polling after terminal states: all items are `done`, `failed`, `skipped_square`, or `canceled`.

Backend:

- Invalid data URL: mark item `failed` or reject the whole request if the payload is structurally invalid.
- Unreadable image dimensions: mark item `failed`, do not call AI.
- Existing 1:1 image: save original, mark `skipped_square`, do not call AI.
- AI returns no inline image: mark item `failed`.
- AI exception after retries: mark item `failed` with a short error message.
- Zip creation with no usable files returns a clear error.

## Testing

Backend tests:

- Creating a batch with 0 images is rejected.
- Creating a batch with 101 images is rejected.
- A valid 1-image batch is accepted.
- A 1:1 image is marked `skipped_square` and does not call AI.
- A non-square image calls `AIService.generate_content` with `imageConfig.aspectRatio = "1:1"`.
- A successful AI image response saves an output URL and marks the item `done`.
- A failed AI response marks the item `failed`.
- `retry-failed` only resets failed items.
- Zip download contains `redrawn/`, `skipped-originals/`, and `manifest.json`.

Frontend checks:

- `node --check frontend/js/square_redraw.js`
- Existing loaded scripts should still parse.

Full backend check:

```bash
python -m pytest backend/tests
```

## Implementation Notes

- Preserve existing user changes in the working tree.
- Do not call AI directly from the browser.
- Keep the prompt centralized in `square_redraw_service.py`.
- Prefer structured image parsing for dimensions instead of ad hoc string checks.
- Use deterministic filenames derived from the original base name plus a uniqueness suffix.
- Keep the implementation local-first and compatible with the existing FastAPI plus vanilla JS application.
