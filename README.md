# 数学知识网络工作台

一个"神经网络式"的数学知识构建器：每个节点是一个引理/定理/推论……节点之间用不同颜色与线型的有向边表示逻辑关系（依据、推论、等价、推广、类比）；点击节点查看命题与证明（LaTeX 渲染）；任何节点或边上都能挂载学习时的问答记录（AI 回答或手动粘贴）。

**架构核心：数据即文件。** 全部内容就是一个 pretty-printed JSON（`data/graph.json`），前端是纯静态页面，本地只用一个极小的 Flask 服务器提供"保存"和"AI 问答"两个 API。同一份文件以后可以直接扔到 GitHub Pages 上变成公开只读网站。

<!-- 截图占位：![总图](docs/screenshot-overview.png) -->
<!-- 截图占位：![详情与问答](docs/screenshot-detail.png) -->

## 三层视图

1. **总图**：Cytoscape 画布，默认是**分层高楼视图（俯视共面）**——所有层共享同一个 2D 平面，像从塔顶垂直往下看，各层投影叠在一起；分层感只靠透明度纵深表达。每个节点按"依赖深度"占一层（L1 = 地基：高中/基本常识；由下层一步推出的在上层；等价命题同层；层由 `scripts/compute_layers.py` 自动计算，可人工调整）。画布左侧是楼层 rail：竖排层号按钮（L1 在底部，带各层节点数），点击切换**焦点层** N——高于 N 的层完全隐藏，第 N 层全彩，下层按深度差逐渐变暗压灰，看得见地基和塔尖。节点在平面内自由拖动（位置自动保存），跨层移动走节点侧栏的"移动到别的层"按钮；工具栏"铺开本层"把焦点层在当前可视区域内重排成宽松网格。工具栏"视图：分层 / 自由"可切回原来的力导向总图（自由视图下"力导向重排"按钮出现）。节点颜色区分类型（定理金、引理蓝、推论绿、定义灰、命题青、断言紫、公理深灰、技巧红、例棕），边样式区分逻辑关系：
   - 依据 `depends_on`：蓝色实线 ▶（A 支撑 B 的证明）
   - 推论 `implies`：绿色实线 ▷（A 直接推出 B）
   - 等价 `equivalent`：紫色虚线 ◀▶（双向）
   - 推广 `generalizes`：橙色点线 ◆（A 是 B 的一般情形）
   - 类比 `analogy`：灰色虚线（无箭头，跨领域对应）
   支持搜索（按名称居中定位）、标签过滤、自由拖拽（自动保存位置）。
2. **详情 + 辐射视图**：点击节点/边，右侧栏显示命题、证明（可折叠）、关系列表（可跳转邻居）、问答区。"辐射视图"以当前节点为中心按 BFS 跳数（1/2 跳）做同心圆布局，只看局部逻辑网。
3. **问答层**：侧栏底部。每个节点和边都有自己的问答列表；"问 AI"会把该对象的完整上下文（命题、证明、邻居、历史问答）发给 Kimi 模型，"手动存档"用来粘贴任何来源的答案。

## 快速开始

```bash
cd math-workbench
python3 -m venv .venv
./.venv/bin/pip install -r requirements.txt
```

之后**双击 `run.command`** 即可（自动起服务并打开浏览器）；或手动：

```bash
./.venv/bin/python server.py    # 然后访问 http://localhost:8421
```

## 如何添加内容

- **笔记导入**（成批录入）：工具栏"导入笔记"——上传 .md/.txt 或直接粘贴，AI（kimi-k3）通读全图清单后提取知识点与强相关边，你在确认页勾选后一键并入；新节点不写层号，服务端保存时自动补层。与现有节点同名的条目会被识别为已存在并跳过。
- **网页编辑**（推荐日常用）：顶部"添加节点"；节点侧栏里"编辑 / 删除 / 添加边"；边侧栏可改标签与备注。所有变更立即写回 `data/graph.json`（旧文件自动备份为 `graph.json.bak`）。添加节点时可点"**AI 建议层与关系**"：kimi-k3 会阅读全图摘要，建议新节点的层号和最多 6 条强相关边（逐条勾选后再随节点一次保存）。
- **让 Kimi Code 帮忙写**：直接说"把 XX 定理加入工作台"。代理会按 `AGENTS.md` 的流程改 `data/graph.json` 并跑校验。数据格式的精确规范见 `SCHEMA.md`。
- 命令行校验数据：`./.venv/bin/python validate.py data/graph.json`。

## 配置 AI 问答（可选）

复制配置模板并填入 Moonshot API Key：

```bash
cp config.example.json config.local.json   # 然后编辑填入 sk-...
```

也可以用环境变量 `MOONSHOT_API_KEY`。未配置时"问 AI"会提示改用手动存档，其余功能不受影响。`config.local.json` 已被 `.gitignore` 忽略，且服务器不提供对它的 HTTP 访问，不会泄露。

## 多图支持与空白模板

一个部署可以挂多份图数据：URL 加 `?graph=名字` 即读写 `data/名字.json`（默认 `graph`）。

- **开新图**：`cp data/graph.template.json data/新名.json`，然后访问 `http://localhost:8421/?graph=新名`（名字限小写字母/数字/点/连字符，≤40 字符；API 只允许读写 data/ 下已存在的文件，不能用它创建）。
- **空白模板**：工具栏"空白模板"链接新标签页打开 `?graph=graph.template`；线上地址同理——`https://<用户名>.github.io/<仓库名>/?graph=graph.template` 就是一个公开只读的空白演示页。

## 部署到 GitHub Pages（公开只读）

1. 把本目录推到 GitHub 仓库（确认 `config.local.json` 不在其中）。
2. 仓库 Settings → Pages → Source 选 `main` 分支根目录。
3. 稍等片刻访问 `https://<用户名>.github.io/<仓库名>/`。

静态托管没有 `/api/graph`，前端会自动降级为**只读展示模式**：直接 fetch `data/graph.json`，隐藏所有编辑按钮，顶部显示"只读展示"徽标。更新内容 = 改 `data/graph.json` 并 push。

## 别人如何从零开始

把 `data/graph.json` 换成 `data/graph.template.json` 的副本即可——模板含 3 个演示节点和 5 条边（每种关系各一条），照着 `SCHEMA.md` 替换成自己的内容：

```bash
cp data/graph.template.json data/graph.json
```

## 目录结构

```
index.html            单页应用入口
static/               style.css · app.js · vendor/（cytoscape、MathJax、marked）
data/graph.json       全部知识网络数据（唯一事实来源）
server.py             本地 Flask 服务（静态 + 保存 + AI 问答，127.0.0.1:8421）
validate.py           数据校验器（CLI 与服务器共用）
scripts/compute_layers.py   自动分层（按支撑关系最长路计算 layer）
run.command           双击启动
SCHEMA.md             数据格式规范 · AGENTS.md 给 AI 代理的指南
```
