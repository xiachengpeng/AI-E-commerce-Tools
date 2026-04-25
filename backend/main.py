from fastapi import FastAPI, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
import base64
import uuid
import json
import logging
import asyncio
import os
from typing import List, Union, Any, Optional
from sqlalchemy.orm import Session
from dotenv import load_dotenv

from models.request import (
    CompareRequest, CompareResponse, CompareResponseData, ProductCompareData,
    ComparisonSummary, ScoreCard, EvalDetail, RecItem,
    TranslationRequest
)
from services.firecrawl import fetch_markdown
from services.cleaner import clean_content, check_block
from services.amazon_parser import parse_amazon, parse_general, is_amazon
from services.ai_single import analyze_single_extract, analyze_single_deep
from services.ai_compare import compare_products
from services.scoring import calculate_score
from services.ai_service import AIService
from config import GEMINI_API_KEY, AI_PROVIDER, VERTEX_PROJECT_ID, VERTEX_LOCATION, FRONTEND_CONCURRENCY_LIMIT, FRONTEND_STAGGER_DELAY
from db import init_db, get_db, SessionLocal, AnalysisHistory, ListingHistory, TranslationHistory, TextTranslationHistory, RenderHistory

# 加载配置
load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), ".env"), override=False)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# 初始化数据库
init_db()

app = FastAPI(title="AI Competitor Analyzer V2")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

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

async def process_single_url(url: str, provider: str = None, markdown_content: str = None) -> dict:
    try:
        logger.info(f"🔍 [单品处理] 开始处理 URL: {url}")
        if not markdown_content:
            markdown_content = await asyncio.to_thread(fetch_markdown, url)
        cleaned_text = clean_content(markdown_content)
        if not cleaned_text:
            raise Exception("内容为空")
        if check_block(markdown_content):
            raise Exception("被拦截")
            
        if is_amazon(url):
            structured_data = parse_amazon(markdown_content)
        else:
            structured_data = parse_general(markdown_content)
        
        ai_result_json_str = await asyncio.to_thread(analyze_single_extract, structured_data, provider=provider)
        parsed_data = json.loads(ai_result_json_str)
        
        p_data = structured_data.get("product_data", {})
        if not parsed_data.get("price") and p_data.get("price"): parsed_data["price"] = p_data["price"]
        if not parsed_data.get("reviews_count"): parsed_data["reviews_count"] = p_data.get("reviews_count", "0")

        return ProductCompareData(**parsed_data).model_dump()
    except Exception as e:
        logger.error(f"❌ [单品处理] 出错: {e}")
        raise e

async def process_single_url_deep(url: str, provider: str = None, markdown_content: str = None) -> dict:
    try:
        if not markdown_content:
            markdown_content = await asyncio.to_thread(fetch_markdown, url)
        if is_amazon(url):
            structured_data = parse_amazon(markdown_content)
        else:
            structured_data = parse_general(markdown_content)
            
        ai_result_json_str = await asyncio.to_thread(analyze_single_deep, structured_data, provider=provider)
        return json.loads(ai_result_json_str)
    except Exception as e:
        logger.error(f"❌ [深度分析] 出错: {e}")
        raise e

# --- 缓存 ---
analysis_cache = {}

@app.post("/compare", response_model=CompareResponse)
async def compare(request: CompareRequest):
    try:
        urls = request.urls
        provider = request.ai_provider
        unique_urls = list(dict.fromkeys([u.strip() for u in urls if u.strip()]))
        cache_key = f"{';'.join(sorted(unique_urls))}_{provider}"
        
        if cache_key in analysis_cache:
            cached_time, cached_res = analysis_cache[cache_key]
            if asyncio.get_event_loop().time() - cached_time < 30:
                return cached_res
        
        if len(unique_urls) == 1:
            url = unique_urls[0]
            markdown_content = await asyncio.to_thread(fetch_markdown, url)
            basic_data = await process_single_url(url, provider=provider, markdown_content=markdown_content)
            score_res = await asyncio.to_thread(calculate_score, basic_data, provider=provider)
            
            # 补全 ScoreCard 所需字段
            if not score_res.get("decision_details"):
                score_res["decision_details"] = {"confidence": "medium", "reason": ""}
            score_res.setdefault("opportunity_score", 0)
            score_res.setdefault("difficulty_score", 0)
            score_res.setdefault("final_decision", "Pending")
            score_res.setdefault("product", basic_data.get("product_name", "Product"))
            
            scores = [ScoreCard(**score_res)]
            single_data = await process_single_url_deep(url, provider=provider, markdown_content=markdown_content)
            response_data = CompareResponseData(single_data=single_data, scores=scores)
            template_type = "single"
            msg = "分析完成"
        else:
            tasks = [process_single_url(url, provider=provider) for url in unique_urls]
            results = await asyncio.gather(*tasks, return_exceptions=True)
            valid_products = [r for r in results if not isinstance(r, Exception)]
            if not valid_products:
                return CompareResponse(status="error", message="处理失败")
            
            comp_result = await asyncio.to_thread(compare_products, valid_products, provider=provider)
            comparison_data = ComparisonSummary(**{k: comp_result.get(k, "") for k in ["market_position", "competition_level", "winner_product"]})
            
            score_tasks = [asyncio.to_thread(calculate_score, p, provider=provider) for p in valid_products]
            score_results = await asyncio.gather(*score_tasks, return_exceptions=True)
            scores = []
            for s_res in score_results:
                if not isinstance(s_res, Exception) and s_res:
                    s_res.setdefault("product", "N/A")
                    s_res.setdefault("opportunity_score", 0)
                    s_res.setdefault("difficulty_score", 0)
                    s_res.setdefault("final_decision", "Pending")
                    if "decision_details" not in s_res: s_res["decision_details"] = {"confidence": "medium", "reason": ""}
                    scores.append(ScoreCard(**s_res))
            
            template_type = "matrix"
            msg = f"分析了 {len(valid_products)} 个产品"
            response_data = CompareResponseData(
                products=[ProductCompareData(**p) for p in valid_products],
                comparison=comparison_data,
                comprehensive_evaluation=[EvalDetail(**e) for e in comp_result.get("comprehensive_evaluation", [])],
                recommendation_list=[RecItem(**r) for r in comp_result.get("recommendation_list", [])],
                scores=scores
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
        analysis_cache[cache_key] = (asyncio.get_event_loop().time(), final_res)
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
        
        # 调用 AI 批量翻译
        result_dict = await asyncio.to_thread(
            AIService.translate_text_batch, 
            text=request.text, 
            target_langs=langs, 
            provider=request.ai_provider
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

@app.post("/log")
async def receive_frontend_log(data: dict):
    message = data.get("message", "")
    if message: logger.info(f"🖥️ [前端] {message}")
    return {"status": "ok"}

@app.get("/config")
async def get_frontend_config():
    config = {
        "AI_PROVIDER": AI_PROVIDER,
        "API_KEY": os.getenv("FRONTEND_API_KEY", ""),
        "TEXT_MODEL": os.getenv("FRONTEND_TEXT_MODEL", "gemini-3.1-flash-preview"),
        "IMAGE_MODEL": os.getenv("FRONTEND_IMAGE_MODEL", "gemini-3.1-flash-image-preview"),
        "CONCURRENCY_LIMIT": FRONTEND_CONCURRENCY_LIMIT,
        "STAGGER_DELAY": FRONTEND_STAGGER_DELAY,
    }
    if AI_PROVIDER == "vertex":
        try:
            config["ACCESS_TOKEN"] = AIService._get_vertex_token()
            config["PROJECT_ID"] = VERTEX_PROJECT_ID
            config["LOCATION"] = VERTEX_LOCATION
        except: pass
    return config

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
        elif module == "render":
            img_data = data.get("image")
            if img_data: data["image"] = save_base64_image(img_data, "outputs")
            hist = RenderHistory(task_name=data.get("name"), style=data.get("style"), image_base64=data.get("image"), metadata_info=data.get("metadata"))
        elif module == "analysis":
            hist = AnalysisHistory(query_url=data.get("url"), template_type=data.get("type"), data=data.get("data"))
        else: return {"status": "error"}
        
        db.add(hist)
        db.commit()
        return {"status": "success", "id": hist.id}
    except Exception as e:
        logger.error(f"❌ [历史] 失败: {e}")
        return {"status": "error"}

@app.get("/api/history/{module}")
async def get_history(module: str, db: Session = Depends(get_db)):
    mapping = {"analysis": AnalysisHistory, "listing": ListingHistory, "translation": TranslationHistory, "text-translation": TextTranslationHistory, "render": RenderHistory}
    model = mapping.get(module)
    if not model: return []
    return db.query(model).order_by(model.timestamp.desc()).all()

@app.delete("/api/history/{module}/{id}")
async def delete_history(module: str, id: int, db: Session = Depends(get_db)):
    mapping = {"analysis": AnalysisHistory, "listing": ListingHistory, "translation": TranslationHistory, "text-translation": TextTranslationHistory, "render": RenderHistory}
    model = mapping.get(module)
    if not model: return {"status": "error"}
    item = db.query(model).filter(model.id == id).first()
    if item:
        db.delete(item)
        db.commit()
    return {"status": "success"}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
