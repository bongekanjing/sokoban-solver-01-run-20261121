// Room-by-room push-optimal Sokoban solver.
//
// Idea: a generated level is a 1-wide hallway with 1-4 rooms off it, and a box
// pushed out of a room's door can never come back, so every box stays in its
// room and the level's push optimum is the sum of the rooms' optima. This
// program therefore splits each level into rooms and solves every room
// push-optimally on its own, instead of searching the whole level as one
// flat state space (which would be the product of the rooms' spaces).
//
// Each room is solved by A* over pushes: a state is the boxes' squares plus
// the player's reachable region (named by its lowest square), each edge is one
// push, and the heuristic is the minimum-cost assignment of boxes to goals
// over single-box push distances (admissible, so the first solved state popped
// is push-optimal). Dead states are pruned two ways: a box standing on a
// square from which no push can ever reach a goal ("dead square", found by a
// reverse pull search from the goals), and a frozen 2x2 block of walls and
// boxes holding a box off its goal.
//
// Budgets are by work, never by the wall clock: every search carries a fixed
// expansion cap, the program never reads the clock, and two runs on one set
// write byte-identical outputs. If a room's optimal search gives up, a greedy
// best-first search over pushes tries for any solution of that room; if the
// level does not split into rooms at all, a plain move-based A* over the whole
// level tries for any solution. An instance is never left unanswered.
//
// Node 22, built-in modules only, erasable TypeScript (plain JavaScript runs
// as it is). Local run: MAKEFUN_INPUT_DIR=practice/input
// MAKEFUN_OUTPUT_DIR=out node main.ts
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Work budgets (expansions). The generator keeps every room solvable well
// inside a few hundred thousand push states; the caps below only bite on
// pathological inputs, where the fallbacks still answer the instance.
const ROOM_ASTAR_CAP = 400_000;
const ROOM_GREEDY_CAP = 400_000;
const WHOLE_MOVE_CAP = 200_000;
const GLOBAL_WORK_CAP = 3_000_000;

let workLeft = GLOBAL_WORK_CAP;

const DIRS: [number, number, string, string][] = [
  [0, -1, 'u', 'U'],
  [0, 1, 'd', 'D'],
  [-1, 0, 'l', 'L'],
  [1, 0, 'r', 'R'],
];

interface Level {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
}

/** Parse XSB text. Short rows and the outer frame count as walls. */
function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x]!;
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  return { w, h, wall, goals, boxes: boxes.sort((a, b) => a - b), player };
}

/**
 * Squares from which a lone box can be pushed onto some goal, found by
 * walking pulls backwards from the goals: a box on y can be pushed to x
 * (one step in direction d, y = x - d) when the player can stand on y - d.
 */
function liveSquares(level: Level): Uint8Array {
  const { w, wall, goals } = level;
  const live = new Uint8Array(wall.length);
  const queue = [...goals];
  for (const g of goals) live[g] = 1;
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi]!;
    for (const [dx, dy] of DIRS) {
      const d = dy * w + dx;
      const y = x - d;
      if (!wall[y] && !wall[y - d] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/**
 * For each goal, the fewest pushes a lone box needs to travel from every
 * square to that goal (same reverse-push graph as liveSquares, -1 when the
 * square cannot reach the goal at all).
 */
function pushDistances(level: Level): Int32Array[] {
  const { w, wall, goals } = level;
  const out: Int32Array[] = [];
  for (const g of goals) {
    const dist = new Int32Array(wall.length).fill(-1);
    dist[g] = 0;
    const queue = [g];
    for (let qi = 0; qi < queue.length; qi++) {
      const x = queue[qi]!;
      for (const [dx, dy] of DIRS) {
        const d = dy * w + dx;
        const y = x - d;
        if (!wall[y] && !wall[y - d] && dist[y] < 0) {
          dist[y] = dist[x]! + 1;
          queue.push(y);
        }
      }
    }
    out.push(dist);
  }
  return out;
}

/** Smallest assignment cost of boxes to goals; Infinity when no box can reach its goal. */
function assignmentCost(boxes: number[], dists: Int32Array[], goals: number[]): number {
  const n = boxes.length;
  if (n === 0) return 0;
  // Cost matrix, then the cheapest bijection by brute force over permutations
  // (rooms hold at most 4-5 boxes, so at most 120 permutations).
  const cost: number[][] = [];
  for (let i = 0; i < n; i++) {
    const row: number[] = [];
    for (let j = 0; j < n; j++) row.push(dists[j]![boxes[i]!]!);
    cost.push(row);
  }
  const perm = goals.map((_, j) => j);
  let best = Infinity;
  const walk = (k: number, sum: number): void => {
    if (sum >= best) return;
    if (k === n) {
      best = sum;
      return;
    }
    for (let t = k; t < n; t++) {
      const c = cost[k]![perm[t]!]!;
      if (c < 0) continue;
      [perm[k], perm[t]] = [perm[t]!, perm[k]!];
      walk(k + 1, sum + c);
      [perm[k], perm[t]] = [perm[t]!, perm[k]!];
    }
  };
  walk(0, 0);
  return best;
}

/** A deterministic binary heap ordered by (f, deeper first, insertion order). */
class Heap {
  private a: [number, number, number, number][] = [];
  get size(): number {
    return this.a.length;
  }
  push(e: [number, number, number, number]): void {
    const a = this.a;
    a.push(e);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(a[i]!, a[p]!)) break;
      [a[i], a[p]] = [a[p]!, a[i]!];
      i = p;
    }
  }
  pop(): [number, number, number, number] {
    const a = this.a;
    const top = a[0]!;
    const last = a.pop()!;
    if (a.length > 0) {
      a[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= a.length) break;
        if (c + 1 < a.length && less(a[c + 1]!, a[c]!)) c++;
        if (!less(a[c]!, a[i]!)) break;
        [a[i], a[c]] = [a[c]!, a[i]!];
        i = c;
      }
    }
    return top;
  }
}

function less(x: [number, number, number, number], y: [number, number, number, number]): boolean {
  return (
    x[0] < y[0] ||
    (x[0] === y[0] && (x[1] > y[1] || (x[1] === y[1] && x[2] < y[2])))
  );
}

/** Scratch state shared by one push search (flood fills reuse these arrays). */
interface SearchCtx {
  w: number;
  size: number;
  wall: Uint8Array;
  goal: Uint8Array;
  live: Uint8Array;
  dists: Int32Array[];
  goals: number[];
  seen: Int32Array;
  mark: Int32Array;
  stack: Int32Array;
  occupied: Uint8Array;
  stamp: number;
}

/**
 * Flood the player's reachable region from `from` (walls and boxes block),
 * stamping it into `seen`; returns the region's lowest square. The array is
 * passed in so the current state's region and a successor's region never
 * share marks: stamping one must not erase the other's.
 */
function flood(ctx: SearchCtx, seen: Int32Array, from: number, stamp: number): number {
  const { w, wall, occupied, stack } = ctx;
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n]!;
    if (p < low) low = p;
    const q0 = p - w;
    const q1 = p + w;
    const q2 = p - 1;
    const q3 = p + 1;
    if (!wall[q0] && !occupied[q0] && seen[q0] !== stamp) { seen[q0] = stamp; stack[n++] = q0; }
    if (!wall[q1] && !occupied[q1] && seen[q1] !== stamp) { seen[q1] = stamp; stack[n++] = q1; }
    if (!wall[q2] && !occupied[q2] && seen[q2] !== stamp) { seen[q2] = stamp; stack[n++] = q2; }
    if (!wall[q3] && !occupied[q3] && seen[q3] !== stamp) { seen[q3] = stamp; stack[n++] = q3; }
  }
  return low;
}

/** Whether the box just pushed to `t` sits in a frozen 2x2 block of walls and boxes holding a box off its goal. */
function frozenAt(ctx: SearchCtx, t: number): boolean {
  const { w, wall, occupied, goal } = ctx;
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (!(wall[a] || occupied[a]) || !(wall[b] || occupied[b]) || !(wall[c] || occupied[c]) || !(wall[d] || occupied[d])) continue;
    if ((occupied[a] && !goal[a]) || (occupied[b] && !goal[b]) || (occupied[c] && !goal[c]) || (occupied[d] && !goal[d])) return true;
  }
  return false;
}

const keyOf = (boxes: number[], low: number): string => String.fromCharCode(low, ...boxes);

/**
 * Push search over one board (a room's sub-board, or a whole level): A* when
 * greedy is false, best-first on the heuristic alone when true. Returns the
 * push-optimal solution for A* (the heuristic is admissible and states are
 * reopened on a cheaper path), or any solution for greedy. Null on giving up.
 */
function pushSearch(
  board: Level,
  maxExpansions: number,
  greedy: boolean,
): { pushes: number; moves: string } | null {
  const { w, wall, goals } = board;
  const size = wall.length;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const live = liveSquares(board);
  const dists = pushDistances(board);
  const ctx: SearchCtx = {
    w,
    size,
    wall,
    goal,
    live,
    dists,
    goals,
    seen: new Int32Array(size),
    mark: new Int32Array(size),
    stack: new Int32Array(size),
    occupied: new Uint8Array(size),
    stamp: 0,
  };
  const startBoxes = board.boxes;
  if (startBoxes.some((b) => !live[b])) return null;
  const solved = (bs: number[]): boolean => bs.every((b) => goal[b]);
  if (solved(startBoxes)) return { pushes: 0, moves: '' };

  const boxesArr: number[][] = [startBoxes];
  const playerArr: number[] = [board.player];
  const parent: number[] = [-1];
  const best = new Map<string, number>();
  for (const b of startBoxes) ctx.occupied[b] = 1;
  const low0 = flood(ctx, ctx.seen, board.player, ++ctx.stamp);
  for (const b of startBoxes) ctx.occupied[b] = 0;
  best.set(keyOf(startBoxes, low0), 0);
  const h0 = assignmentCost(startBoxes, dists, goals);
  if (!Number.isFinite(h0)) return null;
  const heap = new Heap();
  let seq = 0;
  heap.push([greedy ? h0 : h0, 0, seq++, 0]);

  let expanded = 0;
  let found = -1;
  while (heap.size > 0 && expanded < maxExpansions && workLeft > 0) {
    const [, g, , s] = heap.pop();
    const boxes = boxesArr[s]!;
    for (const b of boxes) ctx.occupied[b] = 1;
    const here = ++ctx.stamp;
    const k = keyOf(boxes, flood(ctx, ctx.seen, playerArr[s]!, here));
    // A stale heap entry (a cheaper path to this state was found since).
    if (best.get(k) !== g) {
      for (const b of boxes) ctx.occupied[b] = 0;
      continue;
    }
    if (solved(boxes)) {
      found = s;
      break;
    }
    expanded++;
    workLeft--;
    for (let bi = 0; bi < boxes.length; bi++) {
      const b = boxes[bi]!;
      for (const [dx, dy] of DIRS) {
        const d = dy * w + dx;
        const from = b - d; // where the player must stand to push
        const t = b + d; // where the box lands
        if (ctx.seen[from] !== here || wall[t] || ctx.occupied[t] || !live[t]) continue;
        ctx.occupied[b] = 0;
        ctx.occupied[t] = 1;
        if (frozenAt(ctx, t)) {
          ctx.occupied[t] = 0;
          ctx.occupied[b] = 1;
          continue;
        }
        const next = boxes.slice();
        next[bi] = t;
        next.sort((x, y) => x - y);
        // The successor's region goes in `mark`, never in `seen`: stamping
        // it must not erase the current state's region above.
        const low = flood(ctx, ctx.mark, b, ++ctx.stamp);
        const key = keyOf(next, low);
        const ng = g + 1;
        const prev = best.get(key);
        if (prev === undefined || ng < prev) {
          best.set(key, ng);
          const h = assignmentCost(next, dists, goals);
          if (Number.isFinite(h)) {
            const id = boxesArr.length;
            boxesArr.push(next);
            playerArr.push(b);
            parent.push(s);
            heap.push([greedy ? h : ng + h, ng, seq++, id]);
          }
        }
        ctx.occupied[t] = 0;
        ctx.occupied[b] = 1;
      }
      if (found >= 0) break;
    }
    for (const b of boxes) ctx.occupied[b] = 0;
    if (found >= 0) break;
  }
  if (found < 0) return null;
  ctx.occupied.fill(0);

  // Rebuild the push path, then the moves: walk to each push square, push.
  const path: number[] = [];
  for (let s = found; s > 0; s = parent[s]!) path.push(s);
  path.reverse();
  let moves = '';
  let player = board.player;
  let boxes = startBoxes;
  for (const s of path) {
    const nextBoxes = boxesArr[s]!;
    const from = boxes.find((b) => !nextBoxes.includes(b))!;
    const to = nextBoxes.find((b) => !boxes.includes(b))!;
    const d = to - from;
    const dir = DIRS.find(([dx, dy]) => dy * w + dx === d)!;
    for (const b of boxes) ctx.occupied[b] = 1;
    moves += walkTo(board, ctx.occupied, player, from - d);
    for (const b of boxes) ctx.occupied[b] = 0;
    moves += dir[3];
    player = from;
    boxes = nextBoxes;
  }
  return { pushes: path.length, moves };
}

/** Shortest walk from `from` to `to` around walls and boxes (lower LURD letters, first direction first on ties). */
function walkTo(board: Level, occupied: Uint8Array, from: number, to: number): string {
  const { w, wall } = board;
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const how = new Array<string>(wall.length);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    if (p === to) break;
    for (const [dx, dy, letter] of DIRS) {
      const q = p + dy * w + dx;
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = letter;
      queue.push(q);
    }
  }
  if (prev[to] === -1) return '';
  let s = '';
  for (let p = to; p !== from; p = prev[p]!) s = how[p]! + s;
  return s;
}

interface Room {
  boxes: number[];
  goals: number[];
}

/**
 * The level's rooms: cut the dead squares of the player's row (the hallway:
 * a box there reaches no goal) out of the floor, and each connected part left
 * that holds a box is a room. Null when the level is no set of rooms.
 */
function roomsOf(level: Level): Room[] | null {
  const { w, wall, goals, boxes, player } = level;
  const live = liveSquares(level);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) if (!wall[i] && !live[i]) cut[i] = 1;
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms: Room[] = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      for (const [dx, dy] of DIRS) {
        const q = squares[i]! + dy * w + dx;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ boxes: [], goals: [] });
  }
  for (const b of boxes) rooms[part[b]!]!.boxes.push(b);
  for (const g of goals) if (part[g]! >= 0) rooms[part[g]!]!.goals.push(g);
  if (goals.some((g) => part[g]! < 0)) return null;
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/** Apply a move string to (player, boxes) on a board; used to carry the player between rooms. */
function applyMoves(level: Level, player: number, boxes: number[], moves: string): { player: number; boxes: number[] } {
  const { w, wall } = level;
  const boxAt = new Set(boxes);
  let p = player;
  for (const ch of moves.toLowerCase()) {
    const d = ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
    const q = p + d;
    if (wall[q]) continue;
    if (boxAt.has(q)) {
      const t = q + d;
      if (wall[t] || boxAt.has(t)) continue;
      boxAt.delete(q);
      boxAt.add(t);
    }
    p = q;
  }
  return { player: p, boxes: [...boxAt].sort((a, b) => a - b) };
}

/**
 * Plain move-based A* over the whole level (the house baseline's shape):
 * last-resort fallback that still returns a valid, if push-heavy, solution.
 */
function moveAStar(level: Level, maxExpansions: number): string {
  const { w, wall, goals } = level;
  const goalSet = new Set(goals);
  const manhattan = (b: number): number =>
    Math.min(...goals.map((g) => Math.abs((g % w) - (b % w)) + Math.abs(Math.floor(g / w) - Math.floor(b / w))));
  const est = (bs: number[]): number => bs.reduce((a, b) => a + manhattan(b), 0);
  const key = (p: number, bs: number[]): string => String.fromCharCode(p, ...bs);
  const sp: number[] = [level.player];
  const sb: number[][] = [level.boxes];
  const sg: number[] = [0];
  const parent: number[] = [-1];
  const step: string[] = [''];
  const best = new Map<string, number>([[key(level.player, level.boxes), 0]]);
  const heap = new Heap();
  let seq = 0;
  heap.push([est(level.boxes), 0, seq++, 0]);
  let expanded = 0;
  while (heap.size > 0 && expanded < maxExpansions && workLeft > 0) {
    const [, g, , s] = heap.pop();
    if (best.get(key(sp[s]!, sb[s]!)) !== g) continue;
    const bs = sb[s]!;
    if (bs.every((b) => goalSet.has(b))) {
      let moves = '';
      for (let t = s; t > 0; t = parent[t]!) moves = step[t]! + moves;
      return moves;
    }
    expanded++;
    workLeft--;
    const p = sp[s]!;
    for (const [dx, dy, letter, upper] of DIRS) {
      const d = dy * w + dx;
      const q = p + d;
      if (wall[q]) continue;
      let nb = bs;
      let move = letter;
      const at = bs.indexOf(q);
      if (at >= 0) {
        if (wall[q + d] || bs.includes(q + d)) continue;
        nb = bs.slice();
        nb[at] = q + d;
        nb.sort((a, b) => a - b);
        move = upper;
      }
      const k = key(q, nb);
      const seen = best.get(k);
      if (seen !== undefined && seen <= g + 1) continue;
      const t = sp.length;
      sp.push(q);
      sb.push(nb);
      sg.push(g + 1);
      parent.push(s);
      step.push(move);
      best.set(k, t);
      heap.push([g + 1 + est(nb), g + 1, seq++, t]);
    }
  }
  return '';
}

/** Solve one level: room by room when it splits, else whole-level fallbacks. */
function solveLevel(level: Level): string {
  const rooms = roomsOf(level);
  if (rooms !== null) {
    // Deterministic order: by each room's lowest box square.
    rooms.sort((a, b) => a.boxes[0]! - b.boxes[0]!);
    let player = level.player;
    let boxes = level.boxes;
    let moves = '';
    const done: boolean[] = rooms.map(() => false);
    for (let r = 0; r < rooms.length; r++) {
      const room = rooms[r]!;
      // The room's sub-board: the whole board, with every other room's boxes
      // (on their goals once solved) standing as walls.
      const subWall = level.wall.slice();
      rooms.forEach((other, j) => {
        if (j === r) return;
        for (const b of done[j] ? other.goals : other.boxes) subWall[b] = 1;
      });
      const sub: Level = {
        w: level.w,
        h: level.h,
        wall: subWall,
        goals: room.goals.slice().sort((a, b) => a - b),
        boxes: room.boxes.slice().sort((a, b) => a - b),
        player,
      };
      let solved = pushSearch(sub, ROOM_ASTAR_CAP, false);
      if (solved === null) solved = pushSearch(sub, ROOM_GREEDY_CAP, true);
      if (solved === null) return moveAStar(level, WHOLE_MOVE_CAP);
      moves += solved.moves;
      const after = applyMoves(level, player, boxes, solved.moves);
      player = after.player;
      boxes = after.boxes;
      done[r] = true;
    }
    return moves;
  }
  const whole = pushSearch(level, ROOM_ASTAR_CAP, false);
  if (whole !== null) return whole.moves;
  return moveAStar(level, WHOLE_MOVE_CAP);
}

for (const id of readdirSync(I).sort()) {
  let moves = '';
  try {
    if (!statSync(join(I, id)).isDirectory()) continue;
    const level = parseLevel(readFileSync(join(I, id, 'level.txt'), 'utf8'));
    if (level.player >= 0 && level.boxes.length > 0) moves = solveLevel(level);
  } catch {
    moves = '';
  }
  if (moves.length > 65000) moves = '';
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
