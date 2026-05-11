from pydantic import BaseModel, field_validator
from typing import List, Union, Any, Optional

# ============================
# V2 Models
# ============================

class CompareRequest(BaseModel):
    urls: List[str]
    ai_provider: str | None = None # 可选，支持 "gemini" 或 "vertex"
    force_refresh: bool = False

class ProductCompareData(BaseModel):
    product_name: str
    price: str
    core_selling_points: List[str]
    target_audience: List[str]
    use_scenarios: List[str] = []
    age_range: str | None = None
    target_countries: List[str] = []
    strengths: str
    weaknesses: str
    reviews_count: str = "0"
    voc_analysis: Any = None # Pros/Cons/Sentiment
    source_url: str | None = None

    @field_validator('product_name', 'price', mode='before')
    @classmethod
    def convert_to_string(cls, v: Any) -> str:
        if isinstance(v, list):
            return "\n".join([str(item) for item in v])
        return str(v) if v is not None else ""

    @field_validator('strengths', 'weaknesses', mode='before')
    @classmethod
    def convert_strengths_weaknesses(cls, v: Any) -> str:
        if isinstance(v, str):
            return v
        if isinstance(v, list):
            parts = []
            for item in v:
                if isinstance(item, dict):
                    key = "point" if "point" in item else ("risk" if "risk" in item else None)
                    detail = item.get("detail", "")
                    if key and item.get(key):
                        parts.append(f"{item[key]}: {detail}" if detail else str(item[key]))
                    else:
                        parts.append(str(item))
                else:
                    parts.append(str(item))
            return "\n".join(parts)
        return str(v) if v is not None else ""

    @field_validator('core_selling_points', 'target_audience', 'use_scenarios', mode='before')
    @classmethod
    def convert_to_list(cls, v: Any) -> List[str]:
        if isinstance(v, str):
            return [v]
        if isinstance(v, list):
            res = []
            for item in v:
                if isinstance(item, dict) and 'point' in item:
                    res.append(item['point'])
                else:
                    res.append(str(item))
            return res
        return []

class ComparisonSummary(BaseModel):
    market_position: str
    competition_level: str
    winner_product: str

class EvalDetail(BaseModel):
    dimension: str
    detail: str

    @field_validator('dimension', 'detail', mode='before')
    @classmethod
    def coerce_str(cls, v: Any) -> str:
        return str(v) if v is not None else ""

class RecItem(BaseModel):
    action: str
    content: str

    @field_validator('action', 'content', mode='before')
    @classmethod
    def coerce_str(cls, v: Any) -> str:
        return str(v) if v is not None else ""

class ScoreCard(BaseModel):
    product: str
    opportunity_score: int
    difficulty_score: int
    final_decision: str
    decision_details: dict # {confidence, reason}
    sub_scores: dict # {opportunity: {...}, difficulty: {...}}
    evaluation_details: List[EvalDetail] = []

    @field_validator('evaluation_details', mode='before')
    @classmethod
    def parse_eval_details(cls, v: Any) -> list:
        if not isinstance(v, list):
            return []
        result = []
        for item in v:
            if isinstance(item, dict):
                result.append(EvalDetail(**{k: str(val) for k, val in item.items()}))
            else:
                result.append(EvalDetail(dimension="评估", detail=str(item)))
        return result

class CompareResponseData(BaseModel):
    products: List[ProductCompareData] = []
    comparison: ComparisonSummary | None = None
    comprehensive_evaluation: List[EvalDetail] = []
    recommendation_list: List[RecItem] = []
    scores: List[ScoreCard] = []
    single_data: Any = None  # Populated for single-product deep dive
    url_statuses: List[dict] = []

class CompareResponse(BaseModel):
    status: str
    template_type: str = "matrix"  # "single" or "matrix"
    data: CompareResponseData | None = None
    message: str | None = None

class TranslationRequest(BaseModel):
    text: str
    target_lang: Optional[str] = None
    target_langs: Optional[List[str]] = None
    ai_provider: str | None = None
