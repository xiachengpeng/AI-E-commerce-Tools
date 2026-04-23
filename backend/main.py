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

load_dotenv(dotenv_path=os.path.join(os.path.dirname(__file__), ".env"), override=False)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

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

@app.post("/compare", response_model=CompareResponse)
async def compare(request: CompareRequest):
    try:
        urls = request.urls
        provider = request.ai_provider
        if not urls:
             return CompareResponse(status="error", message="未提供 URL。")
             
        logger.info(f"🚀 [竞品分析] 接收到 {len(urls)} 个链接: {urls} (提供商: {provider})")

        unique_urls = list(dict.fromkeys([u.strip() for u in urls if u.strip()]))
        
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
                    
                    try:
                        scores = [ScoreCard(**score_res)]
                        logger.info(f"📋 [竞品分析] 评分生成成功: {score_res.get('opportunity_score')}")
                    except Exception as ve:
                        logger.error(f"ScoreCard validation failed for single product: {ve}")
                
                single_data = await process_single_url_deep(unique_urls[0], provider=provider)
                
                response_data = CompareResponseData(single_data=single_data, scores=scores)
                return CompareResponse(status="success", template_type="single", data=response_data)
            except Exception as e:
                logger.error(f"❌ [竞品分析] 单品分析失败: {e}")
                return CompareResponse(status="error", message=f"URL 分析失败: {str(e)}")

        logger.info(f"📊 [竞品分析] 检测到多个链接 ({len(unique_urls)}) → 进入矩阵对比模式")
        tasks = [process_single_url(url, provider=provider) for url in unique_urls]
        results = await asyncio.gather(*tasks, return_exceptions=True)

        valid_products = []
        errors = []
        for i, res in enumerate(results):
            if isinstance(res, Exception):
                logger.error(f"Failed on URL {urls[i]}: {res}")
                errors.append(f"Failed on {urls[i]}: {str(res)}")
            else:
                valid_products.append(res)
                
        if not valid_products:
            return CompareResponse(status="error", message=f"所有 URL 处理均失败。 错误信息: {'; '.join(errors)}")

        comparison_data = None
        comprehensive_evaluation = []
        recommendation_list = []
        
        if len(valid_products) > 1:
            logger.info("⚔️ [竞品分析] 多产品检测成功，正在运行对比 AI...")
            try:
                comp_result = await asyncio.to_thread(compare_products, valid_products, provider=provider)
                
                if not isinstance(comp_result, dict):
                    logger.error(f"Compare AI returned invalid type: {type(comp_result)}")
                    comp_result = {}

                comparison_data = ComparisonSummary(
                    market_position=comp_result.get("market_position", ""),
                    competition_level=comp_result.get("competition_level", ""),
                    winner_product=comp_result.get("winner_product", "")
                )
                for item in comp_result.get("comprehensive_evaluation", []):
                    if isinstance(item, dict):
                        comprehensive_evaluation.append(EvalDetail(
                            dimension=str(item.get("dimension", "")),
                            detail=str(item.get("detail", ""))
                        ))
                for item in comp_result.get("recommendation_list", []):
                    if isinstance(item, dict):
                        recommendation_list.append(RecItem(
                            action=str(item.get("action", "")),
                            content=str(item.get("content", ""))
                        ))
            except Exception as e:
                logger.error(f"❌ [竞品分析] 对比 AI 运行失败: {e}")

        logger.info("⚖️ [竞品分析] 正在运行评分 AI...")
        score_tasks = [asyncio.to_thread(calculate_score, p, provider=provider) for p in valid_products]
        score_results = await asyncio.gather(*score_tasks, return_exceptions=True)
        
        scores = []
        for i, s_res in enumerate(score_results):
            if isinstance(s_res, Exception):
                logger.error(f"Scoring AI failed for product index {i}: {s_res}")
            else:
                try:
                    if not s_res.get("product"):
                        s_res["product"] = valid_products[i].get("product_name", f"Product {i+1}")
                    
                    if "decision_details" not in s_res:
                         s_res["decision_details"] = {
                             "confidence": s_res.get("confidence", "medium"),
                             "reason": s_res.get("decision_reason", "")
                         }
                    
                    if "opportunity_score" not in s_res: s_res["opportunity_score"] = 0
                    if "difficulty_score" not in s_res: s_res["difficulty_score"] = 0
                    if "final_decision" not in s_res: s_res["final_decision"] = "Pending ||| 待评估"

                    scores.append(ScoreCard(**s_res))
                except Exception as eval_err:
                     logger.error(f"❌ [竞品分析] 评分输出格式无效: {eval_err}")
        
        msg = f"成功分析了 {len(valid_products)} 个产品。"
        if errors:
            msg += f" {len(errors)} failed: " + "; ".join(errors[:2])
            
        template_type = "matrix" if len(request.urls) > 1 else "single"
        
        if len(valid_products) == 0:
             template_type = "matrix"
        
        response_data = CompareResponseData(
            products=[ProductCompareData(**p) for p in valid_products],
            comparison=comparison_data,
            comprehensive_evaluation=comprehensive_evaluation,
            recommendation_list=recommendation_list,
            scores=scores,
            single_data=None
        )
        
        return CompareResponse(status="success", template_type=template_type, data=response_data, message=msg)

        
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

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
