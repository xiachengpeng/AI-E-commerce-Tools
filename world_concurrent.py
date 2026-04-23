import os
import time
import base64
import requests
from concurrent.futures import ThreadPoolExecutor, as_completed
from google.oauth2 import service_account
from google.auth.transport.requests import Request
from urllib3.util.retry import Retry
from requests.adapters import HTTPAdapter

# ================= 配置区 =================
PROJECT_ID = "ornate-rarity-493511-p5"       
LOCATION = "us-central1"  # 必须使用具体区域，严禁使用 global
KEY_PATH = r"D:\Workspace\miyao\hezihua0215 Gemini API Key\ornate-rarity-493511-p5-6759bce81d52.json"
MODEL_ID = "gemini-3.1-flash-image-preview"

# ================= 工具函数 =================
def get_access_token():
    """获取并刷新鉴权 Token"""
    credentials = service_account.Credentials.from_service_account_file(
        KEY_PATH, scopes=['https://www.googleapis.com/auth/cloud-platform']
    )
    request = Request()
    credentials.refresh(request)
    return credentials.token

def create_retry_session():
    """配置支持指数退避的 Session"""
    session = requests.Session()
    retry_strategy = Retry(
        total=5,              # 最多重试5次
        backoff_factor=2,      # 间隔时间: 2s, 4s, 8s, 16s, 32s
        status_forcelist=[429, 500, 502, 503, 504],
        allowed_methods=["POST"]
    )
    adapter = HTTPAdapter(
        max_retries=retry_strategy,
        pool_connections=10, 
        pool_maxsize=10
    )
    session.mount("https://", adapter)
    return session

# ================= 全局初始化 =================
print("🔄 正在初始化全局资源...")
GLOBAL_TOKEN = get_access_token()
GLOBAL_SESSION = create_retry_session()

# ================= 核心任务函数 =================
def generate_image_task(task_id, prompt):
    url = f"https://aiplatform.googleapis.com/v1/projects/{PROJECT_ID}/locations/{LOCATION}/publishers/google/models/{MODEL_ID}:generateContent"
    
    headers = {
        "Authorization": f"Bearer {GLOBAL_TOKEN}",
        "Content-Type": "application/json"
    }
    
    payload = {
        "contents": [{"role": "user", "parts": [{"text": prompt}]}]
    }

    start_time = time.time()
    try:
        # 注意：这里的 timeout 包含连接和读取时间
        response = GLOBAL_SESSION.post(url, headers=headers, json=payload, timeout=(15, 120))
        duration = time.time() - start_time
        
        if response.status_code != 200:
            return f"❌ [任务 {task_id}] 失败 | 状态码: {response.status_code} | 耗时: {duration:.2f}s | 响应: {response.text[:100]}"
            
        data = response.json()
        parts = data.get('candidates', [{}])[0].get('content', {}).get('parts', [])
        
        for part in parts:
            if 'inlineData' in part and 'data' in part['inlineData']:
                img_data = base64.b64decode(part['inlineData']['data'])
                file_name = f"output_img_{task_id}.jpg"
                with open(file_name, "wb") as f:
                    f.write(img_data)
                return f"✅ [任务 {task_id}] 成功 | 耗时: {duration:.2f}s | 文件: {file_name}"
                
        return f"⚠️ [任务 {task_id}] 未找到图片数据 | 耗时: {duration:.2f}s"

    except Exception as e:
        return f"❌ [任务 {task_id}] 运行异常: {str(e)}"

# ================= 并发入口 =================
if __name__ == "__main__":
    prompts = [
        "赛博朋克风格的未来城市街道，霓虹灯闪烁，下着细雨，电影级光影",
        "一杯放在木桌上的热咖啡，清晨的阳光透过窗户洒在上面，特写镜头"
    ]
    
    print(f"\n🚀 开始执行任务 (并发数: 3, 区域: {LOCATION})")
    total_start = time.time()
    
    with ThreadPoolExecutor(max_workers=3) as executor:
        future_to_task = {}
        
        for i, p in enumerate(prompts):
            tid = i + 1
            # 关键优化：每个请求错开 2 秒提交，避免触发 429 瞬时并发限制
            if i > 0:
                time.sleep(2)
            
            future = executor.submit(generate_image_task, tid, p)
            future_to_task[future] = tid
            print(f"📡 [任务 {tid}] 已提交请求...")

        for future in as_completed(future_to_task):
            print(future.result())
            
    print(f"\n✨ 全部任务处理完毕 | 总累计耗时: {time.time() - total_start:.2f}s")