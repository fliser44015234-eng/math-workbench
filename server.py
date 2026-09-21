#!/usr/bin/env python3
"""数学知识网络工作台 · 本地服务器。

只提供三类东西：
  1. 静态文件（index.html / static/ / data/）——不暴露项目根的其他文件；
  2. GET/PUT /api/graph —— 读取 / 整体保存 data/graph.json（保存前用 validate.py 校验）；
  3. POST /api/ask —— 把节点/边的上下文连同历史问答发给 Moonshot（Kimi）模型。

AI 配置：环境变量 MOONSHOT_API_KEY，或项目根 config.local.json
（字段 moonshot_api_key、model；config.local.json 不会被 HTTP 访问，也不要提交 git）。
"""

import json
import os
import shutil
from datetime import datetime
from pathlib import Path

import requests
from flask import Flask, jsonify, request, send_from_directory

from validate import validate_graph

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
GRAPH_PATH = DATA_DIR / "graph.json"
BACKUP_PATH = DATA_DIR / "graph.json.bak"
CONFIG_PATH = BASE_DIR / "config.local.json"

MOONSHOT_URL = "https://api.moonshot.cn/v1/chat/completions"
DEFAULT_MODEL = "kimi-k3"

KIND_ZH = {
    "definition": "定义", "axiom": "公理", "lemma": "引理",
    "proposition": "命题", "theorem": "定理", "corollary": "推论",
    "claim": "断言", "technique": "技巧", "example": "例",
}
REL_ZH = {
    "depends_on": "依据", "implies": "推论", "equivalent": "等价",
    "generalizes": "推广", "analogy": "类比",
}

SYSTEM_PROMPT = (
    "你是一位耐心严谨的数学助教，服务于一个数学知识图谱。"
    "用户围绕某个定理/概念/逻辑关系提问。"
    "用中文回答，公式用 LaTeX（$...$ 与 $$...$$），"
    "重点讲清证明思路与动机，条理化，400 字以内。"
)

app = Flask(__name__, static_folder=None)


# ---------- 静态文件（只允许这三条路由） ----------

@app.route("/")
def index():
    return send_from_directory(BASE_DIR, "index.html")


@app.route("/static/<path:filename>")
def static_files(filename):
    return send_from_directory(BASE_DIR / "static", filename)


@app.route("/data/<path:filename>")
def data_files(filename):
    return send_from_directory(DATA_DIR, filename)


# ---------- 图数据读写 ----------

def load_graph():
    with open(GRAPH_PATH, encoding="utf-8") as f:
        return json.load(f)


@app.route("/api/graph", methods=["GET"])
def get_graph():
    return jsonify(load_graph())


@app.route("/api/graph", methods=["PUT"])
def put_graph():
    data = request.get_json(force=True, silent=True)
    if data is None:
        return jsonify({"ok": False, "errors": ["请求体不是合法 JSON"]}), 400
    errors = validate_graph(data)
    if errors:
        return jsonify({"ok": False, "errors": errors}), 400
    data.setdefault("meta", {})["updated"] = datetime.now().isoformat(timespec="seconds")
    if GRAPH_PATH.exists():
        shutil.copy(GRAPH_PATH, BACKUP_PATH)
    with open(GRAPH_PATH, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")
    return jsonify({"ok": True})


# ---------- AI 问答 ----------

def load_ai_config():
    """返回 (api_key, model)；两者来源：环境变量优先，其次 config.local.json。"""
    key = os.environ.get("MOONSHOT_API_KEY")
    model = DEFAULT_MODEL
    if CONFIG_PATH.exists():
        try:
            cfg = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            cfg = {}
        key = key or cfg.get("moonshot_api_key")
        model = cfg.get("model") or model
    return key, model


def find_node(g, nid):
    for n in g["nodes"]:
        if n["id"] == nid:
            return n
    return None


def find_edge(g, eid):
    for e in g["edges"]:
        if e["id"] == eid:
            return e
    return None


def build_context(g, target_type, target_id):
    """把目标对象（节点或边）的完整信息组织成给模型看的文本。"""
    if target_type == "node":
        n = find_node(g, target_id)
        if n is None:
            return None
        lines = [
            f"【节点】{n['name']}（{KIND_ZH.get(n['kind'], n['kind'])}）",
            f"命题：{n.get('statement', '')}",
            f"证明：{n.get('proof', '')}",
        ]
        neighbors = []
        for e in g["edges"]:
            if e["source"] == target_id:
                nb = find_node(g, e["target"])
                if nb:
                    neighbors.append(
                        f"- 本节点 --{REL_ZH.get(e['relation'], e['relation'])}--> "
                        f"{nb['name']}（{KIND_ZH.get(nb['kind'], nb['kind'])}）：{nb.get('statement', '')}"
                    )
            elif e["target"] == target_id:
                nb = find_node(g, e["source"])
                if nb:
                    neighbors.append(
                        f"- {nb['name']}（{KIND_ZH.get(nb['kind'], nb['kind'])}）"
                        f" --{REL_ZH.get(e['relation'], e['relation'])}--> 本节点：{nb.get('statement', '')}"
                    )
        if neighbors:
            lines.append("相关节点：")
            lines.extend(neighbors)
        return "\n".join(lines)

    e = find_edge(g, target_id)
    if e is None:
        return None
    s = find_node(g, e["source"])
    t = find_node(g, e["target"])
    rel = REL_ZH.get(e["relation"], e["relation"])
    lines = [f"【边（逻辑关系）】{s['name']} --{rel}--> {t['name']}"]
    if e.get("label"):
        lines.append(f"边标签：{e['label']}")
    if e.get("note"):
        lines.append(f"边备注：{e['note']}")
    for role, n in (("起点节点", s), ("终点节点", t)):
        lines.append(
            f"{role}：{n['name']}（{KIND_ZH.get(n['kind'], n['kind'])}）\n"
            f"命题：{n.get('statement', '')}\n证明：{n.get('proof', '')}"
        )
    return "\n".join(lines)


def recent_qa_messages(g, target_type, target_id, limit=6):
    """取该对象最近 limit 条历史问答，组成多轮 messages（旧→新）。"""
    qa = [q for q in g["questions"]
          if q.get("targetType") == target_type and q.get("targetId") == target_id]
    qa.sort(key=lambda q: q.get("createdAt", ""))
    msgs = []
    for q in qa[-limit:]:
        msgs.append({"role": "user", "content": q["question"]})
        if q.get("answer"):
            msgs.append({"role": "assistant", "content": q["answer"]})
    return msgs


@app.route("/api/ask", methods=["POST"])
def ask():
    body = request.get_json(force=True, silent=True) or {}
    target_type = body.get("targetType")
    target_id = body.get("targetId")
    question = (body.get("question") or "").strip()
    if target_type not in ("node", "edge") or not target_id or not question:
        return jsonify({"error": "bad_request",
                        "message": "需要 targetType(node|edge)、targetId、question"}), 400

    key, model = load_ai_config()
    if not key:
        return jsonify({"error": "not_configured",
                        "message": "未配置 Moonshot API Key"}), 501

    g = load_graph()
    context = build_context(g, target_type, target_id)
    if context is None:
        return jsonify({"error": "not_found",
                        "message": f"找不到 {target_type} '{target_id}'"}), 404

    messages = [{"role": "system", "content": SYSTEM_PROMPT}]
    messages.append({"role": "user", "content": f"以下是知识图谱中相关对象的资料：\n\n{context}"})
    messages.extend(recent_qa_messages(g, target_type, target_id))
    messages.append({"role": "user", "content": question})

    try:
        resp = requests.post(
            MOONSHOT_URL,
            headers={"Authorization": f"Bearer {key}"},
            json={"model": model, "messages": messages},
            timeout=60,
        )
        if resp.status_code != 200:
            return jsonify({"error": "upstream",
                            "message": f"Moonshot API 返回 {resp.status_code}：{resp.text[:300]}"}), 502
        answer = resp.json()["choices"][0]["message"]["content"]
    except requests.RequestException as exc:
        return jsonify({"error": "upstream", "message": f"调用 Moonshot API 失败：{exc}"}), 502
    except (KeyError, IndexError, ValueError) as exc:
        return jsonify({"error": "upstream", "message": f"解析 Moonshot 响应失败：{exc}"}), 502

    return jsonify({"answer": answer})


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=8421)
