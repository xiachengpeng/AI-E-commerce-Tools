
import requests, base64

invoke_url = "https://integrate.api.nvidia.com/v1/chat/completions"
stream = True

NVIDIA_API_KEY = "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"
with open(r"D:\Desktop\2c76eb5919f391f3b2e92782dad2d73e.jpg", "rb") as f:
  image_b64 = base64.b64encode(f.read()).decode()

headers = {
  "Authorization": f"Bearer {NVIDIA_API_KEY}",
  "Accept": "text/event-stream" if stream else "application/json"
}

payload = {
  "model": "moonshotai/kimi-k2.5",
  "messages": [
      {
        "role": "user",
        "content": f"使用中文描述这么文件. <img src=\"data:image/png;base64,{image_b64}\" />"
      }
    ],
  "max_tokens": 16384,
  "temperature": 1.00,
  "top_p": 1.00,
  "stream": stream,
  "chat_template_kwargs": {"thinking":True},
}



response = requests.post(invoke_url, headers=headers, json=payload)

if stream:
    for line in response.iter_lines():
        if line:
            print(line.decode("utf-8"))
else:
    print(response.json())
