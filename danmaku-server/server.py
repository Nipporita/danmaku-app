import asyncio
import websockets
import tkinter as tk
from tkinter import ttk
import json
import random
from threading import Thread

# 一些示例文本和颜色
texts = ['你好', '测试', '弹幕']
answers = [
            "我喜欢编程",
            "我讨厌写作业",
            "我爱吃冰淇淋",
            "我想去旅行",
            "我喜欢看电影",
            "我讨厌早起",
            "我爱运动",
            "我想学吉他"
        ]
colors = ["red", "green", "blue", "purple", "orange", "black", "pink"]
users = ["Alice", "Bob", "Charlie", "Dave", "Eve", "Frank", "Grace", "Heidi", "Ivan", "Judy", "Kevin", "Laura", "Mallory", "Niaj", "Olivia", "Peggy", "Quentin", "Rupert", "Sybil", "Trent", "Uma", "Victor", "Wendy", "Xander", "Yvonne", "Zack"]
users += ["User" + str(i) for i in range(1, 101)]
players = ["Player" + str(i) for i in range(1, 10)]
admin = "Admin"

game_status = ["Idle", "Enroll", "Gaming-Idle", "Answering", "StopAnswering", "Rating"]

GSControl = {
    "StartEnroll": "开始报名",  # 开始报名
    "StartGame": "开始游戏",    # 开始游戏
    "StartRating": "开始打分",  # 开始回合
    "EndRating": "结束打分",    # 结束回合
    "NextRound": "下一回合",    # 下一回合
    "EndGame": "结束游戏",      # 结束游戏
}

# 存储所有连接的客户端
connected_clients = set()

class DanmakuServerApp:
    def __init__(self, root):
        self.root = root
        self.root.title("弹幕服务器控制")
        self.root.geometry("400x200")
        
        self.danmaku_server_started = False
        self.server_task = None
        self.broadcast_task = None
        self.loop = asyncio.new_event_loop()
        self.server_thread = None
        
        self.game_state = "Idle"
        
        self.create_widgets()
        
        # 启动异步事件循环的线程
        self.loop_thread = Thread(target=self.run_event_loop, daemon=True)
        self.loop_thread.start()
    
    def create_widgets(self):
        # 服务器控制按钮
        self.server_btn = ttk.Button(
            self.root, 
            text="启动服务器", 
            command=self.toggle_server
        )
        self.server_btn.pack(pady=10)
        
        # 广播弹幕按钮
        self.broadcast_btn = ttk.Button(
            self.root, 
            text="发送随机弹幕", 
            command=self.broadcast_random_danmaku,
            state=tk.DISABLED
        )
        self.broadcast_btn.pack(pady=10)
        
        # 控制按钮
        self.control_frame = ttk.Frame(self.root)
        self.control_frame.pack(pady=10)

        ttk.Button(self.control_frame, text="开始报名", command=lambda: self.admin_broadcast(GSControl["StartEnroll"])).pack(side=tk.LEFT, padx=5)
        ttk.Button(self.control_frame, text="开始游戏", command=lambda: self.admin_broadcast(GSControl["StartGame"])).pack(side=tk.LEFT, padx=5)
        ttk.Button(self.control_frame, text="开始打分", command=lambda: self.admin_broadcast(GSControl["StartRating"])).pack(side=tk.LEFT, padx=5)
        ttk.Button(self.control_frame, text="结束打分", command=lambda: self.admin_broadcast(GSControl["EndRating"])).pack(side=tk.LEFT, padx=5)
        ttk.Button(self.control_frame, text="下一回合", command=lambda: self.admin_broadcast(GSControl["NextRound"])).pack(side=tk.LEFT, padx=5)
        ttk.Button(self.control_frame, text="结束游戏", command=lambda: self.admin_broadcast(GSControl["EndGame"])).pack(side=tk.LEFT, padx=5)
        
        # 状态标签
        self.status_var = tk.StringVar(value="服务器未运行")
        self.status_label = ttk.Label(
            self.root, 
            textvariable=self.status_var,
            foreground="red"
        )
        self.status_label.pack(pady=10)
        
        # 连接数标签
        self.connections_var = tk.StringVar(value="当前连接: 0")
        self.connections_label = ttk.Label(
            self.root, 
            textvariable=self.connections_var
        )
        self.connections_label.pack(pady=10)
    
    def player_enroll(self):
        for i in range(random.randint(4, 10)):
            danmaku = {
                "text": "1",
                "color": "blue",
                "size": 22,
                "sender": random.choice(players),
                "is_broadcast": True
            }
            # 把发送任务丢给 asyncio loop
            asyncio.run_coroutine_threadsafe(
                self.send_broadcast_danmaku(danmaku),
                self.loop
            )
    
    def player_answer(self):
        for p in players:
            danmaku = {
                "text": random.choice(answers),
                "color": "green",
                "size": 22,
                "sender": p,
                "is_broadcast": True
            }
            # 把发送任务丢给 asyncio loop
            asyncio.run_coroutine_threadsafe(
                self.send_broadcast_danmaku(danmaku),
                self.loop
            )
    
    def admin_broadcast(self, text = ""):
        danmaku = {
            "text": text,
            "color": "red",
            "size": 28,
            "sender": admin,
            "is_broadcast": True
        }
        # 把发送任务丢给 asyncio loop
        asyncio.run_coroutine_threadsafe(
            self.send_broadcast_danmaku(danmaku),
            self.loop
        )
    
    def run_event_loop(self):
        asyncio.set_event_loop(self.loop)
        self.loop.run_forever()
    
    def toggle_server(self):
        if not self.danmaku_server_started:
            self.start_server()
        else:
            self.stop_server()
    
    def start_server(self):
        self.danmaku_server_started = True
        self.server_btn.config(text="停止服务器")
        self.broadcast_btn.config(state=tk.NORMAL)
        self.status_var.set("服务器运行中 (ws://localhost:8080)")
        self.status_label.config(foreground="green")
        
        # 在异步事件循环中启动服务器
        self.server_task = asyncio.run_coroutine_threadsafe(
            self.main(), 
            self.loop
        )
        
        # ✅ 启动随机广播后台任务
        self.broadcast_task = asyncio.run_coroutine_threadsafe(
            self.auto_broadcast_loop(),
            self.loop
        )
    
    def stop_server(self):
        self.danmaku_server_started = False
        self.server_btn.config(text="启动服务器")
        self.broadcast_btn.config(state=tk.DISABLED)
        self.status_var.set("服务器已停止")
        self.status_label.config(foreground="red")
        
        # 取消服务器任务并关闭所有连接
        if self.server_task:
            self.server_task.cancel()
        
        # ✅ 停止随机广播任务
        if self.broadcast_task:
            self.broadcast_task.cancel()
        
        # 关闭所有客户端连接
        asyncio.run_coroutine_threadsafe(
            self.close_all_connections(), 
            self.loop
        )
    
    async def close_all_connections(self):
        global connected_clients
        for websocket in connected_clients:
            await websocket.close()
        connected_clients.clear()
        self.update_connections_count()
    
    async def register_client(self, websocket):
        global connected_clients
        connected_clients.add(websocket)
        self.update_connections_count()
    
    async def unregister_client(self, websocket):
        global connected_clients
        if websocket in connected_clients:
            connected_clients.remove(websocket)
        self.update_connections_count()
    
    def update_connections_count(self):
        self.connections_var.set(f"当前连接: {len(connected_clients)}")
    
    def broadcast_random_danmaku(self):
        # 在异步事件循环中广播随机弹幕
        asyncio.run_coroutine_threadsafe(
            self.send_broadcast_danmaku(), 
            self.loop
        )
    
    async def auto_broadcast_loop(self):
        """后台自动广播循环，随服务器启停"""
        try:
            while self.danmaku_server_started:
                await self.send_broadcast_danmaku()  # 随机生成并广播
                await asyncio.sleep(0.1 * random.randint(0,5))  # 间隔 2 秒
        except asyncio.CancelledError:
            print("✅ 自动广播任务已停止")
    
    async def send_broadcast_danmaku(self, danmaku=None):
        global connected_clients
        if not connected_clients:
            return
        
        if danmaku is None:
            # 生成随机弹幕
            danmaku = {
                "text": random.choice(texts),
                "color": random.choice(colors),
                "size": random.choice([14, 18, 22, 28]),
                "sender": random.choice(users),
                "is_broadcast": True  # 标记为管理员广播
            }
            if self.game_state == "Rating":
                danmaku["text"] = random.choice(['1', '2', '3', '4'])
        
        # 发送给所有连接的客户端
        tasks = []
        for websocket in connected_clients:
            # 为每个发送操作创建任务并添加到列表
            tasks.append(asyncio.create_task(websocket.send(json.dumps(danmaku, ensure_ascii=False))))
        
        # 等待所有任务完成
        if tasks:
            await asyncio.gather(*tasks)
    
    async def danmaku_server(self, websocket):
        await self.register_client(websocket)
        try:
            async for message in websocket:   # ✅ 循环接收消息
                try:
                    data = json.loads(message)
                    await self.receive(websocket, data)  # 👉 交给子类处理
                except json.JSONDecodeError:
                    print(f"⚠️ 非JSON消息: {message}")
        except websockets.ConnectionClosed:
            print("❌ 客户端断开连接")
        finally:
            await self.unregister_client(websocket)

    async def receive(self, websocket, data):
        """
        虚拟函数：处理接收到的消息
        子类实现
        """
        if data.get("type") == "game_state_change":
            self.game_state = data.get("state", "Idle")
            
            if self.game_state == "Enroll":
                self.player_enroll()
            elif self.game_state == "Answering":
                self.player_answer()

    async def send(self, websocket, data):
        """
        虚拟函数：发送消息给客户端
        子类实现
        """
        raise NotImplementedError

    
    async def main(self):
        async with websockets.serve(self.danmaku_server, "localhost", 8080):
            print("✅ WebSocket 弹幕服务已启动 ws://localhost:8080")
            await asyncio.Future()  # 保持服务器运行

if __name__ == "__main__":
    root = tk.Tk()
    app = DanmakuServerApp(root)
    
    # 确保程序退出时正确清理
    def on_closing():
        if app.danmaku_server_started:
            app.stop_server()
        app.loop.call_soon_threadsafe(app.loop.stop)
        root.destroy()
    
    root.protocol("WM_DELETE_WINDOW", on_closing)
    root.mainloop()
    
