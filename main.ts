// Push-optimal Sokoban solver.
//
// The levels this competition draws are a hallway with one to four rooms off it,
// each room holding 3 or 4 boxes and as many goals, and a box pushed out of a
// room's door can never come back -- so the rooms are independent problems and
// a level's push-optimal count is the sum of its rooms' optima. This solver
// splits each level into its rooms, solves every room on its own with a
// push-based A* (states are box placements plus the player's square; a move
// is one push, and the player walks freely between pushes), then joins the
// rooms' answers with the player's walk through the hallway. Only pushes are
// scored, so the walk costs nothing and the joined answer is push-optimal
// whenever every room is.
//
// The search's heuristic is the cheapest assignment of boxes to goals, where
// the cost of a box to a goal is the fewest pushes a lone box needs to reach
// it (a reverse push search from the goal, other boxes ignored). That is a
// lower bound on the pushes left, so the first goal state A* pops is optimal.
// Dead squares (a cell no lone box can ever leave towards a goal) and 2x2
// blocks of boxes prune states no solution can save.
//
// Node 22, erasable TypeScript only; node built-ins and nothing else. The
// search is bounded by a fixed number of expansions per room, never the clock,
// so two runs write the same bytes.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const IN_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Expansions allowed for one room's search. A fixed count, not a time limit.
const ROOM_BUDGET = 300_000;

interface Step {
  dx: number;
  dy: number;
  ch: string;
}
const STEPS: Step[] = [
  { dx: 0, dy: -1, ch: 'u' },
  { dx: 0, dy: 1, ch: 'd' },
  { dx: -1, dy: 0, ch: 'l' },
  { dx: 1, dy: 0, ch: 'r' },
];

interface Level {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  goalSet: Uint8Array;
  boxes: number[];
  player: number;
}

function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const w = Math.max(...rows.map((r) => r.length));
  const h = rows.length;
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const goalSet = new Uint8Array(w * h);
  const boxes: number[] = [];
  let player = 0;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') {
        goals.push(i);
        goalSet[i] = 1;
      }
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  boxes.sort((a, b) => a - b);
  return { w, h, wall, goals, goalSet, boxes, player };
}

// One room: its floor cells (box cells), the door cell into it, the hallway
// square outside the door where the player enters, and its boxes and goals.
interface Room {
  cells: number[];
  cellSet: Uint8Array;
  door: number;
  hall: number;
  boxes: number[];
  goals: number[];
}

function findRooms(level: Level): Room[] | null {
  const { w, h, wall } = level;
  const hallRow = Math.floor(level.player / w);
  const open = (i: number): boolean => wall[i] === 0;
  // Connected components of the floor once the hallway row is taken out.
  const seen = new Uint8Array(w * h);
  const rooms: Room[] = [];
  const placed = new Uint8Array(w * h);
  for (let start = 0; start < w * h; start++) {
    if (wall[start] || seen[start] || Math.floor(start / w) === hallRow) continue;
    const cells: number[] = [];
    const queue = [start];
    seen[start] = 1;
    for (let qi = 0; qi < queue.length; qi++) {
      const c = queue[qi]!;
      cells.push(c);
      const x = c % w;
      const y = Math.floor(c / w);
      for (const s of STEPS) {
        const nx = x + s.dx;
        const ny = y + s.dy;
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
        const q = ny * w + nx;
        if (wall[q] || seen[q] || ny === hallRow) continue;
        seen[q] = 1;
        queue.push(q);
      }
    }
    cells.sort((a, b) => a - b);
    const cellSet = new Uint8Array(w * h);
    for (const c of cells) cellSet[c] = 1;
    // The door: the room cell with a floor neighbour on the hallway row.
    let door = -1;
    let hall = -1;
    for (const c of cells) {
      for (const s of STEPS) {
        const q = c + s.dy * w + s.dx;
        if (q < 0 || q >= w * h) continue;
        if (Math.floor(q / w) === hallRow && open(q)) {
          door = c;
          hall = q;
          break;
        }
      }
      if (door >= 0) break;
    }
    if (door < 0) return null;
    const boxes = level.boxes.filter((b) => cellSet[b] === 1);
    const goals = level.goals.filter((g) => cellSet[g] === 1);
    if (boxes.length !== goals.length) return null;
    for (const b of boxes) placed[b] = 1;
    for (const g of goals) placed[g] = 1;
    rooms.push({ cells, cellSet, door, hall, boxes, goals });
  }
  // Every box and goal must belong to exactly one room.
  for (const b of level.boxes) if (placed[b] !== 1) return null;
  for (const g of level.goals) if (placed[g] !== 1) return null;
  return rooms;
}

// A single push: the box's cell before the push, and the step taken.
interface Push {
  box: number;
  dir: number;
}

// Solve one room push-optimally. `walk` cells are the room's cells plus the
// hallway square outside the door (the player may stand there, a box may not).
// `greedy` turns the same search into a best-first one that takes the first
// solution it finds instead of the cheapest: a valid answer when the optimal
// search runs out of room, worth far more than an empty one.
function solveRoom(level: Level, room: Room, budget: number = ROOM_BUDGET, greedy = false): Push[] | null {
  const { w } = level;
  const boxCell = room.cellSet;
  const walkCell = new Uint8Array(level.w * level.h);
  for (const c of room.cells) walkCell[c] = 1;
  walkCell[room.hall] = 1;
  const n = room.boxes.length;
  if (n === 0) return [];
  const goalSet = level.goalSet;

  // Fewest pushes a lone box needs to reach each goal, by a reverse push
  // search from the goal: a box at c came from c - d, pushed along d, with
  // the player standing at c - 2d. Other boxes are ignored, so this is a
  // lower bound -- and a cell no goal reaches is a dead square.
  const dist: Int32Array[] = room.goals.map((g) => {
    const d = new Int32Array(level.w * level.h).fill(-1);
    d[g] = 0;
    const queue = [g];
    for (let qi = 0; qi < queue.length; qi++) {
      const c = queue[qi]!;
      const cx = c % w;
      const cy = Math.floor(c / w);
      for (const s of STEPS) {
        const p = c - (s.dy * w + s.dx);
        const px = cx - s.dx;
        const py = cy - s.dy;
        if (px < 0 || px >= w || py < 0 || py >= level.h) continue;
        if (boxCell[p] !== 1 || d[p] >= 0) continue;
        const stand = c - 2 * (s.dy * w + s.dx);
        const sx = cx - 2 * s.dx;
        const sy = cy - 2 * s.dy;
        if (sx < 0 || sx >= w || sy < 0 || sy >= level.h) continue;
        if (walkCell[stand] !== 1) continue;
        d[p] = d[c] + 1;
        queue.push(p);
      }
    }
    return d;
  });
  const dead = new Uint8Array(level.w * level.h);
  for (const c of room.cells) {
    if (goalSet[c] === 1) continue;
    let best = Infinity;
    for (const d of dist) if (d[c] >= 0 && d[c] < best) best = d[c];
    if (best === Infinity) dead[c] = 1;
  }
  for (const b of room.boxes) if (dead[b] === 1) return null;

  // Cheapest assignment of boxes to goals, over every permutation (at most
  // 4 boxes, so at most 24). Infinity when no box can reach its goal.
  const assign = (boxes: number[]): number => {
    const cost: number[][] = boxes.map((b) => dist.map((d) => (d[b] < 0 ? Infinity : d[b])));
    let best = Infinity;
    const perm = room.goals.map((_, i) => i);
    const walk = (k: number, sum: number): void => {
      if (sum >= best) return;
      if (k === n) {
        best = sum;
        return;
      }
      for (let i = k; i < n; i++) {
        [perm[k], perm[i]] = [perm[i]!, perm[k]!];
        const c = cost[k]![perm[k]!]!;
        if (c !== Infinity) walk(k + 1, sum + c);
        [perm[k], perm[i]] = [perm[i]!, perm[k]!];
      }
    };
    walk(0, 0);
    return best;
  };

  const startBoxes = [...room.boxes].sort((a, b) => a - b);
  const h0 = assign(startBoxes);
  if (h0 === Infinity) return null;

  // A* over pushes. A state is its boxes (sorted) and the player's square;
  // the heap orders by pushes + estimate, deeper first on a tie, then by
  // creation order, so the search is fully deterministic.
  const keyOf = (boxes: number[], player: number): string => boxes.join(',') + '|' + player;
  const sBoxes: number[][] = [startBoxes];
  const sPlayer: number[] = [room.hall];
  const sG: number[] = [0];
  const sParent: number[] = [-1];
  const sPush: Push[] = [{ box: -1, dir: -1 }];
  const best = new Map<string, number>([[keyOf(startBoxes, room.hall), 0]]);
  const heap: [number, number, number][] = [[h0, 0, 0]];
  const less = (a: [number, number, number], b: [number, number, number]): boolean =>
    a[0] < b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] < b[2])));
  const heapPush = (e: [number, number, number]): void => {
    let i = heap.length;
    heap.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(heap[i]!, heap[p]!)) break;
      [heap[i], heap[p]] = [heap[p]!, heap[i]!];
      i = p;
    }
  };
  const heapPop = (): [number, number, number] => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && less(heap[c + 1]!, heap[c]!)) c++;
        if (!less(heap[c]!, heap[i]!)) break;
        [heap[i], heap[c]] = [heap[c]!, heap[i]!];
        i = c;
      }
    }
    return top;
  };

  // Squares the player can walk to from `from`, around the boxes.
  const reachable = (from: number, boxes: number[]): Uint8Array => {
    const seen = new Uint8Array(level.w * level.h);
    const blocked = new Uint8Array(level.w * level.h);
    for (const b of boxes) blocked[b] = 1;
    const queue = [from];
    seen[from] = 1;
    for (let qi = 0; qi < queue.length; qi++) {
      const c = queue[qi]!;
      for (const s of STEPS) {
        const q = c + s.dy * w + s.dx;
        if (q < 0 || q >= level.w * level.h) continue;
        if (walkCell[q] !== 1 || blocked[q] === 1 || seen[q] === 1) continue;
        seen[q] = 1;
        queue.push(q);
      }
    }
    return seen;
  };

  let expanded = 0;
  while (heap.length > 0) {
    const [, g, s] = heapPop();
    if (best.get(keyOf(sBoxes[s]!, sPlayer[s]!)) !== s) continue;
    const boxes = sBoxes[s]!;
    if (boxes.every((b) => goalSet[b] === 1)) {
      const pushes: Push[] = [];
      for (let t = s; t > 0; t = sParent[t]!) pushes.push(sPush[t]!);
      pushes.reverse();
      return pushes;
    }
    if (++expanded > budget) return null;
    const reach = reachable(sPlayer[s]!, boxes);
    const boxSet = new Set(boxes);
    for (let i = 0; i < n; i++) {
      const b = boxes[i]!;
      const bx = b % w;
      const by = Math.floor(b / w);
      for (let d = 0; d < 4; d++) {
        const step = STEPS[d]!;
        const dv = step.dy * w + step.dx;
        const stand = b - dv;
        if (stand < 0 || stand >= level.w * level.h || reach[stand] !== 1) continue;
        const dest = b + dv;
        const dx2 = bx + step.dx;
        const dy2 = by + step.dy;
        if (dx2 < 0 || dx2 >= w || dy2 < 0 || dy2 >= level.h) continue;
        if (boxCell[dest] !== 1 || boxSet.has(dest) || dead[dest] === 1) continue;
        const next = boxes.slice();
        next[i] = dest;
        next.sort((a, b2) => a - b2);
        // A 2x2 block of boxes with no goal in it can never come apart.
        let stuck = false;
        for (let ox = -1; ox <= 0 && !stuck; ox++) {
          for (let oy = -1; oy <= 0 && !stuck; oy++) {
            const x0 = dx2 + ox;
            const y0 = dy2 + oy;
            if (x0 < 0 || y0 < 0 || x0 + 1 >= w || y0 + 1 >= level.h) continue;
            const block = [y0 * w + x0, y0 * w + x0 + 1, (y0 + 1) * w + x0, (y0 + 1) * w + x0 + 1];
            if (block.every((c) => next.includes(c)) && block.every((c) => goalSet[c] !== 1)) stuck = true;
          }
        }
        if (stuck) continue;
        const h = assign(next);
        if (h === Infinity) continue;
        const k = keyOf(next, b);
        const seen = best.get(k);
        if (seen !== undefined && sG[seen]! <= g + 1) continue;
        const t = sBoxes.length;
        sBoxes.push(next);
        sPlayer.push(b);
        sG.push(g + 1);
        sParent.push(s);
        sPush.push({ box: b, dir: d });
        best.set(k, t);
        heapPush([greedy ? h : g + 1 + h, g + 1, t]);
      }
    }
  }
  return null;
}

// The player's walk from `from` to `to`, around the boxes, as move letters.
function walkPath(level: Level, from: number, to: number, boxes: number[]): string | null {
  const { w, h, wall } = level;
  if (from === to) return '';
  const blocked = new Uint8Array(w * h);
  for (const b of boxes) blocked[b] = 1;
  const prev = new Int32Array(w * h).fill(-1);
  const prevStep = new Int8Array(w * h).fill(-1);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const c = queue[qi]!;
    for (let d = 0; d < 4; d++) {
      const s = STEPS[d]!;
      const q = c + s.dy * w + s.dx;
      if (q < 0 || q >= w * h || wall[q] === 1 || blocked[q] === 1 || prev[q] >= 0) continue;
      prev[q] = c;
      prevStep[q] = d;
      if (q === to) {
        let moves = '';
        for (let t = q; t !== from; t = prev[t]!) moves = STEPS[prevStep[t]!]!.ch + moves;
        return moves;
      }
      queue.push(q);
    }
  }
  return null;
}

function solveLevel(text: string): string {
  const level = parseLevel(text);
  if (level.boxes.every((b) => level.goalSet[b] === 1)) return '';
  const rooms = findRooms(level);
  if (rooms === null) return '';
  let moves = '';
  let player = level.player;
  const boxes = [...level.boxes];
  for (const room of rooms) {
    // The optimal search first; a room it cannot finish gets a longer run,
    // then a greedy one that settles for any solution over an empty answer.
    let pushes = solveRoom(level, room);
    if (pushes === null) pushes = solveRoom(level, room, 1_500_000);
    if (pushes === null) pushes = solveRoom(level, room, 500_000, true);
    if (pushes === null) return '';
    for (const p of pushes) {
      const step = STEPS[p.dir]!;
      const dv = step.dy * level.w + step.dx;
      const stand = p.box - dv;
      const walk = walkPath(level, player, stand, boxes);
      if (walk === null) return '';
      moves += walk + step.ch.toUpperCase();
      const at = boxes.indexOf(p.box);
      boxes[at] = p.box + dv;
      boxes.sort((a, b) => a - b);
      player = p.box;
    }
  }
  return moves;
}

for (const id of readdirSync(IN_DIR).sort()) {
  const moves = solveLevel(readFileSync(join(IN_DIR, id, 'level.txt'), 'utf8'));
  mkdirSync(join(OUT_DIR, id), { recursive: true });
  writeFileSync(join(OUT_DIR, id, 'solution.txt'), `${moves}\n`);
}
