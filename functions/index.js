// ===================== 플레잉배팅장기 - Cloud Functions =====================
// 이 파일이 하는 일: "아직 공개되지 않은 장기말의 실제 값"을 클라이언트에 절대
// 내려보내지 않고, 서버(Admin SDK)만 읽을 수 있는 rooms/$roomId/private/$uid/board
// 경로에 보관합니다. 이동/결투 관련 모든 판정은 여기서만 이루어지고, 그 결과(공개된
// 말, 칩 변화, 턴 진행 등)만 공개 데이터(rooms/$roomId)에 반영됩니다.
//
// 클라이언트는 database.rules.json 규칙에 의해 rooms/$roomId 자체에는 쓰기가
// 전혀 불가능하고(.write:false), 오직 아래 함수들을 호출해서만 게임을 진행할 수
// 있습니다. 이렇게 하면 콘솔(F12)로 RTDB에 직접 쓰기를 시도해도 반영되지 않습니다.

const functions = require("firebase-functions");
const admin = require("firebase-admin");
admin.initializeApp();
const db = admin.database();

const { homeCells, resolveDuel, isValidPlacement, pieceColor } = require("./rules.js");

// Realtime Database 리전과 가까운 리전을 사용합니다 (지연시간 최소화).
const REGION = "asia-southeast1";

const TURN_LIMIT_MS = 3 * 60 * 1000; // 3분
const FOLD_BONUS_CHECK_RANK = "2";
const FOLD_BONUS_AMOUNT = 10;

function boardKey(r, c) {
  return r + "_" + c;
}

function requireAuth(context) {
  if (!context.auth) {
    throw new functions.https.HttpsError("unauthenticated", "로그인이 필요합니다. 잠시 후 다시 시도해주세요.");
  }
  return context.auth.uid;
}

async function getRoom(roomId) {
  if (!roomId) throw new functions.https.HttpsError("invalid-argument", "방 코드가 없습니다.");
  const snap = await db.ref("rooms/" + roomId).get();
  if (!snap.exists()) throw new functions.https.HttpsError("not-found", "존재하지 않는 방입니다.");
  return snap.val();
}

function identityOfUid(room, uid) {
  if (room.players && room.players.host && room.players.host.uid === uid) return "host";
  if (room.players && room.players.guest && room.players.guest.uid === uid) return "guest";
  return null;
}

function roleOfUid(room, uid) {
  const identity = identityOfUid(room, uid);
  if (!identity || !room.roles) return null;
  return room.roles.first === identity ? "first" : "second";
}

function requireParticipant(room, uid) {
  const identity = identityOfUid(room, uid);
  if (!identity) {
    throw new functions.https.HttpsError("permission-denied", "이 방의 참가자가 아닙니다.");
  }
  return identity;
}

function genRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 5; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function addLog(r, msg) {
  r.log = r.log || {};
  const k = Object.keys(r.log).length;
  r.log[k] = { t: Date.now(), msg };
}

// ===================== 순수 게임 로직 (공개 데이터만 다룸) =====================

function applyGoalArrival(r, owner, row, col) {
  const targetRow = owner === "first" ? 0 : 8;
  if (row === targetRow) {
    r.goalPending = { owner, r: row, c: col, turnSet: r.turnNumber };
  }
}

function clearGoalIfPieceGone(r, row, col) {
  if (r.goalPending && r.goalPending.r === row && r.goalPending.c === col) {
    r.goalPending = null;
  }
}

function checkGoalSurvival(r, finishedSide) {
  const gp = r.goalPending;
  if (!gp) return;
  if (gp.owner === finishedSide) return;
  if (gp.turnSet >= r.turnNumber) return;
  const cell = r.board[boardKey(gp.r, gp.c)];
  if (cell && cell.owner === gp.owner) {
    r.winner = gp.owner;
    r.winReason = "goal";
    addLog(r, `${gp.owner === "first" ? "선" : "후"} 플레이어의 말이 상대 진영 끝에서 1턴을 버텨 승리했습니다!`);
  } else {
    r.goalPending = null;
  }
}

function checkEliminationWin(r) {
  if (r.winner) return;
  const counts = { first: 0, second: 0 };
  for (const k in r.board) counts[r.board[k].owner]++;
  if (counts.first === 0) { r.winner = "second"; r.winReason = "elimination"; }
  else if (counts.second === 0) { r.winner = "first"; r.winReason = "elimination"; }

  if (r.chips.first <= 0) { r.winner = "second"; r.winReason = "chips"; }
  else if (r.chips.second <= 0) { r.winner = "first"; r.winReason = "chips"; }
}

function switchTurn(r) {
  r.turnNumber = (r.turnNumber || 0) + 1;
  const finishedSide = r.turn;
  const nextSide = finishedSide === "first" ? "second" : "first";
  checkGoalSurvival(r, finishedSide);
  r.turn = nextSide;
  r.turnStartedAt = Date.now();
  checkEliminationWin(r);
}

// 폴드로 결투가 끝날 때 - 승자의 말(winnerPiece)은 이미 서버에서 조회된 값입니다.
function finishDuelServerFold(r, d, winnerSide, loserSide, winnerPiece) {
  const posKey = boardKey(d.pos.r, d.pos.c);
  const fromKey = boardKey(d.from.r, d.from.c);
  const pot = (d.contrib[d.attacker] || 0) + (d.contrib[d.defender] || 0);

  r.chips[winnerSide] += pot;
  delete r.board[fromKey];
  // 폴드는 "포기"일 뿐, 카드를 뒤집어 확인하는 절차(콜/쇼다운)가 없으므로
  // 승자의 말도 숫자를 공개하지 않습니다. 흑/백/★ 색깔만 유지한 채 그대로 가립니다.
  r.board[posKey] = { owner: winnerSide, revealed: false, color: pieceColor(winnerPiece) };
  if (winnerSide === d.attacker) {
    applyGoalArrival(r, d.attacker, d.pos.r, d.pos.c);
  }
  addLog(r, `상대가 폴드했습니다! 칩 ${pot}개 획득 (말은 공개되지 않습니다).`);
  checkEliminationWin(r);

  if (winnerPiece === FOLD_BONUS_CHECK_RANK) {
    const bonus = Math.min(FOLD_BONUS_AMOUNT, r.chips[loserSide]);
    r.chips[loserSide] -= bonus;
    r.chips[winnerSide] += bonus;
    addLog(r, `2의 폴드 승리 보너스! 상대 칩 ${bonus}개를 추가로 획득했습니다.`);
  }

  r.duel = null;
  switchTurn(r);
}

// ===================== 방 생성 / 입장 =====================

exports.createRoom = functions.region(REGION).https.onCall(async (data, context) => {
  const uid = requireAuth(context);
  let chips = parseInt(data.chips, 10);
  if (!Number.isFinite(chips)) chips = 30;
  chips = Math.max(5, Math.min(200, chips));
  const name = ((data.name || "").toString().trim() || "방장").slice(0, 20);

  let code = null;
  for (let attempt = 0; attempt < 8 && !code; attempt++) {
    const candidate = genRoomCode();
    const ref = db.ref("rooms/" + candidate);
    const result = await ref.transaction((r) => {
      if (r !== null) return; // 이미 존재하는 코드 - 재시도
      return {
        createdAt: admin.database.ServerValue.TIMESTAMP,
        chipsStart: chips,
        status: "waiting",
        players: { host: { name, uid, connected: true } },
        roles: null,
        matchNumber: 1,
        chips: { first: chips, second: chips },
        placementDone: { first: false, second: false },
        board: {},
        turn: "first",
        turnNumber: 0,
        turnStartedAt: null,
        duel: null,
        goalPending: null,
        winner: null,
        winReason: null,
        log: { 0: { t: Date.now(), msg: `${name}님이 방을 만들었습니다. (시작 칩 ${chips}개)` } }
      };
    });
    if (result.committed) code = candidate;
  }
  if (!code) {
    throw new functions.https.HttpsError("resource-exhausted", "방 코드 생성에 실패했습니다. 다시 시도해주세요.");
  }
  return { roomId: code };
});

exports.joinRoom = functions.region(REGION).https.onCall(async (data, context) => {
  const uid = requireAuth(context);
  const code = (data.code || "").toString().trim().toUpperCase();
  const name = ((data.name || "").toString().trim() || "참가자").slice(0, 20);
  if (!code) throw new functions.https.HttpsError("invalid-argument", "방 코드를 입력하세요.");

  const ref = db.ref("rooms/" + code);
  const result = await ref.transaction((r) => {
    if (r === null) return r; // 방 없음
    if (r.players && r.players.guest) {
      if (r.players.guest.uid === uid) return r; // 본인 재입장 허용
      return; // abort - 이미 꽉참
    }
    if (!r.players || !r.players.host) return;
    if (r.players.host.uid === uid) return; // 자기 방엔 게스트로 입장 불가

    r.players.guest = { name, uid, connected: true };
    if (r.status === "waiting") {
      r.status = "placement";
      const hostIsFirst = Math.random() < 0.5;
      r.roles = hostIsFirst ? { first: "host", second: "guest" } : { first: "guest", second: "host" };
      const firstName = hostIsFirst ? r.players.host.name : name;
      const secondName = hostIsFirst ? name : r.players.host.name;
      addLog(r, `${name}님이 입장했습니다. (무작위 결정) 선공: ${firstName} / 후공: ${secondName}`);
    }
    return r;
  });

  if (!result.committed || result.snapshot.val() === null) {
    throw new functions.https.HttpsError("failed-precondition", "존재하지 않거나 이미 가득 찬 방입니다.");
  }
  return { ok: true };
});

// ===================== 배치 =====================

exports.submitPlacement = functions.region(REGION).https.onCall(async (data, context) => {
  const uid = requireAuth(context);
  const roomId = (data.roomId || "").toString();
  const rawPlacement = data.placement || {}; // { "r,c": piece }

  const room = await getRoom(roomId);
  requireParticipant(room, uid);
  const role = roleOfUid(room, uid);
  if (!role) throw new functions.https.HttpsError("failed-precondition", "아직 상대가 입장하지 않았습니다.");
  if (room.status !== "placement") throw new functions.https.HttpsError("failed-precondition", "지금은 배치 단계가 아닙니다.");
  if (room.placementDone && room.placementDone[role]) {
    throw new functions.https.HttpsError("failed-precondition", "이미 배치를 완료했습니다.");
  }
  if (!isValidPlacement(rawPlacement)) {
    throw new functions.https.HttpsError("invalid-argument", "배치가 올바르지 않습니다. (14칸에 서로 다른 14종류 말이 모두 있어야 합니다)");
  }
  const allowedKeys = new Set(homeCells(role).map(({ r, c }) => r + "," + c));
  for (const key in rawPlacement) {
    if (!allowedKeys.has(key)) {
      throw new functions.https.HttpsError("invalid-argument", "자신의 진영 칸에만 배치할 수 있습니다.");
    }
  }

  // "r,c" 키를 게임 전체에서 쓰는 "r_c" 형식으로 변환해서 비공개 경로에 저장
  const myUid = uid;
  const privateBoard = {};
  for (const key in rawPlacement) {
    const [rr, cc] = key.split(",").map(Number);
    privateBoard[boardKey(rr, cc)] = rawPlacement[key];
  }
  await db.ref(`privateBoards/${roomId}/${myUid}/board`).set(privateBoard);
  await db.ref(`rooms/${roomId}/placementDone/${role}`).set(true);

  // 양쪽 다 완료됐는지 확인하고, 완료됐다면 "마스킹된"(값이 없는) 공개 보드로 병합
  const oppRole = role === "first" ? "second" : "first";
  const oppIdentity = room.roles[oppRole];
  const oppUid = room.players[oppIdentity].uid;

  const [myBoardSnap, oppBoardSnap] = await Promise.all([
    db.ref(`privateBoards/${roomId}/${myUid}/board`).get(),
    db.ref(`privateBoards/${roomId}/${oppUid}/board`).get()
  ]);
  const myPrivateBoard = myBoardSnap.val();
  const oppPrivateBoard = oppBoardSnap.exists() ? oppBoardSnap.val() : null;

  await db.ref("rooms/" + roomId).transaction((r) => {
    if (!r) return r;
    if (r.status !== "placement") return r;
    if (!r.placementDone || !r.placementDone.first || !r.placementDone.second) return r;

    const boardsByRole = {};
    boardsByRole[role] = myPrivateBoard;
    boardsByRole[oppRole] = oppPrivateBoard;
    if (!boardsByRole.first || !boardsByRole.second) return r; // 아직 데이터 준비 중 - 다음 기회에 재시도

    const board = {};
    for (const rl of ["first", "second"]) {
      const b = boardsByRole[rl];
      for (const key in b) {
        // 정확한 숫자는 숨기되, 흑/백/★ 색깔은 원래 규칙상 항상 보여야 하는
        // 정보이므로 공개 데이터에 같이 기록합니다 (심리전용 정보).
        board[key] = { owner: rl, revealed: false, color: pieceColor(b[key]) };
      }
    }
    r.board = board;
    r.status = "battle";
    r.turn = "first";
    r.turnNumber = 1;
    r.turnStartedAt = Date.now();
    addLog(r, "양측 배치가 완료되었습니다. 선 플레이어부터 시작합니다.");
    return r;
  });

  return { ok: true };
});

// ===================== 이동 / 결투 시작 =====================

exports.movePiece = functions.region(REGION).https.onCall(async (data, context) => {
  const uid = requireAuth(context);
  const roomId = (data.roomId || "").toString();
  const from = data.from;
  const to = data.to;
  if (!from || !to || typeof from.r !== "number" || typeof to.r !== "number") {
    throw new functions.https.HttpsError("invalid-argument", "이동 정보가 올바르지 않습니다.");
  }

  const room = await getRoom(roomId);
  requireParticipant(room, uid);
  const role = roleOfUid(room, uid);
  if (!role) throw new functions.https.HttpsError("failed-precondition", "역할이 아직 정해지지 않았습니다.");
  if (room.status !== "battle") throw new functions.https.HttpsError("failed-precondition", "전투 단계가 아닙니다.");
  if (room.duel) throw new functions.https.HttpsError("failed-precondition", "결투 중에는 이동할 수 없습니다.");
  if (room.turn !== role) throw new functions.https.HttpsError("failed-precondition", "내 차례가 아닙니다.");
  if (Math.abs(from.r - to.r) > 1 || Math.abs(from.c - to.c) > 1) {
    throw new functions.https.HttpsError("invalid-argument", "인접한 칸으로만 이동할 수 있습니다.");
  }

  const fromKey = boardKey(from.r, from.c);
  const toKey = boardKey(to.r, to.c);
  const moving = room.board[fromKey];
  if (!moving || moving.owner !== role) {
    throw new functions.https.HttpsError("failed-precondition", "이동할 말이 없습니다.");
  }
  const target = room.board[toKey];
  if (target && target.owner === role) {
    throw new functions.https.HttpsError("invalid-argument", "아군 칸으로는 이동할 수 없습니다.");
  }

  // ---- 빈 칸으로 이동: 비밀 정보가 필요 없으므로 바로 처리 ----
  if (!target) {
    await db.ref("rooms/" + roomId).transaction((r) => {
      if (!r || r.status !== "battle" || r.duel) return r;
      if (r.turn !== role) return r;
      const mv = r.board[fromKey];
      if (!mv || mv.owner !== role) return r;
      if (r.board[toKey]) return r; // 그 사이 상황이 바뀜
      delete r.board[fromKey];
      r.board[toKey] = mv; // revealed 여부 그대로 유지 (이동만으로는 공개되지 않음)
      applyGoalArrival(r, role, to.r, to.c);
      switchTurn(r);
      return r;
    });

    await db.ref(`privateBoards/${roomId}/${uid}/board`).transaction((priv) => {
      if (!priv) return priv;
      const piece = priv[fromKey];
      if (piece === undefined) return priv;
      delete priv[fromKey];
      priv[toKey] = piece;
      return priv;
    });

    return { ok: true, result: "moved" };
  }

  // ---- 상대 말과 조우: ★ 여부 확인을 위해 서버에서만 실제 값을 조회 ----
  const defenderRole = target.owner;
  const defenderIdentity = room.roles[defenderRole];
  const defenderUid = room.players[defenderIdentity].uid;

  const [attackerPieceSnap, defenderPieceSnap] = await Promise.all([
    db.ref(`privateBoards/${roomId}/${uid}/board/${fromKey}`).get(),
    db.ref(`privateBoards/${roomId}/${defenderUid}/board/${toKey}`).get()
  ]);
  const attackerPiece = attackerPieceSnap.val();
  const defenderPiece = defenderPieceSnap.val();
  if (!attackerPiece || !defenderPiece) {
    throw new functions.https.HttpsError("internal", "말 정보를 확인할 수 없습니다.");
  }

  if (attackerPiece === "star" || defenderPiece === "star") {
    // ---- 자폭: 결투 없이 둘 다 제거 ----
    await db.ref("rooms/" + roomId).transaction((r) => {
      if (!r || r.status !== "battle" || r.duel) return r;
      if (r.turn !== role) return r;
      const mv = r.board[fromKey];
      const tg = r.board[toKey];
      if (!mv || mv.owner !== role || !tg || tg.owner !== defenderRole) return r;
      delete r.board[fromKey];
      delete r.board[toKey];
      addLog(r, "★ 조커가 상대 말과 함께 자폭했습니다!");
      clearGoalIfPieceGone(r, to.r, to.c);
      switchTurn(r);
      return r;
    });
    await Promise.all([
      db.ref(`privateBoards/${roomId}/${uid}/board/${fromKey}`).remove(),
      db.ref(`privateBoards/${roomId}/${defenderUid}/board/${toKey}`).remove()
    ]);
    return { ok: true, result: "selfdestruct" };
  }

  // ---- 결투 시작: 말 값은 어디에도 기록하지 않고, 배팅 금액만 공개 상태에 기록 ----
  await db.ref("rooms/" + roomId).transaction((r) => {
    if (!r || r.status !== "battle" || r.duel) return r;
    if (r.turn !== role) return r;
    const mv = r.board[fromKey];
    const tg = r.board[toKey];
    if (!mv || mv.owner !== role || !tg || tg.owner !== defenderRole) return r;
    if ((r.chips[role] || 0) < 1 || (r.chips[defenderRole] || 0) < 1) return r; // 기본 배팅 칩 부족

    r.chips[role] -= 1;
    r.chips[defenderRole] -= 1;
    r.duel = {
      pos: { r: to.r, c: to.c },
      from: { r: from.r, c: from.c },
      attacker: role,
      defender: defenderRole,
      contrib: { [role]: 1, [defenderRole]: 1 },
      turnToAct: role,
      stage: "opening",
      lastActionDeadline: Date.now()
    };
    addLog(r, `결투 발생! (${role === "first" ? "선" : "후"} vs ${defenderRole === "first" ? "선" : "후"})`);
    return r;
  });

  return { ok: true, result: "duelStarted" };
});

// ===================== 결투 배팅 (금액만 다룸 - 비밀 정보 없음) =====================

exports.duelBet = functions.region(REGION).https.onCall(async (data, context) => {
  const uid = requireAuth(context);
  const roomId = (data.roomId || "").toString();
  const amount = parseInt(data.amount, 10);
  const room = await getRoom(roomId);
  requireParticipant(room, uid);
  const role = roleOfUid(room, uid);

  await db.ref("rooms/" + roomId).transaction((r) => {
    if (!r || !r.duel) return r;
    const d = r.duel;
    if (d.turnToAct !== role || d.stage !== "opening" || role !== d.attacker) return r;
    const oppRole = role === "first" ? "second" : "first";
    const max = Math.max(1, r.chips[oppRole]);
    let amt = Number.isFinite(amount) ? amount : 1;
    amt = Math.max(1, Math.min(amt, max));
    if (r.chips[role] < amt) amt = r.chips[role];
    r.chips[role] -= amt;
    d.contrib[role] = (d.contrib[role] || 0) + amt;
    d.stage = "responding";
    d.turnToAct = oppRole;
    d.lastActionDeadline = Date.now();
    return r;
  });
  return { ok: true };
});

exports.duelRaise = functions.region(REGION).https.onCall(async (data, context) => {
  const uid = requireAuth(context);
  const roomId = (data.roomId || "").toString();
  const amount = parseInt(data.amount, 10);
  const room = await getRoom(roomId);
  requireParticipant(room, uid);
  const role = roleOfUid(room, uid);

  await db.ref("rooms/" + roomId).transaction((r) => {
    if (!r || !r.duel) return r;
    const d = r.duel;
    if (d.turnToAct !== role) return r;
    const oppRole = role === "first" ? "second" : "first";
    const diff = Math.max(0, (d.contrib[oppRole] || 0) - (d.contrib[role] || 0));
    // 레이즈로 "추가로" 거는 금액(diff 위에 더 얹는 부분)은 내가 낼 수 있는 만큼이면서
    // 동시에 상대가 콜(올인 포함)로 받아줄 수 있는 만큼(=상대의 남은 칩)을 넘을 수 없습니다.
    // (최초 배팅과 동일한 규칙 - 상대가 감당 못 할 금액은 애초에 걸 수 없습니다.)
    const myChipsAfterCall = Math.max(0, r.chips[role] - diff);
    const maxExtra = Math.max(1, Math.min(myChipsAfterCall, r.chips[oppRole]));
    let amt = Number.isFinite(amount) ? amount : 1;
    amt = Math.max(1, Math.min(amt, maxExtra));
    const totalPay = Math.min(diff + amt, r.chips[role]);
    r.chips[role] -= totalPay;
    d.contrib[role] = (d.contrib[role] || 0) + totalPay;
    d.stage = "responding";
    d.turnToAct = oppRole;
    d.lastActionDeadline = Date.now();
    return r;
  });
  return { ok: true };
});

// ===================== 폴드 (승자의 말을 서버에서 조회해서 공개) =====================

exports.duelFold = functions.region(REGION).https.onCall(async (data, context) => {
  const uid = requireAuth(context);
  const roomId = (data.roomId || "").toString();
  const room = await getRoom(roomId);
  requireParticipant(room, uid);
  const role = roleOfUid(room, uid);
  if (!room.duel || room.duel.turnToAct !== role) {
    throw new functions.https.HttpsError("failed-precondition", "지금은 폴드할 수 없습니다.");
  }
  const d = room.duel;
  const winnerSide = role === d.attacker ? d.defender : d.attacker;
  const loserSide = role;

  const fromKey = boardKey(d.from.r, d.from.c);
  const toKey = boardKey(d.pos.r, d.pos.c);
  const attackerIdentity = room.roles[d.attacker];
  const attackerUid = room.players[attackerIdentity].uid;
  const defenderIdentity = room.roles[d.defender];
  const defenderUid = room.players[defenderIdentity].uid;

  const winnerUid = winnerSide === d.attacker ? attackerUid : defenderUid;
  const winnerPosKey = winnerSide === d.attacker ? fromKey : toKey;
  const winnerPieceSnap = await db.ref(`privateBoards/${roomId}/${winnerUid}/board/${winnerPosKey}`).get();
  const winnerPiece = winnerPieceSnap.val();
  if (!winnerPiece) throw new functions.https.HttpsError("internal", "말 정보를 확인할 수 없습니다.");

  await db.ref("rooms/" + roomId).transaction((r) => {
    if (!r || !r.duel) return r;
    const dd = r.duel;
    if (dd.turnToAct !== role) return r;
    finishDuelServerFold(r, dd, winnerSide, loserSide, winnerPiece);
    return r;
  });

  if (winnerSide === d.attacker) {
    await db.ref(`privateBoards/${roomId}/${attackerUid}/board/${fromKey}`).remove();
    await db.ref(`privateBoards/${roomId}/${attackerUid}/board/${toKey}`).set(winnerPiece);
    await db.ref(`privateBoards/${roomId}/${defenderUid}/board/${toKey}`).remove();
  } else {
    await db.ref(`privateBoards/${roomId}/${attackerUid}/board/${fromKey}`).remove();
  }

  return { ok: true };
});

// ===================== 콜 (양쪽 말을 서버에서 조회해서 승패 계산) =====================

exports.duelCall = functions.region(REGION).https.onCall(async (data, context) => {
  const uid = requireAuth(context);
  const roomId = (data.roomId || "").toString();
  const room = await getRoom(roomId);
  requireParticipant(room, uid);
  const role = roleOfUid(room, uid);
  if (!room.duel || room.duel.turnToAct !== role) {
    throw new functions.https.HttpsError("failed-precondition", "지금은 콜할 수 없습니다.");
  }
  const d = room.duel;
  const fromKey = boardKey(d.from.r, d.from.c);
  const toKey = boardKey(d.pos.r, d.pos.c);
  const attackerIdentity = room.roles[d.attacker];
  const attackerUid = room.players[attackerIdentity].uid;
  const defenderIdentity = room.roles[d.defender];
  const defenderUid = room.players[defenderIdentity].uid;

  const [attackerSnap, defenderSnap] = await Promise.all([
    db.ref(`privateBoards/${roomId}/${attackerUid}/board/${fromKey}`).get(),
    db.ref(`privateBoards/${roomId}/${defenderUid}/board/${toKey}`).get()
  ]);
  const attackerPiece = attackerSnap.val();
  const defenderPiece = defenderSnap.val();
  if (!attackerPiece || !defenderPiece) {
    throw new functions.https.HttpsError("internal", "말 정보를 확인할 수 없습니다.");
  }
  const outcome = resolveDuel(attackerPiece, defenderPiece); // 'a' | 'b' | 'draw'

  await db.ref("rooms/" + roomId).transaction((r) => {
    if (!r || !r.duel) return r;
    const dd = r.duel;
    if (dd.turnToAct !== role) return r;

    const oppRoleLocal = role === d.attacker ? d.defender : d.attacker;
    const gap = (dd.contrib[oppRoleLocal] || 0) - (dd.contrib[role] || 0);
    const pay = Math.min(Math.max(gap, 0), r.chips[role]);
    r.chips[role] -= pay;
    dd.contrib[role] = (dd.contrib[role] || 0) + pay;

    const pot = (dd.contrib[d.attacker] || 0) + (dd.contrib[d.defender] || 0);
    const posKey2 = boardKey(dd.pos.r, dd.pos.c);
    const fromKey2 = boardKey(dd.from.r, dd.from.c);

    if (outcome === "draw") {
      delete r.board[fromKey2];
      delete r.board[posKey2];
      r.chips[d.attacker] += dd.contrib[d.attacker] || 0;
      r.chips[d.defender] += dd.contrib[d.defender] || 0;
      addLog(r, "결투 무승부! 두 말 모두 제거, 칩은 반환됩니다.");
      clearGoalIfPieceGone(r, dd.pos.r, dd.pos.c);
    } else {
      const winnerSide = outcome === "a" ? d.attacker : d.defender;
      const winnerPiece = outcome === "a" ? attackerPiece : defenderPiece;
      r.chips[winnerSide] += pot;
      delete r.board[fromKey2];
      r.board[posKey2] = { owner: winnerSide, revealed: true, piece: winnerPiece };
      if (winnerSide === d.attacker) applyGoalArrival(r, d.attacker, dd.pos.r, dd.pos.c);
      addLog(r, `${winnerPiece} 승리! 칩 ${pot}개 획득.`);
      checkEliminationWin(r);
    }

    r.duel = null;
    switchTurn(r);
    return r;
  });

  if (outcome === "draw") {
    await Promise.all([
      db.ref(`privateBoards/${roomId}/${attackerUid}/board/${fromKey}`).remove(),
      db.ref(`privateBoards/${roomId}/${defenderUid}/board/${toKey}`).remove()
    ]);
  } else if (outcome === "a") {
    await db.ref(`privateBoards/${roomId}/${attackerUid}/board/${fromKey}`).remove();
    await db.ref(`privateBoards/${roomId}/${attackerUid}/board/${toKey}`).set(attackerPiece);
    await db.ref(`privateBoards/${roomId}/${defenderUid}/board/${toKey}`).remove();
  } else {
    await db.ref(`privateBoards/${roomId}/${attackerUid}/board/${fromKey}`).remove();
  }

  return { ok: true };
});

// ===================== 제한시간 초과 기권패 =====================

exports.claimForfeit = functions.region(REGION).https.onCall(async (data, context) => {
  const uid = requireAuth(context);
  const roomId = (data.roomId || "").toString();
  const room = await getRoom(roomId);
  requireParticipant(room, uid);

  await db.ref("rooms/" + roomId).transaction((r) => {
    if (!r || r.winner || r.status !== "battle") return r;
    const deadlineBase = r.duel ? r.duel.lastActionDeadline : r.turnStartedAt;
    if (!deadlineBase || Date.now() - deadlineBase <= TURN_LIMIT_MS) return r;
    const timedOutSide = r.duel ? r.duel.turnToAct : r.turn;
    const winnerSide = timedOutSide === "first" ? "second" : "first";
    r.winner = winnerSide;
    r.winReason = "timeout";
    addLog(r, `${timedOutSide === "first" ? "선" : "후"} 플레이어가 제한시간(3분)을 초과하여 기권패 처리되었습니다.`);
    return r;
  });
  return { ok: true };
});

// ===================== 재대결 =====================

exports.rematch = functions.region(REGION).https.onCall(async (data, context) => {
  const uid = requireAuth(context);
  const roomId = (data.roomId || "").toString();
  const room = await getRoom(roomId);
  requireParticipant(room, uid);

  await db.ref("rooms/" + roomId).transaction((r) => {
    if (!r || !r.winner || !r.roles) return r;
    const winnerRole = r.winner;
    const winnerIdentity = r.roles[winnerRole];
    const loserIdentity = winnerIdentity === "host" ? "guest" : "host";
    r.roles = { first: loserIdentity, second: winnerIdentity };
    r.chips = { first: r.chipsStart, second: r.chipsStart };
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
    const winnerName = (r.players && r.players[winnerIdentity] && r.players[winnerIdentity].name) || (winnerRole === "first" ? "선공" : "후공");
    const loserName = (r.players && r.players[loserIdentity] && r.players[loserIdentity].name) || "상대";
    addLog(r, `${r.matchNumber}판 시작! (지난 판 승자 ${winnerName}님이 후공, ${loserName}님이 선공입니다)`);
    return r;
  });

  const hostUid = room.players && room.players.host && room.players.host.uid;
  const guestUid = room.players && room.players.guest && room.players.guest.uid;
  await Promise.all([
    hostUid ? db.ref(`privateBoards/${roomId}/${hostUid}/board`).remove() : Promise.resolve(),
    guestUid ? db.ref(`privateBoards/${roomId}/${guestUid}/board`).remove() : Promise.resolve()
  ]);

  return { ok: true };
});
