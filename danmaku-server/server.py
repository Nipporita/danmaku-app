import asyncio
import websockets
import json
import random

# 一些示例文本和颜色
texts = ["Hello!", "弹幕测试", "Python 👍", "WebSocket 🚀", "前端收到了吗？"]
colors = ["red", "green", "blue", "purple", "orange"]
users = list(set(["".join(random.choices("abcdefghijklmnopqrstuvwxyz")[0] for _ in range(random.randint(3,8))) for _ in range(20)]))

async def danmaku_server(websocket):
    try:
        while True:
            # 随机生成一个弹幕
            danmaku = {
                "text": random.choice(texts),
                "color": random.choice(colors),
                "size": random.choice([14, 18, 22, 28]),
                "sender": f"{random.choice(users)}",
            }
            await websocket.send(json.dumps(danmaku, ensure_ascii=False))
            await asyncio.sleep(random.uniform(1, 3))  # 每 1-3 秒推送一条
    except websockets.ConnectionClosed:
        print("❌ 客户端断开连接")

async def main():
    async with websockets.serve(danmaku_server, "localhost", 8080):
        print("✅ WebSocket 弹幕服务已启动 ws://localhost:8080")
        await asyncio.Future()

if __name__ == "__main__":
    asyncio.run(main())
