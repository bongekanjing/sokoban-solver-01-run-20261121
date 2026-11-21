[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/bongekanjing/sokoban-solver-01-run-20261121/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/bongekanjing/sokoban-solver-01-run-20261121/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)

# Room-by-room push-optimal Sokoban solver

Entry for [sokoban-solver-01-run-20261121](https://make.fun/bounty/sokoban-solver-01-run-20261121)
("Build the best Sokoban solver, 21 November 2026") — one program answers all
5 instances of a set in one run, in as few pushes as possible.

## How it works

A generated level is a 1-wide hallway with 1–4 rooms off it, and a box pushed
out of a room's door can never come back, so every box stays in its room and
the level's push optimum is the sum of the rooms' optima. `main.ts` therefore
splits each level into rooms and solves every room push-optimally on its own,
instead of searching the whole level as one flat state space.

Each room is solved by A* over pushes: a state is the boxes' squares plus the
player's reachable region, each edge is one push, and the heuristic is the
minimum-cost assignment of boxes to goals over single-box push distances
(admissible, so the first solved state popped is push-optimal). Dead states
are pruned two ways: a box on a square from which no push can ever reach a
goal (found by a reverse pull search from the goals), and a frozen 2×2 block
of walls and boxes holding a box off its goal.

Budgets are by work, never by the wall clock — every search carries a fixed
expansion cap, the program never reads the clock, and two runs on one set
write byte-identical outputs. If a room's optimal search gives up, a greedy
best-first search tries for any solution of that room; if a level does not
split into rooms, a plain move-based A* over the whole level tries instead.
An instance is never left unanswered.

## Results (kit scorer)

- Practice set: **1,000,000** — every instance solved in exactly P* pushes
  (13, 16, 29, 47, 60). House baseline plain-astar 1.0.0 scores 200,000 on
  the same set.
- 5 unseen sets drawn with the kit generator: **1,000,000** on each, every
  instance at P*.
- Whole-set wall time ≈ 0.3 s (budget 60 s); two runs on one set produce
  byte-identical outputs.

## Run

Node 22, built-in modules only, no dependencies:

```
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Reads `/input/<id>/level.txt`, writes `/output/<id>/solution.txt` (LURD
moves). Also honours `MAKEFUN_INPUT_DIR` / `MAKEFUN_OUTPUT_DIR` locally.
