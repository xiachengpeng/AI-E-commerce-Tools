import json
import logging
from typing import Optional
from urllib.parse import urlparse

import httpx

try:
    from models.settings import ProviderBalanceResult
except ImportError:
    from backend.models.settings import ProviderBalanceResult

logger = logging.getLogger(__name__)


def _sanitize_message(message: str, secrets: list[Optional[str]]) -> str:
    """Scrub raw API keys or access tokens from any diagnostic message."""
    clean = message or ""
    for secret in secrets:
        if secret and len(secret) >= 4:
            clean = clean.replace(secret, "********")
    return clean


class AIBalanceService:
    """Service to detect and query account balance across various AI proxy gateways,

    including New-API, One-API, DeepSeek, SiliconFlow, OpenRouter, and custom endpoints.
    """

    async def query_balance(
        self,
        protocol: str,
        base_url: Optional[str],
        api_key: Optional[str],
        custom_balance_url: Optional[str] = None,
        balance_access_token: Optional[str] = None,
        balance_user_id: Optional[str] = None,
        timeout_seconds: float = 12.0,
    ) -> ProviderBalanceResult:
        secrets = [api_key, balance_access_token]

        if protocol not in ("openai_compatible", "openai"):
            return ProviderBalanceResult(
                status="unsupported",
                message=f"{protocol} 协议使用的是官方云控制台账单，暂不支持通过 API Key 远程查询余额",
            )

        effective_token = (balance_access_token or api_key or "").strip()
        if not effective_token:
            return ProviderBalanceResult(
                status="error",
                message="未配置 API Key 或查询访问令牌，无法查询余额",
            )

        clean_base_url = (base_url or "").strip().rstrip("/")
        clean_custom_url = (custom_balance_url or "").strip()

        headers = {
            "Authorization": f"Bearer {effective_token}",
            "Accept": "application/json",
            "User-Agent": "AI-Ecommerce-Tools/1.0",
        }
        if balance_user_id and str(balance_user_id).strip():
            headers["New-Api-User"] = str(balance_user_id).strip()

        async with httpx.AsyncClient(timeout=timeout_seconds, follow_redirects=True) as client:
            # 1. If custom balance URL is specified, query it directly
            if clean_custom_url:
                try:
                    resp = await client.get(clean_custom_url, headers=headers)
                    if resp.status_code == 401:
                        return ProviderBalanceResult(
                            status="error",
                            message="认证失败：自定义查询接口返回 401，请检查访问令牌或 API Key",
                        )
                    if resp.status_code == 404:
                        return ProviderBalanceResult(
                            status="error",
                            message=f"自定义查询地址返回 404 Not Found: {clean_custom_url}",
                        )
                    if resp.status_code >= 400:
                        return ProviderBalanceResult(
                            status="error",
                            message=_sanitize_message(
                                f"自定义查询接口请求失败 (HTTP {resp.status_code})",
                                secrets,
                            ),
                        )
                    data = resp.json()
                    return self._parse_generic_balance_response(data, "自定义接口")
                except httpx.TimeoutException:
                    return ProviderBalanceResult(
                        status="error",
                        message="自定义查询接口连接超时，请检查网络或地址",
                    )
                except Exception as exc:
                    return ProviderBalanceResult(
                        status="error",
                        message=_sanitize_message(f"自定义查询接口请求出错: {exc}", secrets),
                    )

            # 2. Known domain auto-matching
            parsed_base = urlparse(clean_base_url)
            host = (parsed_base.netloc or "").lower()

            # DeepSeek Official
            if "deepseek.com" in host:
                deepseek_url = "https://api.deepseek.com/user/balance"
                try:
                    resp = await client.get(deepseek_url, headers=headers)
                    if resp.status_code == 200:
                        data = resp.json()
                        infos = data.get("balance_infos") or []
                        if infos and isinstance(infos, list):
                            first_info = infos[0]
                            curr = first_info.get("currency", "CNY")
                            tot_str = first_info.get("total_balance", "0")
                            try:
                                tot = float(tot_str)
                            except ValueError:
                                tot = 0.0
                            sym = "¥" if curr == "CNY" else "$"
                            return ProviderBalanceResult(
                                status="success",
                                balance_text=f"{sym}{tot:.2f}",
                                currency=curr,
                                total_balance=tot,
                                remaining_balance=tot,
                                message="DeepSeek 官方余额查询成功",
                            )
                    elif resp.status_code == 401:
                        return ProviderBalanceResult(
                            status="error",
                            message="DeepSeek 认证失败：API Key 无效 (401)",
                        )
                except Exception as exc:
                    logger.debug("DeepSeek balance query failed: %s", exc)

            # SiliconFlow Official
            if "siliconflow.cn" in host or "siliconflow.com" in host:
                silicon_url = "https://api.siliconflow.cn/v1/user/info"
                try:
                    resp = await client.get(silicon_url, headers=headers)
                    if resp.status_code == 200:
                        data = resp.json()
                        user_data = data.get("data") or {}
                        bal_val = user_data.get("balance")
                        if bal_val is not None:
                            try:
                                bal = float(bal_val)
                            except ValueError:
                                bal = 0.0
                            return ProviderBalanceResult(
                                status="success",
                                balance_text=f"¥{bal:.2f}",
                                currency="CNY",
                                remaining_balance=bal,
                                message="硅基流动 (SiliconFlow) 余额查询成功",
                            )
                except Exception as exc:
                    logger.debug("Siliconflow balance query failed: %s", exc)

            # OpenRouter Official
            if "openrouter.ai" in host:
                openrouter_url = "https://openrouter.ai/api/v1/credits"
                try:
                    resp = await client.get(openrouter_url, headers=headers)
                    if resp.status_code == 200:
                        data = resp.json()
                        cdata = data.get("data") or {}
                        tot = float(cdata.get("total_credits", 0.0))
                        usage = float(cdata.get("total_usage", 0.0))
                        rem = max(0.0, tot - usage)
                        return ProviderBalanceResult(
                            status="success",
                            balance_text=f"${rem:.2f}",
                            currency="USD",
                            total_balance=tot,
                            used_balance=usage,
                            remaining_balance=rem,
                            message="OpenRouter 额度查询成功",
                        )
                except Exception as exc:
                    logger.debug("OpenRouter balance query failed: %s", exc)

            # 3. Relay Stations: Try New-API first (/api/user/self)
            base_root = clean_base_url
            if base_root.endswith("/v1"):
                base_root = base_root[:-3]

            new_api_url = f"{base_root}/api/user/self"
            try:
                resp = await client.get(new_api_url, headers=headers)
                if resp.status_code == 200:
                    data = resp.json()
                    # New-API returns {"success": true, "data": {"quota": 12345, ...}}
                    # or directly {"quota": 12345}
                    inner_data = data.get("data") if isinstance(data.get("data"), dict) else data
                    if "quota" in inner_data:
                        quota = float(inner_data["quota"])
                        # Standard New-API formula: quota / 500,000 = USD
                        rem_usd = round(quota / 500000.0, 2)
                        return ProviderBalanceResult(
                            status="success",
                            balance_text=f"${rem_usd:.2f}",
                            currency="USD",
                            remaining_balance=rem_usd,
                            message=f"New-API 查询成功 (剩余额度: {int(quota):,})",
                        )
                elif resp.status_code == 401:
                    # If this failed with 401, inform user that Access Token might be needed
                    if not balance_access_token:
                        logger.info("New-API /api/user/self returned 401 with model API Key; trying fallback")
            except Exception as exc:
                logger.debug("New-API /api/user/self probe failed: %s", exc)

            # 4. Standard One-API / OpenAI billing endpoints fallback
            sub_url = f"{clean_base_url}/dashboard/billing/subscription"
            usage_url = f"{clean_base_url}/dashboard/billing/usage"
            try:
                resp_sub = await client.get(sub_url, headers=headers)
                if resp_sub.status_code == 404 and "/v1" not in clean_base_url:
                    sub_url = f"{clean_base_url}/v1/dashboard/billing/subscription"
                    usage_url = f"{clean_base_url}/v1/dashboard/billing/usage"
                    resp_sub = await client.get(sub_url, headers=headers)

                if resp_sub.status_code == 200:
                    sub_data = resp_sub.json()
                    hard_limit = float(sub_data.get("hard_limit_usd") or sub_data.get("hard_limit") or 0.0)

                    # Usage query
                    total_usage = 0.0
                    try:
                        resp_usage = await client.get(usage_url, headers=headers)
                        if resp_usage.status_code == 200:
                            total_usage = float(resp_usage.json().get("total_usage", 0.0))
                    except Exception:
                        pass

                    rem = round(max(0.0, hard_limit - total_usage), 2)
                    return ProviderBalanceResult(
                        status="success",
                        balance_text=f"${rem:.2f}",
                        currency="USD",
                        total_balance=hard_limit,
                        used_balance=total_usage,
                        remaining_balance=rem,
                        message="One-API 订阅额度查询成功",
                    )
                elif resp_sub.status_code == 401:
                    return ProviderBalanceResult(
                        status="error",
                        message="认证失败：API Key 或访问令牌无效 (401)",
                    )
            except Exception as exc:
                logger.debug("Subscription query failed: %s", exc)

            # If all automated routes failed
            return ProviderBalanceResult(
                status="error",
                message=(
                    "未检测到兼容的余额查询接口。若您的中转站是 New-API，请在【编辑线路】中填入系统访问令牌 (Access Token)；"
                    "或填入自定义查询接口 URL"
                ),
            )

    def _parse_generic_balance_response(self, data: dict, label: str) -> ProviderBalanceResult:
        if not isinstance(data, dict):
            return ProviderBalanceResult(
                status="error",
                message=f"{label}返回的不是 JSON 对象格式",
            )

        # Check for nested data
        root = data.get("data") if isinstance(data.get("data"), dict) else data

        curr = root.get("currency") or data.get("currency") or "USD"
        sym = "¥" if curr.upper() == "CNY" else "$"

        # 1. quota format
        if "quota" in root:
            try:
                quota = float(root["quota"])
                rem = round(quota / 500000.0, 2)
                return ProviderBalanceResult(
                    status="success",
                    balance_text=f"${rem:.2f}",
                    currency="USD",
                    remaining_balance=rem,
                    message=f"{label}查询成功 (额度: {int(quota):,})",
                )
            except Exception:
                pass

        # 2. balance / remaining_balance / total_balance
        for key in ("balance", "remaining_balance", "available_balance", "remaining_quota", "credits"):
            if key in root and root[key] is not None:
                try:
                    val = float(root[key])
                    return ProviderBalanceResult(
                        status="success",
                        balance_text=f"{sym}{val:.2f}",
                        currency=curr,
                        remaining_balance=val,
                        message=f"{label}查询成功",
                    )
                except Exception:
                    pass

        # 3. Subscription hard_limit - total_usage
        if "hard_limit_usd" in root:
            try:
                hard = float(root["hard_limit_usd"])
                usage = float(root.get("total_usage", 0.0))
                rem = round(max(0.0, hard - usage), 2)
                return ProviderBalanceResult(
                    status="success",
                    balance_text=f"${rem:.2f}",
                    currency="USD",
                    total_balance=hard,
                    used_balance=usage,
                    remaining_balance=rem,
                    message=f"{label}查询成功",
                )
            except Exception:
                pass

        return ProviderBalanceResult(
            status="error",
            message=f"{label}响应中未解析到有效的 balance 或 quota 字段",
        )
