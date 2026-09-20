/**
 * CC Switch 风格 AI 用量查询预设模板库与原生 JS 提取器沙箱引擎
 */

(function (global) {
    "use strict";

    // 1. 预设模板库 (100% 对齐 CC Switch 官方规范)
    const USAGE_QUERY_TEMPLATES = {
        general: `({
  request: {
    url: "{{baseUrl}}/v1/usage",
    method: "GET",
    headers: { "Authorization": "Bearer {{apiKey}}" }
  },
  extractor: function(response) {
    const remaining = response?.remaining ?? response?.quota?.remaining ?? response?.balance;
    const unit = response?.unit ?? response?.quota?.unit ?? "USD";
    return {
      isValid: response?.is_active ?? response?.isValid ?? true,
      remaining,
      unit
    };
  }
})`,

        newapi: `({
  request: {
    url: "{{baseUrl}}/api/user/self",
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer {{accessToken}}",
      "User-Agent": "cc-switch/1.0",
      "New-Api-User": "{{userId}}"
    },
  },
  extractor: function (response) {
    if (response && response.success && response.data) {
      const quota = Number(response.data.quota || 0);
      const usedQuota = Number(response.data.used_quota || 0);
      return {
        isValid: true,
        planName: response.data.group || "默认套餐",
        remaining: quota / 500000,
        used: usedQuota / 500000,
        total: (quota + usedQuota) / 500000,
        unit: "USD",
      };
    }
    return {
      isValid: false,
      invalidMessage: (response && response.message) || "查询失败或返回格式不正确"
    };
  },
})`,

        token_plan: `({
  request: {
    url: "{{baseUrl}}/v1/dashboard/billing/subscription",
    method: "GET",
    headers: { "Authorization": "Bearer {{apiKey}}" }
  },
  extractor: function(response) {
    const hardLimit = response?.hard_limit_usd ?? response?.hard_limit ?? 0;
    return {
      isValid: response?.is_active ?? true,
      remaining: Number(hardLimit).toFixed(2),
      unit: "USD"
    };
  }
})`,

        official: `({
  request: {
    url: "{{baseUrl}}/user/balance",
    method: "GET",
    headers: { "Authorization": "Bearer {{apiKey}}" }
  },
  extractor: function(response) {
    if (response?.balance_infos && Array.isArray(response.balance_infos) && response.balance_infos.length > 0) {
      const info = response.balance_infos[0];
      return {
        isValid: true,
        remaining: parseFloat(info.total_balance || 0),
        unit: info.currency || "CNY"
      };
    }
    const rem = response?.data?.balance ?? response?.total_available ?? response?.data?.total_credits;
    return {
      isValid: true,
      remaining: rem !== undefined ? parseFloat(rem) : 0,
      unit: response?.currency ?? "USD"
    };
  }
})`,
    };

    // 2. 模板字符串变量替换
    function interpolateTemplate(str, vars) {
        if (!str || typeof str !== "string") return str || "";
        let result = str;
        const replacements = {
            baseUrl: (vars && vars.baseUrl) || "",
            apiKey: (vars && vars.apiKey) || "",
            accessToken: (vars && (vars.accessToken || vars.apiKey)) || "",
            userId: (vars && vars.userId) || "",
        };

        result = result.replace(/\{\{\s*baseUrl\s*\}\}/g, replacements.baseUrl);
        result = result.replace(/\{\{\s*apiKey\s*\}\}/g, replacements.apiKey);
        result = result.replace(/\{\{\s*accessToken\s*\}\}/g, replacements.accessToken);
        result = result.replace(/\{\{\s*userId\s*\}\}/g, replacements.userId);
        return result;
    }

    // 3. 解析脚本对象 ({ request, extractor })
    function parseUsageScript(scriptStr) {
        if (!scriptStr || typeof scriptStr !== "string") {
            throw new Error("脚本代码为空");
        }
        const trimmed = scriptStr.trim();
        let evalCode = trimmed;
        // 如果脚本以 ({ 开头并以 }) 结尾，或是裸对象 { ... }
        if (!evalCode.startsWith("(") && evalCode.startsWith("{")) {
            evalCode = "(" + evalCode + ")";
        }

        try {
            const factory = new Function("return " + evalCode);
            const scriptObj = factory();
            if (!scriptObj || typeof scriptObj !== "object") {
                throw new Error("提取器脚本必须返回一个包含 request 和 extractor 的对象");
            }
            if (!scriptObj.request || typeof scriptObj.request !== "object") {
                throw new Error("脚本缺少 request 配置对象 (需包含 url 与 method)");
            }
            if (!scriptObj.extractor || typeof scriptObj.extractor !== "function") {
                throw new Error("脚本缺少 extractor 提取函数 (需形如 extractor: function(response) { ... })");
            }
            return scriptObj;
        } catch (err) {
            throw new Error("提取器脚本语法错误: " + err.message);
        }
    }

    // 4. 沙箱执行提取器
    function executeUsageExtractor(scriptStr, responseData, context) {
        try {
            const parsed = parseUsageScript(scriptStr);
            const rawResult = parsed.extractor(responseData, context || {});
            if (!rawResult || typeof rawResult !== "object") {
                return {
                    isValid: false,
                    invalidMessage: "提取器函数未返回有效的结果对象",
                };
            }

            const isValid = rawResult.isValid !== false;
            const remaining = rawResult.remaining;
            const unit = rawResult.unit || "USD";
            const planName = rawResult.planName || null;
            const used = rawResult.used !== undefined ? rawResult.used : null;
            const total = rawResult.total !== undefined ? rawResult.total : null;
            const invalidMessage = rawResult.invalidMessage || null;

            return {
                isValid,
                remaining,
                unit,
                planName,
                used,
                total,
                invalidMessage,
                raw: rawResult,
            };
        } catch (err) {
            return {
                isValid: false,
                invalidMessage: "脚本执行异常: " + err.message,
            };
        }
    }

    // 5. 格式化代码
    function formatExtractorScript(scriptStr) {
        if (!scriptStr || typeof scriptStr !== "string") return scriptStr || "";
        const clean = scriptStr.trim();
        // 如果已有换行且缩进较合理，则保留修整；否则尝试轻量美化
        try {
            // 通过解析与序列化生成规范的键名缩进
            const parsed = parseUsageScript(clean);
            const extractorCode = parsed.extractor.toString();
            const requestJson = JSON.stringify(parsed.request, null, 4);

            return `({\n  request: ${requestJson},\n  extractor: ${extractorCode}\n})`;
        } catch (e) {
            return clean;
        }
    }

    // 导出对象
    const api = {
        USAGE_QUERY_TEMPLATES,
        interpolateTemplate,
        parseUsageScript,
        executeUsageExtractor,
        formatExtractorScript,
    };

    if (typeof module !== "undefined" && module.exports) {
        module.exports = api;
    }
    if (typeof window !== "undefined") {
        window.UsageQueryEngine = api;
    }
})(typeof globalThis !== "undefined" ? globalThis : this);
