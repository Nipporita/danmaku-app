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
    StartGame: "开始游戏", // 开始游戏
    StartRating: "开始打分", // 开始回合
    EndRating: "结束打分", // 结束回合
    NextRound: "下一回合", // 下一回合
    EndGame: "结束游戏", // 结束游戏
});

var data = null;

var log = console.log

///// WS 部分
let ws = null;
let reconnectTimer = null;
let path = "弹幕群名";
let port = 5099;
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
    const WS_URL = WS_URL_Head + ":" + port + "/danmaku/" + encodeURIComponent(path);

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

// 前端逻辑
const MaxPlayers = 4; // 最大玩家数

const characterImageHead = "https://cdn.jsdelivr.net/gh/Nipporita/fantasyguide_statics/images/CharacterCards13/"

var Controller = "Admin"; // 控制者的昵称
var Players = []; // 玩家昵称列表
var PlayersScores = {}; // 玩家分数
var PlayersAnswers = {}; // 玩家答案
var Answers = []; // 玩家答案列表
var AnswersPlayers = {}; // 答案对应的玩家
var Answers4Rank = []; //用于排序的答案列表
var AnswersScores = {}; // 玩家答案分数
var GameState = GS.Idle; // 游戏状态
var CurrentRound = 0; // 当前回合数
var characters = allCharacters; // 角色列表
var character = null; // 当前角色

var CountingDownInterval = null; // 倒计时定时器

var messageQueue = []; // 消息队列
var processingMessage = false; // 是否正在处理消息

var AudiencesRating = {}; // 观众评分

function resetAudiencesRating() {
    AudiencesRating = {};
}

function resetCharacters() {
    characters = allCharacters;
}

function resetAnswers() {
    PlayersAnswers = {};
    AnswersScores = {};
    Answers = [];
    clearAnswers();
}

function getActivePlayerElements(s) {
    return Array.from(document.querySelectorAll(s + ":not(#player_template " + s + ")"));
}

function getActiveAnswerElements(s) {
    return Array.from(document.querySelectorAll(s + ":not(#answer_template " + s + ")"));
}

function getPlayers() {
    return getActivePlayerElements(".player_name").map(i => i.value).filter(i => i !== "");
}

function chooseCharacter() {
    if (characters.length === 0) {
        alert("角色已用尽，请重置角色");
        return;
    }
    var idx = Math.floor(Math.random() * characters.length);
    character = characters[idx];
    characters.splice(idx, 1); // 移除已选角色
    return updateCharacterInDocument();
}

function Enroll() {
    removePlayersInDocument();
}

function StopAnswering() {
    GameState = GS.Gaming.StopAnswering;
    updateGameStateInDocument();
    frozenAnswers();
}

async function newGame() {
    CurrentRound = 1;
    const rounds = document.getElementById("rounds");
    rounds.innerText = CurrentRound;
    frozenPlayers();
    Players = getPlayers();
    // 如果相同
    if (new Set(Players).size !== Players.length) {
        alert("玩家昵称不能相同");
        unfrozenPlayers();
        return;
    }
    PlayersScores = Object.fromEntries(Players.map(i => [i, 0]))
    resetAnswers();
    resetAudiencesRating();
    hideAddPlayerButton();
    unfrozenAnswers();
    resetCharacters();
    await chooseCharacter();
    await countingDown(60);
    StopAnswering();
}

function endGame() {
    unfrozenPlayers();
    resetAnswers();
    resetAudiencesRating();
    removeAnswersInDocument();
    showAddPlayerButton();
    resetCharacters();
    countingDown(0); // 停止计时
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
    await chooseCharacter();
    await countingDown(60);
    StopAnswering();
}

function startRating() {
    frozenAnswers();
    const instructionsElement = Array.from(document.getElementsByClassName("answer_guide"));
    instructionsElement.forEach(e => {e.style.opacity = '';})
    var playerElements = getActivePlayerElements(".player");
    for (var i = 0; i < playerElements.length; i++) {
        var pe = playerElements[i];
        var name = pe.getElementsByClassName("player_name")[0].value;
        var answer = pe.getElementsByClassName("player_answer")[0].value;
        PlayersAnswers[name] = answer;
        if (answer !== "") {
            if (!Answers.includes(answer)) {
                Answers.push(answer);
                AnswersPlayers[answer] = [name];
            } else {
                AnswersPlayers[answer].push(name);
            }
        }
    }
    if (Answers.length === 0) {
        alert("没有有效答案，无法评分");
        unfrozenAnswers();
        GameState = GS.Gaming.Answering;
        updateGameStateInDocument();
        return;
    }
    countingDown(0); // 停止计时
    AnswersScores = Object.fromEntries(Answers.map(i => [i, 0]));
    Answers4Rank = Answers.slice(); // 复制一份用于排序
    createAnswersInDocument();
}

function endRating() {
    for (var p in PlayersAnswers) {
        var pa = PlayersAnswers[p];
        if (pa in AnswersScores) {
            PlayersScores[p] += AnswersScores[pa];
        }
    }
    updatePlayersScoresInDocument();
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
            if (data.sender === Controller) {
                if (data.text === GSControl.StartEnroll) {
                    if (GameState === GS.Idle) {
                        GameState = GS.Enroll;
                        Enroll();
                    }
                }
                else if (data.text === GSControl.StartGame) {
                    if (GameState === GS.Enroll) {
                        GameState = GS.Gaming.Answering;
                        newGame();
                    }
                } else if (data.text === GSControl.StartRating) {
                    if (GS.isGaming(GameState)) {
                        if (GameState === GS.Gaming.Answering || GameState === GS.Gaming.StopAnswering) {
                            GameState = GS.Gaming.Rating;
                            startRating();
                        }
                    }
                } else if (data.text === GSControl.EndRating) {
                    if (GameState === GS.Gaming.Rating) {
                        GameState = GS.Gaming.Idle;
                        endRating();
                    }
                } else if (data.text === GSControl.NextRound) {
                    if (GS.isGaming(GameState)) {
                        GameState = GS.Gaming.Answering;
                        nextRound();
                    }
                } else if (data.text === GSControl.EndGame) {
                    if (GS.isGaming(GameState)) {
                        GameState = GS.Idle;
                        endGame();
                    }
                }
                gameStateChangeFeedback();
                updateGameStateInDocument();
                resolve();
            } else {
                if (GameState === GS.Gaming.Rating) {
                    audienceRate(data);
                } else if (GameState === GS.Enroll) {
                    // 报名阶段，允许添加玩家
                    var pname = data.sender;
                    if (data.text !== "1") { // 仅允许发送“1”报名
                        resolve();
                        return;
                    }

                    if (getActivePlayerElements(".player_name").map(i => i.value).includes(pname)) {
                        resolve();
                        return; // 已存在
                    }
                    if (getActivePlayerElements(".player_name").length >= MaxPlayers) {
                        resolve();
                        return; // 超出最大玩家数
                    }
                    addPlayer(pname);
                } else if (GameState === GS.Gaming.Answering) {
                    playerAnswer(data);
                }
                resolve();
            }
        } catch (err) {
            reject(err);
            return;
        }
    });
}

function getAudienceRate(text) {
    var num = parseInt(text);
    if (!isNaN(num)) {
        if (num >= 1 && num <= Answers.length) {
            return Answers[num - 1];
        } else {
            return null; // 超出范围
        }
    }

    if (text in Answers) {
        return text; // 存在
    } else {
        return null; // 不存在
    }
}

function audienceRate(danmaku) {
    var ar = getAudienceRate(danmaku.text);
    if (ar === null) return; // 无效评分
    else AudiencesRating[danmaku.sender] = ar;
    updateAnswersScores();
}

function updateAnswersScores() {
    AnswersScores = Object.fromEntries(Answers.map(i => [i, 0]));
    for (var voter in AudiencesRating) {
        var votedAnswer = AudiencesRating[voter];
        if (votedAnswer in AnswersScores) {
            AnswersScores[votedAnswer] += 1;
        }
    }
    // 更新界面
    updateAnswersScoresInDocument();
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

function addPlayer(name = "") {
    // temp

    if (getActivePlayerElements(".player_name").length >= MaxPlayers) {
        alert("已达到最大玩家数");
        return;
    }

    if (getActivePlayerElements(".player_name").map(i => i.value).includes("")) {
        return;
    }

    const playersWrap = document.getElementById("players_wrap");
    const playersTemplate = document.getElementById("player_template");

    // copy template
    var newPlayer = playersTemplate.cloneNode(true);

    var deleteButton = newPlayer.getElementsByClassName("delete_player_button")[0];
    deleteButton.onclick = () => {
        deleteButton.disabled = true; // 防止多次点击
        deletePlayer(newPlayer);
    };

    newPlayer.id = "";
    newPlayer.style.display = "";
    playersWrap.appendChild(newPlayer);

    var playerName = newPlayer.getElementsByClassName("player_name")[0];
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
    var playerAnswerShow = newPlayer.getElementsByClassName("player_answer_show")[0];
    playerAnswer.addEventListener("input", () => {
        playerAnswerShow.innerText = playerAnswer.value;
        fixTextWidth(playerAnswerShow);
    });
    fixTextWidth(playerAnswerShow, 0);

    if (getActivePlayerElements(".player_name").length >= MaxPlayers) {
        hideAddPlayerButton();
    }
}

function deletePlayer(e) {
    e.remove();
    if (getActivePlayerElements(".player_name").length < MaxPlayers) {
        showAddPlayerButton();
    }
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
    });
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
    const colors = ["#EF65C8", "#57DF0E", "#f07f1f", "#6efdfd"];

    const answersWrap = document.getElementById("answers_wrap");
    answersWrap.innerHTML = ""; // 清空

    const answersTemplate = document.getElementById("answer_template");
    for (var i = 0; i < Answers.length; i++) {
        var at = answersTemplate.cloneNode(true);
        at.id = "";
        at.style.display = "";

        at.style.height = 100./Answers.length + "%"; // 平均分配高度
        at.style.top = (i * 100./Answers.length) + "%";

        var answerText = at.getElementsByClassName("answer_content")[0];
        answerText.innerText = (i + 1) + ". " + Answers[i] + "： ";

        // attribute data-answer-index
        at.getElementsByClassName("answer")[0].setAttribute("data-answer-index", Answers[i]);

        var ap = at.getElementsByClassName("answer_progress")[0];
        if (AnswersPlayers[Answers[i]].length === 1) {
            ap.style.background = colors[Players.indexOf(AnswersPlayers[Answers[i]][0]) % colors.length];
        } else {
            var color = AnswersPlayers[Answers[i]].map(p => colors[Players.indexOf(p) % colors.length])
            var N = color.length;
            var steps = Array.from({length: N+1}, (_, i) => 100. * i / N)
            var softness = 100./(N*4);
            ap.style.background = "linear-gradient(to bottom, " + color.map((c, i) => c + " " + (steps[i]+softness) + "% " + (steps[i+1]-softness) + "%").join(", ") + ")";
        }
        answersWrap.appendChild(at);
    }
}

function updateAnswersScoresInDocument() {
    var answerElements = getActiveAnswerElements(".answer");
    var answerWraps = getActiveAnswerElements(".answer_wrap");
    for (var i = 0; i < answerElements.length; i++) {
        var ae = answerElements[i];
        var answerIndex = ae.getAttribute("data-answer-index");
        var scoreElement = ae.getElementsByClassName("answer_score")[0];
        if (answerIndex in AnswersScores) {
            scoreElement.innerText = AnswersScores[answerIndex];
        } else {
            scoreElement.innerText = "0";
        }

        var rank = Answers4Rank.sort((a, b) => AnswersScores[b] - AnswersScores[a]).indexOf(answerIndex);

        var maxScore = Math.max(...Object.values(AnswersScores), 0);
        var aw = answerWraps[i];
        aw.style.top = rank * (100./Answers.length) + "%";

        var progressElement = ae.getElementsByClassName("answer_progress")[0];
        progressElement.style.width = (maxScore === 0 ? 0 : (AnswersScores[answerIndex] / maxScore * 100)) + "%";
    }
}

function playerAnswer(data) {
    var pname = data.sender;
    var panswer = data.text.trim();
    if (!Players.includes(pname)) {
        return; // 非玩家
    }
    if (panswer === "") {
        return; // 空答案
    }
    var pelements = getActivePlayerElements(".player");
    for (var i = 0; i < pelements.length; i++) {
        var pe = pelements[i];
        var name = pe.getElementsByClassName("player_name")[0].value;
        if (name === pname) {
            var answerInput = pe.getElementsByClassName("player_answer")[0];
            answerInput.value = panswer;
            var answerShow = pe.getElementsByClassName("player_answer_show")[0];
            answerShow.innerText = panswer;
            fixTextWidth(answerShow, 0);
            PlayersAnswers[pname] = panswer;
            break;
        }
    }
}

function updatePlayersScoresInDocument() {
    var playerElements = getActivePlayerElements(".player");
    // 求PlayersScores的总分
    var maxScore = Math.max(...Object.values(PlayersScores), 0);
    for (var i = 0; i < playerElements.length; i++) {
        var pe = playerElements[i];
        var name = pe.getElementsByClassName("player_name")[0].value;
        var scoreElement = pe.getElementsByClassName("player_score")[0];
        var progressElement = pe.getElementsByClassName("player_progress")[0];
        if (name in PlayersScores) {
            scoreElement.innerText = PlayersScores[name];
            progressElement.style.width = (maxScore === 0 ? 0 : (PlayersScores[name] / maxScore * 100)) + "%";
        } else {
            scoreElement.innerText = "0";
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
}

function updateCharacterInDocument() {
    return new Promise((resolve, reject) => {
        const characterElement = document.getElementById("character");
        const instructionsElement = Array.from(document.getElementsByClassName("answer_guide"));
        const characterName = document.getElementById("character_name");
        //"url(" + characterImageHead + hand + ".png)"
        if (character !== null) {
            characterName.innerText = character;
            characterElement.src = characterImageHead + character + ".png";
            // 等加载完成再设置opacity
            characterElement.onload = () => {
                instructionsElement.forEach(e => {e.style.opacity = 1;})
                characterElement.style.opacity = 1;
                resolve();
            };
        } else {
            characterName.innerText = "棍木";
            characterElement.src = "";
            characterElement.style.opacity = 0;
            resolve();
        }
    })
}

function removePlayersInDocument() {
    const playersWrap = document.getElementById("players_wrap");
    playersWrap.innerHTML = ""; // 清空
}

function countingDown(seconds = 30) {
    const clock = document.getElementById("clock");
    return new Promise((resolve, reject) => {
        try {
            var remaining = seconds;
            updateClock(remaining);
            if (CountingDownInterval !== null) {
                clearInterval(CountingDownInterval);
            }
            CountingDownInterval = setInterval(() => {
                remaining -= 1;
                if (remaining <= 0) {
                    updateClock(0);
                    clearInterval(CountingDownInterval);
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

/// 实际代码
connect();