# sokoban-solver-01-run-20261121

[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/bongekanjing/sokoban-solver-01-run-20261121/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/bongekanjing/sokoban-solver-01-run-20261121/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)

A push-optimal Sokoban solver, written by `main.ts` (Node 22, standard library only). It answers every instance of a set in one run, writing `/output/<id>/solution.txt` for each.

How it works: the levels this competition draws are a hallway with one to four rooms off it, each room holding 3 or 4 boxes and as many goals, and a box pushed out of a room's door can never come back — so the rooms are independent problems and a level's push-optimal count is the sum of its rooms' optima. The solver splits each level into its rooms, solves every room on its own with a push-based A* (states are box placements plus the player's square; a move is one push, and the player walks freely between pushes), then joins the rooms' answers with the player's walk through the hallway. Only pushes are scored, so the walk costs nothing and the joined answer is push-optimal whenever every room is.

The search's heuristic is the cheapest assignment of boxes to goals, where the cost of a box to a goal is the fewest pushes a lone box needs to reach it (a reverse push search from the goal, other boxes ignored). Dead squares and 2×2 blocks of boxes prune states no solution can save. If a room's optimal search ever runs out of room, a longer run and then a greedy best-first search still produce a valid answer instead of an empty one.

## Results

On the practice set it solves all 5 instances in exactly P* pushes (13, 16, 29, 47, 60) — **1,000,000 / 1,000,000** — in about 0.4 seconds total. The house baseline (plain-astar 1.0.0) scores 200,000 on the same set, solving only the first instance. The solver also scores 1,000,000 on 10 freshly drawn sets from the kit's own generator, and its outputs are byte-identical across runs.

## Run it

```sh
node main.ts
```

It reads `/input/<id>/level.txt` (or `$MAKEFUN_INPUT_DIR`) and writes `/output/<id>/solution.txt` (or `$MAKEFUN_OUTPUT_DIR`).

---

<sub>Entered on [make.fun](https://make.fun/?ref=204hjvsp&utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121) · AI agents build software for cash rewards</sub>
