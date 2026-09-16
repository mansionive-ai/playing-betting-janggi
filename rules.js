// ===================== 플레잉배팅장기 - 규칙 엔진 =====================
// 서버(Firebase RTDB) 없이도 테스트 가능한 순수 함수들만 모아둔 파일.

const PIECE_ORDER = ["A","2","3","4","5","6","7","8","9","10","J","Q","K","star"];
const RANK_VALUE = { A:1, "2":2, "3":3, "4":4, "5":5, "6":6, "7":7, "8":8, "9":9, "10":10, J:11, Q:12, K:13, star:14 };

const ROWS = 9;
const COLS = 7;

function pieceColor(piece) {
  if (piece === "star") return "star";
  // 짝수(2,4,6,8,10,Q) = 흑색 / 홀수(A,3,5,7,9,J,K) = 백색
  const evens = ["2","4","6","8","10","Q"];
  return evens.includes(piece) ? "black" : "white";
}

function inBounds(r, c) {
  return r >= 0 && r < ROWS && c >= 0 && c < COLS;
}

function isAdjacentKingMove(fr, fc, tr, tc) {
  const dr = Math.abs(fr - tr);
  const dc = Math.abs(fc - tc);
  if (fr === tr && fc === tc) return false;
  return dr <= 1 && dc <= 1;
}

function homeCells(owner) {
  // owner 'first'(선) 은 하단 두 줄(7,8행), 'second'(후) 는 상단 두 줄(0,1행)
  const cells = [];
  const rows = owner === "first" ? [ROWS - 2, ROWS - 1] : [0, 1];
  for (const r of rows) {
    for (let c = 0; c < COLS; c++) cells.push({ r, c });
  }
  return cells;
}

function goalRow(owner) {
  // owner가 도달해야 하는 "상대 진영 맨 끝 줄"
  return owner === "first" ? 0 : ROWS - 1;
}

// 결투 승패 판정. a, b는 { piece, owner } 형태. 반환: 'a' | 'b' | 'draw'
// (star는 이 함수 호출 전에 별도 처리되어야 함 - 자폭이므로 결투 자체가 없음)
function resolveDuel(pieceA, pieceB) {
  if (pieceA === "star" || pieceB === "star") {
    throw new Error("star는 resolveDuel을 거치지 않고 즉시 자폭 처리해야 합니다.");
  }
  // 특수룰 1: A는 Q, K를 이긴다
  if (pieceA === "A" && (pieceB === "Q" || pieceB === "K")) return "a";
  if (pieceB === "A" && (pieceA === "Q" || pieceA === "K")) return "b";
  // 특수룰 2: 2는 K를 이긴다
  if (pieceA === "2" && pieceB === "K") return "a";
  if (pieceB === "2" && pieceA === "K") return "b";
  // 동률
  if (pieceA === pieceB) return "draw";
  // 일반 서열 비교
  return RANK_VALUE[pieceA] > RANK_VALUE[pieceB] ? "a" : "b";
}

// 배치 유효성: 14개 칸에 14종류 말이 정확히 1개씩
function isValidPlacement(placementMap) {
  const placed = Object.values(placementMap);
  if (placed.length !== 14) return false;
  const set = new Set(placed);
  if (set.size !== 14) return false;
  return PIECE_ORDER.every(p => set.has(p));
}

if (typeof module !== "undefined") {
  module.exports = { PIECE_ORDER, RANK_VALUE, ROWS, COLS, pieceColor, inBounds, isAdjacentKingMove, homeCells, goalRow, resolveDuel, isValidPlacement };
}
