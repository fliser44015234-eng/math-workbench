# AGENTS.md · AI 编码代理操作指南

这份文件写给 AI 代理（如 Kimi Code）：当用户让你"把某个数学内容加入工作台"时，按下面的标准流程操作。

## 项目速览

- 这是一个纯数据驱动的数学知识网络：`data/graph.json` 是唯一事实来源，前端渲染它，`server.py` 负责保存与 AI 问答。
- 没有数据库、没有构建步骤。你要改内容，**只改 `data/graph.json`** 这一个文件。

## 标准流程：添加数学内容

1. **先读 `SCHEMA.md`**，确认字段含义、枚举值和方向约定（尤其是 `depends_on` 的方向：A → B 表示"A 支撑 B"）。
2. **编辑 `data/graph.json`**：
   - 保持 pretty-printed 格式（2 空格缩进、UTF-8 中文不转义），与现有内容风格一致。
   - 节点 `id` 用英文 kebab-case（如 `repeated-root-criterion`），全库唯一；边 id 用 `e-` 前缀短横线风格；问答 id 用 `q-YYYYMMDD-序号`。
   - `statement` / `proof` 用 LaTeX：行内 `$...$`，行间 `$$...$$`。JSON 字符串里反斜杠要双写（`\\in`、`\\alpha`）。
   - 新节点的 `position` 填 `null`，前端会自动布局。
   - 内容以用户的课程笔记/教材为准，不要凭印象编造命题表述。
3. **运行校验**（必须）：
   ```bash
   ./.venv/bin/python validate.py data/graph.json
   ```
   输出 `OK` 才算完成；有错逐条修，不要跳过。
4. **汇报**：告诉用户新增了哪些节点（id + 中文名 + 类型）、哪些边（起点 → 终点 + 关系类型）、有没有问答，以及你对拿不准的关系做了什么取舍。

## 硬规则

- **绝不提交 `config.local.json`**（含 API Key）。它被 `.gitignore` 忽略，不要 `git add -f`，也不要把 Key 写进任何会被提交的文件。
- **不确定的关系类型宁可不加边**。五种关系有严格方向语义（见 SCHEMA.md），乱标比缺边更糟。确实需要表达但语义模糊时，可以把说明写进节点 `proof` 或加一条问答。
- 删除节点/边时**级联删除**指向它们的问答，保持数据整洁。
- 改完数据结构（枚举、字段）时，同步更新三处：`validate.py`、`SCHEMA.md`、前端 `static/app.js` 顶部的常量区。
- 不要往 `static/vendor/` 里改文件（那是第三方库）；不要引入需要构建步骤的前端框架。

## 常用命令

```bash
./.venv/bin/python validate.py data/graph.json   # 校验数据
./.venv/bin/python server.py                     # 本地起服务（127.0.0.1:8421）
```
