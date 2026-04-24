import os
import json
import base64
import requests
from google.oauth2 import service_account
from google.auth.transport.requests import Request
from urllib3.util.retry import Retry
from requests.adapters import HTTPAdapter
import time 
# # ================= 代理设置 =================
# os.environ["http_proxy"] = "http://127.0.0.1:3067"
# os.environ["https_proxy"] = "http://127.0.0.1:3067"

# ================= 配置区 =================
PROJECT_ID = "ornate-rarity-493511-p5"       
# 【重要修正】Gemini 模型不支持 global，必须使用特定区域，推荐 us-central1
LOCATION = "global"        
KEY_PATH = r"D:\Workspace\miyao\hezihua0215 Gemini API Key\ornate-rarity-493511-p5-6759bce81d52.json"

# ================= 工具函数 =================
def get_access_token():
    """通过 JSON 密钥文件获取 Google Cloud Token"""
    credentials = service_account.Credentials.from_service_account_file(
        KEY_PATH, 
        scopes=['https://www.googleapis.com/auth/cloud-platform']
    )
    request = Request()
    credentials.refresh(request)
    return credentials.token

def create_retry_session():
    """配置高可用性的 Requests Session"""
    session = requests.Session()
    retry_strategy = Retry(
        total=3,
        backoff_factor=1, # 间隔 1s, 2s, 4s
        status_forcelist=[429, 500, 502, 503, 504],
        allowed_methods=["POST"]
    )
    adapter = HTTPAdapter(max_retries=retry_strategy)
    session.mount("https://", adapter)
    return session
GLOBAL_TOKEN = get_access_token()
GLOBAL_SESSION = create_retry_session()
# ================= 核心请求函数 =================
def call_vertex_ai(prompt, model_id):
    """
    通用请求函数，自动根据模型类型判断解析方式
    """

    # 【重要修正】URL 必须带上前缀 us-central1
    url = f"https://aiplatform.googleapis.com/v1/projects/{PROJECT_ID}/locations/{LOCATION}/publishers/google/models/{model_id}:generateContent"

    headers = {
        "Authorization": f"Bearer {GLOBAL_TOKEN}",
        "Content-Type": "application/json"
    }

    payload = {
        "contents": [
            {
                "role": "user",
                "parts": [{"text": prompt}]
            }
        ]
    }

    print(f"🚀 正在请求模型 [{model_id}] ...")
    
    try:
        start_time = time.time()
        response = GLOBAL_SESSION.post(url, headers=headers, json=payload, timeout=(15, 120))
        end_time = time.time()
        print(f"⏱️ 实际请求耗时: {end_time - start_time:.2f} 秒")
        # 错误拦截
        if response.status_code != 200:
            print(f"❌ API 请求失败，状态码: {response.status_code}")
            print(f"错误详情: {response.text}")
            return
            
        response_data = response.json()
        candidates = response_data.get('candidates', [])
        
        if not candidates:
            print("❌ 错误：返回数据中没有找到 candidates。")
            return

        parts = candidates[0].get('content', {}).get('parts', [])
        if not parts:
            print("❌ 错误：返回数据中没有找到 parts。")
            return

        # ================= 智能解析分支 =================
        # 通过判断 model_id 中是否包含 'image' 来决定解析策略
        is_image_task = "image" in model_id.lower()

        if is_image_task:
            # ---------------- 场景 1：图片模型解析 ----------------
            base64_image = None
            for part in parts:
                if 'inlineData' in part and 'data' in part['inlineData']:
                    base64_image = part['inlineData']['data']
                    break
                    
            if base64_image:
                image_bytes = base64.b64decode(base64_image)
                save_path = "output.jpg"
                with open(save_path, "wb") as f:
                    f.write(image_bytes)
                print(f"✅ 成功！图片已保存至: {save_path}")
            else:
                print("❌ 未在返回体中找到图片数据，可能是触发了安全过滤。")

        else:
            # ---------------- 场景 2：文字模型解析 ----------------
            ai_text = ""
            for part in parts:
                if 'text' in part:
                    ai_text += part['text']
                    
            if ai_text:
                print("\n🤖 AI 回复:")
                print("="*40)
                print(ai_text.strip())
                print("="*40)
            else:
                print("❌ 未在返回体中找到文字数据。")

    except Exception as e:
        print(f"❌ 运行报错: {e}")

# ================= 测试运行 =================
if __name__ == "__main__":
    # 你可以随时切换下面两个 MODEL_ID 来测试不同分支
    
    # 测试文字模型
    # MODEL_ID = "gemini-1.5-pro-preview-0409" # 或者 gemini-3.1-pro-preview (如果你有权限)
    # PROMPT = "请用赛博朋克风格描述一座未来城市，100字左右。"
    
    # 测试图片模型
    MODEL_ID = "gemini-3.1-pro-preview"  # gemini-3.1-pro-preview gemini-3.1-flash-image-preview
    PROMPT = "一只戴着太空头盔的可爱猫咪，正在太阳上行走"
    
    call_vertex_ai(PROMPT, MODEL_ID)