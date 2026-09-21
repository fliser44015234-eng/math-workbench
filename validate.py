#!/usr/bin/env python3
"""知识网络数据校验器。

校验 data/graph.json（或任何符合 SCHEMA.md 的图数据文件）。
被 server.py 复用（PUT /api/graph 前调用 validate_graph）。

命令行用法：
    python validate.py data/graph.json
有错时逐条打印并以退出码 1 结束；全部通过打印 OK。
"""

import json
import sys

# ---- 枚举定义（与前端 app.js 保持一致，改一处必须同步另一处） ----

NODE_KINDS = {
    "definition", "axiom", "lemma", "proposition", "theorem",
    "corollary", "claim", "technique", "example",
}

EDGE_RELATIONS = {
    "depends_on", "implies", "equivalent", "generalizes", "analogy",
}

QUESTION_SOURCES = {"ai", "manual"}
TARGET_TYPES = {"node", "edge"}


def _is_number(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def validate_graph(g):
    """校验整张图，返回错误字符串列表（空列表 = 通过）。"""
    errors = []

    if not isinstance(g, dict):
        return ["顶层必须是 JSON 对象"]

    # ---- 顶层键 ----
    for key in ("nodes", "edges", "questions"):
        if key not in g:
            errors.append(f"缺少顶层键 '{key}'")
    if errors:
        return errors
    if not isinstance(g["nodes"], list):
        errors.append("'nodes' 必须是数组")
    if not isinstance(g["edges"], list):
        errors.append("'edges' 必须是数组")
    if not isinstance(g["questions"], list):
        errors.append("'questions' 必须是数组")
    if errors:
        return errors

    # ---- 节点 ----
    node_ids = set()
    for i, n in enumerate(g["nodes"]):
        where = f"nodes[{i}]"
        if not isinstance(n, dict):
            errors.append(f"{where}: 必须是对象")
            continue
        nid = n.get("id")
        if not nid or not isinstance(nid, str):
            errors.append(f"{where}: id 缺失或不是非空字符串")
        elif nid in node_ids:
            errors.append(f"{where}: id '{nid}' 重复")
        else:
            node_ids.add(nid)
        if n.get("kind") not in NODE_KINDS:
            errors.append(f"{where} (id={nid}): kind '{n.get('kind')}' 不在枚举 {sorted(NODE_KINDS)} 内")
        if not n.get("name"):
            errors.append(f"{where} (id={nid}): name 缺失或为空")
        layer = n.get("layer")
        if not isinstance(layer, int) or isinstance(layer, bool) or layer < 1:
            errors.append(f"{where} (id={nid}): layer 必须是 ≥1 的整数（1=地基），当前为 {layer!r}")
        pos = n.get("position")
        if pos is not None:
            if not isinstance(pos, dict) or not _is_number(pos.get("x")) or not _is_number(pos.get("y")):
                errors.append(f"{where} (id={nid}): position 必须是 null 或 {{'x': 数值, 'y': 数值}}")

    # ---- 边 ----
    edge_ids = set()
    for i, e in enumerate(g["edges"]):
        where = f"edges[{i}]"
        if not isinstance(e, dict):
            errors.append(f"{where}: 必须是对象")
            continue
        eid = e.get("id")
        if not eid or not isinstance(eid, str):
            errors.append(f"{where}: id 缺失或不是非空字符串")
        elif eid in edge_ids:
            errors.append(f"{where}: id '{eid}' 重复")
        else:
            edge_ids.add(eid)
        if e.get("relation") not in EDGE_RELATIONS:
            errors.append(f"{where} (id={eid}): relation '{e.get('relation')}' 不在枚举 {sorted(EDGE_RELATIONS)} 内")
        for endpoint in ("source", "target"):
            ref = e.get(endpoint)
            if ref not in node_ids:
                errors.append(f"{where} (id={eid}): {endpoint} 指向不存在的节点 '{ref}'")

    # ---- 问答 ----
    q_ids = set()
    for i, q in enumerate(g["questions"]):
        where = f"questions[{i}]"
        if not isinstance(q, dict):
            errors.append(f"{where}: 必须是对象")
            continue
        qid = q.get("id")
        if not qid or not isinstance(qid, str):
            errors.append(f"{where}: id 缺失或不是非空字符串")
        elif qid in q_ids:
            errors.append(f"{where}: id '{qid}' 重复")
        else:
            q_ids.add(qid)
        tt = q.get("targetType")
        if tt not in TARGET_TYPES:
            errors.append(f"{where} (id={qid}): targetType '{tt}' 必须是 node 或 edge")
        else:
            pool = node_ids if tt == "node" else edge_ids
            if q.get("targetId") not in pool:
                errors.append(f"{where} (id={qid}): targetId '{q.get('targetId')}' 指向不存在的{tt}")
        if q.get("source") not in QUESTION_SOURCES:
            errors.append(f"{where} (id={qid}): source '{q.get('source')}' 必须是 ai 或 manual")
        if not q.get("question"):
            errors.append(f"{where} (id={qid}): question 缺失或为空")

    return errors


def main():
    if len(sys.argv) != 2:
        print("用法: python validate.py <graph.json 路径>", file=sys.stderr)
        sys.exit(2)
    path = sys.argv[1]
    try:
        with open(path, encoding="utf-8") as f:
            g = json.load(f)
    except (OSError, json.JSONDecodeError) as exc:
        print(f"无法读取/解析 {path}: {exc}", file=sys.stderr)
        sys.exit(1)
    errors = validate_graph(g)
    if errors:
        print(f"发现 {len(errors)} 个错误：")
        for err in errors:
            print(f"  - {err}")
        sys.exit(1)
    print("OK")


if __name__ == "__main__":
    main()
