# Facebook and Google Ad Copy Generator Design

## Goal

Add a new left navigation feature named "广告文案" that lets the user upload a product image and generate bilingual ad copy for Facebook Ads and/or Google Ads.

The feature must generate 9 creative styles every run:

1. Problem/Solution
2. Feature & Benefit
3. Emotional Appeal
4. Social Proof / UGC
5. Us vs. Them
6. How-to / Demonstration
7. Offer / Promotion Driven
8. Scarcity / Urgency
9. Curiosity / Entertainment

Each output item must include target-language copy and Chinese back-translation.

## Scope

In scope:

- Add a new sidebar tab and page for ad copy generation.
- Support product image upload as the primary input.
- Let users select Facebook, Google, or both.
- Generate all 9 styles for each selected platform.
- Show bilingual results with copy buttons.
- Route AI calls through the backend service layer.
- Add backend request models, service logic, API route, and focused tests.

Out of scope for the first version:

- Saving ad copy to history.
- Editing generated copy in place.
- Exporting CSV/XLSX.
- Generating ad images or videos.
- Live platform policy validation against external APIs.

## UX

The left sidebar gets a new tab:

- Label: "广告文案"
- Icon: use an existing Phosphor icon, preferably `ph-megaphone` or a close available icon.

The ad page has two areas:

- Left input panel:
  - Product image uploader with preview and remove action.
  - Platform checkboxes: Facebook, Google.
  - Target market select, reusing existing `REGION_OPTIONS`.
  - Target language select, reusing existing `LANGUAGE_OPTIONS`.
  - Marketing theme select, reusing existing `MARKETING_THEMES`.
  - Generate button.
- Right result panel:
  - Empty state before generation.
  - Loading state during generation.
  - Results grouped by the 9 creative styles.
  - Within each style, show selected platform outputs.

Facebook result fields:

- `primaryText`
- `headline`
- `description`
- `cta`
- `creativeDirection`

Google result fields:

- `headlines`: multiple short headlines
- `descriptions`: multiple descriptions
- `keywords`
- `sitelinks`

Every text field uses the existing bilingual object pattern:

```json
{"target": "Target-language copy", "zh": "中文对照"}
```

## Backend Design

Add request models in `backend/models/request.py`:

- `AdCopyGenerateRequest`
  - `image_data: str`
  - `platforms: list[str]`
  - `region: str`
  - `target_language: str | None`
  - `marketing_theme: str | None`
  - `marketing_theme_label: str | None`
  - `ai_provider: str | None`

Add `backend/services/ads_service.py`:

- Validate the image data URL and size using the same constraints as listing image extraction.
- Send one vision-capable AI request with the image and generation instructions.
- Ask the model to identify the product, audience, visual traits, and likely use cases internally, then output the final ad copy JSON.
- Parse JSON with the existing robust parser approach from `listing_service.py`.
- Normalize missing fields to empty bilingual values so the frontend can render safely.

Add API route in `backend/main.py`:

- `POST /api/ads/generate`
- Return `{ "status": "success", "data": ... }` or `{ "status": "error", "message": ... }`.

## Response Shape

```json
{
  "product": {
    "name": {"target": "Product name", "zh": "中文产品名"},
    "summary": {"target": "Short positioning", "zh": "中文定位"}
  },
  "styles": [
    {
      "id": "problem_solution",
      "name": {"target": "Problem/Solution", "zh": "痛点解决型"},
      "logic": {"target": "Creative logic", "zh": "中文创意逻辑"},
      "facebook": {
        "primaryText": {"target": "", "zh": ""},
        "headline": {"target": "", "zh": ""},
        "description": {"target": "", "zh": ""},
        "cta": {"target": "", "zh": ""},
        "creativeDirection": {"target": "", "zh": ""}
      },
      "google": {
        "headlines": [{"target": "", "zh": ""}],
        "descriptions": [{"target": "", "zh": ""}],
        "keywords": [{"target": "", "zh": ""}],
        "sitelinks": [{"target": "", "zh": ""}]
      }
    }
  ]
}
```

If a platform was not selected, omit that platform key or return an empty object. The frontend must tolerate both.

## Prompt Requirements

The prompt must instruct the model to:

- Return pure JSON only.
- Generate all 9 styles exactly once.
- Respect selected platforms.
- Keep claims specific and defensible.
- Avoid unverifiable medical, safety, guarantee, and exaggerated claims.
- Use target-language copy plus Chinese translation for every field.
- Make Facebook copy suitable for feed/social ads.
- Make Google copy suitable for search ad assets with concise headlines and descriptions.
- Use the marketing theme only when it improves conversion and avoid false urgency.

## Frontend Design

Add `frontend/js/ads.js` for the new workflow:

- Maintain uploaded image state.
- Render preview and remove action.
- Collect selected platforms and inputs.
- Call `/api/ads/generate`.
- Render style cards and platform blocks.
- Add copy buttons using existing utility patterns.

Update existing files:

- `frontend/index.html`: add sidebar tab and `view-ads` page.
- `frontend/js/app.js`: initialize the new tab inputs if needed.
- `frontend/js/config.js`: reuse existing option constants; no new global platform constants are required unless rendering code benefits from a small `AD_PLATFORM_OPTIONS`.

## Error Handling

Frontend:

- Require an uploaded image.
- Require at least one platform selected.
- Show a clear toast on request failure.
- Keep existing results visible until a new request succeeds.

Backend:

- Reject invalid image data.
- Reject oversized images.
- Reject empty or unknown platform selections.
- Return parse errors with a short preview, following listing service behavior.

## Testing

Backend tests:

- Route test for `/api/ads/generate`.
- Reject missing/empty platforms.
- Service normalization test for missing platform fields.
- JSON parser/normalizer test using representative AI output.

Frontend checks:

- `node --check frontend/js/ads.js`
- Existing `node --check frontend/js/listing.js` should still pass.

Full backend check:

- `python -m pytest backend/tests`

## Implementation Notes

- Do not call AI directly from the browser.
- Prefer copying helper patterns from `listing_service.py` rather than introducing broad abstractions first.
- Keep history integration separate from this initial feature.
- Preserve existing Listing behavior.
