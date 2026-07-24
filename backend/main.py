from fastapi import FastAPI, Depends, HTTPException, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from contextlib import asynccontextmanager
import base64
import datetime
import uuid
import json
import logging
import asyncio
import os
import re
import threading
import time
from typing import List, Literal, Union, Any, Optional
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from dotenv import load_dotenv

from models.request import (
    CompareRequest, CompareResponse, CompareResponseData, ProductCompareData,
    ComparisonSummary, ScoreCard, EvalDetail, RecItem,
    TranslationRequest,
    ListingGenerateRequest, ListingImageExtractRequest, ListingComplianceRequest,
    AdCopyGenerateRequest,
    SquareRedrawBatchRequest,
)
from models.settings import (
    AIProviderList,
    AIProviderRead,
    AIProviderWrite,
    CapabilityBindingList,
    CapabilityBindingRead,
    CapabilityBindingWrite,
    FrontendLogEvent,
    ProviderConnectionTest,
    ProviderConnectionTestResult,
    SavedProviderConnectionTest,
)
from services.firecrawl import close_client as close_firecrawl_client, fetch_markdown
from services.cleaner import clean_content, check_block
from services.amazon_parser import parse_amazon, parse_general, is_amazon
from services.ai_single import analyze_single_extract, analyze_single_deep
from services.ai_compare import compare_products
from services.scoring import calculate_score
from services.ai_service import AIService
from services.listing_service import (
    generate_listing,
    extract_listing_inputs,
    check_listing_compliance,
)
from services.ads_service import generate_ad_copy
from services.square_redraw_service import (
    build_square_redraw_zip,
    create_square_redraw_batch,
    delete_square_redraw_item,
    process_square_redraw_item,
    retry_failed_square_redraw_items,
    serialize_square_redraw_batch,
)
from services.ai_config_service import (
    ProviderSnapshot,
    create_provider,
    delete_provider,
    get_bindings,
    get_snapshot,
    import_env_defaults_if_empty,
    list_providers,
    mask_secret,
    set_binding,
    set_provider_enabled,
    update_provider,
    validate_provider_data,
)
from services.ai_adapters import (
    close_adapters,
    get_adapter,
    invalidate_provider_clients,
)
from services.ai_router import (
    AIProviderRequestError,
    diagnose_provider_error,
)
from services.app_log_service import APP_LOG_OVERFLOW, AppLogService, app_logs
from services.image_validation import (
    MAX_IMAGE_BYTES,
    MAX_IMAGE_DIMENSION,
    MAX_IMAGE_PIXELS,
    validate_image_payload,
)
from config import (
    FRONTEND_CONCURRENCY_LIMIT, FRONTEND_STAGGER_DELAY,
    CORS_ORIGINS, MAX_URL_LENGTH,
)
from db import init_db, get_db, SessionLocal, AICapabilityBinding, AIProviderConfig, AnalysisHistory, ListingHistory, TranslationHistory, TextTranslationHistory, AdsHistory, RenderHistory, SquareRedrawHistory

MAX_CONNECTION_IMAGE_BYTES = MAX_IMAGE_BYTES
MAX_CONNECTION_IMAGE_DIMENSION = MAX_IMAGE_DIMENSION
MAX_CONNECTION_IMAGE_PIXELS = MAX_IMAGE_PIXELS

_PROVIDER_ERROR_HTTP_STATUS = {
    "authentication": 401,
    "model_not_found": 404,
    "rate_limit": 429,
    "timeout": 504,
    "protocol_incompatible": 502,
    "upstream_failure": 502,
}

# 加载配置
load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), ".env"), override=False)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# 初始化数据库
def initialize_ai_settings():
    db = SessionLocal()
    try:
        imported = import_env_defaults_if_empty(db)
        has_provider = (
            db.query(AIProviderConfig.id).first() is not None
        )
        if imported:
            message = "AI 默认配置已导入"
            level = "success"
        elif has_provider:
            message = "AI 数据库配置已加载"
            level = "success"
        else:
            message = "AI 尚未配置，可在设置中修复"
            level = "warning"
        app_logs.emit(
            level=level,
            source="system",
            message=message,
        )
    except Exception:
        app_logs.emit(
            level="error",
            source="system",
            message="AI 配置初始化失败",
        )
        raise
    finally:
        db.close()


init_db()
initialize_ai_settings()


@asynccontextmanager
async def app_lifespan(_app):
    try:
        yield
    finally:
        await close_adapters()
        await close_firecrawl_client()


app = FastAPI(
    title="AI Competitor Analyzer V2",
    lifespan=app_lifespan,
)
app_logs.emit(
    level="success",
    source="system",
    message="系统启动完成",
)


@app.exception_handler(RequestValidationError)
async def sanitized_request_validation_error(
    request: Request,
    exc: RequestValidationError,
):
    safe_errors = [
        {
            key: error[key]
            for key in ("type", "loc", "msg")
            if key in error
        }
        for error in exc.errors()
    ]
    return JSONResponse(
        status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
        content={"detail": safe_errors},
    )


app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def add_static_asset_headers(request: Request, call_next):
    response = await call_next(request)
    if request.url.path.startswith("/static/"):
        origin = request.headers.get("origin")
        if origin and (origin in CORS_ORIGINS or "*" in CORS_ORIGINS):
            response.headers["Access-Control-Allow-Origin"] = origin
            response.headers["Access-Control-Allow-Credentials"] = "true"
            vary = response.headers.get("Vary")
            if not vary:
                response.headers["Vary"] = "Origin"
            elif "origin" not in vary.lower():
                response.headers["Vary"] = f"{vary}, Origin"
        response.headers["Access-Control-Allow-Methods"] = "GET, HEAD, OPTIONS"
        response.headers["Access-Control-Allow-Headers"] = "*"
        response.headers["Cross-Origin-Resource-Policy"] = "cross-origin"
        response.headers["Cache-Control"] = "no-store"
    return response


# 挂载静态文件目录
STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")
if not os.path.exists(STATIC_DIR):
    os.makedirs(STATIC_DIR)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

def save_base64_image(base64_str: str, folder: str = "outputs") -> str:
    """将 base64 字符串保存为文件并返回 URL"""
    try:
        if not base64_str or not isinstance(base64_str, str) or not base64_str.startswith("data:image"):
            return base64_str
        if "," not in base64_str:
            return base64_str
            
        header, encoded = base64_str.split(",", 1)
        ext = "jpg"
        if "png" in header: ext = "png"
        elif "gif" in header: ext = "gif"
        elif "webp" in header: ext = "webp"
        
        filename = f"{uuid.uuid4()}.{ext}"
        rel_path = f"{folder}/{filename}"
        abs_path = os.path.join(STATIC_DIR, folder, filename)
        os.makedirs(os.path.dirname(abs_path), exist_ok=True)
        with open(abs_path, "wb") as f:
            f.write(base64.b64decode(encoded))
        return f"/static/{rel_path}"
    except Exception as e:
        logger.error(f"❌ [系统] 保存图片失败: {e}")
        return base64_str


def persist_render_metadata_images(metadata: Any) -> Any:
    """把详情页项目 metadata 里的大图也落盘，避免历史库反复存 base64。"""
    if not isinstance(metadata, dict):
        return metadata

    if isinstance(metadata.get("finalImage"), str):
        metadata["finalImage"] = save_base64_image(metadata["finalImage"], "outputs")

    modules = metadata.get("modules")
    if isinstance(modules, list):
        for module in modules:
            if isinstance(module, dict) and isinstance(module.get("imageSrc"), str):
                module["imageSrc"] = save_base64_image(module["imageSrc"], "outputs")

    uploaded_images = metadata.get("uploadedImages")
    if isinstance(uploaded_images, list):
        for image in uploaded_images:
            if isinstance(image, dict) and isinstance(image.get("base64"), str):
                image["base64"] = save_base64_image(image["base64"], "outputs")
            image.pop("data", None)

    return metadata


def _text_pair_primary(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        return (
            value.get("target")
            or value.get("zh")
            or value.get("English")
            or value.get("Chinese")
            or value.get("text")
            or value.get("copy")
            or ""
        )
    return ""


def _ads_product_name(data: dict) -> str:
    product = data.get("product") if isinstance(data, dict) else {}
    if not isinstance(product, dict):
        return "广告文案"
    return _text_pair_primary(product.get("name")) or "广告文案"


def persist_ads_history(request: AdCopyGenerateRequest, data: dict) -> None:
    db = SessionLocal()
    try:
        image_url = save_base64_image(request.image_data, "outputs")
        hist = AdsHistory(
            product_name=_ads_product_name(data),
            platforms=", ".join(request.platforms),
            region=request.region,
            target_lang=request.target_language,
            marketing_theme=request.marketing_theme_label or request.marketing_theme,
            image_url=image_url,
            result=data,
        )
        db.add(hist)
        db.commit()
    finally:
        db.close()


def normalize_ai_json_object(value: Any) -> dict:
    """兼容 AI 偶尔把对象包成单元素数组返回的情况。"""
    if isinstance(value, dict):
        return value
    if isinstance(value, list):
        if value and isinstance(value[0], dict):
            return value[0]
        return {}
    return {}


def _coerce_score(value: Any) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def investment_score(score: dict) -> int:
    """机会越高越好，进入难度越低越好。"""
    return _coerce_score(score.get("opportunity_score")) + (100 - _coerce_score(score.get("difficulty_score")))


def best_product_index_by_scores(scores: list[dict]) -> int:
    if not scores:
        return -1
    return max(range(len(scores)), key=lambda idx: investment_score(scores[idx]))


def align_comparison_winner(comp_result: dict, products: list[dict], scores: list[dict]) -> dict:
    """用确定性评分规则校准 winner，避免横向分析与评分卡互相矛盾。"""
    if not comp_result or not products or len(products) != len(scores):
        return comp_result

    winner_idx = best_product_index_by_scores(scores)
    if winner_idx < 0:
        return comp_result

    winner_name = products[winner_idx].get("product_name") or scores[winner_idx].get("product") or ""
    if winner_name:
        comp_result["winner_product"] = winner_name
    return comp_result


def build_consistent_recommendations(products: list[dict], scores: list[dict]) -> list[dict]:
    """基于最终评分生成一致的操盘建议，避免 AI 横向建议与 Winner 打架。"""
    if not products or not scores or len(products) != len(scores):
        return []

    winner_idx = best_product_index_by_scores(scores)
    if winner_idx < 0:
        return []

    winner = products[winner_idx]
    winner_score = scores[winner_idx]
    winner_name = winner.get("product_name") or winner_score.get("product") or "Winner"
    reason = (winner_score.get("decision_details") or {}).get("reason", "")

    highest_difficulty_idx = max(range(len(scores)), key=lambda idx: _coerce_score(scores[idx].get("difficulty_score")))
    risk_product = products[highest_difficulty_idx]
    risk_score = scores[highest_difficulty_idx]
    risk_name = risk_product.get("product_name") or risk_score.get("product") or "High-risk product"

    return [
        {
            "action": "主推建议 ||| Primary recommendation",
            "content": f"优先验证 {winner_name}，它在机会分与进入难度的综合投资分中排名最高。{reason} ||| Prioritize validating {winner_name}; it ranks highest by combined opportunity and entry-difficulty score. {reason}",
        },
        {
            "action": "风险控制 ||| Risk control",
            "content": f"谨慎处理 {risk_name}，它的进入难度最高，需要先验证物流、供给、售后或投放成本。 ||| Treat {risk_name} cautiously; it has the highest entry difficulty and needs validation on logistics, supply, after-sales, or acquisition cost.",
        },
        {
            "action": "下一步验证 ||| Next validation step",
            "content": "建议先小预算测试 Winner 的点击率、加购率与真实采购/履约成本，再决定是否放大。 ||| Run a small-budget test for the winner's CTR, add-to-cart rate, and real sourcing/fulfillment cost before scaling.",
        },
    ]


async def process_single_url(url: str, markdown_content: str = None, force_refresh: bool = False) -> dict:
    try:
        logger.info(f"🔍 [单品处理] 开始处理 URL: {url}")
        if not markdown_content:
            markdown_content = await fetch_markdown(url, max_age=0 if force_refresh else 3600)
        cleaned_text = clean_content(markdown_content)
        if not cleaned_text:
            raise Exception("内容为空")
        if check_block(markdown_content):
            raise Exception("被拦截")

        if is_amazon(url):
            structured_data = parse_amazon(markdown_content)
        else:
            structured_data = parse_general(markdown_content, url=url)

        ai_result_json_str = await analyze_single_extract(structured_data)
        parsed_data = normalize_ai_json_object(json.loads(ai_result_json_str))
        parsed_data["source_url"] = url
        
        p_data = structured_data.get("product_data", {})
        if not parsed_data.get("price") and p_data.get("price"): parsed_data["price"] = p_data["price"]
        if not parsed_data.get("reviews_count"): parsed_data["reviews_count"] = p_data.get("reviews_count", "0")

        return ProductCompareData(**parsed_data).model_dump()
    except Exception as e:
        logger.error(f"❌ [单品处理] 出错: {e}")
        raise e

async def process_single_url_deep(url: str, markdown_content: str = None, force_refresh: bool = False) -> dict:
    try:
        if not markdown_content:
            markdown_content = await fetch_markdown(url, max_age=0 if force_refresh else 3600)
        if is_amazon(url):
            structured_data = parse_amazon(markdown_content)
        else:
            structured_data = parse_general(markdown_content, url=url)

        ai_result_json_str = await analyze_single_deep(structured_data)
        result = normalize_ai_json_object(json.loads(ai_result_json_str))
        result["source_url"] = url
        return result
    except Exception as e:
        logger.error(f"❌ [深度分析] 出错: {e}")
        raise e

# --- 校验 ---
_URL_PATTERN = re.compile(r"^https?://[^\s/$.?#].[^\s]*$", re.IGNORECASE)
_BARE_DOMAIN_PATTERN = re.compile(
    r"^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}(?:/[^\s]*)?$",
    re.IGNORECASE,
)


def normalize_input_url(url: str) -> str:
    url = (url or "").strip()
    if not url:
        return ""
    if re.match(r"^https?://", url, re.IGNORECASE):
        return url
    if _BARE_DOMAIN_PATTERN.match(url):
        return f"https://{url}"
    return url


def validate_url(url: str) -> str | None:
    """校验 URL 格式与长度，返回错误信息或 None"""
    if not url or not url.strip():
        return "URL 不能为空"
    if len(url) > MAX_URL_LENGTH:
        return f"URL 长度超过限制 ({MAX_URL_LENGTH} 字符)"
    if not _URL_PATTERN.match(url.strip()):
        return f"URL 格式无效: {url[:80]}"
    return None


# --- 缓存 ---
analysis_cache = {}
_analysis_cache_lock = threading.RLock()
_analysis_cache_generation = 0
_ANALYSIS_ROUTE_UNSET = object()


def invalidate_analysis_cache() -> None:
    global _analysis_cache_generation
    with _analysis_cache_lock:
        _analysis_cache_generation += 1
        analysis_cache.clear()


def analysis_route_identity() -> tuple[int, str, int] | None:
    db = SessionLocal()
    try:
        try:
            snapshot = get_snapshot(db, "text")
            return (
                snapshot.id,
                snapshot.incarnation_id,
                snapshot.config_version,
            )
        except ValueError:
            return None
    finally:
        db.close()


def analysis_cache_key(
    unique_urls: list[str],
    route_identity: tuple[int, str, int] | None | object = (
        _ANALYSIS_ROUTE_UNSET
    ),
) -> str:
    if route_identity is _ANALYSIS_ROUTE_UNSET:
        route_identity = analysis_route_identity()
    if route_identity is None:
        serialized_identity = "unconfigured"
    else:
        serialized_identity = ":".join(
            str(part) for part in route_identity
        )
    return (
        f"{';'.join(sorted(unique_urls))}"
        f"|text-route={serialized_identity}"
    )


@app.post("/compare", response_model=CompareResponse)
async def compare(request: CompareRequest):
    try:
        urls = request.urls
        force_refresh = request.force_refresh
        unique_urls = list(dict.fromkeys([normalize_input_url(u) for u in urls if u.strip()]))

        # URL 格式校验
        for u in unique_urls:
            err = validate_url(u)
            if err:
                return CompareResponse(status="error", message=err)

        with _analysis_cache_lock:
            cache_generation = _analysis_cache_generation
        route_identity = analysis_route_identity()
        cache_key = analysis_cache_key(
            unique_urls,
            route_identity,
        )

        with _analysis_cache_lock:
            cached_entry = (
                analysis_cache.get(cache_key)
                if (
                    not force_refresh
                    and cache_generation == _analysis_cache_generation
                )
                else None
            )
        if cached_entry is not None:
            cached_time, cached_res = cached_entry
            if asyncio.get_event_loop().time() - cached_time < 30:
                return cached_res
        
        if len(unique_urls) == 1:
            url = unique_urls[0]
            markdown_content = await fetch_markdown(url, max_age=0 if force_refresh else 3600)
            basic_data = await process_single_url(url, markdown_content=markdown_content)
            score_res = await calculate_score(basic_data)
            
            # 补全 ScoreCard 所需字段
            if not score_res.get("decision_details"):
                score_res["decision_details"] = {"confidence": "medium", "reason": ""}
            score_res.setdefault("opportunity_score", 0)
            score_res.setdefault("difficulty_score", 0)
            score_res.setdefault("final_decision", "Pending")
            score_res.setdefault("product", basic_data.get("product_name", "Product"))
            
            scores = [ScoreCard(**score_res)]
            single_data = await process_single_url_deep(url, markdown_content=markdown_content)
            response_data = CompareResponseData(
                single_data=single_data,
                scores=scores,
                url_statuses=[{"url": url, "status": "success", "product_name": basic_data.get("product_name", "")}],
            )
            template_type = "single"
            msg = "分析完成"
        else:
            tasks = [process_single_url(url, force_refresh=force_refresh) for url in unique_urls]
            results = await asyncio.gather(*tasks, return_exceptions=True)
            valid_products = []
            url_statuses = []
            for url, result in zip(unique_urls, results):
                if isinstance(result, Exception):
                    url_statuses.append({"url": url, "status": "error", "message": str(result)})
                else:
                    valid_products.append(result)
                    url_statuses.append({"url": url, "status": "success", "product_name": result.get("product_name", "")})
            if not valid_products:
                return CompareResponse(status="error", message="所有 URL 均处理失败", data=CompareResponseData(url_statuses=url_statuses))

            score_tasks = [calculate_score(p) for p in valid_products]
            score_results = await asyncio.gather(*score_tasks, return_exceptions=True)
            scores = []
            score_dicts = []
            scored_products = []
            for idx, (product, s_res) in enumerate(zip(valid_products, score_results)):
                source_url = product.get("source_url", "")
                matching_status = next((s for s in url_statuses if s.get("url") == source_url), None)
                if not isinstance(s_res, Exception) and s_res:
                    s_res.setdefault("product", "N/A")
                    s_res.setdefault("opportunity_score", 0)
                    s_res.setdefault("difficulty_score", 0)
                    s_res.setdefault("final_decision", "Pending")
                    if "decision_details" not in s_res: s_res["decision_details"] = {"confidence": "medium", "reason": ""}
                    score_dicts.append(s_res)
                    scored_products.append(product)
                    scores.append(ScoreCard(**s_res))
                    if matching_status is not None:
                        matching_status["score_status"] = "success"
                else:
                    if matching_status is not None:
                        matching_status["score_status"] = "error"
                        matching_status["score_message"] = str(s_res) if isinstance(s_res, Exception) else "评分结果为空"

            compare_input = []
            for product, score in zip(scored_products, score_dicts):
                enriched = dict(product)
                enriched["investment_scores"] = {
                    "opportunity_score": _coerce_score(score.get("opportunity_score")),
                    "difficulty_score": _coerce_score(score.get("difficulty_score")),
                    "investment_score": investment_score(score),
                    "final_decision": score.get("final_decision", ""),
                }
                compare_input.append(enriched)

            comp_result = await compare_products(compare_input or valid_products)
            comp_result = align_comparison_winner(comp_result, scored_products, score_dicts)
            consistent_recommendations = build_consistent_recommendations(scored_products, score_dicts)
            if consistent_recommendations:
                comp_result["recommendation_list"] = consistent_recommendations
            comparison_data = ComparisonSummary(**{k: comp_result.get(k, "") for k in ["market_position", "competition_level", "winner_product"]})
            
            template_type = "matrix"
            msg = f"分析了 {len(valid_products)} 个产品"
            response_data = CompareResponseData(
                products=[ProductCompareData(**p) for p in valid_products],
                comparison=comparison_data,
                comprehensive_evaluation=[EvalDetail(**e) for e in comp_result.get("comprehensive_evaluation", [])],
                recommendation_list=[RecItem(**r) for r in comp_result.get("recommendation_list", [])],
                scores=scores,
                url_statuses=url_statuses,
            )

        # 保存历史
        db = SessionLocal()
        try:
            pure_json = json.loads(response_data.model_dump_json())
            new_hist = AnalysisHistory(query_url="; ".join(unique_urls), template_type=template_type, data=pure_json)
            db.add(new_hist)
            db.commit()
        finally:
            db.close()

        final_res = CompareResponse(status="success", template_type=template_type, data=response_data, message=msg)
        current_route_identity = analysis_route_identity()
        with _analysis_cache_lock:
            if (
                cache_generation == _analysis_cache_generation
                and current_route_identity == route_identity
            ):
                analysis_cache[cache_key] = (
                    asyncio.get_event_loop().time(),
                    final_res,
                )
        return final_res
    except Exception as e:
        logger.error(f"❌ [分析] 失败: {e}")
        return CompareResponse(status="error", message=str(e))

@app.post("/api/translate-text")
async def api_translate_text(request: TranslationRequest):
    """
    文本翻译接口：支持单请求多语言批量处理
    """
    try:
        # 整理目标语言列表
        langs = request.target_langs or ([request.target_lang] if request.target_lang else ["English"])
        
        # 调用 AI 批量翻译（异步）
        result_dict = await AIService.translate_text_batch(
            text=request.text,
            target_langs=langs,
        )
        
        return {
            "status": "success",
            "translations": result_dict,
            # 兼容旧版
            "translated_text": result_dict.get(langs[0], "") if langs else ""
        }
    except Exception as e:
        logger.error(f"❌ [翻译] 失败: {e}")
        return {"status": "error", "message": str(e)}


@app.post("/api/listing/generate")
async def api_listing_generate(request: ListingGenerateRequest):
    try:
        if not request.name.strip() or not request.points.strip():
            return {"status": "error", "message": "产品名称与核心卖点不能为空"}
        data = await generate_listing(request)
        return {"status": "success", "data": data}
    except Exception as e:
        logger.error(f"❌ [Listing] 生成失败: {e}")
        return {"status": "error", "message": str(e)}


@app.post("/api/listing/extract")
async def api_listing_extract(request: ListingImageExtractRequest):
    try:
        data = await extract_listing_inputs(request)
        return {"status": "success", "data": data}
    except Exception as e:
        logger.error(f"❌ [Listing] 视觉提取失败: {e}")
        return {"status": "error", "message": str(e)}


@app.post("/api/listing/compliance")
async def api_listing_compliance(request: ListingComplianceRequest):
    try:
        data = await check_listing_compliance(request)
        return {"status": "success", "data": data}
    except Exception as e:
        logger.error(f"❌ [Listing] 合规审查失败: {e}")
        return {"status": "error", "message": str(e)}


@app.post("/api/ads/generate")
async def api_ads_generate(request: AdCopyGenerateRequest):
    try:
        data = await generate_ad_copy(request)
        persist_ads_history(request, data)
        return {"status": "success", "data": data}
    except Exception as e:
        logger.error(f"❌ [广告文案] 生成失败: {e}")
        return {"status": "error", "message": str(e)}

@app.post("/api/ai/generate")
async def api_ai_generate(data: dict):
    capability = data.get("capability")
    if capability not in {"text", "image"}:
        raise HTTPException(422, "capability 必须是 text 或 image")
    try:
        return await AIService.generate_content(
            payload=data.get("payload", {}),
            capability=capability,
        )
    except AIProviderRequestError as exc:
        diagnostic = (
            AppLogService.sanitize(exc.diagnostic.as_log_dict())
            if exc.diagnostic is not None
            else {"category": exc.category}
        )
        provider = (
            AppLogService.sanitize(exc.provider)
            if exc.provider is not None
            else None
        )
        model = (
            AppLogService.sanitize(exc.model)
            if exc.model is not None
            else None
        )
        safe_capability = AppLogService.sanitize(
            exc.capability or capability
        )
        public_status = _PROVIDER_ERROR_HTTP_STATUS.get(
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

@app.post("/log")
async def receive_frontend_log(data: FrontendLogEvent):
    app_logs.emit(
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


def serialize_provider(row) -> dict:
    return {
        "id": row.id,
        "name": row.name,
        "protocol": row.protocol,
        "base_url": row.base_url,
        "has_api_key": bool(row.api_key),
        "api_key_masked": mask_secret(row.api_key),
        "has_vertex_credentials": bool(
            row.vertex_project_id
            or row.vertex_location
            or row.vertex_key_path
        ),
        "text_model": row.text_model,
        "image_model": row.image_model,
        "supports_text": bool(row.supports_text),
        "supports_image": bool(row.supports_image),
        "timeout_seconds": row.timeout_seconds,
        "max_retries": row.max_retries,
        "enabled": bool(row.enabled),
        "last_test_status": row.last_test_status,
        "last_test_message": row.last_test_message,
        "last_tested_at": row.last_tested_at,
        "last_test_capability": row.last_test_capability,
        "config_version": row.config_version,
    }


def serialize_binding(row) -> dict:
    return {
        "capability": row.capability,
        "provider_config_id": row.provider_config_id,
        "updated_at": row.updated_at,
    }


def _settings_error(exc: ValueError, *, missing_is_404: bool = False):
    message = str(exc)
    if missing_is_404 and "不存在" in message:
        raise HTTPException(status_code=404, detail=message) from exc
    raise HTTPException(status_code=409, detail=message) from exc


@app.post(
    "/api/settings/ai/providers",
    response_model=AIProviderRead,
    status_code=status.HTTP_201_CREATED,
)
def api_create_ai_provider(
    data: AIProviderWrite,
    db: Session = Depends(get_db),
):
    try:
        created = create_provider(db, data)
        invalidate_analysis_cache()
        return serialize_provider(created)
    except IntegrityError as exc:
        raise HTTPException(
            status_code=409,
            detail="提供商名称已存在",
        ) from exc
    except ValueError as exc:
        _settings_error(exc)


@app.get(
    "/api/settings/ai/providers",
    response_model=AIProviderList,
)
def api_list_ai_providers(db: Session = Depends(get_db)):
    return {
        "items": [
            serialize_provider(row)
            for row in list_providers(db)
        ]
    }


@app.put(
    "/api/settings/ai/providers/{provider_id}",
    response_model=AIProviderRead,
)
def api_update_ai_provider(
    provider_id: int,
    data: AIProviderWrite,
    db: Session = Depends(get_db),
):
    try:
        current = db.get(AIProviderConfig, provider_id)
        previous_version = (
            current.config_version
            if current is not None
            else None
        )
        updated = update_provider(db, provider_id, data)
        if updated.config_version != previous_version:
            invalidate_provider_clients(provider_id)
            invalidate_analysis_cache()
        return serialize_provider(updated)
    except IntegrityError as exc:
        raise HTTPException(
            status_code=409,
            detail="提供商名称已存在",
        ) from exc
    except ValueError as exc:
        _settings_error(exc, missing_is_404=True)


@app.delete("/api/settings/ai/providers/{provider_id}")
def api_delete_ai_provider(
    provider_id: int,
    db: Session = Depends(get_db),
):
    try:
        delete_provider(db, provider_id)
        invalidate_provider_clients(provider_id)
        invalidate_analysis_cache()
    except ValueError as exc:
        _settings_error(exc, missing_is_404=True)
    return {"status": "success"}


def _set_ai_provider_enabled(provider_id: int, enabled: bool, db: Session):
    try:
        current = db.get(AIProviderConfig, provider_id)
        previous_version = (
            current.config_version
            if current is not None
            else None
        )
        updated = set_provider_enabled(db, provider_id, enabled)
        if updated.config_version != previous_version:
            invalidate_provider_clients(provider_id)
            invalidate_analysis_cache()
        return serialize_provider(updated)
    except ValueError as exc:
        _settings_error(exc, missing_is_404=True)


@app.post(
    "/api/settings/ai/providers/{provider_id}/enable",
    response_model=AIProviderRead,
)
def api_enable_ai_provider(
    provider_id: int,
    db: Session = Depends(get_db),
):
    return _set_ai_provider_enabled(provider_id, True, db)


@app.post(
    "/api/settings/ai/providers/{provider_id}/disable",
    response_model=AIProviderRead,
)
def api_disable_ai_provider(
    provider_id: int,
    db: Session = Depends(get_db),
):
    return _set_ai_provider_enabled(provider_id, False, db)


@app.get(
    "/api/settings/ai/bindings",
    response_model=CapabilityBindingList,
)
def api_get_ai_bindings(db: Session = Depends(get_db)):
    return {
        "items": [
            serialize_binding(row)
            for row in get_bindings(db)
        ]
    }


@app.put(
    "/api/settings/ai/bindings/{capability}",
    response_model=CapabilityBindingRead,
)
def api_set_ai_binding(
    capability: Literal["text", "image"],
    data: CapabilityBindingWrite,
    db: Session = Depends(get_db),
):
    try:
        current = db.get(AICapabilityBinding, capability)
        binding_changed = (
            current is None
            or current.provider_config_id
            != data.provider_config_id
        )
        updated = set_binding(
            db,
            capability,
            data.provider_config_id,
        )
        if binding_changed:
            invalidate_analysis_cache()
        return serialize_binding(updated)
    except ValueError as exc:
        _settings_error(exc, missing_is_404=True)


def _connection_test_snapshot(
    data: ProviderConnectionTest,
    db: Session,
) -> tuple[
    ProviderSnapshot | None,
    tuple[int, str, int] | None,
    str | None,
]:
    row = None
    persisted_result_context = None
    try:
        if data.provider_id is not None:
            row = db.get(AIProviderConfig, data.provider_id)
            if row is None:
                raise HTTPException(
                    status_code=404,
                    detail="AI 提供商不存在",
                )
            if data.draft is not None:
                source_values = validate_provider_data(
                    data.draft,
                    row,
                )
                snapshot_id = 0
                incarnation_id = ""
                config_version = 1
            else:
                persisted_result_context = (
                    row.id,
                    row.incarnation_id,
                    row.config_version,
                )
                source_values = validate_provider_data({}, row)
                snapshot_id = row.id
                incarnation_id = row.incarnation_id
                config_version = row.config_version
        else:
            source_values = validate_provider_data(data.draft)
            snapshot_id = 0
            incarnation_id = ""
            config_version = 1
    except ValueError as exc:
        if persisted_result_context is not None:
            return None, persisted_result_context, str(exc)
        raise

    supported = (
        source_values["supports_text"]
        if data.capability == "text"
        else source_values["supports_image"]
    )
    if not supported:
        return None, persisted_result_context, f"该提供商不支持{'文本' if data.capability == 'text' else '图片'}能力"

    model = (
        source_values["text_model"]
        if data.capability == "text"
        else source_values["image_model"]
    )
    if not model:
        return None, persisted_result_context, f"未配置{'文本' if data.capability == 'text' else '图片'}模型"

    snapshot = ProviderSnapshot(
        id=snapshot_id,
        incarnation_id=incarnation_id,
        capability=data.capability,
        name=source_values["name"],
        protocol=source_values["protocol"],
        base_url=source_values["base_url"],
        api_key=source_values["api_key"],
        vertex_project_id=source_values["vertex_project_id"],
        vertex_location=source_values["vertex_location"],
        vertex_key_path=source_values["vertex_key_path"],
        model=model,
        timeout_seconds=source_values["timeout_seconds"],
        max_retries=source_values["max_retries"],
        config_version=config_version,
    )
    return snapshot, persisted_result_context, None


def _save_connection_test_result(
    db: Session,
    row_or_provider_id: AIProviderConfig | int | None,
    result_status: str,
    message: str,
    *,
    expected_incarnation_id: str | None = None,
    expected_config_version: int | None = None,
    capability: str | None = None,
) -> bool:
    if row_or_provider_id is None:
        return False
    tested_at = datetime.datetime.now(datetime.timezone.utc)
    if expected_config_version is None:
        row_or_provider_id.last_test_status = result_status
        row_or_provider_id.last_test_message = message
        row_or_provider_id.last_tested_at = tested_at
        if capability is not None:
            row_or_provider_id.last_test_capability = capability
    else:
        provider_id = (
            row_or_provider_id.id
            if isinstance(row_or_provider_id, AIProviderConfig)
            else row_or_provider_id
        )
        updated = (
            db.query(AIProviderConfig)
            .filter(
                AIProviderConfig.id == provider_id,
                AIProviderConfig.incarnation_id
                == expected_incarnation_id,
                AIProviderConfig.config_version
                == expected_config_version,
            )
            .update(
                {
                    AIProviderConfig.last_test_status: result_status,
                    AIProviderConfig.last_test_message: message,
                    AIProviderConfig.last_tested_at: tested_at,
                    AIProviderConfig.last_test_capability: capability,
                },
                synchronize_session=False,
            )
        )
        if updated != 1:
            db.rollback()
            return False
    try:
        db.commit()
    except Exception:
        db.rollback()
        raise
    return True


def _connection_payload(capability: str) -> dict:
    prompt = (
        "Reply with OK"
        if capability == "text"
        else "Generate a 1×1 image"
    )
    payload = {
        "contents": [
            {
                "role": "user",
                "parts": [{"text": prompt}],
            }
        ]
    }
    if capability == "image":
        payload["generationConfig"] = {
            "responseModalities": ["IMAGE"],
            "imageConfig": {"aspectRatio": "1:1"},
        }
    return payload


def _format_provider_diagnostic(
    diagnostic,
    safe_diagnostic: dict,
) -> str:
    parts = [
        str(AIProviderRequestError(diagnostic.category, diagnostic)),
    ]
    if safe_diagnostic.get("http_status") is not None:
        parts.append(f"HTTP {safe_diagnostic['http_status']}")
    if safe_diagnostic.get("provider_code"):
        parts.append(f"code={safe_diagnostic['provider_code']}")
    if safe_diagnostic.get("exception_type"):
        parts.append(f"type={safe_diagnostic['exception_type']}")
    if safe_diagnostic.get("request_id"):
        parts.append(f"request_id={safe_diagnostic['request_id']}")
    if safe_diagnostic.get("upstream_message"):
        parts.append(f"upstream={safe_diagnostic['upstream_message']}")
    return " | ".join(parts)


def _connection_response_supports(
    capability: str,
    response: dict,
) -> bool:
    if not isinstance(response, dict):
        return False
    for candidate in response.get("candidates") or []:
        if not isinstance(candidate, dict):
            continue
        content = candidate.get("content") or {}
        if not isinstance(content, dict):
            continue
        for part in content.get("parts") or []:
            if not isinstance(part, dict):
                continue
            if capability == "text":
                text_value = part.get("text")
                if isinstance(text_value, str) and text_value.strip():
                    return True
                continue
            inline_data = (
                part.get("inlineData")
                or part.get("inline_data")
                or {}
            )
            if not isinstance(inline_data, dict):
                continue
            mime_type = (
                inline_data.get("mimeType")
                or inline_data.get("mime_type")
                or ""
            )
            data = inline_data.get("data")
            if _verified_image_matches_mime(data, mime_type):
                return True
    return False


def _verified_image_matches_mime(data, mime_type) -> bool:
    try:
        validate_image_payload(
            data,
            mime_type,
            max_bytes=MAX_CONNECTION_IMAGE_BYTES,
            max_dimension=MAX_CONNECTION_IMAGE_DIMENSION,
            max_pixels=MAX_CONNECTION_IMAGE_PIXELS,
        )
    except ValueError:
        return False
    return True


async def _run_ai_provider_connection_test(
    data: ProviderConnectionTest,
    db: Session,
):
    persisted_result_context = None
    try:
        snapshot, persisted_result_context, validation_message = (
            _connection_test_snapshot(data, db)
        )
    except ValueError as exc:
        snapshot = None
        validation_message = str(exc)
    if persisted_result_context is not None:
        db.rollback()
    started = time.monotonic()
    result_status = "success"
    message = "连接成功"
    provider_diagnostic = None
    app_logs.emit(
        level="info",
        source="system",
        message="AI 连接测试开始",
        capability=data.capability,
        provider=snapshot.name if snapshot else None,
        model=snapshot.model if snapshot else None,
    )

    if validation_message is not None:
        result_status = "error"
        message = validation_message
    else:
        try:
            adapter = get_adapter(snapshot.protocol)
            provider_response = await adapter.generate(
                snapshot,
                _connection_payload(data.capability),
            )
            if not _connection_response_supports(
                data.capability,
                provider_response,
            ):
                result_status = "error"
                message = (
                    "不支持文本生成"
                    if data.capability == "text"
                    else "不支持图片生成"
                )
        except Exception as exc:
            diagnostic = diagnose_provider_error(
                exc,
                sensitive_values=(
                    snapshot.api_key,
                    snapshot.vertex_key_path,
                ),
            )
            provider_diagnostic = AppLogService.sanitize(
                diagnostic.as_log_dict()
            )
            result_status = "error"
            message = _format_provider_diagnostic(
                diagnostic,
                provider_diagnostic,
            )

    duration_ms = round((time.monotonic() - started) * 1000)
    if persisted_result_context is not None:
        (
            provider_id,
            tested_incarnation_id,
            tested_config_version,
        ) = (
            persisted_result_context
        )
        result_saved = _save_connection_test_result(
            db,
            provider_id,
            result_status,
            message,
            expected_incarnation_id=tested_incarnation_id,
            expected_config_version=tested_config_version,
            capability=data.capability,
        )
        if not result_saved:
            result_status = "error"
            message = "配置已变更，请重新测试"
    completion_log_message = "AI 连接测试完成"
    if provider_diagnostic is not None:
        completion_log_message = {
            "summary": completion_log_message,
            "diagnostic": provider_diagnostic,
        }
    app_logs.emit(
        level="success" if result_status == "success" else "error",
        source="system",
        message=completion_log_message,
        capability=data.capability,
        provider=snapshot.name if snapshot else None,
        model=snapshot.model if snapshot else None,
        duration_ms=duration_ms,
    )
    return {
        "status": result_status,
        "capability": data.capability,
        "duration_ms": duration_ms,
        "message": message,
    }


@app.post(
    "/api/settings/ai/providers/test",
    response_model=ProviderConnectionTestResult,
)
async def api_test_ai_provider(
    data: ProviderConnectionTest,
    db: Session = Depends(get_db),
):
    return await _run_ai_provider_connection_test(data, db)


@app.post(
    "/api/settings/ai/providers/{provider_id}/test",
    response_model=ProviderConnectionTestResult,
)
async def api_test_saved_ai_provider(
    provider_id: int,
    data: SavedProviderConnectionTest,
    db: Session = Depends(get_db),
):
    return await _run_ai_provider_connection_test(
        ProviderConnectionTest(
            provider_id=provider_id,
            capability=data.capability,
        ),
        db,
    )


@app.get("/api/settings/logs/recent")
def api_recent_logs():
    return {"items": app_logs.recent()}


def _settings_log_cursor(
    request: Request,
    after_id: str | None,
) -> tuple[str | None, int]:
    raw_cursor = (
        after_id
        if after_id is not None
        else getattr(request, "headers", {}).get("last-event-id")
    )
    if not isinstance(raw_cursor, str) or ":" not in raw_cursor:
        return None, 0
    session_id, raw_sequence = raw_cursor.rsplit(":", 1)
    try:
        sequence_id = int(raw_sequence)
    except (TypeError, ValueError):
        return None, 0
    if not session_id or sequence_id < 0:
        return None, 0
    return session_id, sequence_id


def _settings_log_sse_frame(entry: dict) -> str:
    return (
        f"id: {entry['session_id']}:{entry['id']}\n"
        "data: "
        f"{json.dumps(entry, ensure_ascii=False)}\n\n"
    )


@app.get("/api/settings/logs/stream")
async def api_stream_logs(
    request: Request,
    after_id: str | None = None,
):
    cursor_session, cursor_sequence = _settings_log_cursor(
        request,
        after_id,
    )

    async def events():
        queue = app_logs.subscribe()
        last_session, last_sent_id = app_logs.normalize_cursor(
            cursor_session,
            cursor_sequence,
        )
        try:
            for entry in app_logs.recent_after(
                last_session,
                last_sent_id,
            ):
                if await request.is_disconnected():
                    return
                if (
                    entry["session_id"] == last_session
                    and entry["id"] <= last_sent_id
                ):
                    continue
                last_session = entry["session_id"]
                last_sent_id = entry["id"]
                yield _settings_log_sse_frame(entry)

            while not await request.is_disconnected():
                try:
                    entry = await asyncio.wait_for(
                        queue.get(),
                        timeout=15,
                    )
                    if entry is APP_LOG_OVERFLOW:
                        replay = app_logs.recent_after(
                            last_session,
                            last_sent_id,
                            subscriber_queue=queue,
                        )
                        for replay_entry in replay:
                            if (
                                replay_entry["session_id"]
                                == last_session
                                and replay_entry["id"]
                                <= last_sent_id
                            ):
                                continue
                            last_session = replay_entry["session_id"]
                            last_sent_id = replay_entry["id"]
                            yield _settings_log_sse_frame(replay_entry)
                        continue
                    if (
                        entry["session_id"] == last_session
                        and entry["id"] <= last_sent_id
                    ):
                        continue
                    last_session = entry["session_id"]
                    last_sent_id = entry["id"]
                    yield _settings_log_sse_frame(entry)
                except asyncio.TimeoutError:
                    yield ": keep-alive\n\n"
        finally:
            app_logs.unsubscribe(queue)

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )

def serialize_public_snapshot(snapshot: ProviderSnapshot) -> dict:
    return {
        "capability": snapshot.capability,
        "name": snapshot.name,
        "protocol": snapshot.protocol,
        "model": snapshot.model,
    }


def get_public_route(db: Session, capability: str) -> dict:
    try:
        return serialize_public_snapshot(get_snapshot(db, capability))
    except ValueError:
        return {
            "capability": capability,
            "name": None,
            "protocol": None,
            "model": None,
        }


@app.get("/config")
async def get_frontend_config(db: Session = Depends(get_db)):
    return {
        "TEXT_ROUTE": get_public_route(db, "text"),
        "IMAGE_ROUTE": get_public_route(db, "image"),
        "CONCURRENCY_LIMIT": FRONTEND_CONCURRENCY_LIMIT,
        "STAGGER_DELAY": FRONTEND_STAGGER_DELAY,
    }


@app.post("/api/square-redraw/batches")
async def api_square_redraw_create(request: SquareRedrawBatchRequest, db: Session = Depends(get_db)):
    try:
        batch = create_square_redraw_batch(db, request)
        data = serialize_square_redraw_batch(db, batch.id)
        return {"status": "success", "data": data}
    except Exception as e:
        logger.error(f"❌ [方图重绘] 创建批次失败: {e}")
        return {"status": "error", "message": str(e)}


@app.get("/api/square-redraw/batches/{batch_id}")
async def api_square_redraw_get(batch_id: int, db: Session = Depends(get_db)):
    try:
        return {"status": "success", "data": serialize_square_redraw_batch(db, batch_id)}
    except Exception as e:
        return {"status": "error", "message": str(e)}


@app.post("/api/square-redraw/batches/{batch_id}/retry-failed")
async def api_square_redraw_retry_failed(batch_id: int, db: Session = Depends(get_db)):
    try:
        retry_failed_square_redraw_items(db, batch_id)
        return {"status": "success", "data": serialize_square_redraw_batch(db, batch_id)}
    except Exception as e:
        logger.error(f"❌ [方图重绘] 重跑失败项失败: {e}")
        return {"status": "error", "message": str(e)}


@app.post("/api/square-redraw/batches/{batch_id}/items/{item_id}/process")
async def api_square_redraw_process_item(batch_id: int, item_id: int, db: Session = Depends(get_db)):
    try:
        await process_square_redraw_item(item_id)
        db.expire_all()
        return {"status": "success", "data": serialize_square_redraw_batch(db, batch_id)}
    except Exception as e:
        logger.error(f"❌ [方图重绘] 单图处理失败: {e}")
        return {"status": "error", "message": str(e)}


@app.delete("/api/square-redraw/batches/{batch_id}/items/{item_id}")
async def api_square_redraw_delete_item(batch_id: int, item_id: int, db: Session = Depends(get_db)):
    try:
        delete_square_redraw_item(db, batch_id, item_id)
        return {"status": "success", "data": serialize_square_redraw_batch(db, batch_id)}
    except Exception as e:
        logger.error(f"❌ [方图重绘] 删除图片失败: {e}")
        return {"status": "error", "message": str(e)}


@app.get("/api/square-redraw/batches/{batch_id}/download")
async def api_square_redraw_download(batch_id: int, db: Session = Depends(get_db)):
    from fastapi.responses import FileResponse

    try:
        zip_path = build_square_redraw_zip(db, batch_id)
        return FileResponse(
            zip_path,
            media_type="application/zip",
            filename=f"square-redraw-{batch_id}.zip",
        )
    except Exception as e:
        logger.error(f"❌ [方图重绘] 打包下载失败: {e}")
        return {"status": "error", "message": str(e)}


@app.post("/api/history/{module}")
async def save_history(module: str, data: dict, db: Session = Depends(get_db)):
    try:
        init_db() 
        if module == "listing":
            hist = ListingHistory(product_name=data.get("name"), platform=data.get("platform"), result=data.get("result"))
        elif module == "translation":
            res_data = data.get("result")
            if isinstance(res_data, str) and res_data.startswith("data:image"):
                data["result"] = save_base64_image(res_data, "outputs")
            hist = TranslationHistory(source_text=data.get("source_text"), target_lang=data.get("target_lang"), result=data.get("result"))
        elif module == "text-translation":
            res_val = data.get("result")
            # 如果是批量结果（字典），转为 JSON 字符串存储
            if isinstance(res_val, dict):
                res_val = json.dumps(res_val, ensure_ascii=False)
            hist = TextTranslationHistory(source_text=data.get("source_text"), target_lang=data.get("target_lang"), result=res_val)
        elif module == "ads":
            img_data = data.get("image_data")
            image_url = save_base64_image(img_data, "outputs") if img_data else None
            platforms = data.get("platforms") or []
            if isinstance(platforms, list):
                platforms = ", ".join(platforms)
            hist = AdsHistory(
                product_name=data.get("product_name"),
                platforms=platforms,
                region=data.get("region"),
                target_lang=data.get("target_lang"),
                marketing_theme=data.get("marketing_theme"),
                image_url=image_url,
                result=data.get("result"),
            )
        elif module == "render":
            img_data = data.get("image")
            if img_data: data["image"] = save_base64_image(img_data, "outputs")
            metadata = persist_render_metadata_images(data.get("metadata"))
            if isinstance(metadata, dict) and data.get("image"):
                metadata["finalImage"] = data.get("image")
            hist = RenderHistory(task_name=data.get("name"), style=data.get("style"), image_base64=data.get("image"), metadata_info=metadata)
        elif module == "analysis":
            hist = AnalysisHistory(query_url=data.get("url"), template_type=data.get("type"), data=data.get("data"))
        elif module == "square-redraw":
            result = data.get("result") or {}
            hist = SquareRedrawHistory(
                batch_id=data.get("batch_id") or result.get("id"),
                target_aspect_ratio=data.get("target_aspect_ratio") or result.get("target_aspect_ratio") or "1:1",
                result=result,
            )
        else:
            app_logs.emit(
                level="error",
                source="history",
                message="历史记录保存失败",
            )
            return {"status": "error"}
        
        db.add(hist)
        db.commit()
        app_logs.emit(
            level="success",
            source="history",
            message="历史记录保存成功",
        )
        return {"status": "success", "id": hist.id}
    except Exception as e:
        logger.error(f"❌ [历史] 失败: {e}")
        db.rollback()
        app_logs.emit(
            level="error",
            source="history",
            message="历史记录保存失败",
        )
        return {"status": "error"}

@app.get("/api/history/{module}")
async def get_history(module: str, db: Session = Depends(get_db)):
    mapping = {"analysis": AnalysisHistory, "listing": ListingHistory, "translation": TranslationHistory, "text-translation": TextTranslationHistory, "ads": AdsHistory, "render": RenderHistory, "square-redraw": SquareRedrawHistory}
    model = mapping.get(module)
    if not model: return []
    return db.query(model).order_by(model.timestamp.desc()).all()

@app.delete("/api/history/{module}/{id}")
async def delete_history(module: str, id: int, db: Session = Depends(get_db)):
    mapping = {"analysis": AnalysisHistory, "listing": ListingHistory, "translation": TranslationHistory, "text-translation": TextTranslationHistory, "ads": AdsHistory, "render": RenderHistory, "square-redraw": SquareRedrawHistory}
    model = mapping.get(module)
    if not model:
        app_logs.emit(
            level="error",
            source="history",
            message="历史记录删除失败",
        )
        return {"status": "error"}
    try:
        item = db.query(model).filter(model.id == id).first()
        if item:
            db.delete(item)
            db.commit()
        app_logs.emit(
            level="success",
            source="history",
            message="历史记录删除成功",
        )
        return {"status": "success"}
    except Exception:
        db.rollback()
        app_logs.emit(
            level="error",
            source="history",
            message="历史记录删除失败",
        )
        return {"status": "error"}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
