"""AI-backed business endpoints.

The handlers resolve service dependencies from ``main`` at request time.  This
keeps the existing test seams (and the public ``main`` compatibility surface)
while moving endpoint registration out of the application bootstrap module.
"""

from fastapi import APIRouter, HTTPException, status

from models.request import (
    AdCopyGenerateRequest,
    ListingComplianceRequest,
    ListingGenerateRequest,
    ListingImageExtractRequest,
    TranslationRequest,
    WatermarkRemovalRequest,
)
from models.settings import FrontendLogEvent
from services.ai_router import AIProviderRequestError


router = APIRouter()


def _main_module():
    # Import lazily to avoid a circular import while main.py registers routers.
    import main

    return main


@router.post("/api/translate-text")
async def api_translate_text(request: TranslationRequest):
    main = _main_module()
    try:
        langs = request.target_langs or (
            [request.target_lang] if request.target_lang else ["English"]
        )
        result_dict = await main.AIService.translate_text_batch(
            text=request.text,
            target_langs=langs,
        )
        return {
            "status": "success",
            "translations": result_dict,
            "translated_text": result_dict.get(langs[0], "") if langs else "",
        }
    except Exception as exc:
        main.logger.error(f"❌ [翻译] 失败: {exc}")
        return {"status": "error", "message": str(exc)}


@router.post("/api/listing/generate")
async def api_listing_generate(request: ListingGenerateRequest):
    main = _main_module()
    try:
        if not request.name.strip() or not request.points.strip():
            return {"status": "error", "message": "产品名称与核心卖点不能为空"}
        data = await main.generate_listing(request)
        return {"status": "success", "data": data}
    except Exception as exc:
        main.logger.error(f"❌ [Listing] 生成失败: {exc}")
        return {"status": "error", "message": str(exc)}


@router.post("/api/listing/extract")
async def api_listing_extract(request: ListingImageExtractRequest):
    main = _main_module()
    try:
        data = await main.extract_listing_inputs(request)
        return {"status": "success", "data": data}
    except Exception as exc:
        main.logger.error(f"❌ [Listing] 视觉提取失败: {exc}")
        return {"status": "error", "message": str(exc)}


@router.post("/api/listing/compliance")
async def api_listing_compliance(request: ListingComplianceRequest):
    main = _main_module()
    try:
        data = await main.check_listing_compliance(request)
        return {"status": "success", "data": data}
    except Exception as exc:
        main.logger.error(f"❌ [Listing] 合规审查失败: {exc}")
        return {"status": "error", "message": str(exc)}


@router.post("/api/ads/generate")
async def api_ads_generate(request: AdCopyGenerateRequest):
    main = _main_module()
    try:
        data = await main.generate_ad_copy(request)
        main.persist_ads_history(request, data)
        return {"status": "success", "data": data}
    except Exception as exc:
        main.logger.error(f"❌ [广告文案] 生成失败: {exc}")
        return {"status": "error", "message": str(exc)}


@router.post("/api/watermark-removal")
async def api_watermark_removal(request: WatermarkRemovalRequest):
    main = _main_module()
    try:
        data = await main.remove_watermark(request)
        return {"status": "success", "data": data}
    except Exception as exc:
        main.logger.error(f"❌ [水印消除] 失败: {exc}")
        return {"status": "error", "message": str(exc)}


@router.post("/api/ai/generate")
async def api_ai_generate(data: dict):
    main = _main_module()
    capability = data.get("capability")
    if capability not in {"text", "image"}:
        raise HTTPException(422, "capability 必须是 text 或 image")
    try:
        return await main.AIService.generate_content(
            payload=data.get("payload", {}),
            capability=capability,
        )
    except AIProviderRequestError as exc:
        diagnostic = (
            main.AppLogService.sanitize(exc.diagnostic.as_log_dict())
            if exc.diagnostic is not None
            else {"category": exc.category}
        )
        provider = (
            main.AppLogService.sanitize(exc.provider)
            if exc.provider is not None
            else None
        )
        model = (
            main.AppLogService.sanitize(exc.model)
            if exc.model is not None
            else None
        )
        safe_capability = main.AppLogService.sanitize(
            exc.capability or capability
        )
        public_status = main._PROVIDER_ERROR_HTTP_STATUS.get(
            exc.category,
            status.HTTP_502_BAD_GATEWAY,
        )
        if (
            exc.category == "authentication"
            and exc.diagnostic is not None
            and exc.diagnostic.http_status == 403
        ):
            public_status = status.HTTP_403_FORBIDDEN
        raise HTTPException(
            status_code=public_status,
            detail={
                "category": exc.category,
                "diagnostic": diagnostic,
                "provider": provider,
                "model": model,
                "capability": safe_capability,
                "retry": exc.retry,
            },
        ) from None
    except ValueError:
        label = "文本" if capability == "text" else "图片"
        raise HTTPException(
            status_code=409,
            detail=f"{label} AI 未配置，请前往设置页面配置",
        ) from None


@router.post("/log")
async def receive_frontend_log(data: FrontendLogEvent):
    main = _main_module()
    main.app_logs.emit(
        level=data.level,
        source="frontend",
        message=data.message,
        capability=data.capability,
        provider=data.provider,
        model=data.model,
        duration_ms=data.duration_ms,
        retry=data.retry,
    )
    return {"status": "ok"}
