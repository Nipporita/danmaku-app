const GS = Object.freeze({
    Idle: "Idle", // 空闲
    Enroll: "Enroll", // 报名中
    Gaming: Object.freeze({
        Idle: "Gaming-Idle", // 游戏中空闲
        Answering: "Answering", // 回答中
        StopAnswering: "StopAnswering", // 停止回答
        Rating: "Rating", // 打分中
    }),
    isGaming: function(state) {
        return Object.values(GS.Gaming).includes(state);
    }
});

const GSControl = Object.freeze({
    StartEnroll: "开始报名", // 开始报名
    StartGame: "开始游戏", // 开始游戏（= 从报名池抽选并开赛）
    StartRating: "开始打分", // 开始回合
    EndRating: "结束打分", // 结束回合
    NextRound: "下一回合", // 下一回合
    EndGame: "结束游戏", // 结束游戏
});

const ANSWER_SECONDS = 40; // 回答时限（秒）
const RATING_SECONDS = 20; // 打分时限（秒）

const POOL_FACTOR = 2; // 报名池容量 = POOL_FACTOR × 上场人数（扣 1 的人先入池，抽选后才上场）
const SAVE_KEY = "fantasyguide.fourth_righter.save.v1"; // 整局进度存档（落盘在本仓库这一侧）
const SAVE_VERSION = 1;
const LOCAL_CONTROLLER_UID = "local:controller"; // 控制面板本机按钮的合成 uid
const HINT_SECONDS = 5; // 屏上提示停留时长（秒）

var data = null;

var log = console.log

///// WS 部分
let ws = null;
let reconnectTimer = null;
let path = "弹幕群";
let port = 8000;
const WS_URL_Head = "ws://localhost";
let reconnectDelay = 3000; // 初始延迟 3 秒

function connect() {
    const portInput = document.getElementById("port_input");
    const pathInput = document.getElementById("path_input");
    const connectButton = document.getElementById("connect_button");
    if (portInput && portInput.value) {
        const p = parseInt(portInput.value);
        if (!isNaN(p) && p > 0 && p < 65536) {
            port = p;
        } else {
            log("⚠️ 端口号无效，使用默认端口 " + port);
            portInput.value = port;
        }
    }
    if (pathInput && pathInput.value) {
        path = pathInput.value;
    } else {
        log("⚠️ 路径不能为空，使用默认路径 " + path);
        pathInput.value = path;
    }
    // ne-danmaku 真实后端路径为 /api/danmaku/v1/danmaku/{群名}；
    // 本地模拟器不校验路径，因此同一前缀两端通用
    const WS_URL = WS_URL_Head + ":" + port + "/api/danmaku/v1/danmaku/" + encodeURIComponent(path);

    // 先清理旧连接
    disconnect();

    const currentWs = new WebSocket(WS_URL);
    ws = currentWs;

    currentWs.onopen = () => {
        log("✅ 已连接");
        connectButton.style.backgroundColor = "green";
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }
        reconnectDelay = 3000; // 成功连接后重置延迟
    };

    currentWs.onmessage = onMessage;

    currentWs.onclose = () => {
        connectButton.style.backgroundColor = "red";
        log("❌ 连接关闭，尝试重连...");
        if (ws === currentWs) scheduleReconnect();
    };

    currentWs.onerror = (err) => {
        log("⚠️ 出错: " + err.message);
        // 不直接 close，等待 onclose 处理
    };

    updateConnectButtonHint();
}

let connectHinted = false; // 连接按钮当前是否为"参数已改"提示态

function updateConnectButtonHint() {
    // 端口/群名改过但没重新连接时，连接按钮变橙提示
    const connectButton = document.getElementById("connect_button");
    const portInput = document.getElementById("port_input");
    const pathInput = document.getElementById("path_input");
    if (!connectButton || !portInput || !pathInput) return;
    const dirty = portInput.value !== String(port) || pathInput.value !== path;
    if (dirty) {
        connectButton.style.backgroundColor = "#f07f1f"; // 橙色，与玩家配色一致
        connectHinted = true;
    } else if (connectHinted) {
        // 改回与当前生效参数一致：清除橙色，恢复连接状态色（不干扰红/绿）
        connectHinted = false;
        connectButton.style.backgroundColor = (ws && ws.readyState === WebSocket.OPEN) ? "green" : "";
    }
}

function disconnect() {
    if (ws) {
        ws.onclose = null; // 避免触发重连
        ws.onerror = null;
        try {
            ws.close();
        } catch (e) {
            console.warn("关闭旧连接失败:", e);
        }
        ws = null;
    }
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
}

function scheduleReconnect() {
    if (!reconnectTimer) {
        reconnectTimer = setTimeout(() => {
            log(`🔄 正在重连... 延迟 ${reconnectDelay / 1000}s`);
            connect();
            reconnectTimer = null;
            reconnectDelay = Math.min(reconnectDelay * 2, 30000); // 指数退避
        }, reconnectDelay);
    }
}

function gameStateChangeFeedback() {
    sendMessage({
        type: "game_state_change",
        state: GameState,
    });
}

function sendMessage(msg) {
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
    } else {
        log("⚠️ 无法发送消息，WebSocket未连接");
    }
}

////////////////////////////// 身份（uid）模型
//
// 【设计约定】现场一切"人"都以 senderId 为主键：
//   - ne-danmaku / Satori 给的是 event.user.id（QQ 号，稳定不变）
//   - 官方机器人桥给的是 member_openid（同样是稳定 ID）
//   - 本地模拟器 / 手工加人没有 senderId，退化成 "name:<昵称>" 合成 uid
// 昵称只用于显示：改群昵称不会影响身份，也不会丢失分数/答案/主持权。
//
// 历史坑（改用 uid 之前）：昵称即主键，选手比赛中改昵称会导致答案被丢弃、
// 观众改名可以重复投票、任何人把昵称改成 "Admin" 就能操控整局游戏。

var Users = {};            // uid -> 最近一次见到的昵称
var ControllerUids = {};   // uid -> true（主持人，含后续自动识别的群管理员）
var ControllerNames = {};  // 昵称 -> true（控制面板手动填写；命中一次即绑定到该 uid）

function uidOf(data) {
    if (!data) return null;
    if (typeof data.senderId === "string" && data.senderId !== "") {
        return "id:" + data.senderId;
    }
    if (typeof data.sender === "string" && data.sender !== "") {
        return "name:" + data.sender;
    }
    return null;
}

function rememberUser(uid, name) {
    if (!uid || typeof name !== "string" || name === "") return;
    // 昵称里也可能被塞行内元素（<face .../>），一样换成 █ —— 名字是要上大屏的
    name = stripInlineElements(name);
    var old = Users[uid];
    if (old === name) return;
    Users[uid] = name;
    if (old !== undefined) refreshUserNamesInDocument(uid); // 改名：只刷新显示，数据不动
    updateControllerDisplay();
}

function userName(uid) {
    if (uid === undefined || uid === null) return "";
    if (Users[uid] !== undefined) return Users[uid];
    if (typeof uid === "string" && uid.indexOf("name:") === 0) return uid.slice(5);
    return String(uid);
}

function senderIdOf(uid) {
    // uid -> 原始 senderId（手工加人 / 模拟器来的 name: uid 没有 senderId，返回 ""）
    return (typeof uid === "string" && uid.indexOf("id:") === 0) ? uid.slice(3) : "";
}

function isControllerUid(uid) {
    // 权威判定：只有绑定过的 uid 才算主持人（报名/投票/抽选的排除都用它）
    return !!uid && !!ControllerUids[uid];
}

function isControlWord(text) {
    if (typeof text !== "string") return false;
    // 群里发的控制词常被 QQ 追个表情，上游会变成 <face .../> 贴在末尾：
    // 匹配指令时把行内元素整个剔掉（不是换成 █），否则「开始报名<face/>」就认不出来了
    var clean = stripInlineElements(text, "").trim();
    if (Object.values(GSControl).includes(clean)) return true;
    return /^\/(set|remove|clear)\s*[1-6]\s*$/.test(clean);
}

function isController(uid, name, text) {
    // 指令分发用：uid 已绑定 → 是；否则昵称与手动填写的一致**且说的是控制词**才认，
    // 认下的同时把 uid 绑死（之后改昵称也不丢主持权）。
    // 只按昵称就认会让"把群昵称改成 Admin"直接拿到主持权，所以加了控制词这道门槛。
    if (!uid) return false;
    if (ControllerUids[uid]) return true;
    if (name && ControllerNames[name] && isControlWord(text)) {
        ControllerUids[uid] = true;
        updateControllerDisplay();
        return true;
    }
    return false;
}

function setControllerNickname() {
    const input = document.getElementById("controller_nickname_input");
    if (!input) return;
    var name = input.value.trim();
    Controller = name;
    ControllerNames = {};
    if (name) ControllerNames[name] = true;
    updateControllerDisplay();
}

function updateControllerDisplay() {
    var el = document.getElementById("controller_show");
    if (!el) return;
    var bound = Object.keys(ControllerUids)
        .filter(function (uid) { return uid !== "id:" + LOCAL_CONTROLLER_UID; })
        .map(userName);
    var text = "主持人：" + (Controller ? Controller : "（未设置）");
    if (bound.length > 0) text += "｜已绑定 " + bound.join("、");
    el.innerText = text;
}

// 控制面板上的本机按钮：等同主持人本人发指令
function onControllerCommand(text) {
    onMessage({
        data: JSON.stringify({ sender: Controller, senderId: LOCAL_CONTROLLER_UID, text: text })
    });
}

function messageIdOf(frame) {
    // 撤回/贴表情都要靠 message_id 把"群里的那条消息"对回"大屏上的这个答案"
    if (!frame) return "";
    var mid;
    if (frame.message_id !== undefined) mid = frame.message_id;
    else if (frame.messageId !== undefined) mid = frame.messageId;
    else mid = frame.id;
    return (mid === undefined || mid === null) ? "" : String(mid);
}

// 前端逻辑
const MinPlayers = 4; // 最少玩家数
const MaxPlayersLimit = 6; // 最大玩家数上限
var MaxPlayers = 6; // 最大玩家数（控制面板 ± 或主持人 /set 指令可调 4~6）

var Controller = "Admin"; // 主持人昵称（手动指定用的兜底；真正判定见 isController）
var Candidates = []; // 报名池：扣 1 报名者的 uid，先到先得
var PlayersDrawn = false; // 本局是否已经抽选完毕（报名池满自动抽 / 主持人手动抽）
var ShadowBanned = {}; // uid -> true，被"影子封禁"的人（人黑名单）：照常报名、照常上候选区，
                       // 但抽选时优先跳过；只有"非黑名单的人凑不够 N 个"才让他补位
var Played = {}; // uid -> 昵称，已经玩过的人（跨局累计，落盘）
var Players = {}; // uid -> true，本局上场选手（开赛时冻结）
var PlayerOrder = []; // 本局选手 uid 顺序（决定配色、卡片序）
var PlayersScores = {}; // uid -> 分数（内部单位）
var PlayersAnswers = {}; // uid -> {text, messageId, approved}：派生出的"当前生效答案"，供打分结算用
// 一个选手可能发多条答案（改主意、或者补一句）。这里保留**全部**答案记录：
//   AnswerHistory[uid] = [{ text, messageId, approved, at }, ...]（按提交顺序）
// 规则：主持人给哪条贴表情，哪条就"上去"（最新的过审者生效）；一条都没过审时显示最新提交的那条。
// AnswersByMessage 让撤回 / 审核帧按 messageId 直接定位到**那一条**记录 —— 只定位到人的话，
// 给旧答案贴表情会错误地作用在新答案上（这是修掉的一个真 bug）。
var AnswerHistory = {}; // uid -> [记录]
var AnswersByMessage = {}; // messageId -> 记录（同一条记录的引用）
var ApprovalSeq = 0; // 审核顺序计数器：多次贴表情时，靠它判断"哪次是最后一次"
var Answers = []; // 本轮不同答案列表
var AnswersPlayers = {}; // 答案 -> [uid]
var Answers4Rank = []; //用于排序的答案列表
var AnswersScores = {}; // 答案 -> 分数（内部单位）
var GameState = GS.Idle; // 游戏状态
var CurrentRound = 0; // 当前回合数
var UsedQuestions = []; // 已经出过的题目（落盘，跨局不重复）
var questionPool = []; // 本场还没出过的问题（元素形如 { text, by }）
var question = null; // 当前问题（题目正文）
var questionAuthor = ""; // 当前问题的出题人（大屏上单独一行显示）

var CountingDownInterval = null; // 倒计时定时器

var messageQueue = []; // 消息队列
var processingMessage = false; // 是否正在处理消息

var AudiencesRating = {}; // uid -> 答案，观众评分
var ratingRevealDone = true; // 打分答案是否已浮现完成（浮现期间不重排/伸缩）

// ④ 答题审核：选手答完只是「待审核」，必须由主持人给那条消息贴表情（任意表情）
// 才算「已回答」；没通过的答案留在大屏上但不参与打分。
// 回答环节结束后、打分开始之前贴表情同样有效。
var AuditEnabled = true; // 控制面板可关（彩排/主持人不方便贴表情时的退路）

function resetAudiencesRating() {
    AudiencesRating = {};
}

function refillQuestionPool() {
    // 只把"没出过"的题放进池子：跨局、跨刷新都不重复
    // 题库条目形如 { text: "题目", by: "出题人" }，UsedQuestions 里存的是题目文本
    var unused = allQuestions.filter(function (q) { return UsedQuestions.indexOf(q.text) === -1; });
    if (unused.length === 0) {
        // 题目全出过一遍才会走到这里，只能重头再来
        log("⚠️ 题库已全部出过一遍，重新洗牌");
        UsedQuestions = [];
        unused = allQuestions.slice();
    }
    questionPool = unused;
}

function resetQuestions() {
    // 显式重置题库（控制面板按钮：彩排完清空出题记录）
    UsedQuestions = [];
    refillQuestionPool();
    saveState();
}

function resetAnswers() {
    PlayersAnswers = {};
    AnswerHistory = {};
    AnswersByMessage = {};
    AnswersScores = {};
    Answers = [];
    AnswersPlayers = {};
    clearAnswers();
}

function getActivePlayerElements(s) {
    return Array.from(document.querySelectorAll(s + ":not(#player_template " + s + ")"));
}

function getActiveAnswerElements(s) {
    // 排除模板与末尾的"本轮问题"提示条（它不参与计分/排序）
    return Array.from(document.querySelectorAll(
        s + ":not(#answer_template " + s + "):not(.question_row):not(.question_row " + s + ")"));
}

function playerRows() {
    // #player_template 在 #players_wrap 之外，所以这里的行都是真玩家
    return Array.from(document.querySelectorAll("#players_wrap .player_content"));
}

function playerElements() {
    return Array.from(document.querySelectorAll("#players_wrap .player"));
}

function rowUid(row) {
    return (row && row.dataset && row.dataset.uid) ? row.dataset.uid : "";
}

function playerUidsInDocument() {
    return playerRows().map(rowUid).filter(function (uid) { return uid !== ""; });
}

function playerNamesInDocument() {
    return playerRows().map(function (row) {
        var input = row.getElementsByClassName("player_name")[0];
        return input ? input.value : "";
    });
}

function chooseQuestion() {
    if (questionPool.length === 0) refillQuestionPool();
    var idx = Math.floor(Math.random() * questionPool.length);
    var picked = questionPool[idx];
    question = picked.text;
    questionAuthor = picked.by || "";   // 出题人：大屏上单独一行显示
    questionPool.splice(idx, 1); // 移除已出题目
    if (UsedQuestions.indexOf(question) === -1) UsedQuestions.push(question);
    saveState();
    return updateQuestionInDocument();
}

function Enroll() {
    // 开始报名：清空上一局的选手席与报名池
    removePlayersInDocument();
    Candidates = [];
    PlayersDrawn = false;
    CurrentRound = 0; // 新的一局从第 0 回合起（开赛时 newGame 会置 1）
    const rounds = document.getElementById("rounds");
    if (rounds) rounds.innerText = CurrentRound;
    renderCandidates();
    showAddPlayerButton();
    saveState();
}

function poolTarget() {
    return MaxPlayers * POOL_FACTOR;
}

function enrollCandidate(data) {
    // 报名（扣 1）：只进报名池，抽选后才上场
    if (GameState !== GS.Enroll) return;
    if (PlayersDrawn) return; // 本局已经抽完
    var uid = uidOf(data);
    if (!uid) return;
    if (isControllerUid(uid)) return; // ⑥ 主持人不能报名
    if (Played[uid] !== undefined) { // ② 已玩过的人自动排除，并在屏上给个交代
        showHint("⏭️ " + userName(uid) + " 已经玩过啦，本轮不参与抽选");
        return;
    }
    if (Candidates.indexOf(uid) !== -1) return; // 已在池中
    if (Candidates.length >= poolTarget()) {
        showHint("报名池已满（" + poolTarget() + " 人），" + userName(uid) + " 的 1 没挤进来");
        return;
    }
    Candidates.push(uid);
    renderCandidates();
    saveState();
    if (Candidates.length >= poolTarget()) {
        // ① 报名进度满了：直接抽选，N 张选手卡当场出现在大屏上
        autoDrawPlayers();
    }
}

function seatPlayers(uids) {
    Candidates = [];
    PlayersDrawn = true;
    removePlayersInDocument();
    for (var i = 0; i < uids.length; i++) {
        addPlayer(userName(uids[i]), uids[i]);
    }
    renderCandidates();
    saveState();
}

function eligibleCandidates() {
    // 报名池里可上场的人：没玩过、不是主持人
    return Candidates.filter(function (uid) {
        return Played[uid] === undefined && !isControllerUid(uid);
    });
}

function pickDrawn(pool, n) {
    // 抽 n 个人。人黑名单（影子封禁）的人**永远不上台**：
    // 宁可这局少人，也不让被禁言的人拿到话筒（指不定说出什么）。
    // 干净的人不足 n 时就按实际人数上场，主持人可以用面板「添加玩家」补人。
    var clean = pool.filter(function (uid) { return !ShadowBanned[uid]; });
    var shadowCount = pool.length - clean.length;
    var picked = sampleN(clean, Math.min(n, clean.length));
    if (shadowCount > 0 && picked.length < n) {
        log("⚠️ 可用报名者 " + clean.length + " 人（不足 " + n + " 人），" +
            "影子黑名单里还有 " + shadowCount + " 人，本局不上场");
    }
    return picked;
}

function chooseRoster() {
    // 本局上场名单
    var pool = eligibleCandidates();
    var n = Math.min(MaxPlayers, pool.length);
    return n > 0 ? pickDrawn(pool, n) : [];
}

function autoDrawPlayers() {
    // 报名池满 → 直接随机抽 MaxPlayers 人上场（不用等主持人点「开始游戏」）
    var drawn = chooseRoster();
    seatPlayers(drawn);
    log("🎲 报名进度已满，自动抽选：" + drawn.map(userName).join("、"));
    // 少人时不点名、也不说"有人被过滤"，只报实际人数
    showHint(drawn.length < MaxPlayers
        ? "本局 " + drawn.length + " 人上场"
        : "🎲 抽选完成：" + drawn.map(userName).join("、"));
}

function sampleN(list, n) {
    // 从 list 里随机取 n 个（不重复），不改动原数组
    var pool = list.slice();
    var picked = [];
    for (var i = 0; i < n && pool.length > 0; i++) {
        var idx = Math.floor(Math.random() * pool.length);
        picked.push(pool[idx]);
        pool.splice(idx, 1);
    }
    return picked;
}

function startGameFromPool() {
    // 开始游戏：进度满了的话已经抽完了，这里只负责开赛；
    // 没满就现在抽（允许人数没凑够 2N 时提前开，但至少 MinPlayers 人）
    if (!PlayersDrawn) {
        var pool = eligibleCandidates();
        if (pool.length < MinPlayers) {
            alert("报名人数不足：至少需要 " + MinPlayers + " 人才能开局（当前 " + pool.length + " 人）。\n" +
                  "让大家扣 1 报名，或用控制面板把人数调低。");
            return false;
        }
        var drawn = chooseRoster();
        seatPlayers(drawn);
        log("🎲 抽选结果：" + drawn.map(userName).join("、"));
        if (drawn.length < MaxPlayers) {
            showHint("报名没满，" + drawn.length + " 人开赛");
        }
    } else if (playerRows().length < MinPlayers) {
        alert("上场人数不足 " + MinPlayers + " 人，无法开始");
        return false;
    }
    return true;
}

////////// 落盘：整局存档（需求⑦）
//
// 存档放在本地 localStorage（danmaku-app 这一侧），不依赖后端：
// 大屏浏览器崩了 / 误刷新，F5 之后自动回到原来的局面。
// 存的东西：已玩过名单、出过的题、当前问题、状态机、报名池、选手与分数、答案、投票。
var Restoring = false; // 恢复存档期间不要回写，避免把半成品盖到存档上
var CountdownDeadline = null; // 当前阶段倒计时的截止时刻（epoch ms），用于恢复计时

function currentRosterUids() {
    var dom = playerUidsInDocument();
    return dom.length > 0 ? dom : PlayerOrder.slice();
}

function snapshotState() {
    return {
        version: SAVE_VERSION,
        savedAt: Date.now(),
        gameState: GameState,
        currentRound: CurrentRound,
        maxPlayers: MaxPlayers,
        controllerNames: Object.keys(ControllerNames),
        controllerUids: Object.keys(ControllerUids),
        users: Users,
        played: Played,
        usedQuestions: UsedQuestions,
        question: question,
        questionAuthor: questionAuthor,
        candidates: Candidates,
        playersDrawn: PlayersDrawn,
        shadowBanned: ShadowBanned,
        playerOrder: currentRosterUids(),
        players: Players,
        playersScores: PlayersScores,
        playersAnswers: PlayersAnswers,
        answers: Answers,
        answersPlayers: AnswersPlayers,
        answersScores: AnswersScores,
        audiencesRating: AudiencesRating,
        auditEnabled: AuditEnabled,
        answerHistory: AnswerHistory,
        countdownDeadline: CountdownDeadline,
        cards: playerRows().map(function (row) {
            var uid = rowUid(row);
            var nameInput = row.getElementsByClassName("player_name")[0];
            var answerInput = row.getElementsByClassName("player_answer")[0];
            return {
                uid: uid,
                name: nameInput ? nameInput.value : userName(uid),
                answer: answerInput ? answerInput.value : "",
                messageId: (answerInput && answerInput.dataset) ? (answerInput.dataset.messageId || "") : "",
                approved: !!(answerInput && answerInput.dataset && answerInput.dataset.approved === "1"),
            };
        }),
    };
}

function saveState() {
    if (Restoring) return;
    try {
        localStorage.setItem(SAVE_KEY, JSON.stringify(snapshotState()));
    } catch (e) {
        console.warn("写入存档失败:", e);
    }
}

function loadSave() {
    try {
        var raw = localStorage.getItem(SAVE_KEY);
        if (!raw) return null;
        var obj = JSON.parse(raw);
        if (!obj || obj.version !== SAVE_VERSION) return null;
        return obj;
    } catch (e) {
        console.warn("读取存档失败:", e);
        return null;
    }
}

function clearSave() {
    try {
        localStorage.removeItem(SAVE_KEY);
    } catch (e) {
        console.warn("清除存档失败:", e);
    }
}

function rebuildAnswersByMessage() {
    AnswersByMessage = {};
    for (var uid in AnswerHistory) {
        var records = AnswerHistory[uid] || [];
        for (var i = 0; i < records.length; i++) {
            if (records[i] && records[i].messageId) AnswersByMessage[records[i].messageId] = records[i];
        }
    }
}

function roundAnswer(uid) {
    // 本轮算数的答案 = 这个人在回答环节说的**第一条**。
    // 主持人的表情只是「闸」，不负责挑内容；顺序完全由回答顺序决定，
    // 所以不存在"把答案换成另一条"的余地（想换只能撤回第一条）。
    var records = AnswerHistory[uid] || [];
    return records.length ? records[0] : null;
}

function gateOpen(uid) {
    // 闸门状态：这位选手的答案被主持人贴过表情（取消表情 = 关闸）
    var records = AnswerHistory[uid] || [];
    for (var i = 0; i < records.length; i++) {
        if (records[i].approved) return true;
    }
    return false;
}

function playerCard(uid) {
    return playerRows().filter(function (r) { return rowUid(r) === uid; })[0];
}

function refreshPlayerCard(uid) {
    // 卡片上显示的永远是"第一条答案"，右上角标的是闸门状态
    var row = playerCard(uid);
    var rec = roundAnswer(uid);
    var open = gateOpen(uid);
    var text = rec ? rec.text : "";
    if (row) {
        var answerInput = row.getElementsByClassName("player_answer")[0];
        var answerShow = row.getElementsByClassName("player_answer_show")[0];
        if (answerInput) {
            answerInput.value = text;
            if (rec && rec.messageId) answerInput.dataset.messageId = rec.messageId;
            else delete answerInput.dataset.messageId;
            if (open) answerInput.dataset.approved = "1";
            else delete answerInput.dataset.approved;
        }
        if (answerShow) {
            answerShow.innerText = text;
            fixTextWidth(answerShow, 0);
        }
    }
    if (text === "") delete PlayersAnswers[uid];
    else PlayersAnswers[uid] = {
        text: text,
        messageId: (rec && rec.messageId) || "",
        approved: open,
    };
    updatePlayerAuditInDocument();
}

function restoreFromSave(save) {
    Restoring = true;
    try {
        Users = save.users || {};
        Played = save.played || {};
        UsedQuestions = save.usedQuestions || [];
        MaxPlayers = save.maxPlayers || MaxPlayers;
        CurrentRound = save.currentRound || 0;
        question = (save.question === undefined) ? null : save.question;
        questionAuthor = save.questionAuthor || "";
        // 昵称兜底只在存档确实存了主持人昵称时才覆盖，坏档/半档不会把主持人弄丢
        if (save.controllerNames && save.controllerNames.length > 0) {
            ControllerNames = {};
            save.controllerNames.forEach(function (n) { if (n) ControllerNames[n] = true; });
        }
        ControllerUids = {};
        (save.controllerUids || []).forEach(function (u) { if (u) ControllerUids[u] = true; });
        ControllerUids["id:" + LOCAL_CONTROLLER_UID] = true;
        var nameInput = document.getElementById("controller_nickname_input");
        Controller = (save.controllerNames && save.controllerNames[0]) ? save.controllerNames[0] : Controller;
        if (nameInput) nameInput.value = Controller;

        // 1) 先按存档把选手卡原样重建（名字/答案都是当时屏幕上的样子）
        var playersWrap = document.getElementById("players_wrap");
        playersWrap.innerHTML = "";
        (save.cards || []).forEach(function (c) {
            var uid = addPlayer(c.name || "", c.uid || null);
            if (!uid) return;
            if (c.answer) {
                var row = playerRows()[playerRows().length - 1];
                var answerInput = row.getElementsByClassName("player_answer")[0];
                var answerShow = row.getElementsByClassName("player_answer_show")[0];
                if (answerInput) {
                    answerInput.value = c.answer;
                    if (c.messageId) answerInput.dataset.messageId = c.messageId;
                    if (c.approved) answerInput.dataset.approved = "1";
                }
                if (answerShow) answerShow.innerText = c.answer;
            }
        });

        // 2) 再恢复各种状态
        Candidates = save.candidates || [];
        PlayersDrawn = !!save.playersDrawn;
        ShadowBanned = save.shadowBanned || {};
        PlayerOrder = currentRosterUids();
        Players = {};
        PlayerOrder.forEach(function (u) { Players[u] = true; });
        PlayersScores = save.playersScores || {};
        PlayersAnswers = save.playersAnswers || {};
        Answers = save.answers || [];
        AnswersPlayers = save.answersPlayers || {};
        AnswersScores = save.answersScores || {};
        AudiencesRating = save.audiencesRating || {};
        AuditEnabled = (save.auditEnabled === undefined) ? AuditEnabled : !!save.auditEnabled;
        // 答案历史：有就按它恢复（一个选手的多条答案 + 审核状态都在这里），
        // 老存档没有这个字段时退化成"每人一条"（下面按 cards 恢复）
        AnswerHistory = save.answerHistory || {};
        rebuildAnswersByMessage();
        // 审核顺序计数器接着存档里的最大值往后走（否则重启后新贴的表情会被当成"更早的"）
        ApprovalSeq = 0;
        for (var u in AnswerHistory) {
            (AnswerHistory[u] || []).forEach(function (rec) {
                if (rec.approved && (rec.approvedAt || 0) > ApprovalSeq) ApprovalSeq = rec.approvedAt;
            });
        }
        // 有答案历史的选手，卡片按"生效答案"重画一遍（手工敲进去的答案没有历史，保持原样）
        PlayerOrder.forEach(function (u) {
            if (AnswerHistory[u] && AnswerHistory[u].length) refreshPlayerCard(u);
        });
        CountdownDeadline = save.countdownDeadline || null;

        // 3) 最后恢复状态机与界面
        GameState = save.gameState || GS.Idle;
        refillQuestionPool();
        updateQuestionInDocument();
        updatePlayersScoresInDocument();
        updatePlayerAuditInDocument(); // 恢复「待审核 / 已通过」标记
        updateGameStateInDocument();

        if (GameState === GS.Gaming.Answering) {
            hideAddPlayerButton();
            frozenPlayers();
            unfrozenAnswers();
            resumeCountdown("answering");
        } else if (GameState === GS.Gaming.StopAnswering) {
            hideAddPlayerButton();
            frozenPlayers();
            frozenAnswers();
        } else if (GameState === GS.Gaming.Rating) {
            hideAddPlayerButton();
            frozenPlayers();
            frozenAnswers();
            createAnswersInDocument();
            ratingRevealDone = true;
            updateAnswersScores();
            resumeCountdown("rating");
        } else if (GS.isGaming(GameState)) {
            hideAddPlayerButton();
            frozenPlayers();
            frozenAnswers();
            updateAnswersScores();
        } else {
            showAddPlayerButton();
            unfrozenPlayers();
        }
        log("💾 已从存档恢复（" + new Date(save.savedAt || Date.now()).toLocaleString() + " 保存）");
    } finally {
        Restoring = false;
    }
}

function resumeCountdown(phase) {
    // 崩溃/刷新时没走完的倒计时接着走
    var left = 0;
    if (CountdownDeadline) left = Math.round((CountdownDeadline - Date.now()) / 1000);
    if (left <= 0) {
        if (phase === "rating") endRating();
        else StopAnswering();
        return;
    }
    countingDown(left).then(function () {
        if (phase === "rating") endRating();
        else StopAnswering();
    });
}

////////// 「已玩过」名单（跨局累计，落盘）
function markPlayed(uids) {
    if (!uids || uids.length === 0) return;
    for (var i = 0; i < uids.length; i++) {
        Played[uids[i]] = userName(uids[i]);
    }
    saveState();
    renderCandidates();
}

function clearPlayed() {
    Played = {};
    saveState();
    renderCandidates();
    log("🧹 已清空「已玩过」名单");
}

function renderCandidates() {
    const list = document.getElementById("candidates_list");
    const status = document.getElementById("candidates_status");
    const count = document.getElementById("candidates_count");
    const target = document.getElementById("candidates_target");
    const bar = document.getElementById("candidates_progress_bar");

    var chips;
    if (PlayersDrawn) {
        chips = playerUidsInDocument();
    } else {
        chips = Candidates.slice();
    }
    if (list) {
        list.innerHTML = "";
        chips.forEach(function (uid) {
            var chip = document.createElement("div");
            chip.className = "candidate_chip" + (PlayersDrawn ? " drawn" : "");
            chip.innerText = userName(uid);
            list.appendChild(chip);
        });
    }

    if (PlayersDrawn) {
        if (status) status.innerText = "抽选完成，等待主持人开始游戏";
        if (count) count.innerText = chips.length;
        if (target) target.innerText = chips.length;
        if (bar) bar.style.width = "100%";
    } else {
        if (status) status.innerText = "报名中";
        if (count) count.innerText = Candidates.length;
        if (target) target.innerText = poolTarget();
        if (bar) {
            bar.style.width = (poolTarget() === 0 ? 0 : (Candidates.length / poolTarget() * 100)) + "%";
        }
    }

    const playedCount = document.getElementById("played_count");
    var playedNames = Object.keys(Played).map(function (uid) { return Played[uid]; });
    if (playedCount) playedCount.innerText = playedNames.length;
    const playedNamesEl = document.getElementById("played_names");
    if (playedNamesEl) {
        playedNamesEl.innerText = playedNames.length > 0 ? "：" + playedNames.join("、") : "";
    }
}

////////// 屏上提示（后一条直接盖掉前一条，避免刷屏）
var HintTimer = null;

function showHint(text) {
    var el = document.getElementById("hint_wrap");
    if (!el || !text) return;
    el.innerText = text;
    el.classList.add("show");
    if (HintTimer) clearTimeout(HintTimer);
    HintTimer = setTimeout(function () {
        el.classList.remove("show");
        HintTimer = null;
    }, HINT_SECONDS * 1000);
}

function refreshUserNamesInDocument(uid) {
    // 改名后同步已上场的玩家卡显示（分数/答案都按 uid 存，不受影响）
    var name = userName(uid);
    playerRows().forEach(function (row) {
        if (rowUid(row) !== uid) return;
        var nameInput = row.getElementsByClassName("player_name")[0];
        var nameShow = row.getElementsByClassName("player_name_show")[0];
        if (nameInput) nameInput.value = name;
        if (nameShow) {
            nameShow.innerText = name;
            fixTextWidth(nameShow);
        }
    });
}

function removePlayerByIndex(index) {
    // 去掉第 index 个玩家（按玩家卡顺序，从 1 起）：
    // 报名阶段 = 取消报名；回答/停止回答阶段 = 直接退赛删除（最终解决方案）
    const rows = playerRows();
    const row = rows[index - 1];
    if (!row) return;
    // 同步清理该玩家的内部数据，避免删除后以"幽灵"身份参与后续计分：
    //   PlayersScores —— 历史分会污染最高分（进度条比例 / 夺冠判定）
    //   PlayersAnswers —— 已记录的答案会在 endRating 时被幽灵分票
    //   Players / PlayerOrder —— 冻结玩家列表，防止同名观众被误判为玩家
    const uid = rowUid(row);
    if (uid) {
        delete PlayersScores[uid];
        delete PlayersAnswers[uid];
        (AnswerHistory[uid] || []).forEach(function (rec) {
            if (rec.messageId) delete AnswersByMessage[rec.messageId];
        });
        delete AnswerHistory[uid];
        delete Players[uid];
        PlayerOrder = PlayerOrder.filter(function (u) { return u !== uid; });
    }
    deletePlayer(row);
    // 游戏进行中不恢复"添加玩家"按钮（仅报名阶段需要）
    if (GS.isGaming(GameState)) hideAddPlayerButton();
}

function clearPlayerAnswerByUid(uid) {
    // /clear [i]：把这个选手的**全部**答案（含历史）都清掉
    if (!uid) return;
    (AnswerHistory[uid] || []).forEach(function (rec) {
        if (rec.messageId) delete AnswersByMessage[rec.messageId];
    });
    delete AnswerHistory[uid];
    delete PlayersAnswers[uid];
    playerRows().forEach(function (row) {
        if (rowUid(row) !== uid) return;
        var answerInput = row.getElementsByClassName("player_answer")[0];
        var answerShow = row.getElementsByClassName("player_answer_show")[0];
        if (answerInput) {
            answerInput.value = "";
            delete answerInput.dataset.messageId;
            delete answerInput.dataset.approved; // 连审核状态一起作废
        }
        if (answerShow) answerShow.innerText = "";
    });
    updatePlayerAuditInDocument();
}

function clearPlayerAnswerByIndex(index) {
    // 清掉第 index 个玩家的答案（回答/停止回答阶段，防弹幕事故）
    const rows = playerRows();
    const row = rows[index - 1];
    if (!row) return;
    var uid = rowUid(row);
    clearPlayerAnswerByUid(uid);
    if (uid) delete PlayersAnswers[uid]; // 同步清除已记录的答案
}

function countDistinctAnswers() {
    // 已作答的不同答案数量（空答案不计）
    const answers = getActivePlayerElements(".player_answer")
        .map(i => i.value.trim())
        .filter(v => v !== "");
    return new Set(answers).size;
}

function StopAnswering() {
    // 答案不足（≤1 个不同答案）时没有可打分的竞争，直接进入回合间歇
    if (countDistinctAnswers() <= 1) {
        GameState = GS.Gaming.Idle;
        countingDown(0); // 停止计时
        frozenAnswers();
        updateGameStateInDocument();
        return;
    }
    GameState = GS.Gaming.StopAnswering;
    updateGameStateInDocument();
    frozenAnswers();
}

async function newGame() {
    CurrentRound = 1;
    const rounds = document.getElementById("rounds");
    rounds.innerText = CurrentRound;
    frozenPlayers();
    PlayerOrder = playerUidsInDocument();
    Players = Object.fromEntries(PlayerOrder.map(uid => [uid, true]));
    PlayersScores = Object.fromEntries(PlayerOrder.map(uid => [uid, 0]))
    resetAnswers();
    resetAudiencesRating();
    hideAddPlayerButton();
    unfrozenAnswers();
    chooseQuestion(); // 题目跨局不重复（出过的题记在 UsedQuestions 里）
    saveState();
    await countingDown(ANSWER_SECONDS);
    StopAnswering();
}

function endGame() {
    markPlayed(PlayerOrder); // ② 本局上场的人记入「已玩过」，下一局自动排除
    unfrozenPlayers();
    resetAnswers();
    resetAudiencesRating();
    removeAnswersInDocument();
    showAddPlayerButton();
    PlayersDrawn = false;
    set_congratulations();
    countingDown(0); // 停止计时
    saveState();
}

async function nextRound() {
    if (Answers.length !== 0) {
        CurrentRound += 1;
    }
    const rounds = document.getElementById("rounds");
    rounds.innerText = CurrentRound;
    const instructionsElement = Array.from(document.getElementsByClassName("answer_guide"));
    instructionsElement.forEach(e => {e.style.opacity = '';})
    resetAnswers();
    resetAudiencesRating();
    removeAnswersInDocument();
    unfrozenAnswers();
    chooseQuestion();
    await countingDown(ANSWER_SECONDS);
    StopAnswering();
}

async function startRating() {
    frozenAnswers();
    const instructionsElement = Array.from(document.getElementsByClassName("answer_guide"));
    instructionsElement.forEach(e => {e.style.opacity = '';})
    var rows = playerRows();
    PlayersAnswers = {}; // 从当前 DOM（= 各人生效答案）重建
    rebuildAnswersByMessage();
    Answers = [];
    AnswersPlayers = {};
    for (var i = 0; i < rows.length; i++) {
        var uid = rowUid(rows[i]);
        if (!uid) continue;
        var answerInput = rows[i].getElementsByClassName("player_answer")[0];
        var answer = normalizeAnswer(answerInput ? answerInput.value : "");
        var mid = (answerInput && answerInput.dataset && answerInput.dataset.messageId) ? answerInput.dataset.messageId : "";
        // ④ 只有主持人贴过表情（审核通过）的答案才进入打分列表
        var approved = !AuditEnabled || !!(answerInput && answerInput.dataset && answerInput.dataset.approved === "1");
        PlayersAnswers[uid] = { text: answer, messageId: mid, approved: approved };
        if (answer !== "" && approved) {
            if (!Answers.includes(answer)) {
                Answers.push(answer);
                AnswersPlayers[answer] = [uid];
            } else {
                AnswersPlayers[answer].push(uid);
            }
        }
    }
    if (Answers.length <= 1) {
        // 答案不足（≤1 个不同答案，或审核通过的答案不够）时没有可打分的竞争，直接进入回合间歇
        if (AuditEnabled) {
            var raw = playerRows().filter(function (row) {
                var input = row.getElementsByClassName("player_answer")[0];
                return input && input.value.trim() !== "";
            }).length;
            if (raw > 1) {
                showHint("已通过审核的答案不足，先给群里的答案消息贴个表情再开始打分");
            }
        }
        countingDown(0); // 停止计时
        frozenAnswers();
        GameState = GS.Gaming.Idle;
        updateGameStateInDocument();
        return;
    }
    countingDown(0); // 停止计时
    AnswersScores = Object.fromEntries(Answers.map(i => [i, 0]));
    Answers4Rank = Answers.slice(); // 复制一份用于排序
    createAnswersInDocument();
    // 先让答案条安静浮现（FadeIn 2s），浮现完成后再开始随票数排序/伸缩
    ratingRevealDone = false;
    setTimeout(() => {
        ratingRevealDone = true;
        updateAnswersScores(); // 把浮现期间收到的票一次性补上
    }, 2000);
    await countingDown(RATING_SECONDS);
    endRating();
}

function endRating() {
    GameState = GS.Gaming.Idle;
    countingDown(0); // 停止计时
    for (var uid in PlayersAnswers) {
        var pa = PlayersAnswers[uid];
        var text = (pa && typeof pa === "object") ? pa.text : pa; // 兼容旧结构（纯字符串）
        if (!(uid in PlayersScores)) continue; // 中途退赛的玩家不再计分
        if (text in AnswersScores) {
            // 同答案平均分票：该答案的得分由给出此答案的选手均分（60 能被人数整除）
            PlayersScores[uid] += AnswersScores[text] / AnswersPlayers[text].length;
        }
    }
    updatePlayersScoresInDocument();
    saveState();
}

function onMessage(e) {
    messageQueue.push(e);
    if (!processingMessage) {
        processingMessage = true;
        processNextMessage();
    }
}

function processNextMessage() {
    if (messageQueue.length === 0) {
        processingMessage = false; // 队列处理完成
        return;
    }

    var me = messageQueue.shift(); // 获取队列中的第一个消息
    processMessage(me)
        .then(() => {
            processNextMessage();  // 当前消息处理完成，继续处理下一个
        })
        .catch(err => {
            console.error("Error in processing message:", err);
            processNextMessage(); // 错误处理后，继续处理下一个消息
        });
}

function processMessage(e) {
    return new Promise((resolve, reject) => {
        try {
            data = e.data;
            if (typeof data !== "string") {
                reject(new Error("Received data is not a string"));
                return;
            }
            data = JSON.parse(data);
            // 事件帧（撤回 / 贴表情审核）没有 sender，先分流，不进弹幕逻辑
            if (handleEventFrame(data)) {
                resolve();
                return;
            }
            // 适配 ne-danmaku：settings/control 等帧没有 sender（也可能为 null），不参与游戏逻辑
            if (typeof data.sender !== "string" || data.sender === "") {
                resolve();
                return;
            }
            // 👑 是后端给"特殊弹幕"（管理端/上游发出）追加的展示标记，
            // 游戏层剥掉尾部标记后再匹配控制词 / 报名 / 答题 / 投票。
            // 注意必须带 u 标志：👑 是代理对，不带 u 时 + 只作用于后半个码元，
            // 连续两个 👑 只能剥掉一个（真实后端只补一个，这里是防御性写法）
            if (typeof data.text === "string") {
                data.text = data.text.replace(/👑+$/u, "");
            }
            // 控制词/元指令匹配用的"干净文本"：把行内元素整个剔掉（不是换成 █），
            // 这样「开始报名<face id="339"/>」也能被认成控制词
            var cleanText = stripInlineElements(data.text, "").trim();
            var uid = uidOf(data);
            rememberUser(uid, data.sender); // 记录/刷新昵称（改名后显示名会跟着更新）
            // 人黑名单（影子封禁）：后端对"禁止用户"的每一条消息都会标 user_blacklist。
            // 这里只记标记，不拒绝、不提示——对方照常报名、照常出现在候选区（shadow），
            // 抽选时才优先跳过（见 pickDrawn）。名单是每条消息现算的，所以解禁后自动失效。
            if (uid && Array.isArray(data.block_reasons)) {
                if (data.block_reasons.indexOf("user_blacklist") !== -1) {
                    if (!ShadowBanned[uid]) log("🚫 " + data.sender + " 在禁止用户名单里（影子封禁）");
                    ShadowBanned[uid] = true;
                } else {
                    delete ShadowBanned[uid];
                }
            }
            // ⑤ 群主 / 管理员自动成为主持人（后端从 Satori member.roles 带下来的 is_admin）
            if (data.is_admin === true && uid && !ControllerUids[uid]) {
                ControllerUids[uid] = true;
                updateControllerDisplay();
                log("👑 " + data.sender + " 是群管理员，已自动认定为主持人");
            }
            if (isController(uid, data.sender, data.text)) {
                if (cleanText === GSControl.StartEnroll) {
                    if (GameState === GS.Idle) {
                        GameState = GS.Enroll;
                        Enroll();
                    }
                }
                else if (cleanText === GSControl.StartGame) {
                    if (GameState === GS.Enroll) {
                        // ① 开赛即抽选：从报名池随机抽 MaxPlayers 人上场
                        if (startGameFromPool()) {
                            GameState = GS.Gaming.Answering;
                            newGame();
                        }
                    }
                } else if (cleanText === GSControl.StartRating) {
                    if (GS.isGaming(GameState)) {
                        if (GameState === GS.Gaming.Answering || GameState === GS.Gaming.StopAnswering) {
                            GameState = GS.Gaming.Rating;
                            startRating();
                        }
                    }
                } else if (cleanText === GSControl.EndRating) {
                    if (GameState === GS.Gaming.Rating) {
                        GameState = GS.Gaming.Idle;
                        endRating();
                    }
                } else if (cleanText === GSControl.NextRound) {
                    // 观众打分阶段绝对不能下一回合
                    if (GS.isGaming(GameState) && GameState !== GS.Gaming.Rating) {
                        GameState = GS.Gaming.Answering;
                        nextRound();
                    }
                } else if (cleanText === GSControl.EndGame) {
                    if (GameState === GS.Enroll) {
                        // 误触「开始报名」的退路：报名阶段也能结束，回到待机
                        GameState = GS.Idle;
                        Candidates = [];
                        removePlayersInDocument();
                        renderCandidates();
                    } else if (GS.isGaming(GameState)) {
                        GameState = GS.Idle;
                        endGame();
                    }
                } else {
                    // 主持人元指令：
                    //   /set [i]    设置最大玩家数（4~6，仅待机/报名阶段）
                    //   /remove [i] 去掉第 i 个玩家（报名=取消报名；回答/停止回答=退赛删除）
                    //   /clear [i]  清掉第 i 个玩家的答案（回答/停止回答，防弹幕事故）
                    // ⑥ 主持人不再能通过扣 1 报名（原来这里有一条 text === "1" 的分支）
                    var metaMatch = /^\/(set|remove|clear)\s*([1-6])\s*$/.exec(cleanText);
                    if (metaMatch) {
                        var metaIdx = parseInt(metaMatch[2], 10);
                        var inAnswerPhase = GameState === GS.Gaming.Answering || GameState === GS.Gaming.StopAnswering;
                        if (metaMatch[1] === "set") {
                            if (GameState === GS.Idle || GameState === GS.Enroll) {
                                applyMaxPlayers(metaIdx); // 内部会夹到 4~6
                            }
                        } else if (metaMatch[1] === "remove") {
                            if (GameState === GS.Enroll || inAnswerPhase) {
                                removePlayerByIndex(metaIdx);
                            }
                        } else if (inAnswerPhase) {
                            clearPlayerAnswerByIndex(metaIdx);
                        }
                    }
                }
                gameStateChangeFeedback();
                updateGameStateInDocument();
                saveState();
                resolve();
            } else {
                if (GameState === GS.Gaming.Rating) {
                    audienceRate(data);
                } else if (GameState === GS.Enroll && cleanText === "1") {
                    // 报名阶段，仅允许发送“1”报名（先入报名池，不直接上场）
                    enrollCandidate(data);
                } else if (GameState === GS.Gaming.Answering) {
                    playerAnswer(data);
                }
                saveState();
                resolve();
            }
        } catch (err) {
            reject(err);
            return;
        }
    });
}

function handleEventFrame(frame) {
    // 后端「非弹幕」事件帧：没有 sender，不能走弹幕逻辑。
    // 与 ne-danmaku 的约定（待后端落地）：
    //   {type: "recall",   message_id, sender_id?, sender?}  —— 群消息被撤回
    //   {type: "reaction", message_id, sender_id, emoji?}    —— 给某条消息贴了表情（审核用）
    // 两种帧都要带上 message_id（弹幕帧里也需要带，前端才能建立对应关系）。
    if (!frame || typeof frame.type !== "string") return false;
    if (frame.type === "recall") {
        handleRecallFrame(frame);
        return true;
    }
    if (frame.type === "reaction") {
        handleReactionFrame(frame);
        return true;
    }
    return false;
}

function handleRecallFrame(frame) {
    // ③ 撤回：被撤回的那一条答案，在「打分开始前」（回答中 / 停止回答）从大屏消失。
    // 打分一旦开始、或已进入回合间歇，就不再受理撤回。
    // 注意是撤**那一条**：如果这位选手还发过别的答案，撤回旧答案不影响他现在生效的那条。
    if (GameState !== GS.Gaming.Answering && GameState !== GS.Gaming.StopAnswering) return;
    var mid = messageIdOf(frame);
    if (!mid) return;
    var record = AnswersByMessage[mid];
    if (!record) return;
    var uid = record.uid;
    delete AnswersByMessage[mid];
    var records = AnswerHistory[uid] || [];
    var idx = records.indexOf(record);
    if (idx >= 0) records.splice(idx, 1);
    refreshPlayerCard(uid);
    log("↩️ 答案已按撤回撤下：" + userName(uid) + "（" + record.text + "）");
}

function handleReactionFrame(frame) {
    // 观众贴表情：先在"那张答案卡上的答案上方"长出一个一模一样的表情（直播感）。
    // 回答期间、打分期间都放（答案一直挂在选手卡上）；跟「答案需审核」开关无关。
    if (frame && frame.action !== "remove") spawnReactionFlyer(frame);
    // ④ 答题审核：主持人给某条答案贴了表情（任意表情都算通过）
    if (!AuditEnabled) return;
    // 打分一开始就不再受理审核（回答中 / 停止回答 → 打分前都可以补贴）
    if (GameState !== GS.Gaming.Answering && GameState !== GS.Gaming.StopAnswering) return;
    var mid = messageIdOf(frame);
    if (!mid) return;
    var record = AnswersByMessage[mid];
    if (!record) {
        log("👍 收到贴表情，但那不是（或不再是）有效答案：" + mid);
        return;
    }
    var reactor = uidOf({ senderId: frame.sender_id, sender: frame.sender });
    // 后端的贴表情帧带着「贴的人是不是群管理员」（成员角色缓存），
    // 主持人只在控制面板上操作、从没在群里发过言时，靠这一条就地认人
    if (frame.is_admin === true && reactor && !ControllerUids[reactor]) {
        ControllerUids[reactor] = true;
        updateControllerDisplay();
    }
    if (!isControllerUid(reactor)) {
        log("🙅 非主持人贴的表情不算审核：" + (userName(reactor) || "未知"));
        showHint("收到贴表情，但 " + (frame.sender || "对方") + " 还不是主持人，审核没生效");
        return;
    }
    // QQ 里表情是可以取消的（Satori reaction-removed / OneBot is_add=false）：
    // 取消表情 = 取消审核，这条答案回到待审核
    if (frame.action === "remove") {
        unapproveAnswer(record);
        return;
    }
    // 记下是哪个表情批的：后端会把 id 换算成字符和图片地址一起下发
    // （emoji_char 是标准 emoji 字符，emoji_url 是图片；经典 QQ 表情则只有图）
    record.emojiId = frame.emoji || "";
    record.emojiChar = emojiCharOfFrame(frame);
    record.emojiUrl = emojiUrlOfFrame(frame);
    approveAnswer(record);
}

function emojiCharOfFrame(frame) {
    // 后端算好了就用后端的；没有（老后端 / 模拟器）就前端自己兜：
    // QQ 的「贴表情/回应」用的就是标准 emoji，id 直接是 Unicode 码点（128077 = 👍）
    if (frame.emoji_char) return frame.emoji_char;
    var id = parseInt(frame.emoji, 10);
    if (isNaN(id) || id < 0x1F000 || id > 0x10FFFF) return "";
    try {
        return String.fromCodePoint(id);
    } catch (e) {
        return "";
    }
}

function emojiUrlOfFrame(frame) {
    if (frame.emoji_url) return frame.emoji_url;
    var id = parseInt(frame.emoji, 10);
    if (isNaN(id)) return "";
    if (id >= 0x1F000 && id <= 0x10FFFF) {
        // 和站点其它资源同一个 CDN；极新的 emoji Twemoji 14 里可能没有，用的时候 onerror 退回字符
        return "https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72/" + id.toString(16) + ".png";
    }
    // 经典 QQ 表情：≥222 的"会动的"腾讯编号是 10000+id
    return "https://qzonestyle.gtimg.cn/qzone/em/e" + (id < 222 ? id : 10000 + id) + ".gif";
}

// ---------------------------------------------------------------
// 观众贴表情 → 那个表情从答案旁边长出来、飞走淡出
// ---------------------------------------------------------------

var REACTION_FLY_MAX = 14;   // 同时最多这么多个：QQ 里表情能连点，得防刷屏糊屏
var reactionFlyCount = 0;

function answerAnchorForMessage(mid) {
    // 那条消息对应的答案，现在在屏上的哪个元素上。
    // 只认**选手卡上的答案**：不管回答期间还是打分期间，答案都挂在选手卡上，
    // 表情就从那张卡的答案上方长出来（打分环节左侧那排"答案条"不放）。
    var record = AnswersByMessage[mid];
    if (!record) return null;
    var rows = playerRows();
    for (var i = 0; i < rows.length; i++) {
        if (rowUid(rows[i]) !== record.uid) continue;
        var answerShow = rows[i].getElementsByClassName("player_answer_show")[0];
        if (answerShow && answerShow.innerText) return answerShow;
        var answerInput = rows[i].getElementsByClassName("player_answer")[0];
        if (answerInput && answerInput.value) return answerInput;
        return rows[i].getElementsByClassName("player_score_wrap")[0] || rows[i];
    }
    return null;
}

function spawnReactionFlyer(frame) {
    // 取消表情不放
    if (!frame || frame.action === "remove") return false;
    // 答案卡不在屏上（待机/报名，或没抽到上场）自然就找不到锚点，也就不会放
    var layer = document.getElementById("reaction_fly_layer");
    if (!layer) return false;
    if (reactionFlyCount >= REACTION_FLY_MAX) return false;
    var anchor = answerAnchorForMessage(messageIdOf(frame));
    if (!anchor || !anchor.getBoundingClientRect) return false;
    var ch = emojiCharOfFrame(frame);
    var url = emojiUrlOfFrame(frame);
    if (!ch && !url) return false;

    var el = document.createElement("div");
    el.className = "reaction_fly";
    if (url) {
        var img = document.createElement("img");
        img.src = url;
        img.alt = ch || "";
        // 图挂了（网络受限 / Twemoji 里没有这个新 emoji）就退回字符
        img.onerror = function () {
            if (img.parentNode) img.parentNode.removeChild(img);
            if (ch) {
                el.classList.add("reaction_fly_text");
                el.innerText = ch;
            }
        };
        el.appendChild(img);
    } else {
        el.classList.add("reaction_fly_text");
        el.innerText = ch;
    }
    var rect = anchor.getBoundingClientRect();
    // 从答案**上方**长出来（水平居中于那条答案）
    el.style.left = (rect.left + rect.width / 2) + "px";
    el.style.top = rect.top + "px";
    // 往上飘走（横向带点随机偏移，别整齐划一）；幅度压住，别飞到屏幕外被裁掉
    el.style.setProperty("--fly-x", (-3 + Math.random() * 6).toFixed(2) + "rem");
    el.style.setProperty("--fly-y", (-3 - Math.random() * 3).toFixed(2) + "rem");
    el.style.setProperty("--fly-rot", Math.round(-20 + Math.random() * 40) + "deg");
    layer.appendChild(el);
    reactionFlyCount++;

    var finished = false;
    function done() {
        if (finished) return;   // animationend 和兜底定时器可能都到
        finished = true;
        if (el.parentNode) el.parentNode.removeChild(el);
        reactionFlyCount = Math.max(0, reactionFlyCount - 1);
    }
    el.addEventListener("animationend", done, { once: true });
    setTimeout(done, 2600);     // 兜底：jsdom / 动画被禁用时也要把元素收掉
    return true;
}

function approveAnswer(record) {
    // 主持人给**这一条**答案贴了表情 = 开闸（放这位选手的答案过关）。
    // 闸只有一个、跟着"最后一次贴的那条消息"走，但**内容**永远是回答顺序上的第一条：
    // 所以贴哪一条都不改变答案文本，不给"改答案"留余地。
    if (!record) return;
    (AnswerHistory[record.uid] || []).forEach(function (r) {
        if (r !== record) {
            r.approved = false;
            r.approvedAt = 0;
        }
    });
    record.approved = true;
    record.approvedAt = ++ApprovalSeq;
    refreshPlayerCard(record.uid);
    var rec = roundAnswer(record.uid);
    var content = rec ? rec.text : record.text;
    var face = record.emojiChar ? (record.emojiChar + " ") : "";
    showHint("✅ " + face + userName(record.uid) + " 的答案已通过审核：" + content +
        (rec && rec !== record ? "（本轮以他第一条答案为准）" : ""));
    saveState();
}

function unapproveAnswer(record) {
    // 主持人把表情取消了 = 关闸：这条答案回到待审核，不参与打分
    if (!record) return;
    record.approved = false;
    record.approvedAt = 0;
    refreshPlayerCard(record.uid);
    showHint("↩️ 已取消审核：" + userName(record.uid) +
        (gateOpen(record.uid) ? "" : "（回到待审核）"));
    saveState();
}

function setAuditEnabled(on) {
    AuditEnabled = !!on;
    syncAuditCheckbox();
    updatePlayerAuditInDocument();
    saveState();
}

function updatePlayerAuditInDocument() {
    // 玩家卡右上角标「待审核」；已通过则标一个绿色对勾
    playerRows().forEach(function (row) {
        var input = row.getElementsByClassName("player_answer")[0];
        var hasAnswer = input && input.value !== "";
        var approved = !!(input && input.dataset && input.dataset.approved === "1");
        row.classList.remove("audit_pending", "audit_ok");
        if (!AuditEnabled || !hasAnswer) return;
        row.classList.add(approved ? "audit_ok" : "audit_pending");
    });
}

// ---------------------------------------------------------------
// 行内元素（上游塞进文本里的 <face id="339" type="2" platform="llonebot"/> 之类）
// ---------------------------------------------------------------
// 这类东西对游戏来说是**非法内容**：不能让玩家靠标签把图片/卡片塞进答案或昵称带到屏幕上。
// 后端的处理：把文本切成段（inline，给显示层行内渲染），并给出 text_plain
// （元素一律已换成 █，**整条只有元素也算数，答案就是 █**）。这里优先用后端算好的；
// 老后端没有这些字段时，前端按同样规则自己替换一次（正则与后端 inline_elements.py 保持一致）。
// 附加属性（platform 之类）不参与任何判断。
var INLINE_PLACEHOLDER = "█";
var INLINE_TAG_PATTERN = /<(face|mface|marketface|image|record|voice|video|file|json|xml|reply|at|poke|forward|node|markdown)\b[^<>]*\/?>/gi;

function stripInlineElements(text, replacement) {
    if (typeof text !== "string" || text.indexOf("<") === -1) return text;
    if (replacement === undefined) replacement = INLINE_PLACEHOLDER;
    return text.replace(INLINE_TAG_PATTERN, replacement);
}

function plainTextOf(data) {
    var raw = (data && data.text) || "";
    var tp = data && data.text_plain;
    if (typeof tp === "string" && tp !== "") return tp;
    return stripInlineElements(raw);
}

function normalizeAnswer(text) {    // 答案格式化：去掉两侧空白，中间的连续空白折叠为 1 个空格
    var t = String(text).replace(/\s+/g, " ").trim();
    // 边缘情况：答案为单个 "0" 会与"发送 0 取消投票"冲突，替换为"零"
    if (t === "0") {
        t = "零";
    }
    return t;
}

function getAudienceRate(text) {
    var num = parseInt(text);
    if (!isNaN(num) && String(num) === String(text).trim()) {
        if (num >= 1 && num <= Answers.length) {
            return Answers[num - 1];
        } else {
            return null; // 超出范围
        }
    }

    var normalized = normalizeAnswer(text);
    if (Answers.includes(normalized)) {
        return normalized; // 存在（按格式化后的文本匹配）
    } else {
        return null; // 不存在
    }
}

function audienceRate(danmaku) {
    var uid = uidOf(danmaku);
    if (!uid) return;
    if (Players[uid]) return; // 选手不能评分
    if (isControllerUid(uid)) return; // ⑥ 主持人不能评分
    if (String(danmaku.text).trim() === "0") { // 发送 0 取消投票（数字 0 同样有效）
        delete AudiencesRating[uid];
        updateAnswersScores();
        return;
    }
    var ar = getAudienceRate(danmaku.text);
    if (ar === null) return; // 无效评分
    AudiencesRating[uid] = ar;
    updateAnswersScores();
}

// 分数内部计算单位：1 分 = 60 单位（1/60）。
// 60 是 2~6 的最小公倍数，同答案平均分票（除以人数）时必定整除，全程整数无浮点误差。
const SCORE_UNIT = 60;

function displayScore(units) {
    // 内部单位 → 显示值：按需给位数（整数不带小数点、能一位精确就一位、
    // 否则两位）。判断全部走整数运算，避免浮点误差：
    // 一位小数能精确表示 ⟺ units×10 能被 60 整除；1/6 这类无限小数显示两位近似
    if (units % SCORE_UNIT === 0) {
        return String(units / SCORE_UNIT);
    }
    if ((units * 10) % SCORE_UNIT === 0) {
        return (units / SCORE_UNIT).toFixed(1);
    }
    return (units / SCORE_UNIT).toFixed(2);
}

function updateAnswersScores() {
    AnswersScores = Object.fromEntries(Answers.map(i => [i, 0]));
    for (var voter in AudiencesRating) {
        var votedAnswer = AudiencesRating[voter];
        if (votedAnswer in AnswersScores) {
            AnswersScores[votedAnswer] += SCORE_UNIT; // 每票 1 分
        }
    }
    // 更新界面：答案浮现动画期间只记票不重排，等浮现完成后统一刷新
    if (ratingRevealDone) {
        updateAnswersScoresInDocument();
    }
}

///////////////////////////// 和document操作的部分

function fixTextWidth(e, offset = 28.0 / 8) {
    var parentWidth = e.parentElement.clientWidth;
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize); // 1rem 对应多少像素
    var targetWidth = parentWidth - (offset * rem);
    var width = e.clientWidth;
    if (width > targetWidth) {
        var scale = targetWidth / width;
        e.style.transform = "scaleX(" + scale + ")";
    } else {
        e.style.transform = "";
    }
}

function fitTextToContainer(e, opts) {
    // 把一段文字缩进容器里：
    //   1) 先降字号（中文能换行，降字号最不伤可读性），最多降到 base * minFontRatio；
    //   2) 还不够就整块等比缩放 scale(sx, sy)（横向超长的不换行串、纵向太高都用它兜底）。
    // 布局尺寸由调用方给（availW/availH）：题目框要用**稳定**的预算（.character_wrap 的高度），
    // 否则"容器高度跟着文字长"会导致量到的可用高度偏小、字号被压到几乎看不见。
    if (!e) return;
    var o = opts || {};
    var offsetRem = (o.offsetRem === undefined) ? 0 : o.offsetRem;
    var minRatio = (o.minFontRatio === undefined) ? 0.5 : o.minFontRatio;
    var rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    var parent = e.parentElement;
    var availW = o.availW, availH = o.availH;
    if (availW === undefined || availH === undefined) {
        if (!parent) return;
        var cs = getComputedStyle(parent);
        if (availW === undefined) {
            availW = parent.clientWidth - (parseFloat(cs.paddingLeft) || 0)
                - (parseFloat(cs.paddingRight) || 0) - offsetRem * rem;
        }
        if (availH === undefined) {
            availH = parent.clientHeight - (parseFloat(cs.paddingTop) || 0)
                - (parseFloat(cs.paddingBottom) || 0);
        }
    }
    // 每次都从"自然状态"开始量，重复调用才幂等
    e.style.transform = "";
    e.style.fontSize = "";
    var baseFont = parseFloat(getComputedStyle(e).fontSize) || 16;
    if (availW <= 1 || availH <= 1) return;   // 容器还没布局出来（不可见/为 0），交给下一次
    // 注意：**能换行的块，scrollWidth 恒等于自身宽度**，跟字号无关。
    // 所以"太宽"只有在真的横向溢出（scrollWidth > clientWidth，比如不换行的长串）时才算，
    // 否则宽度判据会永远为真、字号被一路压到下限。
    function overflows() {
        if (e.scrollHeight > availH + 1) return true;
        return e.scrollWidth > availW + 1 && e.scrollWidth > e.clientWidth + 2;
    }
    var floorFont = Math.max(baseFont * minRatio, 8);
    var font = baseFont;
    var guard = 0;
    while (font > floorFont && overflows() && guard++ < 60) {
        font = Math.max(font * 0.94, floorFont);
        e.style.fontSize = font + "px";
    }
    if (overflows()) {
        var sx = Math.min(1, availW / e.scrollWidth);
        var sy = Math.min(1, availH / e.scrollHeight);
        e.style.transform = "scale(" + sx + ", " + sy + ")";
    } else {
        e.style.transform = "";
    }
}

function fitQuestionText() {
    // 答题环节的题目框：题目 + 出题人一起缩进白框。
    // 白框高度不该由文字决定（否则量出来的"可用高度"就是文字自己的高度，永远刚好放得下），
    // 所以可用高度取它的父容器 .character_wrap —— 那个高度是布局给的、稳定的。
    var box = document.getElementById("question");
    var body = document.getElementById("question_body");
    if (!box || !body) return;
    var csBox = getComputedStyle(box);
    var wrap = box.parentElement;
    var padH = (parseFloat(csBox.paddingLeft) || 0) + (parseFloat(csBox.paddingRight) || 0);
    var padV = (parseFloat(csBox.paddingTop) || 0) + (parseFloat(csBox.paddingBottom) || 0);
    var border = (parseFloat(csBox.borderTopWidth) || 0) + (parseFloat(csBox.borderBottomWidth) || 0);
    var availW = box.clientWidth - padH;              // 宽度是 CSS 定的，稳定
    var availH = (wrap ? wrap.clientHeight : box.clientHeight) - padV - border;
    fitTextToContainer(body, { availW: availW - 1, availH: availH - 1, minFontRatio: 0.45 });
}

function fitRatingQuestionRow(row) {
    // 打分环节顶部的问题条：只放题目（不显示出题人），所以宽度就是整行
    if (!row) return;
    var qContent = row.getElementsByClassName("answer_content")[0];
    if (!qContent) return;
    var answer = qContent.parentElement;
    if (!answer) return;
    var cs = getComputedStyle(answer);
    var availW = answer.clientWidth - (parseFloat(cs.paddingLeft) || 0)
        - (parseFloat(cs.paddingRight) || 0) - 6;
    var availH = answer.clientHeight - (parseFloat(cs.paddingTop) || 0)
        - (parseFloat(cs.paddingBottom) || 0) - 2;
    fitTextToContainer(qContent, { availW: availW, availH: availH, minFontRatio: 0.45 });
}

function refitQuestionTexts() {
    fitQuestionText();
    var rows = document.querySelectorAll("#answers_wrap .question_row");
    for (var i = 0; i < rows.length; i++) fitRatingQuestionRow(rows[i]);
}

function applyMaxPlayers(target) {
    // 绝对值设置最大玩家数（夹到 4~6，且不低于当前在座人数）
    var newMax = Math.min(Math.max(target, MinPlayers), MaxPlayersLimit);
    if (newMax === MaxPlayers) return;
    var count = playerRows().length;
    if (newMax < count) {
        alert("当前已有 " + count + " 名玩家，无法降低到 " + newMax + "，请先删除多余玩家");
        return;
    }
    MaxPlayers = newMax;
    const show = document.getElementById("max_players_show");
    if (show) show.innerText = MaxPlayers;
    if (count < MaxPlayers) showAddPlayerButton(); // 提高上限时重新显示“添加玩家”按钮
    renderCandidates(); // 报名池容量随之变化
    saveState();
}

function changeMaxPlayers(delta) {
    applyMaxPlayers(MaxPlayers + delta);
}

function updatePlayersWrapClass() {
    // 5 人及以上时玩家区切换为 3 列布局（CSS .players_six）
    const six = playerRows().length >= 5;
    const wrap = document.querySelector(".players_wrap_wrap");
    if (wrap) {
        wrap.classList.toggle("players_six", six);
    }
    // body 级标记：6 人报名时气泡改悬浮屏中央，避开玩家区
    document.body.classList.toggle("players_six", six);
}

function addPlayer(name = "", uid = null) {
    if (playerRows().length >= MaxPlayers) {
        alert("已达到最大玩家数");
        return null;
    }

    if (playerNamesInDocument().includes("")) {
        return null;
    }

    const playersWrap = document.getElementById("players_wrap");
    const playersTemplate = document.getElementById("player_template");

    if (!uid) {
        // 手工加人（或没有 senderId 的来源）：造一个只在本机有效的 uid
        uid = "manual:" + (++manualUidSeq) + ":" + (name || "");
    }
    if (name !== "") rememberUser(uid, name);
    if (PlayerOrder.indexOf(uid) === -1) PlayerOrder.push(uid); // 名单顺序与 DOM 保持一致

    // copy template
    var newPlayer = playersTemplate.cloneNode(true);

    var deleteButton = newPlayer.getElementsByClassName("delete_player_button")[0];
    deleteButton.onclick = () => {
        deleteButton.disabled = true; // 防止多次点击
        deletePlayer(newPlayer);
    };

    newPlayer.id = "";
    newPlayer.style.display = "";
    newPlayer.dataset.uid = uid;
    playersWrap.appendChild(newPlayer);

    var playerName = newPlayer.getElementsByClassName("player_name")[0];
    playerName.dataset.uid = uid;
    if (name !== "") {
        playerName.value = name;
        // playerName.disabled = true; // 报名的玩家不允许修改昵称
    } else {
        playerName.focus();
    }

    var playerNameShow = newPlayer.getElementsByClassName("player_name_show")[0];
    if (name !== "") {
        playerNameShow.innerText = name;
    }

    playerName.addEventListener("input", () => {
        playerNameShow.innerText = playerName.value;
        fixTextWidth(playerNameShow);
    });
    fixTextWidth(playerNameShow);

    var playerAnswer = newPlayer.getElementsByClassName("player_answer")[0];
    playerAnswer.dataset.uid = uid;
    var playerAnswerShow = newPlayer.getElementsByClassName("player_answer_show")[0];
    playerAnswer.addEventListener("input", () => {
        playerAnswerShow.innerText = playerAnswer.value;
        fixTextWidth(playerAnswerShow);
    });
    fixTextWidth(playerAnswerShow, 0);

    if (playerRows().length >= MaxPlayers) {
        hideAddPlayerButton();
    }
    updatePlayersWrapClass();
    updatePlayerAuditInDocument();
    saveState();
    return uid;
}

var manualUidSeq = 0; // 手工加人的 uid 序号

function deletePlayer(e) {
    var uid = rowUid(e);
    e.remove();
    if (uid) PlayerOrder = PlayerOrder.filter(function (u) { return u !== uid; });
    updatePlayersWrapClass();
    if (playerRows().length < MaxPlayers) {
        showAddPlayerButton();
    }
    saveState();
}


function frozenPlayers() {
    var inputs = getActivePlayerElements(".player_name");
    for (var i = 0; i < inputs.length; i++) {
        inputs[i].disabled = true;
    }
    var buttons = getActivePlayerElements(".delete_player_button");
    for (var i = 0; i < buttons.length; i++) {
        buttons[i].disabled = true;
    }
}

function unfrozenPlayers() {
    var inputs = getActivePlayerElements(".player_name");
    for (var i = 0; i < inputs.length; i++) {
        inputs[i].disabled = false;
    }
    var buttons = getActivePlayerElements(".delete_player_button");
    for (var i = 0; i < buttons.length; i++) {
        buttons[i].disabled = false;
    }
}

function frozenAnswers() {
    getActivePlayerElements(".player_answer").forEach(e => {
        e.disabled = true;
    });
}

function unfrozenAnswers() {
    getActivePlayerElements(".player_answer").forEach(e => {
        e.disabled = false;
    });
}

function clearAnswers() {
    getActivePlayerElements(".player_answer").forEach(e => {
        e.value = "";
        delete e.dataset.messageId;
        delete e.dataset.approved;
    });
    getActiveAnswerElements(".player_answer_show").forEach(e => {
        e.innerText = "";
    });
    updatePlayerAuditInDocument();
}

function syncAuditCheckbox() {
    var box = document.getElementById("audit_toggle");
    if (box) box.checked = AuditEnabled;
}

function hideAddPlayerButton() {
    document.getElementById("add_player_btn").disabled = true;
    document.getElementById("add_player_btn").style.display = "none";
}

function showAddPlayerButton() {
    document.getElementById("add_player_btn").disabled = false;
    document.getElementById("add_player_btn").style.display = "";
}

function createAnswersInDocument() {
    const colors = ["#EF65C8", "#57DF0E", "#f07f1f", "#6efdfd", "#FFE44D", "#B967FF"];

    const answersWrap = document.getElementById("answers_wrap");
    answersWrap.innerHTML = ""; // 清空

    const answersTemplate = document.getElementById("answer_template");
    const totalRows = Answers.length + 1; // 第 0 条是"本轮问题"提示条，其后是各答案条

    function colorOf(uid) {
        var idx = PlayerOrder.indexOf(uid);
        return colors[(idx < 0 ? 0 : idx) % colors.length];
    }

    // 第 0 条："本轮问题"提示条（不参与投票/计分/排序）
    var qRow = answersTemplate.cloneNode(true);
    qRow.id = "";
    qRow.style.display = "";
    qRow.classList.add("question_row");
    qRow.style.height = 100. / totalRows + "%";
    qRow.style.top = "0%";
    var qContent = qRow.getElementsByClassName("answer_content")[0];
    qContent.innerText = (question !== null) ? question : "";
    // 打分环节的问题条只显示题目本身，不显示出题人（出题人只在答题环节的大白框里显示）
    qRow.getElementsByClassName("answer_score")[0].innerText = "";
    answersWrap.appendChild(qRow);
    // 长题目自动缩进这一条（降字号 + 兜底缩放）。
    // 延到下一帧（状态类已切换、容器已可见）再量，否则量到 0
    requestAnimationFrame(() => fitRatingQuestionRow(qRow));

    for (var i = 0; i < Answers.length; i++) {
        var at = answersTemplate.cloneNode(true);
        at.id = "";
        at.style.display = "";

        at.style.height = 100. / totalRows + "%"; // 平均分配高度
        at.style.top = ((i + 1) * 100. / totalRows) + "%"; // 第 0 格让给问题条

        var answerText = at.getElementsByClassName("answer_content")[0];
        answerText.innerText = (i + 1) + ". " + Answers[i] + "： ";

        // attribute data-answer-index
        at.getElementsByClassName("answer")[0].setAttribute("data-answer-index", Answers[i]);

        var ap = at.getElementsByClassName("answer_progress")[0];
        if (AnswersPlayers[Answers[i]].length === 1) {
            ap.style.background = colorOf(AnswersPlayers[Answers[i]][0]);
        } else {
            var color = AnswersPlayers[Answers[i]].map(colorOf)
            var N = color.length;
            var steps = Array.from({length: N+1}, (_, i) => 100. * i / N)
            var softness = 100./(N*4);
            ap.style.background = "linear-gradient(to bottom, " + color.map((c, i) => c + " " + (steps[i]+softness) + "% " + (steps[i+1]-softness) + "%").join(", ") + ")";
        }
        answersWrap.appendChild(at);
    }
    // 答案数 ≥5 时标记，供 CSS 缩小字号
    answersWrap.classList.toggle("many_answers", Answers.length >= 5);
}

function updateAnswersScoresInDocument() {
    var answerElements = getActiveAnswerElements(".answer");
    var answerWraps = getActiveAnswerElements(".answer_wrap");
    for (var i = 0; i < answerElements.length; i++) {
        var ae = answerElements[i];
        var answerIndex = ae.getAttribute("data-answer-index");
        var scoreElement = ae.getElementsByClassName("answer_score")[0];
        if (answerIndex in AnswersScores) {
            scoreElement.innerText = displayScore(AnswersScores[answerIndex]);
        } else {
            scoreElement.innerText = displayScore(0);
        }

        var rank = Answers4Rank.sort((a, b) => AnswersScores[b] - AnswersScores[a]).indexOf(answerIndex);

        var maxScore = Math.max(...Object.values(AnswersScores), 0);
        var aw = answerWraps[i];
        aw.style.top = (rank + 1) * (100. / (Answers.length + 1)) + "%"; // 第 0 格是"本轮问题"条
        aw.classList.add('bigger');
        void aw.offsetWidth; // 触发重绘
        aw.classList.remove('bigger');

        var progressElement = ae.getElementsByClassName("answer_progress")[0];
        progressElement.style.width = (maxScore === 0 ? 0 : (AnswersScores[answerIndex] / maxScore * 100)) + "%";
    }
}

function playerAnswer(data) {
    var uid = uidOf(data);
    if (!uid) return;
    if (!Players[uid]) {
        return; // 非本局选手
    }
    // 行内元素（<face .../> 之类）一律换成 █（后端 text_plain 已算好，这里兜底）。
    // 只发一个表情也算数：那条答案就是 █
    var panswer = normalizeAnswer(plainTextOf(data)); // 去首尾空白 + 中间连续空格折叠
    if (panswer === "") {
        return; // 空答案
    }
    var mid = messageIdOf(data);
    rememberUser(uid, data.sender);
    // 记录进"这个人的答案历史"，而不是覆盖掉上一条 —— 上一条要留着，
    // 主持人可能给上一条贴表情（"审核选了第一个上去"）
    var records = AnswerHistory[uid] || (AnswerHistory[uid] = []);
    var last = records[records.length - 1];
    if (last && !last.approved && last.text === panswer) {
        // 同一句话又发了一遍（重发/手滑）：认作同一条，只更新消息 ID，不堆历史
        if (last.messageId) delete AnswersByMessage[last.messageId];
        last.messageId = mid;
        last.at = Date.now();
    } else {
        records.push({ uid: uid, text: panswer, messageId: mid, approved: false, at: Date.now() });
    }
    if (mid) AnswersByMessage[mid] = records[records.length - 1];
    refreshPlayerCard(uid);
    // 一个人说了多条：以**第一条**为准（主持人只是闸，不换内容）
    if (records.length > 1) {
        log("ℹ️ " + userName(uid) + " 本轮已答过，后说的内容不替换答案：" + records[records.length - 1].text);
        showHint("ℹ️ " + userName(uid) + " 又答了一条，本轮仍以第一条为准：" + records[0].text);
    }
}

function updatePlayersScoresInDocument() {
    var elements = playerElements();
    // 求PlayersScores的总分
    var maxScore = Math.max(...Object.values(PlayersScores), 0);
    for (var i = 0; i < elements.length; i++) {
        var pe = elements[i];
        var uid = rowUid(pe.parentElement);
        var scoreElement = pe.getElementsByClassName("player_score")[0];
        var progressElement = pe.getElementsByClassName("player_progress")[0];
        if (uid && uid in PlayersScores) {
            scoreElement.innerText = displayScore(PlayersScores[uid]);
            progressElement.style.width = (maxScore === 0 ? 0 : (PlayersScores[uid] / maxScore * 100)) + "%";
        } else {
            scoreElement.innerText = displayScore(0);
            progressElement.style.width = "0%";
        }
    }
}

function removeAnswersInDocument() {
    const answersWrap = document.getElementById("answers_wrap");
    answersWrap.innerHTML = ""; // 清空
}

function updateGameStateInDocument() {
    const stateElement = document.getElementById("game_state");
    const mainContent = document.getElementById("main_content");
    if (GameState === GS.Idle) {
        stateElement.innerText = "待机中";
    } else if (GameState === GS.Enroll) {
        stateElement.innerText = "报名环节";
    } else if (GameState === GS.Gaming.Answering) {
        stateElement.innerText = "回答环节";
    } else if (GameState === GS.Gaming.StopAnswering) {
        stateElement.innerText = "停止回答";
    } else if (GameState === GS.Gaming.Rating) {
        stateElement.innerText = "观众打分";
    } else if (GameState === GS.Gaming.Idle) {
        stateElement.innerText = "回合间歇";
    } else {
        stateElement.innerText = "未知状态";
    }
    // 更换mainContent的class
    var targetGameStateClass = GameState.replace("-", "_").toLowerCase();
    mainContent.classList.remove(...Array.from(mainContent.classList).filter(c => c.startsWith("state_")));
    mainContent.classList.add("state_" + targetGameStateClass);
    // 状态切换会改变各区的宽度/可见性（打分态是另一套布局），长题目要重新量一次
    if (typeof scheduleRefitQuestionTexts === "function") scheduleRefitQuestionTexts();
}

function updateQuestionInDocument() {
    const questionElement = document.getElementById("question");
    const textElement = document.getElementById("question_text");
    const authorElement = document.getElementById("question_author");
    // 题目框里现在是「题目正文 + 出题人」两个子元素，别用 innerText 直接写整个框（会把子元素冲掉）
    if (textElement) textElement.innerText = (question !== null) ? question : "";
    else questionElement.innerText = (question !== null) ? question : "";
    if (authorElement) authorElement.innerText = questionAuthor ? ("出题人：" + questionAuthor) : "";
    // 等这一帧布局完成再量尺寸（长题目要自动缩进白框里）
    requestAnimationFrame(() => fitQuestionText());
}

function removePlayersInDocument() {
    const playersWrap = document.getElementById("players_wrap");
    playersWrap.innerHTML = ""; // 清空
    PlayerOrder = [];
    Players = {};
    updatePlayersWrapClass();
}

function countingDown(seconds = 30) {
    const clock = document.getElementById("clock");
    return new Promise((resolve, reject) => {
        try {
            var remaining = seconds;
            updateClock(remaining);
            // 记下截止时刻：刷新/崩溃恢复时按它接着走
            CountdownDeadline = seconds > 0 ? (Date.now() + seconds * 1000) : null;
            if (CountingDownInterval !== null) {
                clearInterval(CountingDownInterval);
            }
            CountingDownInterval = setInterval(() => {
                remaining -= 1;
                if (remaining <= 0) {
                    updateClock(0);
                    clearInterval(CountingDownInterval);
                    CountdownDeadline = null;
                    resolve();
                } else {
                    updateClock(remaining);
                }
            }, 1000);
        } catch (err) {
            reject(err);
        }
    });
}

function updateClock(seconds) {
    const clock = document.getElementById("clock");
    // mm:ss
    var m = Math.floor(seconds / 60);
    var s = seconds % 60;
    clock.innerText = (m < 10 ? "0" + m : m) + ":" + (s < 10 ? "0" + s : s);
}

function set_congratulations() {
    var elements = playerElements();
    // 求PlayersScores的总分
    var maxScore = Math.max(...Object.values(PlayersScores), 0);
    for (var i = 0; i < elements.length; i++) {
        var pe = elements[i];
        var uid = rowUid(pe.parentElement);
        var scoreElement = pe.getElementsByClassName("player_score")[0];
        var playerAnswerShow = pe.getElementsByClassName("player_answer_show")[0];
        if (uid && uid in PlayersScores && PlayersScores[uid] === maxScore) {
            scoreElement.innerText = displayScore(PlayersScores[uid]);
            playerAnswerShow.innerText = "!?强强?!";
            fixTextWidth(playerAnswerShow, 0);
        }
    }
}

/// 实际代码
//
// 消息格式说明：
// ne-danmaku 后端发送的消息格式为：
//   {type, text, color, size, position, sender, senderId, is_special, blocked, ...}
// 游戏前端读取 data.sender / data.senderId / data.text 进行游戏逻辑处理。
// 【重要】blocked 消息（黑名单/去重标记）仍会被游戏逻辑正常处理——
//   后端保证不丢弃任何消息，原始文本完整保留，游戏指令不受影响。
//   blocked 标记仅供弹幕展示层（DanmakuDisplay）使用。
//
// 【身份】一切以 senderId 为主键（QQ 号 / member_openid），昵称只用于显示。
//
// 【待后端补充的帧】（缺 message_id 时撤回/审核都无法对上号）
//   1) 每条弹幕帧带上 message_id     —— 群里那条消息的 ID
//   2) {type: "recall",   message_id} —— 群消息撤回（Satori: EventType.MESSAGE_DELETED）
//   3) {type: "reaction", message_id, sender_id, emoji} —— 贴表情（Satori: EventType.REACTION_ADDED）
//   4) 消息帧带上成员角色（Satori: member.roles）—— 群主/管理员自动成为主持人

// 控制面板本机按钮视同主持人本人：先把本机控制台的 uid 登记为主持人
ControllerUids["id:" + LOCAL_CONTROLLER_UID] = true;
ControllerNames[Controller] = true;

// 需求⑦：有存档就先恢复局面（大屏崩了/误刷新，F5 后接着玩）
var __save = loadSave();
if (__save) {
    restoreFromSave(__save);
} else {
    refillQuestionPool();
}
renderCandidates();
updateControllerDisplay();
syncAuditCheckbox();
connect();

// 长题目自动缩放：窗口尺寸变了、或自定义字体姗姗来迟（度量会变）时都要重新量一次
var __refitTimer = null;
function scheduleRefitQuestionTexts() {
    if (__refitTimer) clearTimeout(__refitTimer);
    __refitTimer = setTimeout(function () {
        __refitTimer = null;
        refitQuestionTexts();
    }, 120);
}
window.addEventListener("resize", scheduleRefitQuestionTexts);
window.addEventListener("orientationchange", scheduleRefitQuestionTexts);
if (document.fonts && document.fonts.ready && document.fonts.ready.then) {
    document.fonts.ready.then(function () { refitQuestionTexts(); });
}
