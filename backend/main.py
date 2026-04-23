from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from models.request import (
    CompareRequest, CompareResponse, CompareResponseData, ProductCompareData,
    ComparisonSummary, ScoreCard, EvalDetail, RecItem
)
from services.firecrawl import fetch_markdown
from services.cleaner import clean_content
from services.amazon_parser import parse_amazon, parse_general, is_amazon
from services.ai_single import analyze_single_extract, analyze_single_deep
from services.ai_compare import compare_products
from services.scoring import calculate_score

import json
import logging
import asyncio
from config import GEMINI_API_KEY
import os
from dotenv import load_dotenv

from db import init_db, get_db, AnalysisHistory, ListingHistory, TranslationHistory, RenderHistory
from sqlalchemy.orm import Session
from fastapi import Depends

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

async def process_single_url(url: str, provider: str = None) -> dict:
    try:
        logger.info(f"🔍 [单品处理] 开始处理 URL: {url} (提供商: {provider})")
        markdown_content = await asyncio.to_thread(fetch_markdown, url)
        logger.info(f"✅ [单品处理] 成功获取 Markdown 内容: {url}")
        cleaned_text = clean_content(markdown_content)
        if not cleaned_text:
            raise Exception("抓取到的内容为空或无效")
        logger.info(f"🏗️ [单品处理] 正在解析页面结构: {url}...")
        if is_amazon(url):
            structured_data = parse_amazon(markdown_content)
        else:
            structured_data = parse_general(markdown_content)
        
        logger.info(f"🤖 [单品处理] 正在发送至 AI 进行特征提取 ({url})...")
        ai_result_json_str = await asyncio.to_thread(analyze_single_extract, structured_data, provider=provider)
        
        try:
            parsed_data = json.loads(ai_result_json_str)
        except json.JSONDecodeError as e:
            logger.error(f"JSON parsing failed for {url}. Error: {e}")
            cleaned_json = ai_result_json_str.replace('\n', ' ').strip()
            parsed_data = json.loads(cleaned_json)

        p_data = structured_data.get("product_data", {})
        if parsed_data.get("price") in [None, "", "Unknown"] and p_data.get("price"):
             parsed_data["price"] = p_data["price"]
        
        if not parsed_data.get("reviews_count") and p_data.get("reviews_count"):
            parsed_data["reviews_count"] = p_data.get("reviews_count")
        elif not parsed_data.get("reviews_count"):
             parsed_data["reviews_count"] = "0"

        validated_product = ProductCompareData(**parsed_data)
        logger.info(f"✨ [单品处理] 特征提取完成: {url}")
        return validated_product.model_dump()
    except Exception as e:
        logger.error(f"❌ [单品处理] 处理 URL 出错 {url}: {str(e)}")
        raise e

async def process_single_url_deep(url: str, provider: str = None) -> dict:
    try:
        logger.info(f"🧠 [深度分析] 开始深度分析 URL: {url} (提供商: {provider})")
        markdown_content = await asyncio.to_thread(fetch_markdown, url)
        cleaned_text = clean_content(markdown_content)
        if not cleaned_text:
            raise Exception("抓取到的内容为空或无效")
        if is_amazon(url):
            structured_data = parse_amazon(markdown_content)
        else:
            structured_data = parse_general(markdown_content)
            
        ai_result_json_str = await asyncio.to_thread(analyze_single_deep, structured_data, provider=provider)
        
        try:
            parsed_data = json.loads(ai_result_json_str)
        except json.JSONDecodeError as e:
            logger.error(f"JSON parsing failed (DEEP) for {url}. Error: {e}")
            raise e

        p_data = structured_data.get("product_data", {})
        if parsed_data.get("price") in [None, "", "Unknown"] and p_data.get("price"):
            parsed_data["price"] = p_data["price"]
        
        if not parsed_data.get("reviews_count") and p_data.get("reviews_count"):
            parsed_data["reviews_count"] = p_data["reviews_count"]
        elif not parsed_data.get("reviews_count"):
             parsed_data["reviews_count"] = "0"

        return parsed_data
    except Exception as e:
        logger.error(f"Error in deep single analysis for URL {url}: {str(e)}")
        raise e

# --- 全局请求防重缓存 ---
analysis_cache = {}

@app.post("/compare", response_model=CompareResponse)
async def compare(request: CompareRequest):
    try:
        urls = request.urls
        provider = request.ai_provider
        if not urls:
             return CompareResponse(status="error", message="未提供 URL。")

        # --- 防重逻辑 ---
        import time
        unique_urls = list(dict.fromkeys([u.strip() for u in urls if u.strip()]))
        cache_key = f"{';'.join(sorted(unique_urls))}_{provider}"
        now = time.time()
        if cache_key in analysis_cache:
            cached_time, cached_res = analysis_cache[cache_key]
            if now - cached_time < 30:
                logger.info(f"♻️ [防重] 检测到重复请求，返回缓存结果: {cache_key}")
                return cached_res
        
        logger.info(f"🚀 [竞品分析] 接收到 {len(urls)} 个链接: {urls} (提供商: {provider})")
        
        if len(unique_urls) == 1:
            logger.info(f"Single Unique URL detected → switching to Deep Single Analysis")
            try:
                basic_data = await process_single_url(unique_urls[0], provider=provider)
                
                score_res = await asyncio.to_thread(calculate_score, basic_data, provider=provider)
                
                scores = []
                if score_res and isinstance(score_res, dict):
                    if "decision_details" not in score_res:
                         score_res["decision_details"] = {
                             "confidence": score_res.get("confidence", "medium"), 
                             "reason": score_res.get("decision_reason", score_res.get("reason", ""))
                         }
                    if "opportunity_score" not in score_res: score_res["opportunity_score"] = 0
                    if "difficulty_score" not in score_res: score_res["difficulty_score"] = 0
                    if "final_decision" not in score_res: score_res["final_decision"] = "Pending ||| 待评估"
                    if "product" not in score_res: score_res["product"] = basic_data.get("product_name", "Product")
                    
                    scores = [ScoreCard(**score_res)]
                
                single_data = await process_single_url_deep(unique_urls[0], provider=provider)
                response_data = CompareResponseData(single_data=single_data, scores=scores)
                template_type = "single"
                msg = "单品分析完成。"
            except Exception as e:
                logger.error(f"❌ [竞品分析] 单品分析失败: {e}")
                return CompareResponse(status="error", message=f"URL 分析失败: {str(e)}")
        else:
            logger.info(f"📊 [竞品分析] 检测到多个链接 ({len(unique_urls)}) → 进入矩阵对比模式")
            tasks = [process_single_url(url, provider=provider) for url in unique_urls]
            results = await asyncio.gather(*tasks, return_exceptions=True)
            valid_products = []
            errors = []
            for i, res in enumerate(results):
                if isinstance(res, Exception):
                    errors.append(f"Failed on {urls[i]}: {str(res)}")
                else:
                    valid_products.append(res)
            if not valid_products:
                return CompareResponse(status="error", message=f"所有 URL 处理均失败。 错误信息: {'; '.join(errors)}")
            comparison_data = None
            comprehensive_evaluation = []
            recommendation_list = []
            if len(valid_products) > 1:
                comp_result = await asyncio.to_thread(compare_products, valid_products, provider=provider)
                comparison_data = ComparisonSummary(
                    market_position=comp_result.get("market_position", ""),
                    competition_level=comp_result.get("competition_level", ""),
                    winner_product=comp_result.get("winner_product", "")
                )
                for item in comp_result.get("comprehensive_evaluation", []):
                    comprehensive_evaluation.append(EvalDetail(dimension=str(item.get("dimension", "")), detail=str(item.get("detail", ""))))
                for item in comp_result.get("recommendation_list", []):
                    recommendation_list.append(RecItem(action=str(item.get("action", "")), content=str(item.get("content", ""))))
            score_tasks = [asyncio.to_thread(calculate_score, p, provider=provider) for p in valid_products]
            score_results = await asyncio.gather(*score_tasks, return_exceptions=True)
            scores = []
            for i, s_res in enumerate(score_results):
                if not isinstance(s_res, Exception):
                    if "decision_details" not in s_res:
                         s_res["decision_details"] = {"confidence": s_res.get("confidence", "medium"), "reason": s_res.get("decision_reason", "")}
                    scores.append(ScoreCard(**s_res))
            template_type = "matrix"
            msg = f"成功分析了 {len(valid_products)} 个产品。"
            response_data = CompareResponseData(
                products=[ProductCompareData(**p) for p in valid_products],
                comparison=comparison_data,
                comprehensive_evaluation=comprehensive_evaluation,
                recommendation_list=recommendation_list,
                scores=scores
            )

        db_session = None
        try:
            from db import SessionLocal
            db_session = SessionLocal()
            pure_json_data = json.loads(response_data.model_dump_json())
            new_hist = AnalysisHistory(query_url="; ".join(unique_urls), template_type=template_type, data=pure_json_data)
            db_session.add(new_hist)
            db_session.commit()
            logger.info(f"💾 [系统] 竞品分析历史已保存 (ID: {new_hist.id})")
        except Exception as db_err:
            logger.error(f"❌ [数据库] 保存历史记录失败: {str(db_err)}")
        finally:
            if db_session:
                db_session.close()

        final_res = CompareResponse(status="success", template_type=template_type, data=response_data, message=msg if 'msg' in locals() else "")
        
        # 写入防重缓存
        try:
            analysis_cache[cache_key] = (time.time(), final_res)
        except: pass

        return final_res

    except Exception as e:
        logger.error(f"Unexpected error in /compare: {str(e)}")
        return CompareResponse(status="error", message=f"An unexpected error occurred: {str(e)}")

@app.post("/log")
async def receive_frontend_log(data: dict):
    """接收来自前端的日志并打印到后端终端"""
    message = data.get("message", "")
    if message:
        logger.info(f"🖥️ [前端] {message}")
    return {"status": "ok"}

@app.get("/config")
async def get_frontend_config():
    """向前端提供配置信息（从 .env 读取）"""
    logger.info("⚙️ [系统] 正在读取前端配置下发...")
    from services.ai_service import AIService
    from config import AI_PROVIDER, VERTEX_PROJECT_ID, VERTEX_LOCATION, FRONTEND_CONCURRENCY_LIMIT, FRONTEND_STAGGER_DELAY
    
    config = {
        "AI_PROVIDER": AI_PROVIDER,
        "API_KEY":     os.getenv("FRONTEND_API_KEY", ""),
        "TEXT_MODEL":  os.getenv("FRONTEND_TEXT_MODEL", "gemini-3.1-flash-preview"),
        "IMAGE_MODEL": os.getenv("FRONTEND_IMAGE_MODEL", "gemini-3.1-flash-image-preview"),
        "CONCURRENCY_LIMIT": FRONTEND_CONCURRENCY_LIMIT,
        "STAGGER_DELAY": FRONTEND_STAGGER_DELAY,
    }
    
    # 如果是 vertex 模式，提供必要的鉴权信息
    if AI_PROVIDER == "vertex":
        try:
            config["ACCESS_TOKEN"] = AIService._get_vertex_token()
            config["PROJECT_ID"] = VERTEX_PROJECT_ID
            config["LOCATION"] = VERTEX_LOCATION
        except Exception as e:
            logger.error(f"❌ [系统] 获取 Vertex Token 失败: {e}")
            
    logger.info(f"📡 [系统] 配置已成功下发 (Provider: {config['AI_PROVIDER']})")
    return config

# --- 历史记录通用 API ---

@app.post("/api/save_history/{module}")
async def save_history(module: str, data: dict, db: Session = Depends(get_db)):
    try:
        if module == "listing":
            hist = ListingHistory(product_name=data.get("name"), platform=data.get("platform"), result=data.get("result"))
        elif module == "translation":
            hist = TranslationHistory(source_text=data.get("text"), target_lang=data.get("lang"), result=data.get("result"))
        elif module == "render":
            hist = RenderHistory(task_name=data.get("name"), style=data.get("style"), image_base64=data.get("image"), metadata_info=data.get("metadata"))
        elif module == "analysis": # 手动保存入口（如果需要）
            hist = AnalysisHistory(query_url=data.get("url"), template_type=data.get("type"), data=data.get("data"))
        else:
            return {"status": "error", "message": "Unknown module"}
        
        db.add(hist)
        db.commit()
        return {"status": "success", "id": hist.id}
    except Exception as e:
        logger.error(f"Error saving history for {module}: {e}")
        return {"status": "error", "message": str(e)}

@app.get("/api/history/{module}")
async def get_history(module: str, db: Session = Depends(get_db)):
    try:
        if module == "analysis":
            res = db.query(AnalysisHistory).order_by(AnalysisHistory.timestamp.desc()).all()
        elif module == "listing":
            res = db.query(ListingHistory).order_by(ListingHistory.timestamp.desc()).all()
        elif module == "translation":
            res = db.query(TranslationHistory).order_by(TranslationHistory.timestamp.desc()).all()
        elif module == "render":
            res = db.query(RenderHistory).order_by(RenderHistory.timestamp.desc()).all()
        else:
            return []
        return res
    except Exception as e:
        logger.error(f"Error fetching history for {module}: {e}")
        return []

@app.delete("/api/history/{module}/{id}")
async def delete_history(module: str, id: int, db: Session = Depends(get_db)):
    try:
        model = {
            "analysis": AnalysisHistory,
            "listing": ListingHistory,
            "translation": TranslationHistory,
            "render": RenderHistory
        }.get(module)
        if not model: return {"status": "error"}
        
        item = db.query(model).filter(model.id == id).first()
        if item:
            db.delete(item)
            db.commit()
        return {"status": "success"}
    except Exception as e:
        return {"status": "error", "message": str(e)}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
