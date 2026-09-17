// ===================== 플레잉배팅장기 - app.js =====================
// 이제 이 클라이언트는 Firebase Realtime Database에 직접 쓰기를 하지 않습니다.
// (database.rules.json 에서 rooms/$roomId 자체를 완전히 쓰기 금지 처리했습니다.)
// 방 만들기/입장/배치/이동/베팅/폴드/콜 등 상태를 바꾸는 모든 동작은 Cloud
// Functions(functions/index.js)를 호출해서만 이루어지고, 서버만 아직 공개되지
// 않은 장기말의 실제 값을 알 수 있습니다. 클라이언트는 (1) 공개된 방 상태와
// (2) 내 자신의 말 값만 담긴 개인 전용 경로, 이 두 가지만 실시간으로 구독합니다.

const firebaseApp = firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.database();

// Cloud Functions를 배포한 리전 (Realtime Database와 가까운 리전으로 맞춰뒀습니다).
const FUNCTIONS_REGION = "asia-southeast1";
const fx = firebaseApp.functions(FUNCTIONS_REGION);
const createRoomFn = fx.httpsCallable("createRoom");
const joinRoomFn = fx.httpsCallable("joinRoom");
const submitPlacementFn = fx.httpsCallable("submitPlacement");
const movePieceFn = fx.httpsCallable("movePiece");
const duelBetFn = fx.httpsCallable("duelBet");
const duelRaiseFn = fx.httpsCallable("duelRaise");
const duelFoldFn = fx.httpsCallable("duelFold");
const duelCallFn = fx.httpsCallable("duelCall");
const claimForfeitFn = fx.httpsCallable("claimForfeit");
const rematchFn = fx.httpsCallable("rematch");

const TURN_LIMIT_MS = 3 * 60 * 1000; // 3분 (서버와 동일한 값 - 타이머 표시용)

// ==================== 사운드 파일 설정 ====================
// 아래 mp3 두 개를 GitHub 저장소의 루트(폴더 없이, index.html과 같은 위치)에
// 그대로 올리면 자동으로 재생됩니다. 파일명을 다르게 쓰고 싶다면 이 두 값만 바꾸세요.
const BGM_FILE = "배경음악.mp3";          // 배경음악 파일명
const MOVE_SFX_FILE = "장기말효과음.mp3"; // 장기말 배치/이동 효과음 파일명

let CLIENT_ID = null;   // = 내 Firebase Auth uid (로그인 완료 후 채워짐)
let roomId = null;
let myRole = null;      // 'first'(선공) | 'second'(후공) - 이번 판의 역할
let room = null;        // 최신 공개 room 스냅샷 (비밀 말 값은 들어있지 않음)
let myPrivateBoard = null; // 내 소유 말의 "실제" 위치->값 매핑 (나만 읽을 수 있는 경로)
let selectedCell = null;
let selectedBoardCell = null;
let lastMatchNumber = null;
let localPlacement = {}; // {"r,c": piece} - 확정 전까지는 완전히 로컬 상태

const $ = (id) => document.getElementById(id);

// ===================== 사운드 =====================

function initSounds() {
  const bgm = $("bgm-audio");
  const sfx = $("sfx-move");
  if (bgm) bgm.src = BGM_FILE;
  if (sfx) sfx.src = MOVE_SFX_FILE;
}

let musicOn = false;
function toggleMusic() {
  const bgm = $("bgm-audio");
  if (!bgm) return;
  musicOn = !musicOn;
  if (musicOn) {
    bgm.volume = 0.4;
    bgm.play().catch(() => { musicOn = false; });
    $("btn-toggle-music").textContent = "🔊";
  } else {
    bgm.pause();
    $("btn-toggle-music").textContent = "🔈";
  }
}

function playMoveSound() {
  const sfx = $("sfx-move");
  if (!sfx) return;
  try {
    sfx.currentTime = 0;
    sfx.play().catch(() => {});
  } catch (e) { /* 무시 */ }
}

function showScreen(name) {
  ["lobby", "waiting", "placement", "battle", "result"].forEach(s => {
    $("screen-" + s).style.display = (s === name) ? "" : "none";
  });
}

function showError(err) {
  const msg = (err && err.message) ? err.message : String(err);
  alert(msg);
}

// ===================== 로그인 (익명) =====================
// RTDB 보안 규칙과 Cloud Functions가 auth.uid 기반으로 "누가 어떤 말을 볼 수
// 있는지"를 판단하기 때문에, 방을 만들거나 입장하기 전에 먼저 로그인이 끝나야 합니다.

auth.onAuthStateChanged((user) => {
  if (user) {
    CLIENT_ID = user.uid;
    $("auth-status").style.display = "none";
    $("btn-create-room").disabled = false;
    $("btn-join-room").disabled = false;
  }
});

auth.signInAnonymously().catch((err) => {
  $("auth-status").textContent = "서버 연결에 실패했습니다. 새로고침 해주세요. (" + err.message + ")";
});

// ===================== 방 생성 / 입장 =====================

async function createRoom() {
  const chips = parseInt($("input-chips").value, 10) || 30;
  const name = $("input-name").value.trim();
  $("btn-create-room").disabled = true;
  try {
    const res = await createRoomFn({ chips, name });
    roomId = res.data.roomId;
    $("room-code-display").textContent = roomId;
    showScreen("waiting");
    listenRoom();
  } catch (err) {
    showError(err);
  } finally {
    $("btn-create-room").disabled = false;
  }
}

async function joinRoom() {
  const code = $("input-join-code").value.trim().toUpperCase();
  const name = $("input-name").value.trim();
  if (!code) { alert("방 코드를 입력하세요."); return; }
  $("btn-join-room").disabled = true;
  try {
    await joinRoomFn({ code, name });
    roomId = code;
    listenRoom();
  } catch (err) {
    showError(err);
  } finally {
    $("btn-join-room").disabled = false;
  }
}

// ===================== 방 상태 구독 =====================
// 두 개의 실시간 구독을 유지합니다:
//  1) rooms/$roomId       -> 공개 상태 (비밀 말 값은 절대 들어있지 않음)
//  2) rooms/$roomId/private/$내uid/board -> 내 말의 "진짜" 위치->값 매핑

function computeMyRole() {
  if (!room || !CLIENT_ID) return;
  if (room.players?.host?.uid === CLIENT_ID) myRole = room.roles ? (room.roles.first === "host" ? "first" : "second") : null;
  else if (room.players?.guest?.uid === CLIENT_ID) myRole = room.roles ? (room.roles.first === "guest" ? "first" : "second") : null;
}

function listenRoom() {
  db.ref("rooms/" + roomId).on("value", (snap) => {
    room = snap.val();
    if (!room) return;
    computeMyRole();
    render();
  });
  db.ref(`rooms/${roomId}/private/${CLIENT_ID}/board`).on("value", (snap) => {
    myPrivateBoard = snap.val() || {};
    if (room) render();
  });
}

// ===================== 렌더링 디스패치 =====================

function render() {
  if (!room) return;

  // 재대결로 새 판이 시작되면(matchNumber 증가) 로컬 배치 상태를 초기화합니다.
  if (room.matchNumber && room.matchNumber !== lastMatchNumber) {
    lastMatchNumber = room.matchNumber;
    localPlacement = {};
    selectedCell = null;
    selectedBoardCell = null;
  }

  if (room.winner) {
    showScreen("result");
    renderResult();
    return;
  }

  if (room.status === "waiting") {
    showScreen("waiting");
    $("room-code-display").textContent = roomId;
    return;
  }

  if (room.status === "placement") {
    showScreen("placement");
    renderPlacement();
    return;
  }

  if (room.status === "battle") {
    showScreen("battle");
    renderBattle();
    return;
  }
}

// ===================== 배치 단계 =====================
// 확정 버튼을 누르기 전까지는 서버에 아무것도 보내지 않는 완전한 로컬 상태입니다.

const ALL_PIECES = ["A","2","3","4","5","6","7","8","9","10","J","Q","K","star"];

function homeCellsFor(role) {
  const rows = role === "first" ? [7, 8] : [0, 1];
  const cells = [];
  for (const r of rows) for (let c = 0; c < 7; c++) cells.push([r, c]);
  return cells;
}

function renderPlacement() {
  const myDone = room.placementDone?.[myRole];
  const oppRole = myRole === "first" ? "second" : "first";
  const oppDone = room.placementDone?.[oppRole];

  $("placement-status").textContent = myDone
    ? (oppDone ? "상대도 배치를 완료했습니다. 전투를 시작합니다..." : "배치 완료! 상대를 기다리는 중...")
    : "말을 팔레트에서 선택한 뒤, 자신의 진영 칸을 클릭해 배치하세요. (14칸 모두 채워야 확정 가능)";

  const used = new Set(Object.values(localPlacement));
  const palette = $("placement-palette");
  palette.innerHTML = "";
  ALL_PIECES.forEach(p => {
    if (used.has(p)) return;
    const btn = document.createElement("div");
    btn.className = "piece-chip" + (selectedCell === p ? " selected" : "");
    btn.textContent = p === "star" ? "★" : p;
    btn.onclick = () => { selectedCell = (selectedCell === p) ? null : p; renderPlacement(); };
    palette.appendChild(btn);
  });

  const board = $("placement-board");
  board.innerHTML = "";
  board.style.pointerEvents = myDone ? "none" : "";
  const myCells = new Set(homeCellsFor(myRole).map(([r,c]) => r + "," + c));

  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 7; c++) {
      const cell = document.createElement("div");
      cell.className = "cell";
      const key = r + "," + c;
      if (myCells.has(key)) {
        cell.classList.add("mine-zone");
        const piece = localPlacement[key];
        if (piece) {
          cell.appendChild(makePieceEl(piece, true));
          cell.onclick = () => { delete localPlacement[key]; renderPlacement(); };
        } else {
          cell.onclick = () => {
            if (!selectedCell || myDone) return;
            localPlacement[key] = selectedCell;
            selectedCell = null;
            playMoveSound();
            renderPlacement();
          };
        }
      } else {
        cell.classList.add("dim-zone");
      }
      board.appendChild(cell);
    }
  }

  const allFilled = Object.keys(localPlacement).length === 14;
  $("btn-confirm-placement").disabled = !allFilled || myDone;

  // 선공(아래 진영, first)은 배치할 칸이 보드 아래쪽에 있어서, 팔레트가 보드 위에
  // 있으면 마우스를 매번 멀리 움직여야 합니다. 선공일 때만 팔레트를 보드 아래로
  // 옮겨서 자기 진영과 가깝게 둡니다. 후공(위 진영)은 기존 그대로 팔레트가 위에 있습니다.
  const panel = document.querySelector("#screen-placement .panel");
  const paletteEl = $("placement-palette");
  const boardFrame = board.closest(".board-frame") || board;
  if (panel && paletteEl && boardFrame) {
    if (myRole === "first") {
      panel.insertBefore(boardFrame, paletteEl);
    } else {
      panel.insertBefore(paletteEl, boardFrame);
    }
  }
}

async function confirmPlacement() {
  if (Object.keys(localPlacement).length !== 14) return;
  $("btn-confirm-placement").disabled = true;
  try {
    await submitPlacementFn({ roomId, placement: localPlacement });
  } catch (err) {
    showError(err);
    $("btn-confirm-placement").disabled = false;
  }
}

// ===================== 전투 단계 =====================

function boardKey(r, c) { return r + "_" + c; }

function makePieceEl(piece, alwaysShowRank) {
  const wrap = document.createElement("div");
  wrap.className = "piece";
  const img = document.createElement("img");
  img.src = pieceImageSrc(piece);
  wrap.appendChild(img);
  if (alwaysShowRank && piece !== "star") {
    const label = document.createElement("span");
    label.className = "piece-rank";
    label.textContent = piece;
    wrap.appendChild(label);
  }
  return wrap;
}

// 실제 말 값("A","2",..,"K","star") 또는 색깔 카테고리("black","white","star")를
// 받아서 알맞은 이미지 경로를 돌려줍니다.
function pieceImageSrc(value) {
  if (value === "star") return "assets/star.png";
  if (value === "black") return "assets/black.png";
  if (value === "white") return "assets/white.png";
  const isEven = ["2","4","6","8","10","Q"].includes(value);
  return isEven ? "assets/black.png" : "assets/white.png";
}

// 아직 결투로 숫자가 드러나지 않은 상대 말: 정확한 숫자는 모르지만, 이 게임은
// 원래부터 흑/백/★ 색깔은 항상 보이는 심리전 규칙이라 색깔 이미지는 그대로
// 보여주고, 숫자만 가립니다 (랭크 텍스트 없이 이미지만).
function makeColorOnlyPieceEl(color) {
  const wrap = document.createElement("div");
  wrap.className = "piece";
  const img = document.createElement("img");
  img.src = pieceImageSrc(color);
  wrap.appendChild(img);
  return wrap;
}

// 색깔 정보조차 아직 없는 극히 드문 과도 상태(로딩 중)를 위한 대체 표시.
function makeHiddenPieceEl() {
  const wrap = document.createElement("div");
  wrap.className = "piece piece-hidden";
  return wrap;
}

// 화면에 그릴 말 정보를 계산합니다. 내 말이면 내 개인 경로(myPrivateBoard)에서
// 진짜 값을 가져오고, 상대의 아직 공개되지 않은 말이면 색깔(흑/백/★)만 알 수
// 있고 정확한 숫자는 결투로 밝혀지기 전까지 알 수 없습니다.
function pieceAt(key) {
  const occ = room.board[key];
  if (!occ) return null;
  if (occ.revealed) {
    return { owner: occ.owner, piece: occ.piece, color: null, revealed: true, mine: occ.owner === myRole };
  }
  if (occ.owner === myRole) {
    const piece = myPrivateBoard ? myPrivateBoard[key] : undefined;
    return { owner: occ.owner, piece: piece || null, color: null, revealed: false, mine: true };
  }
  return { owner: occ.owner, piece: null, color: occ.color || null, revealed: false, mine: false };
}

function renderBattle() {
  const board = $("battle-board");
  board.innerHTML = "";
  const oppRole = myRole === "first" ? "second" : "first";

  $("chip-mine").textContent = room.chips[myRole];
  $("chip-opp").textContent = room.chips[oppRole];
  const activeSide = room.duel ? room.duel.turnToAct : room.turn;
  $("turn-indicator").textContent = room.duel
    ? (activeSide === myRole ? "결투 중 - 내 선택 차례" : "결투 중 - 상대 선택 대기")
    : (activeSide === myRole ? "내 차례입니다" : "상대 차례입니다");
  $("turn-indicator").className = activeSide === myRole ? "my-turn" : "opp-turn";

  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 7; c++) {
      const cell = document.createElement("div");
      cell.className = "cell";
      const key = boardKey(r, c);
      const info = pieceAt(key);
      if (info) {
        if (info.piece) {
          // 내 말이거나, 결투로 이미 공개된 말 - 정확한 숫자까지 보여줍니다.
          cell.appendChild(makePieceEl(info.piece, info.mine || info.revealed));
        } else if (info.color) {
          // 아직 결투 전인 상대 말 - 흑/백/★ 색깔은 보여주되 숫자는 가립니다.
          cell.appendChild(makeColorOnlyPieceEl(info.color));
        } else {
          // 색깔 정보조차 아직 안 온 극히 짧은 과도 상태
          cell.appendChild(makeHiddenPieceEl());
        }
      }
      if (selectedBoardCell && selectedBoardCell.r === r && selectedBoardCell.c === c) {
        cell.classList.add("selected");
      }
      cell.onclick = () => onBattleCellClick(r, c);
      board.appendChild(cell);
    }
  }

  renderDuel();
  updateTimerDisplay();
}

function onBattleCellClick(r, c) {
  if (room.duel) return; // 결투 중엔 이동 불가
  if (room.turn !== myRole) return;

  const key = boardKey(r, c);
  const occ = room.board[key];

  if (!selectedBoardCell) {
    if (occ && occ.owner === myRole) {
      selectedBoardCell = { r, c };
      render();
    }
    return;
  }

  if (selectedBoardCell.r === r && selectedBoardCell.c === c) {
    selectedBoardCell = null; render(); return;
  }
  if (occ && occ.owner === myRole) {
    selectedBoardCell = { r, c }; render(); return;
  }

  const { r: fr, c: fc } = selectedBoardCell;
  if (Math.abs(fr - r) > 1 || Math.abs(fc - c) > 1) { return; }

  playMoveSound();
  performMove(fr, fc, r, c);
  selectedBoardCell = null;
}

async function performMove(fr, fc, tr, tc) {
  try {
    await movePieceFn({ roomId, from: { r: fr, c: fc }, to: { r: tr, c: tc } });
  } catch (err) {
    showError(err);
  }
}

// ===================== 결투(배팅) 단계 =====================

function renderDuel() {
  const box = $("duel-box");
  if (!room.duel) { box.style.display = "none"; return; }
  box.style.display = "";
  const d = room.duel;
  const oppRole = myRole === "first" ? "second" : "first";
  const attackerLabel = d.attacker === "first" ? "선" : "후";
  const defenderLabel = d.defender === "first" ? "선" : "후";

  $("duel-title").textContent = `결투! (${attackerLabel} ➜ ${defenderLabel})`;
  $("duel-pot").textContent = d.contrib.first + d.contrib.second;
  $("duel-my-contrib").textContent = d.contrib[myRole] || 0;
  $("duel-opp-contrib").textContent = d.contrib[oppRole] || 0;

  const actions = $("duel-actions");
  actions.innerHTML = "";

  if (d.turnToAct !== myRole) {
    const waitMsg = document.createElement("p");
    waitMsg.textContent = "상대의 결정을 기다리는 중...";
    actions.appendChild(waitMsg);
    return;
  }

  const oppRemaining = room.chips[oppRole];
  const myRemaining = room.chips[myRole];

  if (d.stage === "opening" && myRole === d.attacker) {
    const max = Math.max(1, oppRemaining);
    const input = document.createElement("input");
    input.type = "number"; input.min = 1; input.max = max; input.value = 1;
    input.id = "duel-bet-input";
    const btn = document.createElement("button");
    btn.textContent = `배팅 (1~${max})`;
    btn.onclick = () => duelOpeningBet(clampInt(input.value, 1, max));
    actions.appendChild(input); actions.appendChild(btn);
  } else {
    const callBtn = document.createElement("button");
    const diff = (d.contrib[oppRole] || 0) - (d.contrib[myRole] || 0);
    callBtn.textContent = `콜 (${diff}칩 추가)`;
    callBtn.onclick = () => duelCall();
    actions.appendChild(callBtn);

    // 서버 쪽 duelRaise와 동일한 캡: 내가 낼 수 있는 만큼이면서, 상대가 콜(올인
    // 포함)로 받아줄 수 있는 만큼(=상대의 남은 칩)을 넘을 수 없습니다.
    const raiseMax = Math.max(1, Math.min(myRemaining - Math.max(0, diff), oppRemaining));
    if (raiseMax >= 1 && oppRemaining > 0) {
      const input = document.createElement("input");
      input.type = "number"; input.min = 1; input.max = raiseMax; input.value = 1;
      input.id = "duel-raise-input";
      const raiseBtn = document.createElement("button");
      raiseBtn.textContent = `레이즈 (추가 1~${raiseMax})`;
      raiseBtn.onclick = () => duelRaise(clampInt(input.value, 1, raiseMax));
      actions.appendChild(input); actions.appendChild(raiseBtn);
    }

    const foldBtn = document.createElement("button");
    foldBtn.textContent = "폴드";
    foldBtn.className = "danger";
    foldBtn.onclick = () => duelFold();
    actions.appendChild(foldBtn);
  }
}

function clampInt(v, min, max) {
  v = parseInt(v, 10);
  if (isNaN(v)) v = min;
  return Math.max(min, Math.min(max, v));
}

async function duelOpeningBet(amount) {
  try { await duelBetFn({ roomId, amount }); } catch (err) { showError(err); }
}
async function duelCall() {
  try { await duelCallFn({ roomId }); } catch (err) { showError(err); }
}
async function duelRaise(amount) {
  try { await duelRaiseFn({ roomId, amount }); } catch (err) { showError(err); }
}
async function duelFold() {
  try { await duelFoldFn({ roomId }); } catch (err) { showError(err); }
}

// ===================== 타이머 (3분 제한) =====================

let lastForfeitAttempt = 0;
let timerInterval = setInterval(() => {
  if (!room || room.status !== "battle" || room.winner) return;
  const deadlineBase = room.duel ? room.duel.lastActionDeadline : room.turnStartedAt;
  if (!deadlineBase) return;
  const elapsed = Date.now() - deadlineBase;
  if (elapsed > TURN_LIMIT_MS && Date.now() - lastForfeitAttempt > 3000) {
    lastForfeitAttempt = Date.now();
    claimForfeitFn({ roomId }).catch(() => {});
  }
  updateTimerDisplay();
}, 1000);

function updateTimerDisplay() {
  if (!room || room.status !== "battle") return;
  const deadlineBase = room.duel ? room.duel.lastActionDeadline : room.turnStartedAt;
  if (!deadlineBase) return;
  const remain = Math.max(0, TURN_LIMIT_MS - (Date.now() - deadlineBase));
  const sec = Math.floor(remain / 1000);
  const m = Math.floor(sec / 60), s = sec % 60;
  const el = $("timer-display");
  if (el) el.textContent = `${m}:${String(s).padStart(2, "0")}`;
}

// ===================== 결과 화면 =====================

function renderResult() {
  const won = room.winner === myRole;
  $("result-title").textContent = won ? "🎉 승리했습니다!" : "패배했습니다.";
  const reasons = { chips: "상대의 모든 칩을 획득", goal: "상대 진영 끝에서 1턴 생존", elimination: "상대의 모든 말을 제거", timeout: "상대의 제한시간 초과" };
  $("result-reason").textContent = "승리 조건: " + (reasons[room.winReason] || room.winReason);
}

// ===================== 재대결(게임 재시작) =====================

async function rematch() {
  $("btn-rematch").disabled = true;
  try {
    await rematchFn({ roomId });
  } catch (err) {
    showError(err);
  } finally {
    $("btn-rematch").disabled = false;
  }
}

// ===================== 이벤트 바인딩 =====================

window.addEventListener("DOMContentLoaded", () => {
  initSounds();
  $("btn-create-room").onclick = createRoom;
  $("btn-join-room").onclick = joinRoom;
  $("btn-confirm-placement").onclick = confirmPlacement;
  $("btn-copy-code").onclick = () => {
    navigator.clipboard.writeText(roomId);
    alert("방 코드가 복사되었습니다: " + roomId);
  };
  $("btn-rematch").onclick = rematch;
  $("btn-back-lobby").onclick = () => location.reload();
  $("btn-toggle-music").onclick = toggleMusic;
});
