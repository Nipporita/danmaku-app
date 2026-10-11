import asyncio
import websockets
import tkinter as tk
from tkinter import ttk
import json
import random
from threading import Thread
import sys

# 服务端口：默认 8080。前端「端口」默认填的是 8000（与真实后端一致），
# 想省掉每次手填，可以 `python server.py 8000` 起在 8000。
SERVER_PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8080

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
            "我想学吉他",
            # 下面这些是给"一批人同时作答"用的：一次灌 12 个人时答案不重样，
            # 彩排打分环节才不会因为"两个人碰巧同一句答案"而只有一条不同答案
            "我想养一只猫",
            "我最怕星期一",
            "我想回老家",
            "我喜欢下雨天",
        ]
colors = ["red", "green", "blue", "purple", "orange", "black", "pink"]
users = ["Alice", "Bob", "Charlie", "Dave", "Eve", "Frank", "Grace", "Heidi", "Ivan", "Judy", "Kevin", "Laura", "Mallory", "Niaj", "Olivia", "Peggy", "Quentin", "Rupert", "Sybil", "Trent", "Uma", "Victor", "Wendy", "Xander", "Yvonne", "Zack"]
users += ["User" + str(i) for i in range(1, 101)]
players = ["Player" + str(i) for i in range(1, 10)]
admin = "Admin"
admin_uid = "1"  # 主持人的 senderId（模拟真实后端的 QQ 号）

# 逐个自增的消息 ID：模拟真实后端给每条弹幕带的 message_id，
# 撤回 / 贴表情事件要靠它把"群里那条消息"对回"大屏上的那条弹幕"
_next_message_id = [1000]


def new_message_id():
    _next_message_id[0] += 1
    return "sim|%d" % _next_message_id[0]

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

EMOJI_UNICODE_MIN = 0x1F000  # 与后端 game_events.emoji_char 保持一致
EMOJI_CDN = "https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/%s.png"
FACE_IMG = "https://qzonestyle.gtimg.cn/qzone/em/e%d.gif"


def emoji_char_of(emoji_id):
    """QQ「回应」的 id 就是 Unicode 码点（128077 = 👍）；经典 QQ 表情是小 id，没有字符"""
    try:
        code = int(emoji_id)
    except (TypeError, ValueError):
        return ""
    if EMOJI_UNICODE_MIN <= code <= 0x10FFFF:
        try:
            return chr(code)
        except ValueError:
            return ""
    return ""


def emoji_image_url_of(emoji_id):
    """表情图地址：标准 emoji 走 Twemoji；经典 QQ 表情走腾讯的 e{id}.gif（≥222 用 10000+id）"""
    try:
        code = int(emoji_id)
    except (TypeError, ValueError):
        return ""
    if EMOJI_UNICODE_MIN <= code <= 0x10FFFF:
        return EMOJI_CDN % ("%x" % code)
    return FACE_IMG % (code if code < 222 else 10000 + code)


class DanmakuServerApp:
    def __init__(self, root):
        self.root = root
        self.root.title("弹幕服务器控制")
        self.root.geometry("400x200")
        
        self.danmaku_server_started = False
        self.server_task = None
        self.broadcast_task = None
        self.random_danmaku_enabled = True  # 随机弹幕开关（排练游戏流程时建议关掉）
        self.loop = asyncio.new_event_loop()
        self.server_thread = None
        
        self.game_state = "Idle"
        self.blocked_var = tk.BooleanVar(value=False)
        self.last_answers = []  # 最近一批选手答案：{message_id, sender, senderId, index}
        self.current_enroll = []  # 最近一批报名者：{sender, senderId}
        self.shadow_ids = set()  # 被"影子封禁"（人黑名单）的 senderId：照常发消息，但带 user_blacklist 标记

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

        # 随机弹幕自动广播开关：排练游戏流程时建议关掉
        # （回答阶段里上场选手的随机发言会被当成答案，打分阶段的随机数字会被当成投票）
        self.random_danmaku_var = tk.BooleanVar(value=True)
        self.random_danmaku_check = ttk.Checkbutton(
            self.root,
            text="自动随机弹幕",
            variable=self.random_danmaku_var,
            command=self.toggle_random_danmaku,
        )
        self.random_danmaku_check.pack(pady=2)
        
        # 控制按钮
        self.control_frame = ttk.Frame(self.root)
        self.control_frame.pack(pady=10)

        ttk.Button(self.control_frame, text="开始报名", command=lambda: self.admin_broadcast(GSControl["StartEnroll"])).pack(side=tk.LEFT, padx=5)
        ttk.Button(self.control_frame, text="开始游戏", command=lambda: self.admin_broadcast(GSControl["StartGame"])).pack(side=tk.LEFT, padx=5)
        ttk.Button(self.control_frame, text="开始打分", command=lambda: self.admin_broadcast(GSControl["StartRating"])).pack(side=tk.LEFT, padx=5)
        ttk.Button(self.control_frame, text="结束打分", command=lambda: self.admin_broadcast(GSControl["EndRating"])).pack(side=tk.LEFT, padx=5)
        ttk.Button(self.control_frame, text="下一回合", command=lambda: self.admin_broadcast(GSControl["NextRound"])).pack(side=tk.LEFT, padx=5)
        ttk.Button(self.control_frame, text="结束游戏", command=lambda: self.admin_broadcast(GSControl["EndGame"])).pack(side=tk.LEFT, padx=5)

        ttk.Checkbutton(self.control_frame, text="blocked", variable=self.blocked_var).pack(side=tk.LEFT, padx=10)

        # 撤回 / 贴表情：模拟 QQ 群里的通知事件（游戏侧的"撤回答案""贴表情审核"靠它们排练）
        self.notice_frame = ttk.Frame(self.root)
        self.notice_frame.pack(pady=10)
        ttk.Button(self.notice_frame, text="撤回最后一条答案", command=self.recall_last_answer).pack(side=tk.LEFT, padx=5)
        ttk.Button(self.notice_frame, text="给最后一条答案贴表情", command=self.like_last_answer).pack(side=tk.LEFT, padx=5)
        ttk.Button(self.notice_frame, text="给第一条答案贴表情", command=self.like_first_answer).pack(side=tk.LEFT, padx=5)
        ttk.Button(self.notice_frame, text="取消最后一条表情", command=self.unlike_last_answer).pack(side=tk.LEFT, padx=5)
        ttk.Button(self.notice_frame, text="撤销最后一条答案", command=self.clear_last_answer).pack(side=tk.LEFT, padx=5)

        # 影子黑名单（人黑名单）：对方照常报名/答题，但不会被抽中
        self.shadow_target_id = "sim-user-%s" % users[0]
        self.shadow_btn = ttk.Button(
            self.notice_frame,
            text="影子黑名单: %s" % users[0],
            command=self.toggle_shadow_ban,
        )
        self.shadow_btn.pack(side=tk.LEFT, padx=5)
        
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
    
    def shadow_reasons(self, sender_id):
        """这个 senderId 是否在"影子黑名单"里 → 返回要带的 block_reasons"""
        return ["user_blacklist"] if sender_id in self.shadow_ids else []

    def toggle_shadow_ban(self):
        """把 Alice 在"人黑名单"里加/减（排练影子封禁用：她照常报名，但抽不中）"""
        target = self.shadow_target_id
        if target in self.shadow_ids:
            self.shadow_ids.discard(target)
            self.shadow_btn.config(text="影子黑名单: %s" % users[0])
            print("[影子黑名单] 解除 %s" % users[0])
        else:
            self.shadow_ids.add(target)
            self.shadow_btn.config(text="影子黑名单: %s ✓" % users[0])
            print("[影子黑名单] %s 加入（她照常报名/答题，但不会被抽中）" % users[0])

    def player_enroll(self):
        # 模拟 12 个人扣 1（6 个固定选手 + 6 个随机观众），正好填满 2×6 的报名池，
        # 这样能排练"进度满了自动抽选"这条路；身份固定，方便用「清空已玩过」重开一局
        self.current_enroll = []
        people = [(players[i], "sim-player-%d" % (i + 1)) for i in range(6)]
        people += [(users[i], "sim-user-%s" % users[i]) for i in range(6)]
        for name, sender_id in people:
            self.current_enroll.append({"sender": name, "senderId": sender_id})
            reasons = self.shadow_reasons(sender_id)
            danmaku = {
                "type": "plain",
                "text": "1",
                "color": "blue",
                "size": 22,
                "position": "scroll",
                "sender": name,
                "senderId": sender_id,  # 模拟真实后端的 QQ 号（游戏侧以它为主键）
                "is_special": False,
                "blocked": bool(reasons),
                "block_reasons": reasons,
                "message_id": new_message_id(),
            }
            # 把发送任务丢给 asyncio loop
            asyncio.run_coroutine_threadsafe(
                self.send_broadcast_danmaku(danmaku),
                self.loop
            )

    def player_answer(self):
        # 从"刚报名的那批人"里逐个发答案：游戏侧只会采纳真正上场的那几位，
        # 但模拟器不知道抽选结果，所以全都发一遍（和真实群里一样，谁都能说话）
        people = self.current_enroll or [
            {"sender": players[i], "senderId": "sim-player-%d" % (i + 1)} for i in range(6)
        ]
        self.last_answers = []
        # 一批人作答时**不重样**：随机洗牌后按顺序发，人数超过答案条数才循环。
        # 这样"两个上场选手碰巧同一句答案"不会发生，彩排打分环节才稳定
        # （撞车本身是合法情况，但排练时不好复现"至少两条不同答案"）
        shuffled = answers[:]
        random.shuffle(shuffled)
        for i, person in enumerate(people):
            message_id = new_message_id()
            reasons = self.shadow_reasons(person["senderId"])
            danmaku = {
                "type": "plain",
                "text": shuffled[i % len(shuffled)],
                "color": "green",
                "size": 22,
                "position": "scroll",
                "sender": person["sender"],
                "senderId": person["senderId"],
                "is_special": False,
                "blocked": bool(reasons),
                "block_reasons": reasons,
                "message_id": message_id,
            }
            self.last_answers.append({
                "message_id": message_id,
                "sender": person["sender"],
                "senderId": person["senderId"],
                "index": i + 1,  # 选手卡序号（主持人 /clear 用）
            })
            # 把发送任务丢给 asyncio loop
            asyncio.run_coroutine_threadsafe(
                self.send_broadcast_danmaku(danmaku),
                self.loop
            )

    def send_event_frame(self, payload):
        """把「非弹幕」事件帧（撤回 / 贴表情）广播给所有客户端"""
        asyncio.run_coroutine_threadsafe(
            self.send_broadcast_danmaku(payload),
            self.loop
        )

    def recall_answer(self, picked):
        """模拟主持人撤回某一条答案消息"""
        if picked is None:
            print("[!] 还没有选手答案可撤回（先进入回答环节）")
            return
        print("[撤回] %s 的答案 %s" % (picked["sender"], picked["message_id"]))
        self.send_event_frame({
            "type": "recall",
            "message_id": picked["message_id"],
            "sender_id": picked["senderId"],
            "operator_id": admin_uid,
            "channel_id": "弹幕群",
        })

    def recall_last_answer(self):
        """模拟群消息撤回：游戏侧应把大屏上的那条答案撤下来"""
        self.recall_answer(self.last_answers[-1] if self.last_answers else None)

    def like_answer(self, picked, action = "add"):
        """模拟主持人给某条答案贴表情（游戏侧审核用）；action="remove" 表示取消这张表情"""
        if picked is None:
            print("[!] 还没有选手答案可贴表情（先进入回答环节）")
            return
        verb = "取消表情" if action == "remove" else "贴表情"
        print("[%s] %s %s 的答案 %s" % (verb, "取消审核（关闸）" if action == "remove" else "审核",
                                        picked["sender"], picked["message_id"]))
        emoji_id = "128077"  # 👍（QQ 的"回应"就是标准 emoji，id 是 Unicode 码点）
        self.send_event_frame({
            "type": "reaction",
            "action": action,  # 真实后端：Satori reaction-removed / OneBot is_add=false
            "message_id": picked["message_id"],
            "sender_id": admin_uid,
            "sender": admin,
            "emoji": emoji_id,
            # 真后端会一起下发换算好的字符和图片地址，模拟器照做，彩排走的才是真路径
            "emoji_char": emoji_char_of(emoji_id),
            "emoji_url": emoji_image_url_of(emoji_id),
            "channel_id": "弹幕群",
            "is_admin": True,  # 真实后端会带成员角色
        })

    def like_last_answer(self):
        self.like_answer(self.last_answers[-1] if self.last_answers else None)

    def like_first_answer(self):
        self.like_answer(self.last_answers[0] if self.last_answers else None)

    def unlike_last_answer(self):
        """取消最后一条答案上的表情 = 取消审核"""
        self.like_answer(self.last_answers[-1] if self.last_answers else None, action="remove")

    def clear_last_answer(self):
        """模拟主持人用 /clear 清掉某位选手的答案"""
        if not self.last_answers:
            print("[!] 还没有选手答案可清")
            return
        last = self.last_answers[-1]
        self.admin_broadcast("/clear %d" % last["index"])

    def admin_broadcast(self, text = ""):
        danmaku = {
            "type": "plain",
            "text": text,
            "color": "red",
            "size": 28,
            "position": "scroll",
            "sender": admin,
            "senderId": admin_uid,
            "is_special": True,
            "blocked": self.blocked_var.get(),
            "is_admin": True,  # 群主/管理员 → 游戏侧自动认定主持人
            "message_id": new_message_id(),
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
        self.status_var.set("服务器运行中 (ws://localhost:%d)" % SERVER_PORT)
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
        # Tkinter 只能在主线程更新；websockets 处理器跑在 asyncio 线程，
        # 跨线程调用会抛 "main thread is not in main loop"，这里排到主线程执行
        def _set():
            try:
                self.connections_var.set(f"当前连接: {len(connected_clients)}")
            except Exception:
                pass
        try:
            if threading.current_thread() is threading.main_thread():
                _set()
            else:
                self.root.after(0, _set)
        except Exception:
            pass
    
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
                if not self.random_danmaku_enabled:
                    # 排练游戏流程时通常要关掉随机弹幕：回答阶段里上场选手的
                    # 随机发言会被当成"答案"，打分阶段的随机数字会被当成"投票"
                    await asyncio.sleep(0.3)
                    continue
                await self.send_broadcast_danmaku()  # 随机生成并广播
                await asyncio.sleep(0.1 * random.randint(0,5))  # 间隔 2 秒
        except asyncio.CancelledError:
            print("[OK] auto broadcast task stopped")

    def toggle_random_danmaku(self):
        self.random_danmaku_enabled = bool(self.random_danmaku_var.get())
        print("[随机弹幕] %s" % ("开启" if self.random_danmaku_enabled else "关闭（排练游戏流程建议关掉）"))
    
    async def send_broadcast_danmaku(self, danmaku=None):
        global connected_clients
        if not connected_clients:
            return

        if danmaku is None:
            # 生成随机弹幕（模拟真实后端 PlainDanmakuMessage 格式）
            sender = random.choice(users)
            sender_id = "sim-user-%s" % sender  # 稳定身份：同一个人改票/改名都不换 uid
            shadow = self.shadow_reasons(sender_id)
            blocked = bool(shadow) or random.random() < 0.1  # 10% 概率模拟 blocked
            reasons = shadow or ([random.choice(["word_blacklist", "duplicate"])] if blocked else [])
            danmaku = {
                "type": "plain",
                "text": random.choice(texts),
                "color": random.choice(colors),
                "size": random.choice([14, 18, 22, 28]),
                "position": "scroll",
                "sender": sender,
                "senderId": sender_id,
                "is_special": False,
                "blocked": blocked,
                # blocked 的原因（真实后端区分：人黑名单 / 言论黑名单 / 去重）
                "block_reasons": reasons,
                "message_id": new_message_id(),
            }
            if self.game_state == "Rating":
                danmaku["text"] = random.choice(['1', '2', '3', '4', '5', '6', '0'])
        
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
                    print(f"[!] 非JSON消息: {message}")
        except websockets.ConnectionClosed:
            print("[!] 客户端断开连接")
        finally:
            await self.unregister_client(websocket)

    async def receive(self, websocket, data):
        """
        处理接收到的消息。

        支持两种格式：
        - ne-danmaku 格式：{type: "plain"|"game_state_change", text, sender, ...}
        - 旧扁平格式：{text, sender, ...}（自动补全 type="plain"）
        """
        # 兼容旧格式
        if "type" not in data:
            data["type"] = "plain"

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
        async with websockets.serve(self.danmaku_server, "localhost", SERVER_PORT):
            print("[OK] WebSocket 弹幕服务已启动 ws://localhost:%d" % SERVER_PORT)
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
    
