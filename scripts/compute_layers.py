#!/usr/bin/env python3
"""自动分层脚本：为 data/graph.json 的节点计算 layer（层号，整数 ≥1，1=地基）。

算法：
  1. equivalent 边用并查集归并——等价的节点必在同一层；
  2. 支撑边 = depends_on + implies（generalizes / analogy 不参与层计算），
     在归并后的等价类上建图；
  3. SCC（强连通分量）检测环并坍缩（相互依赖的节点同层），得到 DAG；
  4. 在 DAG 上求最长路：layer(n) = 1（无支撑前驱）或 1 + max(layer(前驱))。

默认只为缺失 layer 字段的节点计算（保留人工调整）；--force 全量重算。

用法：
    python3 scripts/compute_layers.py [--force] [graph.json 路径]
"""

import json
import sys
from collections import deque
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_PATH = ROOT / "data" / "graph.json"
SUPPORT_RELATIONS = {"depends_on", "implies"}


# ---------- 并查集（equivalent 归并） ----------

class UnionFind:
    def __init__(self, items):
        self.parent = {x: x for x in items}

    def find(self, x):
        root = x
        while self.parent[root] != root:
            root = self.parent[root]
        while self.parent[x] != root:
            self.parent[x], x = root, self.parent[x]
        return root

    def union(self, a, b):
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.parent[rb] = ra


# ---------- SCC（Kosaraju，迭代实现） ----------

def scc_components(vertices, adj):
    """返回 (comp: vertex -> 分量编号, 分量个数)。"""
    visited = set()
    order = []
    for s in vertices:
        if s in visited:
            continue
        visited.add(s)
        stack = [(s, iter(adj.get(s, ()))) ]
        while stack:
            v, it = stack[-1]
            advanced = False
            for w in it:
                if w not in visited:
                    visited.add(w)
                    stack.append((w, iter(adj.get(w, ()))))
                    advanced = True
                    break
            if not advanced:
                order.append(v)
                stack.pop()

    radj = {v: [] for v in vertices}
    for v, ws in adj.items():
        for w in ws:
            radj.setdefault(w, []).append(v)

    comp = {}
    ncomp = 0
    for s in reversed(order):
        if s in comp:
            continue
        comp[s] = ncomp
        stack = [s]
        while stack:
            v = stack.pop()
            for w in radj.get(v, []):
                if w not in comp:
                    comp[w] = ncomp
                    stack.append(w)
        ncomp += 1
    return comp, ncomp


# ---------- 层计算 ----------

def compute_layers(graph):
    """返回 {节点id: layer}（全部重算的结果）。"""
    node_ids = [n["id"] for n in graph["nodes"]]

    uf = UnionFind(node_ids)
    for e in graph["edges"]:
        if e["relation"] == "equivalent":
            uf.union(e["source"], e["target"])

    # 等价类上的支撑边（去掉归并后的自环）
    class_adj = {}
    for e in graph["edges"]:
        if e["relation"] not in SUPPORT_RELATIONS:
            continue
        rs, rt = uf.find(e["source"]), uf.find(e["target"])
        if rs != rt:
            class_adj.setdefault(rs, set()).add(rt)
    class_adj = {k: sorted(v) for k, v in class_adj.items()}

    vertices = sorted({uf.find(x) for x in node_ids})
    comp, ncomp = scc_components(vertices, class_adj)

    # 缩点成 DAG，拓扑序上求最长路
    cadj = {c: set() for c in range(ncomp)}
    for v, ws in class_adj.items():
        for w in ws:
            if comp[v] != comp[w]:
                cadj[comp[v]].add(comp[w])
    indeg = {c: 0 for c in range(ncomp)}
    for c, ws in cadj.items():
        for w in ws:
            indeg[w] += 1
    comp_layer = {c: 1 for c in range(ncomp)}
    q = deque(c for c in range(ncomp) if indeg[c] == 0)
    while q:
        c = q.popleft()
        for w in cadj[c]:
            comp_layer[w] = max(comp_layer[w], comp_layer[c] + 1)
            indeg[w] -= 1
            if indeg[w] == 0:
                q.append(w)

    return {nid: comp_layer[comp[uf.find(nid)]] for nid in node_ids}


def main():
    args = [a for a in sys.argv[1:]]
    force = "--force" in args
    args = [a for a in args if a != "--force"]
    path = Path(args[0]) if args else DEFAULT_PATH

    graph = json.loads(path.read_text(encoding="utf-8"))
    computed = compute_layers(graph)

    assigned, kept = 0, 0
    for n in graph["nodes"]:
        if force or "layer" not in n:
            n["layer"] = computed[n["id"]]
            assigned += 1
        else:
            kept += 1

    graph.setdefault("meta", {})["updated"] = datetime.now().isoformat(timespec="seconds")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(graph, f, ensure_ascii=False, indent=2, sort_keys=True)
        f.write("\n")

    # 打印层分布
    by_layer = {}
    names = {n["id"]: n["name"] for n in graph["nodes"]}
    for n in graph["nodes"]:
        by_layer.setdefault(n["layer"], []).append(n["id"])
    max_layer = max(by_layer)
    print(f"共 {max_layer} 层；本次计算写入 {assigned} 个节点，保留人工 layer {kept} 个。")
    for layer in range(1, max_layer + 1):
        members = sorted(by_layer[layer])
        print(f"\nL{layer}（{len(members)} 个）：")
        for nid in members:
            print(f"  {nid}（{names[nid]}）")


if __name__ == "__main__":
    main()
