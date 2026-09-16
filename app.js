// ===================== 플레잉배팅장기 - app.js =====================
// Firebase Realtime Database를 이용한 1v1 온라인 대전 로직

firebase.initializeApp(firebaseConfig);
const db = firebase.database();

const TURN_LIMIT_MS = 3 * 60 * 1000; // 3분
const FOLD_BONUS_CHECK_RANK = "2"; // 2가 폴드로 승리하면 상대 칩 10개 추가 획득
const FOLD_BONUS_AMOUNT = 10;

// ==================== 사운드 파일 설정 ====================
// 아래 mp3 두 개를 GitHub 저장소의 루트(폴더 없이, index.html과 같은 위치)에
// 그대로 올리면 자동으로 재생됩니다. 파일명을 다르게 쓰고 싶다면 이 두 값만 바꾸세요.
const BGM_FILE = "배경음악.mp3";          // 배경음악 파일명
const MOVE_SFX_FILE = "장기말효과음.mp3"; // 장기말 배치/이동 효과음 파일명

// -------- 로컬 클라이언트 식별자 (새로고침해도 내 자리 유지) --------
function getClientId() {
  let id = localStorage.getItem("jbj_clientId");
  if (!id) {
    id = "c_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem("jbj_clientId", id);
  }
  return id;
}
const CLIENT_ID = getClientId();

let roomId = null;
let myIdentity = null; // 'host'(방 만든 사람) | 'guest'(입장한 사람) - 방에 접속한 물리적 자리, 판이 바뀌어도 고정
let myRole = null;     // 'first'(선공) | 'second'(후공) - 이번 판의 역할. roles 매핑에 따라 매 판 바뀔 수 있음
let room = null;   // 최신 room 스냅샷 (로컬 캐시)
let selectedCell = null; // 배치 단계에서 선택된 팔레트 말
let selectedBoardCell = null; // 전투 단계에서 선택된 내 말 좌표
let lastMatchNumber = null; // 재대결 시 로컬 배치 상태를 초기화하기 위한 추적값

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

// ===================== 방 생성 / 입장 =====================

function genRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 5; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

async function createRoom() {
  const chips = parseInt($("input-chips").value, 10) || 30;
  const name = $("input-name").value.trim() || "방장";
  const code = genRoomCode();
  const ref = db.ref("rooms/" + code);

  await ref.set({
    createdAt: firebase.database.ServerValue.TIMESTAMP,
    chipsStart: chips,
    status: "waiting",
    // players: 방에 접속한 "자리"(host/guest) - 판이 몇 번을 가든 고정된 물리적 자리입니다.
    players: {
      host: { name, clientId: CLIENT_ID, connected: true }
    },
    // roles: 이번 판에서 누가 선공(first)/후공(second)인지 - host/guest 둘 중 하나를 가리킵니다.
    // 첫 판은 상대가 입장할 때 무작위로 정해지고, 이후 판은 "이긴 사람이 후공" 규칙으로 재배정됩니다.
    roles: null,
    matchNumber: 1,
    chips: { first: chips, second: chips },
    placement: {},
    placementDone: { first: false, second: false },
    board: {},
    turn: "first",
    turnNumber: 0,
    turnStartedAt: firebase.database.ServerValue.TIMESTAMP,
    duel: null,
    goalPending: null,
    winner: null,
    winReason: null,
    log: { "0": { t: firebase.database.ServerValue.TIMESTAMP, msg: `${name}님이 방을 만들었습니다. (시작 칩 ${chips}개)` } }
  });

  roomId = code;
  myIdentity = "host";
  $("room-code-display").textContent = code;
  showScreen("waiting");
  listenRoom();
}

async function joinRoom() {
  const code = $("input-join-code").value.trim().toUpperCase();
  const name = $("input-name").value.trim() || "참가자";
  if (!code) { alert("방 코드를 입력하세요."); return; }
  const ref = db.ref("rooms/" + code);

  const result = await ref.transaction((r) => {
    if (r === null) return r; // 방 없음
    if (r.players && r.players.guest) {
      // 이미 guest가 있음 - 재접속인지 확인
      if (r.players.guest.clientId === CLIENT_ID) return r; // 본인 재접속 허용
      return; // abort - 방이 이미 꽉참
    }
    if (!r.players || !r.players.host) return; // abort
    r.players.guest = { name, clientId: CLIENT_ID, connected: true };

    if (r.status === "waiting") {
      r.status = "placement";
      // 첫 판의 선공/후공은 무작위로 결정합니다.
      const hostIsFirst = Math.random() < 0.5;
      r.roles = hostIsFirst
        ? { first: "host", second: "guest" }
        : { first: "guest", second: "host" };
      const firstName = hostIsFirst ? r.players.host.name : name;
      const secondName = hostIsFirst ? name : r.players.host.name;
      r.log = r.log || {};
      let k = Object.keys(r.log).length;
      r.log[k] = { t: Date.now(), msg: `${name}님이 입장했습니다. (무작위 결정) 선공: ${firstName} / 후공: ${secondName}` };
    }
    return r;
  });

  if (!result.committed || result.snapshot.val() === null) {
    alert("존재하지 않거나 이미 가득 찬 방입니다.");
    return;
  }

  roomId = code;
  myIdentity = "guest";
  listenRoom();
}

// ===================== 방 상태 구독 =====================

function computeMyRole() {
  if (!room) return;
  // 내 자리(host/guest)가 아직 확정 안됐으면 (재접속 케이스) clientId로 판별
  if (!myIdentity) {
    if (room.players?.host?.clientId === CLIENT_ID) myIdentity = "host";
    else if (room.players?.guest?.clientId === CLIENT_ID) myIdentity = "guest";
  }
  if (myIdentity && room.roles) {
    myRole = room.roles.first === myIdentity ? "first" : "second";
  }
}

function listenRoom() {
  db.ref("rooms/" + roomId).on("value", (snap) => {
    room = snap.val();
    if (!room) return;
    computeMyRole();
    render();
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

const ALL_PIECES = ["A","2","3","4","5","6","7","8","9","10","J","Q","K","star"];

// 로컬 전용 임시 배치 상태 (서버에는 확정 버튼 눌러야 반영)
let localPlacement = {}; // {"r,c": piece}

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

  // 팔레트 렌더 (아직 안 쓴 말들)
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

  // 보드 렌더
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
          cell.appendChild(makePieceEl(piece, "mine", true));
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
  // 있으면 마우스를 매번 멀리 움직여야 합니다. 그래서 선공일 때만 팔레트를 보드
  // 아래로 옮겨서 자기 진영과 가깝게 둡니다. 후공(위 진영)은 기존 그대로 팔레트가 위에 있습니다.
  const panel = document.querySelector("#screen-placement .panel");
  const paletteEl = $("placement-palette");
  const boardFrame = board.closest(".board-frame") || board;
  if (panel && paletteEl && boardFrame) {
    if (myRole === "first") {
      panel.insertBefore(boardFrame, paletteEl); // 보드가 먼저, 팔레트가 그 아래
    } else {
      panel.insertBefore(paletteEl, boardFrame); // 기존 순서: 팔레트가 먼저, 보드가 아래
    }
  }
}

async function confirmPlacement() {
  if (Object.keys(localPlacement).length !== 14) return;
  const updates = {};
  updates[`placement/${myRole}`] = localPlacement;
  updates[`placementDone/${myRole}`] = true;
  await db.ref("rooms/" + roomId).update(updates);

  // 양쪽 다 완료됐는지 트랜잭션으로 확인 후 board 병합 (한쪽 클라이언트만 실행되도록)
  await db.ref("rooms/" + roomId).transaction((r) => {
    if (!r) return r;
    if (r.status !== "placement") return r;
    if (!r.placementDone?.first || !r.placementDone?.second) return r;
    // 병합
    const board = {};
    for (const role of ["first", "second"]) {
      const p = r.placement[role];
      for (const key in p) {
        const [rr, cc] = key.split(",").map(Number);
        board[rr + "_" + cc] = { owner: role, piece: p[key], revealed: false };
      }
    }
    r.board = board;
    r.status = "battle";
    r.turn = "first";
    r.turnNumber = 1;
    r.turnStartedAt = Date.now(); // 서버 트랜잭션 내부이므로 클라이언트 시각 기준 근사값 사용
    r.log = r.log || {};
    const k = Object.keys(r.log).length;
    r.log[k] = { t: Date.now(), msg: "양측 배치가 완료되었습니다. 선 플레이어부터 시작합니다." };
    return r;
  });
}

// ===================== 전투 단계 =====================

function boardKey(r, c) { return r + "_" + c; }

function makePieceEl(piece, side, alwaysShowRank) {
  // side: 'mine' | 'black' | 'white' | 'star'
  const wrap = document.createElement("div");
  wrap.className = "piece";
  const img = document.createElement("img");
  if (piece === "star") {
    img.src = "assets/star.png";
  } else {
    const isEven = ["2","4","6","8","10","Q"].includes(piece);
    img.src = isEven ? "assets/black.png" : "assets/white.png";
  }
  wrap.appendChild(img);
  if (alwaysShowRank && piece !== "star") {
    const label = document.createElement("span");
    label.className = "piece-rank";
    label.textContent = piece;
    wrap.appendChild(label);
  }
  return wrap;
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
      const occ = room.board[key];
      if (occ) {
        const isMine = occ.owner === myRole;
        const showRank = isMine || occ.revealed;
        cell.appendChild(makePieceEl(occ.piece, isMine ? "mine" : "opp", showRank));
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

  // 이미 선택된 말이 있는 상태
  if (selectedBoardCell.r === r && selectedBoardCell.c === c) {
    selectedBoardCell = null; render(); return;
  }
  if (occ && occ.owner === myRole) {
    selectedBoardCell = { r, c }; render(); return; // 다른 내 말로 선택 변경
  }

  const { r: fr, c: fc } = selectedBoardCell;
  if (Math.abs(fr - r) > 1 || Math.abs(fc - c) > 1) { return; } // 킹 이동 범위 초과

  playMoveSound();
  performMove(fr, fc, r, c);
  selectedBoardCell = null;
}

async function performMove(fr, fc, tr, tc) {
  await db.ref("rooms/" + roomId).transaction((room) => {
    if (!room || room.status !== "battle" || room.duel) return room;
    if (room.turn !== myRole) return room;
    const fromKey = boardKey(fr, fc);
    const toKey = boardKey(tr, tc);
    const moving = room.board[fromKey];
    if (!moving || moving.owner !== myRole) return room;
    const target = room.board[toKey];

    room.log = room.log || {};
    const logIdx = () => Object.keys(room.log).length;

    if (!target) {
      // 빈 칸 이동
      delete room.board[fromKey];
      room.board[toKey] = moving;
      applyGoalArrival(room, myRole, tr, tc, moving.piece);
      switchTurn(room);
      return room;
    }

    if (target.owner === myRole) return room; // 아군 칸 - 불가

    // 상대 말과 조우
    if (moving.piece === "star" || target.piece === "star") {
      // 자폭: 결투 없이 둘 다 제거
      delete room.board[fromKey];
      delete room.board[toKey];
      room.log[logIdx()] = { t: Date.now(), msg: "★ 조커가 상대 말과 함께 자폭했습니다!" };
      clearGoalIfPieceGone(room, tr, tc);
      switchTurn(room);
      return room;
    }

    // 결투 시작
    const attacker = myRole;
    const defender = target.owner;
    if (room.chips[attacker] < 1 || room.chips[defender] < 1) {
      // 기본 배팅 칩이 없으면 이동 불가 처리 (극단적 예외 상황 방지)
      return room;
    }
    room.chips[attacker] -= 1;
    room.chips[defender] -= 1;
    room.duel = {
      pos: { r: tr, c: tc },
      from: { r: fr, c: fc },
      attacker, defender,
      attackerPiece: moving.piece,
      defenderPiece: target.piece,
      contrib: { [attacker]: 1, [defender]: 1 },
      turnToAct: attacker,
      stage: "opening", // opening -> responding 반복
      lastActionDeadline: Date.now()
    };
    room.log[logIdx()] = { t: Date.now(), msg: `결투 발생! (${attacker === "first" ? "선" : "후"} vs ${defender === "first" ? "선" : "후"})` };
    return room;
  });
}

function switchTurn(room) {
  room.turnNumber = (room.turnNumber || 0) + 1;
  const finishedSide = room.turn;
  const nextSide = finishedSide === "first" ? "second" : "first";

  // 골 생존 체크: finishedSide가 방금 한 턴을 마쳤으므로, 상대(nextSide가 아니라
  // 그 반대편, 즉 "골에 들어가 있던 쪽")가 한 턴을 버텼는지 확인
  checkGoalSurvival(room, finishedSide);

  room.turn = nextSide;
  room.turnStartedAt = Date.now();

  checkEliminationWin(room);
}

function applyGoalArrival(room, owner, r, c, piece) {
  const targetRow = owner === "first" ? 0 : 8;
  if (r === targetRow) {
    room.goalPending = { owner, r, c, turnSet: room.turnNumber };
  } else if (room.goalPending && room.goalPending.owner === owner) {
    // 같은 편의 다른 말이 움직였다고 goalPending을 건드릴 필요는 없음(다른 칸이므로 유지)
  }
}

function clearGoalIfPieceGone(room, r, c) {
  if (room.goalPending && room.goalPending.r === r && room.goalPending.c === c) {
    room.goalPending = null;
  }
}

function checkGoalSurvival(room, finishedSide) {
  const gp = room.goalPending;
  if (!gp) return;
  if (gp.owner === finishedSide) return; // 자기 턴에 스스로 체크할 필요 없음 (상대 턴이 지나야 함)
  // finishedSide(상대편)의 턴이 막 끝남 = gp.owner 쪽이 한 턴을 버틴 것
  if (gp.turnSet >= room.turnNumber) return; // 도착한 바로 그 턴이면 아직 안버틴 것
  const cell = room.board[boardKey(gp.r, gp.c)];
  if (cell && cell.owner === gp.owner) {
    room.winner = gp.owner;
    room.winReason = "goal";
    room.log = room.log || {};
    room.log[Object.keys(room.log).length] = { t: Date.now(), msg: `${gp.owner === "first" ? "선" : "후"} 플레이어의 말이 상대 진영 끝에서 1턴을 버텨 승리했습니다!` };
  } else {
    room.goalPending = null;
  }
}

function checkEliminationWin(room) {
  if (room.winner) return;
  const counts = { first: 0, second: 0 };
  for (const k in room.board) counts[room.board[k].owner]++;
  if (counts.first === 0) { room.winner = "second"; room.winReason = "elimination"; }
  else if (counts.second === 0) { room.winner = "first"; room.winReason = "elimination"; }

  if (room.chips.first <= 0) { room.winner = "second"; room.winReason = "chips"; }
  else if (room.chips.second <= 0) { room.winner = "first"; room.winReason = "chips"; }
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
    // 공격자 최초 배팅: 1 ~ 상대 남은칩
    const max = Math.max(1, oppRemaining);
    const input = document.createElement("input");
    input.type = "number"; input.min = 1; input.max = max; input.value = 1;
    input.id = "duel-bet-input";
    const btn = document.createElement("button");
    btn.textContent = `배팅 (1~${max})`;
    btn.onclick = () => duelOpeningBet(clampInt(input.value, 1, max));
    actions.appendChild(input); actions.appendChild(btn);
  } else {
    // 상대의 배팅에 대응: 콜 / 레이즈 / 폴드
    const callBtn = document.createElement("button");
    const diff = (d.contrib[oppRole] || 0) - (d.contrib[myRole] || 0);
    callBtn.textContent = `콜 (${diff}칩 추가)`;
    callBtn.onclick = () => duelCall();
    actions.appendChild(callBtn);

    const raiseMax = Math.max(1, myRemaining - Math.max(0, diff));
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
  await db.ref("rooms/" + roomId).transaction((room) => {
    if (!room || !room.duel) return room;
    const d = room.duel;
    if (d.turnToAct !== myRole || d.stage !== "opening" || myRole !== d.attacker) return room;
    const oppRole = myRole === "first" ? "second" : "first";
    const max = Math.max(1, room.chips[oppRole]);
    amount = Math.max(1, Math.min(amount, max));
    if (room.chips[myRole] < amount) amount = room.chips[myRole];
    room.chips[myRole] -= amount;
    d.contrib[myRole] = (d.contrib[myRole] || 0) + amount;
    d.stage = "responding";
    d.turnToAct = oppRole;
    d.lastActionDeadline = Date.now();
    return room;
  });
}

async function duelCall() {
  await db.ref("rooms/" + roomId).transaction((room) => {
    if (!room || !room.duel) return room;
    const d = room.duel;
    if (d.turnToAct !== myRole) return room;
    const oppRole = myRole === "first" ? "second" : "first";
    const diff = (d.contrib[oppRole] || 0) - (d.contrib[myRole] || 0);
    const pay = Math.min(Math.max(diff, 0), room.chips[myRole]);
    room.chips[myRole] -= pay;
    d.contrib[myRole] = (d.contrib[myRole] || 0) + pay;
    resolveShowdown(room);
    return room;
  });
}

async function duelRaise(amount) {
  await db.ref("rooms/" + roomId).transaction((room) => {
    if (!room || !room.duel) return room;
    const d = room.duel;
    if (d.turnToAct !== myRole) return room;
    const oppRole = myRole === "first" ? "second" : "first";
    const diff = Math.max(0, (d.contrib[oppRole] || 0) - (d.contrib[myRole] || 0));
    const maxExtra = Math.max(1, room.chips[myRole] - diff);
    amount = Math.max(1, Math.min(amount, maxExtra));
    const totalPay = Math.min(diff + amount, room.chips[myRole]);
    room.chips[myRole] -= totalPay;
    d.contrib[myRole] = (d.contrib[myRole] || 0) + totalPay;
    d.stage = "responding";
    d.turnToAct = oppRole;
    d.lastActionDeadline = Date.now();
    return room;
  });
}

async function duelFold() {
  await db.ref("rooms/" + roomId).transaction((room) => {
    if (!room || !room.duel) return room;
    const d = room.duel;
    if (d.turnToAct !== myRole) return room;
    const winnerSide = myRole === d.attacker ? d.defender : d.attacker;
    const loserSide = myRole;
    finishDuel(room, winnerSide, loserSide, "fold");
    return room;
  });
}

function resolveShowdown(room) {
  const d = room.duel;
  const outcome = resolveDuel(d.attackerPiece, d.defenderPiece); // 'a' | 'b' | 'draw'
  room.log = room.log || {};
  const logIdx = () => Object.keys(room.log).length;

  const posKey = boardKey(d.pos.r, d.pos.c);
  const fromKey = boardKey(d.from.r, d.from.c);
  const pot = (d.contrib[d.attacker] || 0) + (d.contrib[d.defender] || 0);

  if (outcome === "draw") {
    delete room.board[fromKey];
    delete room.board[posKey];
    room.chips[d.attacker] += d.contrib[d.attacker] || 0;
    room.chips[d.defender] += d.contrib[d.defender] || 0;
    room.log[logIdx()] = { t: Date.now(), msg: `결투 무승부! (${d.attackerPiece} vs ${d.defenderPiece}) 두 말 모두 제거, 칩은 반환됩니다.` };
    clearGoalIfPieceGone(room, d.pos.r, d.pos.c);
  } else {
    const winnerSide = outcome === "a" ? d.attacker : d.defender;
    const winnerPiece = outcome === "a" ? d.attackerPiece : d.defenderPiece;
    finalizeDuelWin(room, d, winnerSide, winnerPiece, pot, `${d.attackerPiece} vs ${d.defenderPiece} 결투 결과`);
  }

  room.duel = null;
  switchTurn(room);
}

function finishDuel(room, winnerSide, loserSide, reason) {
  const d = room.duel;
  room.log = room.log || {};
  const logIdx = () => Object.keys(room.log).length;
  const pot = (d.contrib[d.attacker] || 0) + (d.contrib[d.defender] || 0);
  const winnerPiece = winnerSide === d.attacker ? d.attackerPiece : d.defenderPiece;

  finalizeDuelWin(room, d, winnerSide, winnerPiece, pot, "상대가 폴드했습니다");

  // 특수룰: 2가 폴드로 승리 시 상대 칩 10개 추가 획득
  if (winnerPiece === FOLD_BONUS_CHECK_RANK) {
    const bonus = Math.min(FOLD_BONUS_AMOUNT, room.chips[loserSide]);
    room.chips[loserSide] -= bonus;
    room.chips[winnerSide] += bonus;
    room.log[logIdx()] = { t: Date.now(), msg: `2의 폴드 승리 보너스! 상대 칩 ${bonus}개를 추가로 획득했습니다.` };
  }

  room.duel = null;
  switchTurn(room);
}

function finalizeDuelWin(room, d, winnerSide, winnerPiece, pot, msgPrefix) {
  const posKey = boardKey(d.pos.r, d.pos.c);
  const fromKey = boardKey(d.from.r, d.from.c);
  room.log = room.log || {};
  const logIdx = () => Object.keys(room.log).length;

  room.chips[winnerSide] += pot;

  if (winnerSide === d.attacker) {
    // 공격자가 승리: 공격자 말이 목표 칸으로 이동, 수비자 말 제거
    delete room.board[fromKey];
    room.board[posKey] = { owner: d.attacker, piece: d.attackerPiece, revealed: true };
    applyGoalArrival(room, d.attacker, d.pos.r, d.pos.c, d.attackerPiece);
  } else {
    // 수비자가 승리: 공격자 말 제거, 수비자 말은 원위치 유지(공개됨)
    delete room.board[fromKey];
    room.board[posKey] = { owner: d.defender, piece: d.defenderPiece, revealed: true };
  }
  room.log[logIdx()] = { t: Date.now(), msg: `${msgPrefix} - ${winnerPiece} 승리! 칩 ${pot}개 획득.` };
  checkEliminationWin(room);
}

// ===================== 타이머 (3분 제한) =====================

let timerInterval = setInterval(() => {
  if (!room || room.status !== "battle" || room.winner) return;
  const deadlineBase = room.duel ? room.duel.lastActionDeadline : room.turnStartedAt;
  if (!deadlineBase) return;
  const elapsed = Date.now() - deadlineBase;
  if (elapsed > TURN_LIMIT_MS) {
    tryForfeit();
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

async function tryForfeit() {
  await db.ref("rooms/" + roomId).transaction((room) => {
    if (!room || room.winner || room.status !== "battle") return room;
    const deadlineBase = room.duel ? room.duel.lastActionDeadline : room.turnStartedAt;
    if (!deadlineBase || Date.now() - deadlineBase <= TURN_LIMIT_MS) return room;
    const timedOutSide = room.duel ? room.duel.turnToAct : room.turn;
    const winnerSide = timedOutSide === "first" ? "second" : "first";
    room.winner = winnerSide;
    room.winReason = "timeout";
    room.log = room.log || {};
    room.log[Object.keys(room.log).length] = { t: Date.now(), msg: `${timedOutSide === "first" ? "선" : "후"} 플레이어가 제한시간(3분)을 초과하여 기권패 처리되었습니다.` };
    return room;
  });
}

// ===================== 결과 화면 =====================

function renderResult() {
  const won = room.winner === myRole;
  $("result-title").textContent = won ? "🎉 승리했습니다!" : "패배했습니다.";
  const reasons = { chips: "상대의 모든 칩을 획득", goal: "상대 진영 끝에서 1턴 생존", elimination: "상대의 모든 말을 제거", timeout: "상대의 제한시간 초과" };
  $("result-reason").textContent = "승리 조건: " + (reasons[room.winReason] || room.winReason);
}

// ===================== 재대결(게임 재시작) =====================
// 로비로 돌아가지 않고 같은 방에서 바로 다음 판을 시작합니다.
// 규칙: 이번 판 승자가 다음 판의 후공, 패자가 다음 판의 선공이 됩니다.
// (첫 판의 선공/후공은 입장 시점에 무작위로 이미 정해져 있습니다.)
async function rematch() {
  await db.ref("rooms/" + roomId).transaction((r) => {
    if (!r || !r.winner || !r.roles) return r;

    const winnerRole = r.winner; // 'first' | 'second'
    const winnerIdentity = r.roles[winnerRole]; // 'host' | 'guest'
    const loserIdentity = winnerIdentity === "host" ? "guest" : "host";

    r.roles = { first: loserIdentity, second: winnerIdentity };
    r.chips = { first: r.chipsStart, second: r.chipsStart };
    r.placement = {};
    r.placementDone = { first: false, second: false };
    r.board = {};
    r.turn = "first";
    r.turnNumber = 0;
    r.turnStartedAt = null;
    r.duel = null;
    r.goalPending = null;
    r.winner = null;
    r.winReason = null;
    r.status = "placement";
    r.matchNumber = (r.matchNumber || 1) + 1;

    r.log = r.log || {};
    const k = Object.keys(r.log).length;
    const winnerName = r.players?.[winnerIdentity]?.name || (winnerRole === "first" ? "선공" : "후공");
    const loserName = r.players?.[loserIdentity]?.name || "상대";
    r.log[k] = { t: Date.now(), msg: `${r.matchNumber}판 시작! (지난 판 승자 ${winnerName}님이 후공, ${loserName}님이 선공입니다)` };
    return r;
  });
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
