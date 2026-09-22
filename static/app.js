/* =========================================================================
 * 数学知识网络 · 前端逻辑（vanilla JS，无构建步骤）
 * 三层视图：总图（Cytoscape） → 详情侧栏（MathJax 渲染） → 问答层（AI/手动）
 * 数据即文件：内存中维护一份 graph 对象，任何变更整体 PUT 回 /api/graph。
 * ========================================================================= */

/* ---------- 枚举与常量（与 validate.py 保持一致） ---------- */

const KIND_ZH = {
  definition: '定义', axiom: '公理', lemma: '引理', proposition: '命题',
  theorem: '定理', corollary: '推论', claim: '断言', technique: '技巧', example: '例',
};
const KIND_COLOR = {
  theorem: '#d69e2e', lemma: '#3182ce', corollary: '#38a169',
  definition: '#718096', proposition: '#319795', claim: '#805ad5',
  axiom: '#2d3748', technique: '#c53030', example: '#b7791f',
};
const REL_ZH = {
  depends_on: '依据', implies: '推论', equivalent: '等价',
  generalizes: '推广', analogy: '类比',
};
const REL_HINT = {
  depends_on: '依据（A 支撑 B 的证明）',
  implies: '推论（A 直接推出 B）',
  equivalent: '等价（A ⟺ B，双向）',
  generalizes: '推广（A 是 B 的一般情形）',
  analogy: '类比（A 与 B 结构相似）',
};
const REL_COLOR = {
  depends_on: '#2b6cb0', implies: '#2f855a', equivalent: '#805ad5',
  generalizes: '#dd6b20', analogy: '#a0aec0',
};

/* ---------- 全局状态 ---------- */

let graph = null;        // 内存中的图数据（唯一事实来源）
let cy = null;           // Cytoscape 实例
let readOnly = false;    // 只读展示模式（无本地服务器时）
let state = { selected: null, radial: null };  // radial: {centerId, depth}
let viewMode = 'layered';  // 'layered' 分层高楼（默认）| 'free' 自由力导向
let focusLayer = 1;      // 当前焦点层（初始化时设为最高层）
let saveTimer = null;
let toastTimer = null;

/* ---------- 小工具 ---------- */

const $ = sel => document.querySelector(sel);

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function debounce(fn, ms) {
  let t = null;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
}

function nowIso() {
  return new Date().toISOString().slice(0, 19);
}

function typeset(el) {
  if (window.MathJax && MathJax.typesetPromise) {
    MathJax.typesetPromise(el ? [el] : undefined).catch(() => {});
  }
}

function findNode(id) { return graph.nodes.find(n => n.id === id) || null; }
function findEdge(id) { return graph.edges.find(e => e.id === id) || null; }

function slugifyNodeId(name) {
  let base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!base) base = 'node';
  let id = base, i = 2;
  while (findNode(id)) id = `${base}-${i++}`;
  return id;
}

function genEdgeId() {
  let i = graph.edges.length + 1, id = `e-${i}`;
  while (findEdge(id)) id = `e-${++i}`;
  return id;
}

function genQaId() {
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  let i = 1, id;
  do { id = `q-${ymd}-${String(i).padStart(3, '0')}`; i++; }
  while (graph.questions.some(q => q.id === id));
  return id;
}

/* ---------- 数据加载与保存 ---------- */

// 多图支持：?graph=名字 → data/{名字}.json / /api/graph?name={名字}
const GRAPH_NAME = (() => {
  const p = new URLSearchParams(location.search).get('graph') || 'graph';
  return (/^[a-z0-9][a-z0-9.-]{0,39}$/.test(p) && !p.includes('..')) ? p : 'graph';
})();
const GRAPH_API = `/api/graph?name=${encodeURIComponent(GRAPH_NAME)}`;

async function loadGraph() {
  try {
    const res = await fetch(GRAPH_API);
    if (!res.ok) throw new Error(String(res.status));
    return { data: await res.json(), readOnly: false };
  } catch {
    const res = await fetch(`data/${GRAPH_NAME}.json`);
    if (!res.ok) throw new Error(`无法加载 data/${GRAPH_NAME}.json`);
    return { data: await res.json(), readOnly: true };
  }
}

async function saveGraph() {
  if (readOnly) return true;
  try {
    const res = await fetch(GRAPH_API, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(graph),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      toast('保存失败：' + ((err.errors || []).join('；') || err.message || res.status));
      return false;
    }
    return true;
  } catch (e) {
    toast('保存失败：' + e.message);
    return false;
  }
}

/* ---------- Cytoscape ---------- */

const CY_STYLE = [
  {
    selector: 'node',
    style: {
      'background-color': 'data(color)',
      'label': 'data(name)',
      'color': '#2d3748',
      'font-size': 11,
      'text-wrap': 'wrap',
      'text-max-width': '90px',
      'text-valign': 'bottom',
      'text-margin-y': 6,
      'width': 13,
      'height': 13,
      'border-width': 0,
    },
  },
  { selector: 'node[kind="theorem"]', style: { 'width': 17, 'height': 17, 'font-size': 12 } },
  { selector: 'node:selected', style: { 'border-width': 3, 'border-color': '#1a202c' } },
  {
    selector: 'edge',
    style: {
      'width': 1.2,
      'curve-style': 'taxi',        // 直角布线（cytoscape 3.5+ 内置）
      'taxi-direction': 'auto',
      'taxi-turn': '20px',
      'taxi-radius': 6,             // 圆角转弯（3.30+）
      'line-cap': 'round',
      'line-opacity': 0.85,         // 线色整体调柔，五种 relation 以色相区分
      'arrow-scale': 0.8,
    },
  },
  { selector: 'edge:selected', style: { 'width': 2.2 } },
  {
    selector: 'edge[relation="depends_on"]',
    style: { 'line-color': '#2b6cb0', 'target-arrow-color': '#2b6cb0', 'target-arrow-shape': 'triangle' },
  },
  {
    selector: 'edge[relation="implies"]',
    style: { 'line-color': '#2f855a', 'target-arrow-color': '#2f855a', 'target-arrow-shape': 'vee' },
  },
  {
    selector: 'edge[relation="equivalent"]',
    style: {
      'line-color': '#805ad5', 'line-style': 'dashed',
      'source-arrow-color': '#805ad5', 'target-arrow-color': '#805ad5',
      'source-arrow-shape': 'triangle', 'target-arrow-shape': 'triangle',
    },
  },
  {
    selector: 'edge[relation="generalizes"]',
    style: { 'line-color': '#dd6b20', 'line-style': 'dotted', 'target-arrow-color': '#dd6b20', 'target-arrow-shape': 'diamond' },
  },
  {
    selector: 'edge[relation="analogy"]',
    style: { 'line-color': '#a0aec0', 'line-style': 'dashed' },
  },
  // 注意：元素的显示/隐藏、透明度、压暗一律由 refreshViewStyles() 逐元素内联设置，
  // 不再用 .hidden-el / .hidden-filter 的全局样式规则（内联样式优先，避免两处打架）。
  { selector: '.flash', style: { 'overlay-color': '#e53e3e', 'overlay-padding': 8, 'overlay-opacity': 0.3 } },
];

function toCyElements() {
  const nodes = graph.nodes.map(n => ({
    data: { id: n.id, name: n.name, kind: n.kind, color: KIND_COLOR[n.kind] || '#718096' },
    position: n.position ? { x: n.position.x, y: n.position.y } : undefined,
  }));
  const edges = graph.edges.map(e => ({
    data: { id: e.id, source: e.source, target: e.target, relation: e.relation, label: e.label || '', note: e.note || '' },
  }));
  return [...nodes, ...edges];
}

function presetLayout() {
  cy.layout({
    name: 'preset',
    positions: n => {
      const gn = findNode(n.id());
      return gn && gn.position ? { x: gn.position.x, y: gn.position.y } : n.position();
    },
    fit: true,
    padding: 40,
  }).run();
}

function runCose(animate) {
  return new Promise(resolve => {
    const layout = cy.layout({
      name: 'cose',
      animate,
      padding: 40,
      nodeRepulsion: 9000,
      idealEdgeLength: 130,
      gravity: 0.3,
      randomize: true,
    });
    layout.one('layoutstop', resolve);
    layout.run();
  });
}

/* ---------- 分层高楼视图（俯视共面模型） ----------
 * 所有层共享同一个 2D 平面（从塔顶垂直往下看，各层投影叠在一起）。
 * 节点位置 = 保存的 x,y，平面内自由拖动（无钳制）；
 * 分层感只通过透明度/饱和度表达（焦点层全彩、下层渐暗、上层隐藏）。
 */

const GRID_DX = 130;   // 铺开网格的最小水平间距（容纳下方中文标签）
const GRID_DY = 80;    // 铺开网格的最小垂直间距

function maxLayer() {
  return Math.max(1, ...graph.nodes.map(n => n.layer || 1));
}
function layerCounts() {
  const counts = {};
  graph.nodes.forEach(n => { const l = n.layer || 1; counts[l] = (counts[l] || 0) + 1; });
  return counts;
}

// 分层布局 = preset + 节点已存 position（未布局的放到当前视野中心附近）。
// meta.layoutVersion < 2 时先做一次性的全图 cose 迁移（zone 时代坐标作废）。
function layeredLayout(animate) {
  const lv = (graph.meta && graph.meta.layoutVersion) || 0;
  if (lv < 2) {
    runCose(true).then(() => {
      graph.meta.layoutVersion = 2;
      syncPositions();
      if (!readOnly) saveGraph();   // 只读（静态托管）跳过保存
      layeredLayout(false);         // 此时 lv 已是 2，走正常 preset 进场
      toast('分层平面布局已初始化');
    });
    return;
  }
  const ext = cy.extent();
  const cx = (ext.x1 + ext.x2) / 2, cyy = (ext.y1 + ext.y2) / 2;
  cy.layout({
    name: 'preset',
    positions: n => {
      const gn = findNode(n.id());
      if (!gn) return n.position();
      if (gn.position) return { x: gn.position.x, y: gn.position.y };
      return { x: Math.round(cx + (Math.random() * 160 - 80)), y: Math.round(cyy + (Math.random() * 160 - 80)) };
    },
    fit: false,
    animate: false,
  }).run();
  refreshViewStyles();
  fitVisible(animate);
}

function fitVisible(animate) {
  const vis = cy.nodes().filter(n => n.style('display') !== 'none');
  if (!vis.nonempty()) return;
  if (animate) cy.animate({ fit: { eles: vis, padding: 60 } }, { duration: 300 });
  else cy.fit(vis, 60);
}

// 按视图模式逐元素设置 显示/透明度/压暗/标签（显示状态的唯一写入处）
function refreshViewStyles() {
  if (!cy) return;
  const radial = state.radial;
  const centerL = radial ? ((findNode(radial.centerId) || {}).layer || 1) : null;
  cy.nodes().forEach(n => {
    const gn = findNode(n.id());
    if (!gn) return;
    const l = gn.layer || 1;
    let visible = !n.hasClass('hidden-el') && !n.hasClass('hidden-filter');
    let opacity = 1, blacken = 0, textOp = 1;
    if (radial) {
      // 辐射视图：平面同心圆 + 层次提示（标签带层号，低于中心层的调暗）
      n.style('label', `${gn.name} ·L${l}`);
      if (l < centerL) {
        const d = centerL - l;
        opacity = Math.max(0.35, 1 - 0.15 * d);
        blacken = Math.min(0.5, 0.12 * d);
      }
    } else {
      n.style('label', gn.name);
      if (viewMode === 'layered') {
        if (l > focusLayer) visible = false;                    // 高于焦点层：完全隐藏
        else if (l < focusLayer) {                              // 下层：按深度差渐暗
          const d = focusLayer - l;
          opacity = Math.max(0.25, 1 - 0.18 * d);
          blacken = Math.min(0.55, 0.13 * d);
          textOp = Math.max(0.3, 1 - 0.15 * d);
        }
      }
    }
    const style = { display: visible ? 'element' : 'none', opacity, 'background-blacken': blacken, 'text-opacity': textOp };
    // 焦点层标签加圆角底衬：按节点类型取极浅本色（与白色混合），压过下层淡影文字
    if (!radial && viewMode === 'layered' && l === focusLayer) {
      const hex = KIND_COLOR[gn.kind] || '#718096';
      const mix = i => Math.round(255 + (parseInt(hex.substr(i, 2), 16) - 255) * 0.14);
      style['text-background-color'] = `rgb(${mix(1)}, ${mix(3)}, ${mix(5)})`;
      style['text-background-opacity'] = 0.9;
      style['text-background-shape'] = 'roundrectangle';
      style['text-background-padding'] = '3px';
    } else {
      style['text-background-opacity'] = 0;
    }
    n.style(style);
  });
  cy.edges().forEach(e => {
    const visible = e.source().style('display') !== 'none' && e.target().style('display') !== 'none';
    let opacity = 1;
    if (visible && viewMode === 'layered' && !radial) {
      const ls = (findNode(e.source().id()) || {}).layer || 1;
      const lt = (findNode(e.target().id()) || {}).layer || 1;
      if (ls !== focusLayer && lt !== focusLayer) opacity = 0.1;  // 完全在下层之间的边仅隐约可见
    }
    e.style({ display: visible ? 'element' : 'none', opacity });
  });
}

/* ---------- 楼层 rail ---------- */

function renderRail() {
  const rail = $('#floor-rail');
  const maxL = maxLayer();
  const counts = {};
  graph.nodes.forEach(n => { const l = n.layer || 1; counts[l] = (counts[l] || 0) + 1; });
  let html = '';
  for (let l = maxL; l >= 1; l--) {   // 高楼在上，L1 地基在底部
    const active = viewMode === 'layered' && l === focusLayer ? ' active' : '';
    html += `<button class="floor-btn${active}" data-layer="${l}" title="第 ${l} 层">` +
      `<span class="floor-num">L${l}</span><span class="floor-count">${counts[l] || 0}</span></button>`;
  }
  rail.innerHTML = html;
  rail.querySelectorAll('.floor-btn').forEach(b => {
    b.onclick = () => setFocusLayer(parseInt(b.dataset.layer, 10));
  });
  rail.classList.toggle('hidden', viewMode !== 'layered' || !!state.radial);
}

function setFocusLayer(l) {
  focusLayer = l;
  renderRail();
  refreshViewStyles();
  fitVisible(true);
}

// 按当前模式布局并刷新样式（辐射模式下布局由辐射逻辑自己负责）
function applyLayout(animate) {
  if (state.radial) { refreshViewStyles(); return; }
  if (viewMode === 'layered') layeredLayout(animate);
  else { presetLayout(); refreshViewStyles(); }
}

function toggleViewMode() {
  viewMode = viewMode === 'layered' ? 'free' : 'layered';
  $('#btn-viewmode').textContent = viewMode === 'layered' ? '视图：分层' : '视图：自由';
  $('#btn-relayout').classList.toggle('hidden', viewMode !== 'free');  // 力导向重排只对自由视图有意义
  $('#btn-spread-layer').classList.toggle('hidden', viewMode !== 'layered');
  $('#btn-tidy-edges').classList.toggle('hidden', viewMode !== 'layered');
  renderRail();
  applyLayout(true);
}

// 理顺连线：对焦点层节点做 barycenter（重心）排序减少边交叉。
// 只动焦点层节点的 x（均布到原 x 区间），y 与其他层一律不动。
async function tidyEdges() {
  if (viewMode !== 'layered' || state.radial) return;
  const visEdges = cy.edges().filter(e => e.style('display') !== 'none');
  const adj = {};
  visEdges.forEach(e => {
    const s = e.source().id(), t = e.target().id();
    (adj[s] = adj[s] || []).push(t);
    (adj[t] = adj[t] || []).push(s);
  });
  const layerNodes = graph.nodes.filter(gn => (gn.layer || 1) === focusLayer && gn.position);
  if (layerNodes.length < 2) { toast('本层节点太少，无需理顺'); return; }
  for (let round = 0; round < 2; round++) {   // 第 2 轮用新位置重算均值
    const items = layerNodes
      .map(gn => {
        const xs = (adj[gn.id] || [])
          .map(nb => (findNode(nb) || {}).position)
          .filter(Boolean)
          .map(p => p.x);
        return xs.length ? { gn, mean: xs.reduce((a, b) => a + b, 0) / xs.length } : null;
      })
      .filter(Boolean);
    if (items.length < 2) break;
    items.sort((a, b) => a.mean - b.mean);
    const xs0 = items.map(it => it.gn.position.x);
    const minX = Math.min(...xs0), maxX = Math.max(...xs0);
    const step = items.length > 1 ? (maxX - minX) / (items.length - 1) : 0;
    items.forEach((it, i) => { it.gn.position = { x: Math.round(minX + i * step), y: it.gn.position.y }; });
  }
  layerNodes.forEach(gn => {
    const n = cy.getElementById(gn.id);
    if (n.nonempty()) n.animate({ position: { x: gn.position.x, y: gn.position.y } }, { duration: 350 });
  });
  if (!readOnly) await saveGraph();
  toast('已理顺本层连线');
}

// 铺开本层：把焦点层节点在当前可视画布区域内排成宽松网格（其他层不动）并保存
async function spreadCurrentLayer() {
  if (viewMode !== 'layered' || state.radial) return;
  const list = graph.nodes.filter(gn => (gn.layer || 1) === focusLayer)
    .sort((a, b) => a.id.localeCompare(b.id));
  if (!list.length) { toast(`L${focusLayer} 没有节点`); return; }
  const ext = cy.extent();   // 当前可视区域（模型坐标）
  const cx = (ext.x1 + ext.x2) / 2, cyy = (ext.y1 + ext.y2) / 2;
  const availW = Math.max(300, ext.x2 - ext.x1 - 160);
  const availH = Math.max(240, ext.y2 - ext.y1 - 160);
  // 列数按节点数与画布宽高比自适应
  const cols = Math.max(1, Math.min(list.length, Math.round(Math.sqrt(list.length * (availW / availH)))));
  const rows = Math.ceil(list.length / cols);
  const dx = cols > 1 ? Math.max(GRID_DX, availW / (cols - 1)) : 0;
  const dy = rows > 1 ? Math.max(GRID_DY, availH / (rows - 1)) : 0;
  list.forEach((gn, i) => {
    const r = Math.floor(i / cols), c = i % cols;
    const colsThisRow = Math.min(cols, list.length - r * cols);
    gn.position = {
      x: Math.round(cx - ((colsThisRow - 1) * dx) / 2 + c * dx),
      y: Math.round(cyy - ((rows - 1) * dy) / 2 + r * dy),
    };
  });
  layeredLayout(false);
  if (!readOnly) await saveGraph();
  toast(`第 L${focusLayer} 层已在可视区域铺开`);
}

function syncPositions() {
  cy.nodes().forEach(n => {
    const gn = findNode(n.id());
    if (gn) {
      const p = n.position();
      gn.position = { x: Math.round(p.x), y: Math.round(p.y) };
    }
  });
}

function debounceSavePositions() {
  if (state.radial || readOnly) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => { syncPositions(); await saveGraph(); }, 1000);
}

function layoutInitial() {
  if (viewMode === 'layered') { layeredLayout(false); return; }
  if (graph.nodes.some(n => !n.position)) {
    runCose(false).then(() => { syncPositions(); saveGraph(); cy.fit(undefined, 40); refreshViewStyles(); });
  } else {
    presetLayout();
    refreshViewStyles();
  }
}

function rebuildGraph() {
  cy.elements().remove();
  cy.add(toCyElements());
  initTagFilter();
  renderRail();
  layoutInitial();
}

function bindCyEvents() {
  cy.on('tap', 'node', evt => { evt.target.select(); showNodeDetail(evt.target.id()); });
  cy.on('tap', 'edge', evt => { evt.target.select(); showEdgeDetail(evt.target.id()); });
  cy.on('dragend', 'node', debounceSavePositions);
}

/* ---------- 图例 ---------- */

function legendEdgeSvg(rel) {
  const c = REL_COLOR[rel];
  const dash = rel === 'equivalent' || rel === 'analogy' ? ' stroke-dasharray="4,3"' : (rel === 'generalizes' ? ' stroke-dasharray="2,3"' : '');
  const target = rel === 'analogy' ? ''
    : rel === 'generalizes' ? `<polygon points="24,5 29,2 34,5 29,8" fill="${c}"/>`
    : rel === 'implies' ? `<polygon points="26,1 34,5 26,9" fill="none" stroke="${c}" stroke-width="1.6"/>`
    : `<polygon points="26,1 34,5 26,9" fill="${c}"/>`;
  const source = rel === 'equivalent' ? `<polygon points="8,1 0,5 8,9" fill="${c}"/>` : '';
  return `<svg width="34" height="10"><line x1="0" y1="5" x2="27" y2="5" stroke="${c}" stroke-width="2"${dash}/>${source}${target}</svg>`;
}

function initLegend() {
  $('#legend-nodes').innerHTML = Object.keys(KIND_ZH).map(k =>
    `<span class="legend-item"><span class="legend-dot" style="background:${KIND_COLOR[k]}"></span>${KIND_ZH[k]}</span>`
  ).join('');
  $('#legend-edges').innerHTML = Object.keys(REL_ZH).map(r =>
    `<div class="legend-line">${legendEdgeSvg(r)}<span>${REL_ZH[r]}</span></div>`
  ).join('');
}

/* ---------- 侧栏：节点详情 ---------- */

function showSidebar() { $('#sidebar').classList.remove('hidden'); }
function hideSidebar() {
  $('#sidebar').classList.add('hidden');
  state.selected = null;
  if (cy) cy.elements().unselect();
}

function relListHTML(nodeId) {
  const render = (list, isOut) => list.map(e => {
    const nbId = isOut ? e.target : e.source;
    const nb = findNode(nbId);
    if (!nb) return '';
    const arrow = isOut ? '→' : '←';
    return `<div class="rel-item" data-node="${escapeHtml(nbId)}">
      <span class="rel-tag" style="background:${REL_COLOR[e.relation]}">${REL_ZH[e.relation]}</span>${arrow} ${escapeHtml(nb.name)}
    </div>`;
  }).join('');
  const out = graph.edges.filter(e => e.source === nodeId);
  const inc = graph.edges.filter(e => e.target === nodeId);
  let html = '';
  if (out.length) html += `<div class="rel-group"><div class="rel-direction">出边（本节点指向）</div>${render(out, true)}</div>`;
  if (inc.length) html += `<div class="rel-group"><div class="rel-direction">入边（指向本节点）</div>${render(inc, false)}</div>`;
  return html || '<div class="detail-meta">暂无关联</div>';
}

function showNodeDetail(id) {
  const n = findNode(id);
  if (!n) return;
  state.selected = { type: 'node', id };
  const tags = (n.tags || []).map(t => `<span class="tag">${escapeHtml(t)}</span>`).join('');
  const color = KIND_COLOR[n.kind] || '#718096';
  $('#sidebar-body').innerHTML = `
    <span class="kind-badge" style="background:${color}">${KIND_ZH[n.kind] || n.kind}</span>
    <div class="detail-name">${escapeHtml(n.name)}</div>
    <div class="detail-meta">层：L${n.layer || 1} · ${n.chapter ? '章节：' + escapeHtml(n.chapter) + ' · ' : ''}${tags}<span class="detail-meta">id: ${escapeHtml(n.id)}</span></div>
    <div class="section-title">命题</div>
    <div class="math-block">${escapeHtml(n.statement || '')}</div>
    <button class="proof-toggle" id="proof-toggle">显示证明</button>
    <div class="math-block proof-body hidden" id="proof-body">${escapeHtml(n.proof || '（暂无证明）')}</div>
    <div class="section-title">关系</div>
    ${relListHTML(id)}
    <div class="action-row edit-only">
      <button id="act-edit">编辑</button>
      <button id="act-add-edge">添加边</button>
      <button id="act-move-layer">移动到别的层</button>
      <button id="act-delete" class="danger">删除</button>
    </div>
    ${qaSectionHTML('node', id)}
  `;

  $('#proof-toggle').onclick = () => {
    const body = $('#proof-body');
    const open = body.classList.toggle('hidden');
    $('#proof-toggle').textContent = open ? '显示证明' : '收起证明';
    if (!open) typeset(body);
  };
  $('#sidebar-body').querySelectorAll('.rel-item').forEach(el => {
    el.onclick = () => jumpToNode(el.dataset.node);
  });
  if (!readOnly) {
    $('#act-edit').onclick = () => openNodeModal(n);
    $('#act-add-edge').onclick = () => openEdgeModal(n.id);
    $('#act-move-layer').onclick = () => openMoveLayerModal(n);
    $('#act-delete').onclick = () => deleteNode(n.id);
  }
  bindQaSection('node', id);

  $('#btn-radial').classList.remove('hidden');
  $('#btn-overview').classList.toggle('hidden', !state.radial);
  $('#radial-depth').classList.toggle('hidden', !state.radial);
  showSidebar();
  typeset($('#sidebar-body'));
}

function jumpToNode(id) {
  const n = cy.getElementById(id);
  if (n && n.nonempty()) {
    const gn = findNode(id);
    // 分层模式下跳转更高层邻居：自动把焦点层抬上去，让目标可见
    if (gn && viewMode === 'layered' && !state.radial && (gn.layer || 1) > focusLayer) {
      setFocusLayer(gn.layer || 1);
    }
    if (n.style('display') !== 'none') {
      n.select();
      cy.animate({ center: { eles: n } }, { duration: 250 });
    } else {
      toast('该节点当前被标签过滤或处于辐射视图外');
    }
  }
  showNodeDetail(id);
}

/* ---------- 侧栏：边详情 ---------- */

function showEdgeDetail(id) {
  const e = findEdge(id);
  if (!e) return;
  state.selected = { type: 'edge', id };
  const s = findNode(e.source), t = findNode(e.target);
  const color = REL_COLOR[e.relation] || '#718096';
  $('#sidebar-body').innerHTML = `
    <span class="kind-badge" style="background:${color}">${REL_ZH[e.relation] || e.relation}</span>
    <div class="detail-name">逻辑关系</div>
    <div class="edge-endpoint">
      <a data-node="${escapeHtml(e.source)}">${escapeHtml(s ? s.name : e.source)}</a>
      <span class="edge-arrow">—${escapeHtml(e.label || REL_ZH[e.relation])}→</span>
      <a data-node="${escapeHtml(e.target)}">${escapeHtml(t ? t.name : e.target)}</a>
    </div>
    <div class="detail-meta">关系含义：${escapeHtml(REL_HINT[e.relation] || '')} · id: ${escapeHtml(e.id)}</div>
    ${e.note ? `<div class="section-title">备注</div><div class="math-block">${escapeHtml(e.note)}</div>` : ''}
    <div class="action-row edit-only">
      <button id="act-edit-edge">编辑标签/备注</button>
      <button id="act-delete-edge" class="danger">删除边</button>
    </div>
    ${qaSectionHTML('edge', id)}
  `;
  $('#sidebar-body').querySelectorAll('.edge-endpoint a').forEach(el => {
    el.onclick = () => jumpToNode(el.dataset.node);
  });
  if (!readOnly) {
    $('#act-edit-edge').onclick = () => openEdgeEditModal(e);
    $('#act-delete-edge').onclick = () => deleteEdge(e.id);
  }
  bindQaSection('edge', id);

  $('#btn-radial').classList.add('hidden');
  $('#btn-overview').classList.toggle('hidden', !state.radial);
  $('#radial-depth').classList.toggle('hidden', !state.radial);
  showSidebar();
  typeset($('#sidebar-body'));
}

/* ---------- 问答层 ---------- */

function qaFor(targetType, targetId) {
  return graph.questions
    .filter(q => q.targetType === targetType && q.targetId === targetId)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

function qaSectionHTML(targetType, targetId) {
  const list = qaFor(targetType, targetId);
  const items = list.map(q => `
    <div class="qa-item">
      <div class="qa-q">Q：${escapeHtml(q.question)}</div>
      <div class="qa-a">${marked.parse(q.answer || '（暂无回答）')}</div>
      <div class="qa-meta">
        <span class="qa-src ${q.source === 'ai' ? 'qa-src-ai' : 'qa-src-manual'}">${q.source === 'ai' ? 'AI' : '手动'}</span>${escapeHtml(q.createdAt || '')}
      </div>
    </div>`).join('');
  return `
    <div class="section-title">问答（${list.length}）</div>
    <div class="qa-list">${items || '<div class="detail-meta">暂无问答，学到这里有疑问就记下来。</div>'}</div>
    <div class="qa-input edit-only">
      <textarea id="qa-q" placeholder="围绕这个${targetType === 'node' ? '节点' : '关系'}提问…"></textarea>
      <div class="qa-btns">
        <button class="primary" id="qa-ai">问 AI</button>
        <button id="qa-manual">手动存档</button>
      </div>
      <div class="qa-hint hidden" id="qa-hint"></div>
      <div id="qa-manual-area" class="hidden" style="margin-top:8px">
        <textarea id="qa-a" placeholder="把答案粘贴到这里（支持 Markdown 与 LaTeX）…"></textarea>
        <div class="qa-btns"><button class="primary" id="qa-save-manual">保存问答</button></div>
      </div>
    </div>`;
}

function bindQaSection(targetType, targetId) {
  if (readOnly) return;
  const qInput = $('#qa-q');
  const hint = $('#qa-hint');
  const showHint = msg => { hint.textContent = msg; hint.classList.remove('hidden'); };

  $('#qa-manual').onclick = () => {
    if (!qInput.value.trim()) { showHint('先在上方输入问题。'); return; }
    hint.classList.add('hidden');
    $('#qa-manual-area').classList.toggle('hidden');
  };

  $('#qa-save-manual').onclick = async () => {
    const question = qInput.value.trim();
    const answer = $('#qa-a').value.trim();
    if (!question || !answer) { showHint('问题和答案都要填写。'); return; }
    addQA(targetType, targetId, question, answer, 'manual', null);
  };

  $('#qa-ai').onclick = async () => {
    const question = qInput.value.trim();
    if (!question) { showHint('先输入问题。'); return; }
    const btn = $('#qa-ai');
    btn.disabled = true;
    btn.textContent = '思考中…';
    hint.classList.add('hidden');
    try {
      const res = await fetch('/api/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetType, targetId, question }),
      });
      if (res.status === 501) {
        showHint('未配置 API Key，可改用手动存档。');
        $('#qa-manual-area').classList.remove('hidden');
      } else if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        showHint('AI 请求失败：' + (err.message || res.status));
      } else {
        const data = await res.json();
        addQA(targetType, targetId, question, data.answer, 'ai', data.model || null);
      }
    } catch (e) {
      showHint('AI 请求失败：' + e.message);
    } finally {
      btn.disabled = false;
      btn.textContent = '问 AI';
    }
  };
}

async function addQA(targetType, targetId, question, answer, source, model) {
  graph.questions.push({
    id: genQaId(), targetType, targetId, question, answer,
    source, model, createdAt: nowIso(),
  });
  if (await saveGraph()) {
    toast('问答已保存');
    if (state.selected) {
      state.selected.type === 'node' ? showNodeDetail(state.selected.id) : showEdgeDetail(state.selected.id);
    }
  }
}

/* ---------- 辐射视图（第二层） ---------- */

function bfsLevels(centerId, maxDepth) {
  const level = { [centerId]: 0 };
  let frontier = [centerId];
  for (let d = 1; d <= maxDepth; d++) {
    const next = [];
    frontier.forEach(fid => {
      cy.getElementById(fid).connectedEdges().forEach(e => {
        const other = e.source().id() === fid ? e.target().id() : e.source().id();
        if (level[other] === undefined) { level[other] = d; next.push(other); }
      });
    });
    frontier = next;
  }
  return level;
}

function enterRadial() {
  if (!state.selected || state.selected.type !== 'node') return;
  const centerId = state.selected.id;
  const depth = parseInt($('#radial-depth').value, 10) || 1;
  state.radial = { centerId, depth };
  const level = bfsLevels(centerId, depth);

  cy.elements().addClass('hidden-el');
  cy.nodes().forEach(n => { if (level[n.id()] !== undefined) n.removeClass('hidden-el'); });
  cy.edges().forEach(e => {
    if (level[e.source().id()] !== undefined && level[e.target().id()] !== undefined) e.removeClass('hidden-el');
  });

  const visible = cy.elements().filter(el => !el.hasClass('hidden-el'));
  visible.layout({
    name: 'concentric',
    concentric: n => -(level[n.id()] ?? 99),
    levelWidth: () => 1,
    minNodeSpacing: 45,
    padding: 40,
    animate: true,
  }).run();
  refreshViewStyles();   // 标签加 ·L{n} 后缀、低于中心层的调暗
  renderRail();          // 辐射模式下隐藏楼层 rail

  $('#btn-radial').classList.add('hidden');
  $('#btn-overview').classList.remove('hidden');
  $('#radial-depth').classList.remove('hidden');
}

function exitRadial() {
  state.radial = null;
  cy.elements().removeClass('hidden-el');
  applyLayout(false);    // 恢复分层/自由总图布局与样式
  renderRail();
  $('#btn-overview').classList.add('hidden');
  $('#radial-depth').classList.add('hidden');
  if (state.selected && state.selected.type === 'node') $('#btn-radial').classList.remove('hidden');
}

/* ---------- 模态框：节点表单 / 边表单 ---------- */

function openModal(html) {
  $('#modal').innerHTML = html;
  $('#modal-overlay').classList.remove('hidden');
}
function closeModal() { $('#modal-overlay').classList.add('hidden'); }

const KIND_OPTIONS = selected => Object.keys(KIND_ZH).map(k =>
  `<option value="${k}" ${k === selected ? 'selected' : ''}>${KIND_ZH[k]}（${k}）</option>`).join('');

// AI 建议层与强相关边（添加节点模态内；失败不阻塞手动创建）
async function suggestLayerAndEdges(btn) {
  const errBox = $('#f-ai-error');
  const showErr = msg => { errBox.textContent = msg; errBox.classList.remove('hidden'); };
  errBox.classList.add('hidden');
  const name = $('#f-name').value.trim();
  const statement = $('#f-statement').value.trim();
  if (!name || !statement) { showErr('先填写名称和命题，再让 AI 建议。'); return; }
  btn.disabled = true;
  btn.textContent = 'AI 思考中（kimi-k3 推理约 1–3 分钟）…';
  try {
    const res = await fetch('/api/suggest-node', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name, statement,
        kind: $('#f-kind').value,
        proof: $('#f-proof').value.trim(),
      }),
    });
    if (res.status === 501) {
      showErr('未配置 API Key，无法使用 AI 建议（可手动填写）。');
    } else if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      showErr(`AI 建议失败：${err.message || res.status}（不影响手动创建）`);
    } else {
      const data = await res.json();
      if (data.layer) $('#f-layer').value = data.layer;
      const result = $('#f-ai-result');
      if (!data.edges || !data.edges.length) {
        result.innerHTML = `<div class="form-hint">AI 没有把握给出强相关边${data.layer ? `，层已建议为 L${data.layer}` : ''}。</div>`;
      } else {
        result.innerHTML = '<div class="form-hint">AI 建议的边（取消勾选则不创建）：</div>' +
          data.edges.map(e => {
            const t = findNode(e.target);
            const tname = t ? t.name : e.target;
            const arrow = e.direction === 'out'
              ? `新节点 ─${REL_ZH[e.relation]}→ ${escapeHtml(tname)}`
              : `${escapeHtml(tname)} ─${REL_ZH[e.relation]}→ 新节点`;
            return `<label class="ai-edge-item">
              <input type="checkbox" checked data-target="${escapeHtml(e.target)}" data-direction="${e.direction}" data-relation="${e.relation}" data-reason="${escapeHtml(e.reason || '')}">
              <span>${arrow}</span><span class="ai-edge-reason">${escapeHtml(e.reason || '')}</span>
            </label>`;
          }).join('');
      }
    }
  } catch (e) {
    showErr(`AI 建议失败：${e.message}（不影响手动创建）`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'AI 建议层与关系';
  }
}

function openNodeModal(existing) {
  const isEdit = !!existing;
  const n = existing || { name: '', kind: 'theorem', statement: '', proof: '', tags: [], chapter: '' };
  openModal(`
    <h3>${isEdit ? '编辑节点' : '添加节点'}</h3>
    <div class="form-row"><label>名称 *</label><input id="f-name" value="${escapeHtml(n.name)}"></div>
    <div class="form-row"><label>类型</label><select id="f-kind">${KIND_OPTIONS(n.kind)}</select></div>
    <div class="form-row"><label>层（整数 ≥1，1=地基；当前焦点层 L${focusLayer}）</label><input id="f-layer" type="number" min="1" step="1" value="${isEdit ? (n.layer || 1) : focusLayer}"></div>
    ${isEdit ? '' : `
    <div class="form-row">
      <button type="button" id="f-ai-suggest">AI 建议层与关系</button>
      <span class="form-hint">填好名称与命题后可用，AI 建议层号和强相关边（可勾选）。</span>
      <div class="form-error hidden" id="f-ai-error"></div>
      <div id="f-ai-result"></div>
    </div>`}
    <div class="form-row"><label>命题（支持 LaTeX：$...$、$$...$$）</label><textarea id="f-statement">${escapeHtml(n.statement)}</textarea></div>
    <div class="form-row"><label>证明</label><textarea id="f-proof" style="min-height:100px">${escapeHtml(n.proof)}</textarea></div>
    <div class="form-row"><label>标签（逗号分隔）</label><input id="f-tags" value="${escapeHtml((n.tags || []).join(', '))}"></div>
    <div class="form-row"><label>章节</label><input id="f-chapter" value="${escapeHtml(n.chapter || '')}" placeholder="如 L03 / Week 2"></div>
    <div class="form-error hidden" id="f-error"></div>
    <div class="form-actions">
      <button id="f-cancel">取消</button>
      <button class="primary" id="f-ok">${isEdit ? '保存' : '创建'}</button>
    </div>
  `);
  $('#f-cancel').onclick = closeModal;
  const btnAI = $('#f-ai-suggest');
  if (btnAI) btnAI.onclick = () => suggestLayerAndEdges(btnAI);
  $('#f-ok').onclick = async () => {
    const name = $('#f-name').value.trim();
    if (!name) { $('#f-error').textContent = '名称不能为空'; $('#f-error').classList.remove('hidden'); return; }
    const fields = {
      name,
      kind: $('#f-kind').value,
      layer: Math.max(1, parseInt($('#f-layer').value, 10) || focusLayer),
      statement: $('#f-statement').value.trim(),
      proof: $('#f-proof').value.trim(),
      tags: $('#f-tags').value.split(/[,，]/).map(s => s.trim()).filter(Boolean),
      chapter: $('#f-chapter').value.trim(),
    };
    let createdId = null;
    if (isEdit) {
      Object.assign(existing, fields);
    } else {
      const ext = cy.extent();
      createdId = slugifyNodeId(name);
      graph.nodes.push({
        id: createdId,
        ...fields,
        position: {
          x: Math.round((ext.x1 + ext.x2) / 2 + (Math.random() * 80 - 40)),
          y: Math.round((ext.y1 + ext.y2) / 2 + (Math.random() * 80 - 40)),
        },
      });
      // 勾选的 AI 建议边随节点一并创建（一次 PUT）
      document.querySelectorAll('#f-ai-result input[type="checkbox"]:checked').forEach(cb => {
        const { target, direction, relation, reason } = cb.dataset;
        if (!findNode(target)) return;
        graph.edges.push({
          id: genEdgeId(),
          source: direction === 'out' ? createdId : target,
          target: direction === 'out' ? target : createdId,
          relation,
          label: '',
          note: reason ? `AI 建议：${reason}` : 'AI 建议',
        });
      });
    }
    if (await saveGraph()) {
      closeModal();
      rebuildGraph();
      toast(isEdit ? '节点已更新' : '节点已创建');
      if (fields.layer > focusLayer && viewMode === 'layered') {
        toast(`注意：L${fields.layer} 高于当前焦点层 L${focusLayer}，画布上暂时隐藏`);
      }
      const targetId = isEdit ? existing.id : createdId;
      showNodeDetail(targetId);
    }
  };
}

function openEdgeModal(sourceId) {
  const others = graph.nodes.filter(n => n.id !== sourceId);
  if (!others.length) { toast('至少需要两个节点才能加边'); return; }
  const relOptions = Object.keys(REL_ZH).map(r =>
    `<option value="${r}">${REL_HINT[r]}</option>`).join('');
  openModal(`
    <h3>添加边（从「${escapeHtml(findNode(sourceId).name)}」出发）</h3>
    <div class="form-row"><label>搜索目标节点</label><input id="f-search-target" placeholder="输入名称过滤…"></div>
    <div class="form-row"><label>目标节点 *</label><select id="f-target" size="6"></select></div>
    <div class="form-row"><label>关系类型</label><select id="f-relation">${relOptions}</select>
      <div class="form-hint">方向：当前节点 → 目标节点。等价与类比的箭头无方向含义。</div></div>
    <div class="form-row"><label>标签（显示在边上，可留空）</label><input id="f-label"></div>
    <div class="form-row"><label>备注（可留空）</label><textarea id="f-note" style="min-height:50px"></textarea></div>
    <div class="form-error hidden" id="f-error"></div>
    <div class="form-actions">
      <button id="f-cancel">取消</button>
      <button class="primary" id="f-ok">创建</button>
    </div>
  `);
  const renderOptions = filter => {
    const kw = (filter || '').toLowerCase();
    $('#f-target').innerHTML = others
      .filter(n => !kw || n.name.toLowerCase().includes(kw) || n.id.includes(kw))
      .map(n => `<option value="${escapeHtml(n.id)}">${escapeHtml(n.name)}（${KIND_ZH[n.kind]}）</option>`).join('')
      || '<option disabled>无匹配节点</option>';
  };
  renderOptions('');
  $('#f-search-target').oninput = () => renderOptions($('#f-search-target').value);
  $('#f-cancel').onclick = closeModal;
  $('#f-ok').onclick = async () => {
    const target = $('#f-target').value;
    if (!target || !findNode(target)) { $('#f-error').textContent = '请选择目标节点'; $('#f-error').classList.remove('hidden'); return; }
    graph.edges.push({
      id: genEdgeId(),
      source: sourceId,
      target,
      relation: $('#f-relation').value,
      label: $('#f-label').value.trim(),
      note: $('#f-note').value.trim(),
    });
    if (await saveGraph()) {
      closeModal();
      rebuildGraph();
      toast('边已创建');
      showNodeDetail(sourceId);
    }
  };
}

function openEdgeEditModal(e) {
  openModal(`
    <h3>编辑边</h3>
    <div class="form-row"><label>标签</label><input id="f-label" value="${escapeHtml(e.label || '')}"></div>
    <div class="form-row"><label>备注</label><textarea id="f-note" style="min-height:60px">${escapeHtml(e.note || '')}</textarea></div>
    <div class="form-actions">
      <button id="f-cancel">取消</button>
      <button class="primary" id="f-ok">保存</button>
    </div>
  `);
  $('#f-cancel').onclick = closeModal;
  $('#f-ok').onclick = async () => {
    e.label = $('#f-label').value.trim();
    e.note = $('#f-note').value.trim();
    if (await saveGraph()) {
      closeModal();
      rebuildGraph();
      toast('边已更新');
      showEdgeDetail(e.id);
    }
  };
}

// 移动到别的层：唯一的跨层移动方式（画布上节点被钳制在本层分带内）
function openMoveLayerModal(n) {
  const maxL = maxLayer();
  const cur = n.layer || 1;
  const opts = [];
  for (let i = 1; i <= maxL + 1; i++) {
    const mark = i === cur ? '（当前）' : (i === maxL + 1 ? '（新建顶层）' : '');
    opts.push(`<option value="${i}" ${i === cur ? 'selected' : ''}>L${i} ${mark}</option>`);
  }
  openModal(`
    <h3>移动「${escapeHtml(n.name)}」到别的层</h3>
    <div class="form-row"><label>目标层（当前焦点层：L${focusLayer}）</label>
      <select id="f-move-layer">${opts.join('')}</select>
      <div class="form-hint">层号由 scripts/compute_layers.py 自动计算；这里是人工调整，脚本不带 --force 时不会覆盖。</div>
    </div>
    <div class="form-actions">
      <button id="f-cancel">取消</button>
      <button class="primary" id="f-ok">移动</button>
    </div>
  `);
  $('#f-cancel').onclick = closeModal;
  $('#f-ok').onclick = async () => {
    const target = parseInt($('#f-move-layer').value, 10);
    if (!target || target < 1) return;
    n.layer = target;
    if (await saveGraph()) {
      closeModal();
      renderRail();
      applyLayout(true);
      showNodeDetail(n.id);
      if (target > focusLayer) toast(`已移动到 L${target}，高于当前焦点层 L${focusLayer}，画布上暂时隐藏`);
      else toast(`已移动到 L${target}`);
    }
  };
}

/* ---------- 笔记导入（AI 提取 + 确认合并） ---------- */

function importNodeName(id, newNodes) {
  const n = newNodes.find(x => x.id === id) || findNode(id);
  return n ? n.name : id;
}

function openImportModal() {
  openModal(`
    <h3>导入笔记</h3>
    <div class="form-row"><label>选择笔记文件（.md / .txt）</label><input type="file" id="imp-file" accept=".md,.txt,text/markdown,text/plain"></div>
    <div class="form-row"><label>或直接粘贴笔记内容 *</label><textarea id="imp-content" style="min-height:140px" placeholder="粘贴 Markdown / 纯文本笔记…"></textarea></div>
    <div class="form-row"><label>章节（可选，默认取文件名）</label><input id="imp-chapter" placeholder="如 L03 / Week 4"></div>
    <div class="form-error hidden" id="imp-error"></div>
    <div class="form-actions">
      <button id="f-cancel">取消</button>
      <button class="primary" id="imp-run">AI 提取</button>
    </div>
  `);
  $('#f-cancel').onclick = closeModal;
  $('#imp-file').onchange = async e => {
    const f = e.target.files[0];
    if (!f) return;
    $('#imp-content').value = await f.text();
    if (!$('#imp-chapter').value) $('#imp-chapter').value = f.name.replace(/\.[^.]+$/, '');
  };
  $('#imp-run').onclick = runImportExtract;
}

async function runImportExtract() {
  const errBox = $('#imp-error');
  const showErr = msg => { errBox.textContent = msg; errBox.classList.remove('hidden'); };
  errBox.classList.add('hidden');
  const content = $('#imp-content').value.trim();
  if (!content) { showErr('请先选择文件或粘贴笔记内容。'); return; }
  const btn = $('#imp-run');
  btn.disabled = true;
  btn.textContent = 'AI 提取中（约 15–60 秒）…';
  try {
    const res = await fetch('/api/import-notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, chapter_hint: $('#imp-chapter').value.trim() }),
    });
    if (res.status === 501) {
      showErr('未配置 API Key，无法使用 AI 提取。');
      return;
    }
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      showErr(`提取失败：${err.message || res.status}`);
      return;
    }
    renderImportConfirm(await res.json());
  } catch (e) {
    showErr(`提取失败：${e.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'AI 提取';
  }
}

function renderImportConfirm(data) {
  const { nodes, edges, skipped_existing: skipped } = data;
  const nodeHtml = nodes.map((n, i) => `
    <label class="import-item">
      <input type="checkbox" checked data-kind="node" data-idx="${i}">
      <span class="import-kind" style="background:${KIND_COLOR[n.kind] || '#718096'}">${KIND_ZH[n.kind] || n.kind}</span>
      <span>${escapeHtml(n.name)}</span>
      <span class="import-preview">${escapeHtml((n.statement || '').slice(0, 60))}</span>
    </label>`).join('');
  const edgeHtml = edges.map((e, i) => `
    <label class="import-item">
      <input type="checkbox" checked data-kind="edge" data-idx="${i}">
      <span class="import-kind" style="background:${REL_COLOR[e.relation] || '#718096'}">${REL_ZH[e.relation] || e.relation}</span>
      <span>${escapeHtml(importNodeName(e.source, nodes))} → ${escapeHtml(importNodeName(e.target, nodes))}</span>
    </label>`).join('');
  openModal(`
    <h3>确认导入（节点 ${nodes.length} / 边 ${edges.length}）</h3>
    ${skipped.length ? `<div class="import-skipped">与现有节点同名，已跳过：${skipped.map(escapeHtml).join('、')}</div>` : ''}
    <div class="form-row"><label>节点（取消勾选则不导入）</label><div class="import-list">${nodeHtml || '<div class="form-hint">无新增节点</div>'}</div></div>
    <div class="form-row"><label>边</label><div class="import-list">${edgeHtml || '<div class="form-hint">无新增边</div>'}</div></div>
    <div class="form-actions">
      <button id="f-cancel">取消</button>
      <button class="primary" id="imp-join">加入工作台</button>
    </div>
  `);
  $('#f-cancel').onclick = closeModal;
  $('#imp-join').onclick = () => joinImport(data);
}

async function joinImport(data) {
  const pickedNodes = [], pickedEdges = [];
  document.querySelectorAll('#modal input[type="checkbox"]').forEach(cb => {
    const pool = cb.dataset.kind === 'node' ? data.nodes : data.edges;
    const item = pool[+cb.dataset.idx];
    if (cb.checked && item) (cb.dataset.kind === 'node' ? pickedNodes : pickedEdges).push(item);
  });
  if (!pickedNodes.length && !pickedEdges.length) { toast('没有勾选任何内容'); return; }
  pickedNodes.forEach(n => {
    graph.nodes.push({
      id: n.id, name: n.name, kind: n.kind,
      statement: n.statement, proof: n.proof,
      tags: n.tags || [], chapter: n.chapter || '',
      position: null,   // 不写 layer：服务端保存时自动按依赖深度补全
    });
  });
  pickedEdges.forEach(e => {
    if (!findNode(e.source) || !findNode(e.target)) return;   // 端点未勾选则丢弃
    graph.edges.push({
      id: genEdgeId(), source: e.source, target: e.target,
      relation: e.relation, label: e.label || '', note: e.note || '',
    });
  });
  if (await saveGraph()) {
    closeModal();
    try {
      const fresh = await loadGraph();   // 重新 GET，拿到服务端补好的 layer
      graph = fresh.data;
    } catch { /* 保留内存状态 */ }
    rebuildGraph();
    toast(`导入 ${pickedNodes.length} 节点 ${pickedEdges.length} 边`);
  }
}

/* ---------- 删除 ---------- */

async function deleteNode(id) {
  const n = findNode(id);
  if (!confirm(`确定删除节点「${n.name}」？\n将级联删除与它相连的边和相关问答。`)) return;
  const removedEdgeIds = new Set(
    graph.edges.filter(e => e.source === id || e.target === id).map(e => e.id)
  );
  graph.nodes = graph.nodes.filter(x => x.id !== id);
  graph.edges = graph.edges.filter(e => !removedEdgeIds.has(e.id));
  graph.questions = graph.questions.filter(q =>
    !(q.targetType === 'node' && q.targetId === id) &&
    !(q.targetType === 'edge' && removedEdgeIds.has(q.targetId))
  );
  if (await saveGraph()) {
    hideSidebar();
    rebuildGraph();
    toast('节点已删除');
  }
}

async function deleteEdge(id) {
  if (!confirm('确定删除这条边？相关问答也会一并删除。')) return;
  graph.edges = graph.edges.filter(e => e.id !== id);
  graph.questions = graph.questions.filter(q => !(q.targetType === 'edge' && q.targetId === id));
  if (await saveGraph()) {
    hideSidebar();
    rebuildGraph();
    toast('边已删除');
  }
}

/* ---------- 工具栏 ---------- */

function initTagFilter() {
  const sel = $('#tag-filter');
  const cur = sel.value;
  const tags = [...new Set(graph.nodes.flatMap(n => n.tags || []))].sort();
  sel.innerHTML = '<option value="">全部标签</option>' +
    tags.map(t => `<option value="${escapeHtml(t)}" ${t === cur ? 'selected' : ''}>${escapeHtml(t)}</option>`).join('');
}

function applyTagFilter() {
  const tag = $('#tag-filter').value;
  cy.elements().removeClass('hidden-filter');
  if (tag) {
    cy.nodes().forEach(n => {
      const gn = findNode(n.id());
      if (!gn || !(gn.tags || []).includes(tag)) {
        n.addClass('hidden-filter');
        n.connectedEdges().addClass('hidden-filter');
      }
    });
  }
  refreshViewStyles();
}

const doSearch = debounce(() => {
  const q = $('#search').value.trim();
  if (!q) return;
  const n = cy.nodes().find(x => x.data('name').includes(q));
  if (!n) { toast('未找到匹配节点'); return; }
  if (n.style('display') === 'none') {
    toast('匹配节点当前被过滤、隐藏或高于焦点层');
    return;
  }
  n.select();
  cy.animate({ center: { eles: n }, zoom: Math.max(cy.zoom(), 1.25) }, { duration: 350 });
  n.flashClass('flash', 900);
}, 250);

function exportJSON() {
  const blob = new Blob([JSON.stringify(graph, null, 2) + '\n'], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'graph.json';
  a.click();
  URL.revokeObjectURL(a.href);
}

function bindToolbar() {
  $('#search').addEventListener('input', doSearch);
  $('#tag-filter').addEventListener('change', applyTagFilter);
  $('#btn-export').onclick = exportJSON;
  $('#btn-viewmode').onclick = toggleViewMode;
  $('#btn-relayout').classList.toggle('hidden', viewMode !== 'free');
  $('#btn-spread-layer').classList.toggle('hidden', viewMode !== 'layered');
  $('#btn-spread-layer').onclick = spreadCurrentLayer;
  $('#btn-tidy-edges').classList.toggle('hidden', viewMode !== 'layered');
  $('#btn-tidy-edges').onclick = tidyEdges;
  $('#btn-relayout').onclick = () => {
    exitRadial();
    runCose(true).then(() => { syncPositions(); saveGraph(); cy.fit(undefined, 40); });
  };
  if (!readOnly) {
    $('#btn-add').onclick = () => openNodeModal(null);
    $('#btn-import').onclick = openImportModal;
  }
  $('#sidebar-close').onclick = hideSidebar;
  $('#btn-radial').onclick = enterRadial;
  $('#btn-overview').onclick = exitRadial;
  $('#radial-depth').onchange = () => { if (state.radial) enterRadial(); };
  $('#modal-overlay').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeModal();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { closeModal(); }
  });
}

/* ---------- 初始化 ---------- */

(async function init() {
  let loaded;
  try {
    loaded = await loadGraph();
  } catch (e) {
    document.body.innerHTML = `<p style="padding:40px">加载失败：${escapeHtml(e.message)}</p>`;
    return;
  }
  graph = loaded.data;
  readOnly = loaded.readOnly;
  focusLayer = maxLayer();   // 默认焦点 = 最高层（看得见地基和塔尖）

  document.title = graph.meta.title || '数学知识网络';
  $('#app-title').textContent = graph.meta.title || '数学知识网络';
  $('#graph-name').textContent = `图：${GRAPH_NAME}`;
  if (readOnly) {
    document.body.classList.add('readonly');
    const badge = $('#mode-badge');
    badge.textContent = '只读展示';
    badge.className = 'badge badge-readonly';
  }

  initLegend();
  initTagFilter();
  cy = cytoscape({
    container: $('#cy'),
    elements: toCyElements(),
    style: CY_STYLE,
    wheelSensitivity: 0.3,
  });
  bindCyEvents();
  bindToolbar();
  renderRail();
  layoutInitial();
})();
