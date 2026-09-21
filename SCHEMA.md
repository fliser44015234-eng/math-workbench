# SCHEMA.md · 数据格式规范

工作台的全部数据都在一个 pretty-printed JSON 文件里（默认 `data/graph.json`）。本文档是它的精确规范；`validate.py` 与本文件一一对应，改数据后应运行 `./.venv/bin/python validate.py data/graph.json` 校验。

## 顶层结构

```json
{
  "meta": { "title": "...", "course": "...", "updated": "..." },
  "nodes": [ ... ],
  "edges": [ ... ],
  "questions": [ ... ]
}
```

- `meta.title`：网络标题，显示在网页左上角。
- `meta.course`：课程号，可为空字符串。
- `meta.updated`：最后更新时间，ISO 格式字符串（如 `2026-09-21T23:00:00`）。通过服务器保存时自动更新。
- `nodes` / `edges` / `questions`：三个数组，**必须都存在**（可以为空数组）。

## 节点 node

```json
{
  "id": "root-count-bound",
  "name": "根的个数上界",
  "kind": "corollary",
  "statement": "域 $F$ 上 $n$ 次非零多项式……",
  "proof": "对次数归纳……",
  "tags": ["多项式"],
  "chapter": "L03",
  "position": { "x": 100, "y": 200 }
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | **必填、全局唯一、非空**。约定英文 kebab-case（小写字母/数字/连字符），如 `fx-euclidean-domain`。 |
| `name` | string | 必填非空，中文显示名。 |
| `kind` | enum | 必填，九选一：`definition`（定义）、`axiom`（公理）、`lemma`（引理）、`proposition`（命题）、`theorem`（定理）、`corollary`（推论）、`claim`（断言）、`technique`（技巧）、`example`（例）。 |
| `statement` | string | 命题陈述，可含 LaTeX：行内 `$...$`、行间 `$$...$$`。 |
| `proof` | string | 证明，同样支持 LaTeX；换行用 `\n`。 |
| `tags` | string[] | 主题标签，用于顶部下拉过滤，如 `["多项式", "域论"]`。 |
| `chapter` | string | 章节标记，如 `"L03"`、`"Week 2"`，可空。 |
| `position` | object \| null | 画布坐标 `{ "x": 数值, "y": 数值 }`；`null` 表示尚未布局——只要任一节点为 `null`，前端首次加载会自动跑力导向布局并把坐标写回。 |

## 边 edge

```json
{
  "id": "e-div-root",
  "source": "division-algorithm",
  "target": "root-count-bound",
  "relation": "depends_on",
  "label": "带余除法",
  "note": "证明的第一步就是带余除法"
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 必填、全局唯一、非空。 |
| `source` / `target` | string | 必填，必须是已存在的节点 id。 |
| `relation` | enum | 必填，五选一：`depends_on`、`implies`、`equivalent`、`generalizes`、`analogy`。 |
| `label` | string | 边上小字（8px 显示），可空字符串。 |
| `note` | string | 备注，点选边时在侧栏显示，可空字符串。 |

### 方向约定（重要）

- `depends_on`（依据，蓝色实线 ▶）：**A → B 表示「A 支撑 B」**，即 A 是 B 的证明依据（引理 → 定理）。箭头指向被支撑的结论。
- `implies`（推论，绿色实线 ▷）：A → B 表示 A 直接推出 B（定理 → 推论）。
- `equivalent`（等价，紫色虚线 ◀▶）：A ⟺ B，双向箭头，source/target 无方向含义。
- `generalizes`（推广，橙色点线 ◆）：A → B 表示 **A 是 B 的一般情形**（B 是 A 的特例）。
- `analogy`（类比，灰色虚线，无箭头）：A 与 B 是不同领域里结构相似的对应物。

拿不准两个节点是什么关系时，宁可不加边，也不要乱标。

## 问答 question

```json
{
  "id": "q-20260921-001",
  "targetType": "node",
  "targetId": "root-count-bound",
  "question": "为什么在一般环上不成立？",
  "answer": "因为可能有零因子……",
  "source": "manual",
  "model": null,
  "createdAt": "2026-09-21T22:00:00"
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 必填唯一。约定 `q-YYYYMMDD-序号`，如 `q-20260921-003`。 |
| `targetType` | enum | `node` 或 `edge`——这条问答挂在节点上还是边上。 |
| `targetId` | string | 必须指向存在的节点/边 id。删除节点或边时要级联删除其问答。 |
| `question` | string | 必填非空。 |
| `answer` | string | 回答，Markdown + LaTeX，前端用 marked 渲染。 |
| `source` | enum | `ai`（来自"问 AI"按钮）或 `manual`（手动粘贴存档）。 |
| `model` | string \| null | AI 回答时记录模型名，手动存档为 `null`。 |
| `createdAt` | string | ISO 时间，列表按它倒序显示。 |
