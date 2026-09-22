#!/usr/bin/env python3
"""数学知识网络工作台 · 本地服务器。

只提供这几类东西：
  1. 静态文件（index.html / static/ / data/）——不暴露项目根的其他文件；
  2. GET/PUT /api/graph —— 读取 / 整体保存 data/<name>.json（保存前用 validate.py 校验）；
  3. POST /api/ask / /api/suggest-node / /api/import-notes —— 把节点/边/笔记的上下文
     发给任意 OpenAI 兼容模型（默认 Moonshot Kimi）。

所有 /api/* 路由都接受 ?name=<图名> 选择 data/ 下的图文件（默认 graph）。

AI 配置：环境变量 MOONSHOT_API_KEY，或项目根 config.local.json
（字段 base_url / api_key / model，旧字段 moonshot_api_key 仍兼容；
config.local.json 不会被 HTTP 访问，也不要提交 git）。
"""

import json
import os
import re
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path

import requests
from flask import Flask, jsonify, request, send_from_directory

from validate import EDGE_RELATIONS, NODE_KINDS, validate_graph

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
GRAPH_PATH = DATA_DIR / "graph.json"
BACKUP_PATH = DATA_DIR / "graph.json.bak"
CONFIG_PATH = BASE_DIR / "config.local.json"

DEFAULT_BASE_URL = "https://api.moonshot.cn/v1"
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

# Moonshot 请求走独立 Session：trust_env=False 绕过系统代理
# （本机直连 api.moonshot.cn 正常，而 macOS 系统代理会掐断长耗时的推理请求）
_http = requests.Session()
_http.trust_env = False


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


# ---------- 图数据读写（支持 ?name= 多图） ----------

# 图名白名单：小写字母/数字/点/连字符，拒绝 ".."（防路径穿越）
GRAPH_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9.\-]{0,39}$")


def resolve_graph_path():
    """从 ?name= 解析出 data/ 下已存在的 .json 文件；非法或不存在返回 None。

    /api/graph 与三个 AI 路由共用，保证多图模式下 AI 看到的是当前图的上下文。
    """
    name = request.args.get("name", "graph")
    if not GRAPH_NAME_RE.match(name) or ".." in name:
        return None
    p = (DATA_DIR / f"{name}.json").resolve()
    if DATA_DIR.resolve() not in p.parents:
        return None
    if not p.is_file():
        return None   # API 不创建新图；开新图用 cp data/graph.template.json data/新名.json
    return p


def load_graph(path=None):
    with open(path or GRAPH_PATH, encoding="utf-8") as f:
        return json.load(f)


@app.route("/api/graph", methods=["GET"])
def get_graph():
    path = resolve_graph_path()
    if path is None:
        return jsonify({"error": "not_found", "message": "图不存在或名称非法"}), 404
    return jsonify(load_graph(path))


@app.route("/api/graph", methods=["PUT"])
def put_graph():
    path = resolve_graph_path()
    if path is None:
        return jsonify({"ok": False, "errors": ["图不存在或名称非法"]}), 404
    data = request.get_json(force=True, silent=True)
    if data is None:
        return jsonify({"ok": False, "errors": ["请求体不是合法 JSON"]}), 400
    errors = validate_graph(data)
    if errors:
        return jsonify({"ok": False, "errors": errors}), 400
    data.setdefault("meta", {})["updated"] = datetime.now().isoformat(timespec="seconds")
    if path.exists():
        shutil.copy(path, path.with_name(path.name + ".bak"))
    # sort_keys 与 scripts/compute_layers.py 保持一致，保证文件键序稳定、git diff 干净
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2, sort_keys=True)
        f.write("\n")
    # 缺 layer 的节点：best-effort 调 compute_layers.py 补齐（异常静默，不影响保存成功）
    layers_filled = False
    if any("layer" not in n for n in data.get("nodes", [])):
        try:
            proc = subprocess.run(
                [sys.executable, str(BASE_DIR / "scripts" / "compute_layers.py"), str(path)],
                cwd=BASE_DIR, timeout=120, capture_output=True, check=False,
            )
            layers_filled = proc.returncode == 0
        except Exception:
            pass
    return jsonify({"ok": True, "layers_filled": layers_filled})


# ---------- AI 问答 ----------

def load_ai_config():
    """返回 (base_url, api_key, model)。

    来源：config.local.json 的 base_url / api_key（向后兼容旧字段 moonshot_api_key）/ model；
    环境变量 MOONSHOT_API_KEY 仍可覆盖 key。
    """
    key = os.environ.get("MOONSHOT_API_KEY")
    base_url = DEFAULT_BASE_URL
    model = DEFAULT_MODEL
    if CONFIG_PATH.exists():
        try:
            cfg = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            cfg = {}
        key = key or cfg.get("api_key") or cfg.get("moonshot_api_key")
        base_url = cfg.get("base_url") or base_url
        model = cfg.get("model") or model
    return base_url, key, model


def ai_chat_completions(base_url, key, model, messages, timeout, low_effort=False):
    """统一的 OpenAI 兼容 /chat/completions 调用。

    reasoning_effort 仅 Moonshot 支持（DeepSeek 等收到会 400），只在 base_url 含 moonshot 时发送。
    """
    payload = {"model": model, "messages": messages}
    if low_effort and "moonshot" in base_url:
        payload["reasoning_effort"] = "low"
    return _http.post(
        f"{base_url.rstrip('/')}/chat/completions",
        headers={"Authorization": f"Bearer {key}"},
        json=payload,
        timeout=timeout,
    )


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
    if s is None or t is None:
        return None
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

    base_url, key, model = load_ai_config()
    if not key:
        return jsonify({"error": "not_configured",
                        "message": "未配置 API Key"}), 501

    path = resolve_graph_path()
    if path is None:
        return jsonify({"error": "not_found", "message": "图不存在或名称非法"}), 404
    g = load_graph(path)
    context = build_context(g, target_type, target_id)
    if context is None:
        return jsonify({"error": "not_found",
                        "message": f"找不到 {target_type} '{target_id}'"}), 404

    messages = [{"role": "system", "content": SYSTEM_PROMPT}]
    messages.append({"role": "user", "content": f"以下是知识图谱中相关对象的资料：\n\n{context}"})
    messages.extend(recent_qa_messages(g, target_type, target_id))
    messages.append({"role": "user", "content": question})

    try:
        resp = ai_chat_completions(base_url, key, model, messages, timeout=60)
        if resp.status_code != 200:
            return jsonify({"error": "upstream",
                            "message": f"AI 接口返回 {resp.status_code}：{resp.text[:300]}"}), 502
        answer = resp.json()["choices"][0]["message"]["content"]
    except requests.RequestException as exc:
        return jsonify({"error": "upstream", "message": f"调用 AI 接口失败：{exc}"}), 502
    except (KeyError, IndexError, ValueError) as exc:
        return jsonify({"error": "upstream", "message": f"解析 AI 响应失败：{exc}"}), 502

    return jsonify({"answer": answer, "model": model})


# ---------- AI 建议新节点的层与强相关边 ----------

SUGGEST_RELATIONS = {"depends_on", "implies", "equivalent", "generalizes"}

SUGGEST_SYSTEM = (
    "你是数学知识图谱的建图助手。用户要给图谱添加一个新节点。"
    "根据给出的图谱摘要，判断新节点应所在的层号，以及它与现有节点之间确信无疑的强逻辑关系。"
    "严格只输出一个 JSON 对象：不要输出任何其他文字，不要使用 markdown 代码围栏。"
)


def graph_summary_by_layer(g):
    """按层分组列出全部节点 'id（名称，kind）'，供 prompt 使用。"""
    by_layer = {}
    for n in g["nodes"]:
        by_layer.setdefault(n.get("layer", 1), []).append(n)
    lines = []
    for layer in sorted(by_layer):
        members = "、".join(f"{n['id']}（{n['name']}，{n['kind']}）" for n in by_layer[layer])
        lines.append(f"L{layer}: {members}")
    # 空图（如刚复制的模板删光节点）时 max() 会抛异常，视为 1 层
    return "\n".join(lines) or "（图谱暂无节点）", max(by_layer, default=1)


@app.route("/api/suggest-node", methods=["POST"])
def suggest_node():
    body = request.get_json(force=True, silent=True) or {}
    name = (body.get("name") or "").strip()
    statement = (body.get("statement") or "").strip()
    kind = (body.get("kind") or "").strip()
    proof = (body.get("proof") or "").strip()
    if not name or not statement:
        return jsonify({"error": "bad_request", "message": "需要 name 与 statement"}), 400

    base_url, key, model = load_ai_config()
    if not key:
        return jsonify({"error": "not_configured",
                        "message": "未配置 API Key"}), 501

    path = resolve_graph_path()
    if path is None:
        return jsonify({"error": "not_found", "message": "图不存在或名称非法"}), 404
    g = load_graph(path)
    summary, max_layer = graph_summary_by_layer(g)
    user_prompt = (
        "图谱层规则：层号 = 离地基（第 1 层）的证明深度；节点应比它最强的支撑前驱高一层；"
        "没有支撑前驱则为 1；等价命题同层。\n"
        "图谱摘要（按层分组，格式 id（名称，kind））：\n"
        f"{summary}\n\n"
        f"新节点：名称「{name}」，kind={kind or '未知'}。\n"
        f"命题：{statement}\n"
        f"证明：{proof or '（无）'}\n\n"
        "只输出如下 JSON：\n"
        '{"layer": 整数, "edges": [{"target": "现有节点id", "direction": "in"|"out", '
        '"relation": "depends_on"|"implies"|"equivalent"|"generalizes", "reason": "十字以内"}]}\n'
        "direction 语义：out = 新节点支撑目标（新节点→目标）；in = 目标支撑新节点（目标→新节点）。\n"
        "只列确信无疑的强关系，最多 6 条；没有把握就返回空 edges 数组。"
    )

    try:
        resp = ai_chat_completions(
            base_url, key, model,
            [{"role": "system", "content": SUGGEST_SYSTEM},
             {"role": "user", "content": user_prompt}],
            timeout=300,   # kimi-k3 是推理模型，实测该 prompt 推理约 3 分钟
            low_effort=True,   # 结构化抽取任务不需要深推理，显著降延迟
        )
        if resp.status_code != 200:
            return jsonify({"error": "upstream",
                            "message": f"AI 接口返回 {resp.status_code}：{resp.text[:300]}"}), 502
        text = resp.json()["choices"][0]["message"]["content"]
    except requests.RequestException as exc:
        return jsonify({"error": "upstream", "message": f"调用 AI 接口失败：{exc}"}), 502
    except (KeyError, IndexError, ValueError) as exc:
        return jsonify({"error": "upstream", "message": f"解析 AI 响应失败：{exc}"}), 502

    # 防御性解析：剥离可能的 ```json 围栏，非法条目丢弃不报错
    raw = text.strip()
    if raw.startswith("```"):
        raw = re.sub(r"^```(?:json)?\s*", "", raw)
        raw = re.sub(r"\s*```$", "", raw)
    try:
        data = json.loads(raw)
    except ValueError:
        return jsonify({"error": "parse",
                        "message": "AI 输出不是合法 JSON",
                        "raw": text[:300]}), 502

    node_ids = {n["id"] for n in g["nodes"]}
    layer = None
    try:
        layer = max(1, min(max_layer + 1, int(data.get("layer"))))
    except (TypeError, ValueError):
        pass
    edges = []
    for item in data.get("edges") or []:
        if not isinstance(item, dict):
            continue
        t, direction, relation = item.get("target"), item.get("direction"), item.get("relation")
        if t not in node_ids or direction not in ("in", "out") or relation not in SUGGEST_RELATIONS:
            continue
        edges.append({"target": t, "direction": direction, "relation": relation,
                      "reason": str(item.get("reason", ""))[:40]})
    return jsonify({"layer": layer, "edges": edges[:6]})


# ---------- AI 笔记导入 ----------

IMPORT_SYSTEM = (
    "你是数学知识图谱的建图助手。用户给你一份课程笔记，请你提取知识点与逻辑关系，输出为图谱数据。"
    "规则：\n"
    "- 节点 kind 只能是：definition（定义）/ axiom（公理）/ lemma（引理）/ proposition（命题）/ "
    "theorem（定理）/ corollary（推论）/ claim（断言）/ technique（技巧）/ example（例）。\n"
    "- 边 relation 只能是：depends_on（A→B 表示 A 支撑 B 的证明，箭头指向被支撑者）/ "
    "implies（A 直接推出 B）/ equivalent（A 与 B 等价，无方向）/ generalizes（A 是 B 的一般情形）/ "
    "analogy（跨领域类比，无方向）。只提取确信无疑的强关系，拿不准宁可不加。\n"
    "- 节点 id 用英文 kebab-case（小写字母/数字/连字符）。\n"
    "- statement/proof 用笔记原文的 LaTeX，忠于原文，不得编造；笔记没给证明则 proof 留空字符串。\n"
    "- 若笔记中的知识点在现有节点清单里已存在，仍照常提取（服务端会按同名去重并列入 skipped）；"
    "现有节点清单主要用于边端点引用。\n"
    "- 严格只输出一个 JSON 对象，不要输出任何其他文字，不要使用 markdown 代码围栏。"
)


def slugify(text):
    slug = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return slug or "node"


@app.route("/api/import-notes", methods=["POST"])
def import_notes():
    body = request.get_json(force=True, silent=True) or {}
    content = (body.get("content") or "").strip()
    chapter_hint = (body.get("chapter_hint") or "").strip()
    if not content:
        return jsonify({"error": "bad_request", "message": "需要 content"}), 400
    content = content[:60000]  # 防超长

    base_url, key, model = load_ai_config()
    if not key:
        return jsonify({"error": "not_configured",
                        "message": "未配置 API Key"}), 501

    path = resolve_graph_path()
    if path is None:
        return jsonify({"error": "not_found", "message": "图不存在或名称非法"}), 404
    g = load_graph(path)
    summary, _ = graph_summary_by_layer(g)
    chapter_line = f'所有新节点的 chapter 统一填 "{chapter_hint}"。' if chapter_hint else "chapter 可留空字符串。"
    user_prompt = (
        "现有图谱节点清单（按层分组，格式 id（名称，kind），供边端点引用）：\n"
        f"{summary}\n\n"
        "注意：笔记中出现的知识点请全部照常提取，不要因清单中已有而跳过；与现有节点重名的由服务端去重。\n"
        f"{chapter_line}\n"
        "只输出如下 JSON：\n"
        '{"nodes": [{"id": "...", "name": "...", "kind": "...", "statement": "...", "proof": "...", '
        '"tags": ["..."], "chapter": "..."}], '
        '"edges": [{"source": "节点id", "target": "节点id", "relation": "...", "label": "...", "note": "..."}]}\n'
        "edge 端点可以是现有节点 id 或本次新节点 id。\n\n"
        "笔记正文：\n" + content
    )

    try:
        resp = ai_chat_completions(
            base_url, key, model,
            [{"role": "system", "content": IMPORT_SYSTEM},
             {"role": "user", "content": user_prompt}],
            timeout=300, low_effort=True,
        )
        if resp.status_code != 200:
            return jsonify({"error": "upstream",
                            "message": f"AI 接口返回 {resp.status_code}：{resp.text[:300]}"}), 502
        text = resp.json()["choices"][0]["message"]["content"]
    except requests.RequestException as exc:
        return jsonify({"error": "upstream", "message": f"调用 AI 接口失败：{exc}"}), 502
    except (KeyError, IndexError, ValueError) as exc:
        return jsonify({"error": "upstream", "message": f"解析 AI 响应失败：{exc}"}), 502

    # 防御性解析：剥围栏、json.loads、逐项校验，非法条目丢弃不报错
    raw = text.strip()
    if raw.startswith("```"):
        raw = re.sub(r"^```(?:json)?\s*", "", raw)
        raw = re.sub(r"\s*```$", "", raw)
    try:
        data = json.loads(raw)
    except ValueError:
        return jsonify({"error": "parse",
                        "message": "AI 输出不是合法 JSON",
                        "raw": text[:300]}), 502

    existing_ids = {n["id"] for n in g["nodes"]}
    existing_names = {re.sub(r"\s+", "", n["name"]).lower() for n in g["nodes"]}
    nodes_out, skipped_existing = [], []
    batch_ids = set()
    for item in data.get("nodes") or []:
        if len(nodes_out) >= 60:   # 上限防失控
            break
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or "").strip()
        if not name or item.get("kind") not in NODE_KINDS:
            continue
        # 与现有节点同名（去空白、忽略大小写）→ 视为已存在，不入候选
        if re.sub(r"\s+", "", name).lower() in existing_names:
            skipped_existing.append(name)
            continue
        nid = slugify(str(item.get("id") or name))
        if nid in existing_ids or nid in batch_ids:
            base, i = nid, 2
            while f"{base}-{i}" in existing_ids or f"{base}-{i}" in batch_ids:
                i += 1
            nid = f"{base}-{i}"
        batch_ids.add(nid)
        tags = item.get("tags")
        nodes_out.append({
            "id": nid,
            "name": name,
            "kind": item["kind"],
            "statement": str(item.get("statement") or ""),
            "proof": str(item.get("proof") or ""),
            "tags": [str(t) for t in tags if str(t).strip()] if isinstance(tags, list) else [],
            "chapter": str(item.get("chapter") or chapter_hint or ""),
        })

    valid_ids = existing_ids | batch_ids
    edges_out = []
    for item in data.get("edges") or []:
        if not isinstance(item, dict):
            continue
        s, t, r = item.get("source"), item.get("target"), item.get("relation")
        if s in valid_ids and t in valid_ids and s != t and r in EDGE_RELATIONS:
            edges_out.append({
                "source": s, "target": t, "relation": r,
                "label": str(item.get("label") or "")[:60],
                "note": str(item.get("note") or "")[:200],
            })

    return jsonify({"nodes": nodes_out, "edges": edges_out, "skipped_existing": skipped_existing})


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=8421)
