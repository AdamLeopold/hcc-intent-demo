'use strict';
(() => {
  const TOKEN = document.querySelector('meta[name="hcc-token"]').content;
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  // ---------- DOM helpers (text only via textContent; inline styles via CSSOM for CSP) ----------
  function h(tag, attrs, ...kids) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'style') Object.assign(node.style, v);
      else if (k === 'dataset') Object.assign(node.dataset, v);
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return node;
  }
  // replaceChildren() would print null as "null"; drop empty slots first.
  const fill = (node, ...kids) => node.replaceChildren(...kids.flat().filter(k => k != null && k !== false));
  const SVGNS = 'http://www.w3.org/2000/svg';
  function s(tag, attrs, ...kids) {
    const node = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null) continue;
      if (k === 'text') node.textContent = v;
      else if (k === 'style') Object.assign(node.style, v);
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    }
    kids.flat().forEach(kid => kid && node.append(kid));
    return node;
  }

  const api = {
    async get(path, params = {}) {
      const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ''));
      const res = await fetch(path + (q.toString() ? '?' + q : ''), { headers: { Accept: 'application/json' } });
      const data = await res.json().catch(() => ({ error: '服务器返回了无法解析的内容' }));
      if (!res.ok) throw new Error(data.error || '请求失败 ' + res.status);
      return data;
    },
    async post(path, body) {
      const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-HCC-Token': TOKEN }, body: JSON.stringify(body) });
      const data = await res.json().catch(() => ({ error: '服务器返回了无法解析的内容' }));
      if (!res.ok) throw new Error(data.error || '请求失败 ' + res.status);
      return data;
    },
  };

  function loadPref(key) { try { return localStorage.getItem('hcc.v2.' + key); } catch { return null; } }
  function savePref(key, value) { try { localStorage.setItem('hcc.v2.' + key, value); } catch { /* private mode */ } }

  let toastTimer = null;
  function toast(text) {
    const t = $('#toast');
    t.textContent = text; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 3600);
  }

  // ---------- vocabulary ----------
  const CLASS = {
    TACE: { name: 'TACE', color: 'var(--c-tace)', lane: 0 },
    HAIC: { name: 'HAIC', color: 'var(--c-local)', lane: 0 },
    RESECTION: { name: '切除', color: 'var(--c-curative)', lane: 1 },
    ABLATION: { name: '消融', color: 'var(--c-curative)', lane: 1 },
    TRANSPLANT: { name: '移植', color: 'var(--c-curative)', lane: 1 },
    SYSTEMIC: { name: '系统治疗', color: 'var(--c-systemic)', lane: 2 },
    RADIATION: { name: '放疗', color: 'var(--c-local)', lane: 2 },
  };
  const LANES = ['介入', '根治性', '系统 / 放疗', '其他住院'];
  const JUDGE = [['acceptable', '可接受'], ['conditional', '有条件'], ['unacceptable', '不可接受'], ['unknown', '无法判断']];
  const TOOL_NAMES = { get_admission: '查看住院', search_records: '检索记录', cohort_reference: '队列参考', get_followup: '后续病程' };
  const PROMPTS = {
    locked: [
      ['节点简报', '请生成这个节点的简报：①当时可见病程摘要（按时间，引用住院编号）；②A 层状态倾向（S1–S4）及依据，信息不足就选 S4 并列出缺什么；③B 层 8 个行动族各自需要满足的条件和需要核对的信息；④最关键的缺失信息与建议的复评时机。'],
      ['缺什么信息', '要对这个节点做决定，最缺哪些信息？按重要性排序，并说明每一项会怎样改变判断。'],
      ['规则提示解读', '逐条解释这个节点触发的规则提示，以及它们在只有病案首页时的局限。'],
      ['队列参考', '调用队列参考，说明同类节点在本院 180 天内实际发生转换的频率，以及这个数字能说明什么、不能说明什么。'],
    ],
    hindsight: [
      ['当时 vs 事后', '对比节点当时可见的信息和之后的真实病程：哪些结局在当时有迹可循，哪些只有事后才知道？'],
      ['结局解读', '调用后续病程工具，概括节点出院后 180 天内实际发生了什么，并说明这是行为锚定的结局。'],
      ['回看决策', '只用节点当时可见的信息，评价当时继续 TACE 的合理性；再单独说明事后信息会怎样改变这个评价，以及为什么不能用事后信息评判当时的决策。'],
    ],
    full: [
      ['病程梳理', '按时间梳理这位患者的全部住院，概括治疗序列和关键转折点。'],
      ['重复 TACE 节点', '列出这位患者的重复 TACE 节点，并说明每个节点前后的治疗变化。'],
      ['费用概览', '概括这位患者各次住院的费用变化，指出费用最高的几次住院及其治疗类别。'],
    ],
  };

  // ---------- state ----------
  const S = {
    status: null, scope: loadPref('scope') || 'hcc_nodes', q: '', offset: 0, total: 0, patients: [],
    pid: '', patient: null, nodeId: '', mode: 'locked', timeline: null, node: null, hindsight: null,
    detail: null, selectedRef: '', tab: 'visible',
    chat: { id: '', messages: [], streaming: false, streamId: '', controller: null },
  };

  // ---------- formatting ----------
  const fmtInt = v => (v == null ? '—' : Number(v).toLocaleString('zh-CN'));
  const money = v => (!v ? '—' : v >= 10000 ? `¥${(v / 10000).toFixed(1)} 万` : `¥${Math.round(v).toLocaleString('zh-CN')}`);
  const dayText = d => (d == null ? '时间无效' : `第 ${d} 天`);
  const classNames = cs => (cs && cs.length ? cs.map(c => (CLASS[c] ? CLASS[c].name : c)).join('、') : '未识别治疗');
  function classTags(classes) {
    return (classes || []).map(c => h('span', { class: 'ct', text: CLASS[c] ? CLASS[c].name : c, style: { background: CLASS[c] ? CLASS[c].color : 'var(--c-other)' } }));
  }
  const chatMode = () => (S.nodeId ? (S.mode === 'locked' ? 'locked' : 'hindsight') : 'full');
  const currentNode = () => (S.patient ? S.patient.nodes.find(n => n.node_id === S.nodeId) : null);

  // ---------- theme ----------
  function applyTheme(mode) {
    if (mode === 'light' || mode === 'dark') document.documentElement.dataset.theme = mode;
    else delete document.documentElement.dataset.theme;
  }
  function cycleTheme() {
    const order = ['auto', 'light', 'dark'];
    const next = order[(order.indexOf(loadPref('theme') || 'auto') + 1) % order.length];
    savePref('theme', next); applyTheme(next);
    toast({ auto: '跟随系统主题', light: '浅色主题', dark: '深色主题' }[next]);
    if (S.timeline) renderTimeline();
  }

  // ---------- status / header ----------
  function renderStatus() {
    const st = S.status;
    const chips = $('#statusChips');
    fill(chips, 
      h('span', { class: 'chip' }, 'HCC 重复 TACE 节点 ', h('b', { text: fmtInt(st.nodes_hcc) })),
      h('span', { class: 'chip' }, '有节点的患者 ', h('b', { text: fmtInt(st.patients_with_nodes) })),
      st.manifest_loaded
        ? h('span', { class: 'chip ok', title: '封存的 final 测试集不显示、不进入队列参考和 AI 对话' }, `封存 final ${st.sealed_hidden} 人已隐藏`)
        : h('span', { class: 'chip warn', title: '启动时用 --cohort-manifest 指定分组清单' }, '未找到分组清单：封存患者无法排除'),
    );
  }
  function renderWelcomeNotes() {
    const box = $('#welcomeNotes');
    box.replaceChildren(h('h4', { text: '研究现状（只含汇总）' }),
      ...S.status.research_notes.map(n => h('div', { class: 'note-line' }, h('b', { text: n.id }), h('span', { text: n.text }))),
      h('div', { class: 'note-line' }, h('b', { text: '口径' }), h('span', { text: S.status.caliber_note })));
  }

  // ---------- patients ----------
  async function loadPatients(reset) {
    if (reset) { S.offset = 0; S.patients = []; }
    try {
      const data = await api.get('/api/v2/patients', { q: S.q, scope: S.scope, offset: S.offset });
      S.patients.push(...data.patients); S.total = data.total; S.offset += data.patients.length;
      $('#loadMore').hidden = !data.has_more;
    } catch (e) { toast(e.message); }
    renderPatients();
  }
  function renderPatients() {
    $$('#scopeSwitch button').forEach(b => b.classList.toggle('active', b.dataset.scope === S.scope));
    $('#patientTotal').textContent = `${fmtInt(S.total)} 位患者`;
    const list = $('#patientList');
    list.replaceChildren();
    if (!S.patients.length) { list.append(h('div', { class: 'empty', text: '没有符合条件的患者' })); return; }
    for (const p of S.patients) {
      const named = p.name && p.name !== '姓名未录';
      list.append(h('button', { class: 'patient-item' + (p.patient_id === S.pid ? ' active' : ''), role: 'option',
        'aria-selected': p.patient_id === S.pid ? 'true' : 'false', 'aria-label': `${p.patient_id}，${p.nodes} 个节点`, onclick: () => openPatient(p.patient_id) },
        h('div', { class: 'row' }, h('span', { class: 'pid', text: named ? p.display_name : p.patient_id }), p.death ? h('span', { class: 'tag danger', text: '院内死亡' }) : null),
        h('div', { class: 'meta' },
          h('span', { class: 'tag' + (p.disease === 'HCC' ? ' accent' : ''), text: p.disease_name }),
          p.nodes ? h('span', { class: 'tag violet', text: `◆ ${p.nodes} 个节点` }) : null,
          h('span', { text: `${p.admissions} 次住院` }),
          p.marked_nodes ? h('span', { class: 'tag', text: `✓ 已记录 ${p.marked_nodes}` }) : null,
          p.latest_activity ? h('span', { text: '末次 ' + p.latest_activity.slice(0, 7) }) : null)));
    }
  }

  async function openPatient(pid) {
    if (S.chat.streaming) { toast('请先停止当前对话'); return; }
    S.pid = pid; mapReset(); renderPatients();
    document.body.classList.remove('show-patients');
    try { S.patient = await api.get('/api/v2/patient', { id: pid }); } catch (e) { toast(e.message); return; }
    const nodes = S.patient.nodes;
    const first = nodes.find(n => !n.marked) || nodes[nodes.length - 1];
    S.nodeId = first ? first.node_id : '';
    S.mode = S.nodeId ? 'locked' : 'full';
    S.tab = 'visible';
    $('#welcome').hidden = true; $('#caseView').hidden = false;
    renderCaseHead();
    await loadView();
  }

  async function loadView() {
    S.hindsight = null; S.detail = null; S.selectedRef = '';
    try {
      S.timeline = await api.get('/api/v2/timeline', { id: S.pid, node: S.nodeId, mode: S.mode });
      S.node = S.nodeId ? await api.get('/api/v2/node', { id: S.pid, node: S.nodeId }) : null;
    } catch (e) { toast(e.message); return; }
    renderNodeStrip(); renderMode(); renderTimeline(); renderTabs(); renderTab();
    resetChat(); refreshHistory();
  }

  function selectNode(nodeId) {
    if (S.chat.streaming) { toast('请先停止当前对话'); return; }
    S.nodeId = nodeId; S.mode = nodeId ? 'locked' : 'full';
    if (!nodeId && ['alayer', 'blayer', 'after'].includes(S.tab)) S.tab = 'visible';
    loadView();
  }
  function setMode(mode) {
    if (S.chat.streaming) { toast('请先停止当前对话'); return; }
    if (mode === 'locked' && !S.nodeId) return;
    if (mode === S.mode) return;
    S.mode = mode; loadView();
  }

  // ---------- case header ----------
  function renderCaseHead() {
    const p = S.patient.patient, sm = S.patient.summary;
    $('#caseEyebrow').textContent = p.name && p.name !== '姓名未录' ? p.display_name : '患者研究编号';
    $('#caseTitle').textContent = p.patient_id;
    fill($('#caseBadges'), 
      h('span', { class: 'tag' + (p.disease === 'HCC' ? ' accent' : ''), text: p.disease_name }),
      h('span', { class: 'tag', text: `${sm.sex} · 首次入院 ${sm.age_at_first ?? '—'} 岁` }),
      sm.death ? h('span', { class: 'tag danger', text: '有院内死亡记录' }) : null,
      p.identity_conflict ? h('span', { class: 'tag warn', text: '身份字段冲突' }) : null,
      p.split ? h('span', { class: 'tag', text: '分组 ' + p.split }) : null);
    $('#caseStats').replaceChildren(
      stat('住院', fmtInt(S.patient.admissions)), stat('TACE 住院', fmtInt(sm.tace_admissions)),
      stat('重复 TACE 节点', fmtInt(S.patient.nodes.length)), stat('总费用', money(sm.total_cost)));
  }
  const stat = (label, value) => h('div', { class: 'stat' }, h('small', { text: label }), h('b', { text: value }));

  function renderNodeStrip() {
    const strip = $('#nodeStrip');
    fill(strip, h('span', { class: 'label', text: '节点' }));
    if (!S.patient.nodes.length) strip.append(h('span', { class: 'hint', text: '没有重复 TACE 节点，只能看全病程' }));
    for (const n of S.patient.nodes) {
      strip.append(h('button', { class: 'node-chip' + (n.node_id === S.nodeId ? ' active' : ''), title: `${n.ref} · 第 ${n.k} 次 TACE 入院`, onclick: () => selectNode(n.node_id) },
        `◆ 第 ${n.k} 次`, n.marked ? h('span', { class: 'done', text: '✓' }) : null));
    }
    if (S.nodeId) strip.append(h('button', { class: 'node-chip', onclick: () => selectNode(''), text: '患者总览' }));
  }

  function renderMode() {
    $$('#modeSwitch button').forEach(b => {
      b.classList.toggle('active', b.dataset.mode === (S.mode === 'locked' ? 'locked' : 'full'));
      b.disabled = b.dataset.mode === 'locked' && !S.nodeId;
    });
    const hint = $('#modeHint'), n = currentNode();
    if (S.mode === 'locked' && n) {
      hint.className = 'mode-hint';
      hint.textContent = `时间锁：第 0 天 = 第 ${n.k} 次 TACE 入院。只显示之前已出院的 ${S.node ? S.node.visible.length : 0} 次住院；本次住院和之后的住院都隐藏。`;
    } else if (n) {
      hint.className = 'mode-hint warn';
      hint.textContent = '全病程（后见之明）：显示节点之后的真实病程，已记录为“查看过后续病程”；之后保存的 B 层记录会带上这个标记。';
    } else {
      hint.className = 'mode-hint';
      hint.textContent = '全病程：第 0 天 = 首次入院。点 ◆ 节点进入时间锁视图。';
    }
  }

  // ---------- timeline ----------
  function niceStep(raw) {
    return [7, 14, 30, 60, 90, 180, 365, 730, 1460].find(v => v >= raw) || 1460;
  }
  function renderTimeline() {
    const box = $('#timeline');
    box.replaceChildren();
    const t = S.timeline;
    if (!t) return;
    const adms = t.admissions;
    const width = Math.max(box.clientWidth - 16, 520);
    const left = 86, right = 14, top = 30, laneH = 30, lanes = LANES.length;
    const height = top + lanes * laneH + 28;
    const days = adms.flatMap(a => [a.admission_day, a.discharge_day]).filter(d => d != null);
    let min = Math.min(0, ...days), max = Math.max(0, ...days);
    if (t.mode === 'locked') max = Math.max(30, (0 - min) * 0.22);
    const pad = Math.max(8, (max - min) * 0.025);
    min -= pad; max += pad;
    const x = d => left + ((d - min) / (max - min)) * (width - left - right);
    const svg = s('svg', { viewBox: `0 0 ${width} ${height}`, height, role: 'img', 'aria-label': '住院时间轴' });
    const pat = s('pattern', { id: 'hatch', width: 8, height: 8, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' },
      s('rect', { width: 8, height: 8, style: { fill: 'var(--hatch)' } }),
      s('line', { x1: 0, y1: 0, x2: 0, y2: 8, 'stroke-width': 3, style: { stroke: 'var(--border)' } }));
    svg.append(s('defs', {}, pat));
    LANES.forEach((name, i) => {
      const y = top + i * laneH;
      svg.append(s('rect', { class: 'lane-bg', x: left, y: y + 3, width: width - left - right, height: laneH - 6, rx: 6 }),
        s('text', { class: 'lane-label', x: 4, y: y + laneH / 2 + 4, text: name }));
    });
    const step = niceStep((max - min) / 8);
    const axis = s('g', { class: 'axis' });
    for (let d = Math.ceil(min / step) * step; d <= max; d += step) {
      const xx = x(d);
      axis.append(s('line', { x1: xx, x2: xx, y1: top, y2: top + lanes * laneH }),
        s('text', { x: xx, y: top + lanes * laneH + 16, 'text-anchor': 'middle', text: d === 0 ? '0' : `${d > 0 ? '+' : ''}${d} 天` }));
    }
    svg.append(axis);
    if (t.mode === 'locked') {
      const x0 = x(0), w = Math.max(0, width - right - x0);
      svg.append(s('rect', { class: 'hidden-zone', x: x0, y: top, width: w, height: lanes * laneH, rx: 4 }),
        s('text', { class: 'hidden-label', x: x0 + w / 2, y: top + (lanes * laneH) / 2 + 4, 'text-anchor': 'middle', text: w > 120 ? '时间锁 · 之后隐藏' : '已隐藏' }));
    }
    const marks = [];
    for (const a of adms) {
      if (a.hidden) {
        svg.append(s('rect', { class: 'placeholder', x: x(0), y: top + 6, width: 9, height: laneH - 12, rx: 3 }));
        marks.push({ day: 0, k: a.node_k, nodeId: a.node_id });
        continue;
      }
      if (a.admission_day == null) continue;
      const end = a.discharge_day ?? a.admission_day;
      const x1 = x(a.admission_day), w = Math.max(5, x(end + 1) - x1);
      const classes = a.classes && a.classes.length ? a.classes : [null];
      const usedLanes = new Set();
      for (const c of classes) {
        const info = CLASS[c], lane = info ? info.lane : 3;
        if (usedLanes.has(lane + ':' + (info ? info.color : ''))) continue;
        usedLanes.add(lane + ':' + (info ? info.color : ''));
        svg.append(s('rect', {
          class: 'adm' + (a.ref === S.selectedRef ? ' selected' : ''), x: x1, y: top + lane * laneH + 7, width: w, height: laneH - 14, rx: 3,
          style: { fill: info ? info.color : 'var(--c-other)' },
          onclick: () => openAdmission(a.ref), onmousemove: e => showTip(e, a), onmouseleave: hideTip,
        }));
      }
      if (a.death) {
        const lane = CLASS[classes[0]] ? CLASS[classes[0]].lane : 3;
        svg.append(s('circle', { cx: x(end) + 4, cy: top + lane * laneH + laneH / 2, r: 4, style: { fill: 'var(--c-death)' } }));
      }
      if (a.node_id) marks.push({ day: a.admission_day, k: a.node_k, nodeId: a.node_id });
    }
    if (t.as_of_day != null) {
      const x0 = x(t.as_of_day);
      svg.append(s('line', { class: 'zero-line', x1: x0, x2: x0, y1: top - 4, y2: top + lanes * laneH }));
    }
    for (const m of marks) {
      const cx = x(m.day), cy = 14, current = m.nodeId === S.nodeId, r = current ? 8 : 6.5;
      const g = s('g', { class: 'node-mark', onclick: () => m.nodeId !== S.nodeId && selectNode(m.nodeId) },
        s('polygon', { points: `${cx},${cy - r} ${cx + r},${cy} ${cx},${cy + r} ${cx - r},${cy}`, style: { fill: current ? 'var(--accent)' : 'var(--c-tace)', opacity: current ? 1 : 0.75 } }),
        s('text', { x: cx, y: cy + 3.5, 'text-anchor': 'middle', text: String(m.k) }));
      g.append(s('title', { text: `第 ${m.k} 次 TACE 入院${current ? '（当前节点）' : '，点击切换'}` }));
      svg.append(g);
      if (current) svg.append(s('text', { class: 'zero-label', x: cx + 12, y: cy + 4, text: `第 0 天 · 第 ${m.k} 次 TACE 入院` }));
    }
    box.append(svg);
  }
  function showTip(e, a) {
    const tip = $('#tooltip');
    fill(tip, h('b', { text: `${a.ref} · ${dayText(a.admission_day)}入院` }),
      h('div', { text: `住院 ${a.los_days ?? '—'} 天 · ${classNames(a.classes)}` }),
      a.main_diagnosis ? h('div', { text: a.main_diagnosis }) : null,
      a.death ? h('div', { text: '院内死亡' }) : null);
    tip.hidden = false;
    const r = tip.getBoundingClientRect();
    tip.style.left = Math.min(window.innerWidth - r.width - 8, e.clientX + 14) + 'px';
    tip.style.top = Math.min(window.innerHeight - r.height - 8, e.clientY + 14) + 'px';
  }
  function hideTip() { $('#tooltip').hidden = true; }
  function renderLegend() {
    const items = [['TACE', 'var(--c-tace)'], ['HAIC / 放疗', 'var(--c-local)'], ['系统治疗', 'var(--c-systemic)'], ['切除 / 消融 / 移植', 'var(--c-curative)'], ['其他住院', 'var(--c-other)'], ['院内死亡', 'var(--c-death)']];
    $('#timelineLegend').replaceChildren(...items.map(([n, c]) => h('span', {}, h('i', { style: { background: c } }), n)),
      h('span', {}, '◆ 重复 TACE 节点'), h('span', {}, '斜线区：时间锁隐藏'));
  }

  // ---------- tabs ----------
  function renderTabs() {
    if (!S.nodeId && ['alayer', 'blayer', 'after'].includes(S.tab)) S.tab = 'visible';
    $$('#tabs button').forEach(b => {
      const tab = b.dataset.tab;
      b.disabled = ['alayer', 'blayer', 'after'].includes(tab) && !S.nodeId;
      b.classList.toggle('active', tab === S.tab);
      if (tab === 'visible') b.textContent = S.mode === 'locked' ? '当时可见' : '全部住院';
    });
  }
  function renderTab() {
    if (S.tab !== 'map' && document.querySelector('.node-card.map-max')) { document.querySelector('.node-card').classList.remove('map-max'); document.body.classList.remove('map-maxed'); }
    const body = $('#tabBody');
    body.replaceChildren();
    ({ visible: tabVisible, alayer: tabA, blayer: tabB, after: tabAfter, map: tabMap, detail: tabDetail })[S.tab](body);
  }

  function admCard(a, opts = {}) {
    return h('button', { class: 'adm-card', onclick: () => openAdmission(a.ref, opts) },
      h('div', {}, h('div', { class: 'ref', text: a.ref }), h('div', { class: 'when', text: dayText(a.admission_day) })),
      h('div', { style: { minWidth: '0' } }, h('div', { class: 'dx', text: a.main_diagnosis || '无主要诊断' }),
        h('div', { class: 'class-tags' }, classTags(a.classes), h('span', { class: 'when', text: `住院 ${a.los_days ?? '—'} 天` }),
          a.death ? h('span', { class: 'tag danger', text: '院内死亡' }) : null)),
      h('div', { class: 'right', text: a.total_cost ? money(a.total_cost) : '' }));
  }

  function tabVisible(body) {
    const rows = S.timeline.admissions.filter(a => !a.hidden);
    if (S.node && S.mode === 'locked') {
      const n = S.node.node;
      body.append(h('div', { class: 'lead' },
        h('span', { class: 'tag accent', text: `第 ${n.k} 次 TACE 入院 = 第 0 天` }), h('span', { class: 'tag', text: n.age_band || '年龄未记录' }),
        h('span', { class: 'tag', text: n.sex }), h('span', { class: 'tag', text: `当时可见 ${rows.length} 次住院` }),
        S.node.excluded_invalid_time ? h('span', { class: 'tag warn', text: `${S.node.excluded_invalid_time} 次时间无效、未纳入` }) : null,
        n.overlap ? h('span', { class: 'tag warn', text: '与其他住院时间重叠' }) : null,
        n.followup_complete ? null : h('span', { class: 'tag', text: '180 天随访不完整' })));
    }
    const list = h('div', { class: 'adm-list' });
    rows.forEach(a => list.append(admCard(a)));
    body.append(list);
    if (S.mode === 'locked') {
      body.append(h('div', { class: 'callout', style: { marginTop: '12px' } },
        '本次住院（第 0 天）的诊断、操作、费用和结局不在时间锁视图里。需要时到“后续病程”查看（会记录为已查看）。'));
    }
  }

  function tabA(body) {
    const f = S.node.features;
    body.append(h('div', { class: 'section-title', text: '派生特征（只用当时可见的住院计算）' }));
    const metric = (label, value, unit) => h('div', { class: 'metric' }, h('small', { text: label }), h('b', {}, value == null ? '—' : String(value), value == null ? null : h('span', { text: unit })));
    body.append(h('div', { class: 'metrics' },
      metric('既往 TACE', f.n_prior_tace, '次'), metric('距上次 TACE 出院', f.days_since_last_tace, '天'),
      metric('距首次 TACE', f.days_since_first_tace, '天'), metric('既往住院', f.n_prior_adm, '次'),
      metric('近 180 天住院', f.n_prior_adm_180d, '次'), metric('既往住院总天数', f.prior_los_days, '天')));
    body.append(h('div', { class: 'section-title', text: '规则提示（研究对照用的简单规则，不是建议）' }));
    body.append(h('div', { class: 'rules' }, ...S.node.rules.map(r => h('div', { class: 'rule' + (r.fired ? ' fired' : '') }, h('div', {}, h('b', { text: r.title }), ' ', h('span', { text: r.detail }))))));
    const c = S.node.cohort;
    body.append(h('div', { class: 'section-title', text: '本院队列参考 · LOCAL-COHORT' }));
    if (!c.available) {
      body.append(h('div', { class: 'callout warn', text: c.reason }));
    } else {
      body.append(h('div', { class: 'cohort' }, ...c.groups.map(g => h('div', { class: 'cohort-row', title: `根治性 ${g.curative} · 新的转换 ${g.switch} · 无再住院 ${g.no_readmission}` },
        h('span', { text: g.label }), h('div', { class: 'bar' }, h('i', { style: { width: ((g.rate || 0) * 100).toFixed(1) + '%' } })),
        h('span', { class: 'num', text: g.rate == null ? '—' : `${(g.rate * 100).toFixed(1)}% · ${fmtInt(g.nodes)}` })))));
      body.append(h('div', { class: 'callout', style: { marginTop: '10px' } }, h('b', { text: '统计对象：' }), c.population, '。', h('br'), h('b', { text: '结局：' }), c.outcome, '。', h('br'), c.caution));
    }
    body.append(h('div', { class: 'section-title', text: '这一层目前能做到什么' }));
    body.append(h('div', { class: 'callout accent' }, ...S.status.research_notes.map(n => h('div', {}, h('b', { text: n.id + '：' }), n.text))));
  }

  function tabB(body) {
    const rec = S.node.record || {};
    const draft = {
      state: rec.state || '', families: JSON.parse(JSON.stringify(rec.families || {})), missing: rec.missing || '',
      reassess: rec.reassess || '', note: rec.note || '', reviewer: rec.reviewer || loadPref('reviewer') || '',
    };
    const audit = S.node.audit;
    body.append(h('div', { class: 'callout' }, '这里记录医生对这个节点的判断。它是工作台记录，不是正式参考标准；AI 不会预填这里。正式试标请用 T13 试标包（只看当时资料、不看结局、两人独立）。'));
    body.append(h('div', { class: 'audit', style: { marginTop: '10px' } },
      audit.full_course_viewed ? h('span', { class: 'tag warn', text: '已查看过后续病程' }) : h('span', { class: 'tag accent', text: '尚未查看后续病程' }),
      audit.ai_consulted ? h('span', { class: 'tag violet', text: `已咨询 AI（${audit.chats} 段对话）` }) : h('span', { class: 'tag', text: '尚未咨询 AI' }),
      rec.saved_at ? h('span', { class: 'tag', text: '上次保存 ' + new Date(rec.saved_at).toLocaleString('zh-CN') }) : null));

    body.append(h('div', { class: 'section-title', text: 'A 层状态（医生判断）' }));
    const states = h('div', { class: 'state-options' });
    const paintStates = () => $$('.state-option', states).forEach(b => b.classList.toggle('active', b.dataset.v === draft.state));
    for (const st of S.status.states) {
      states.append(h('button', { type: 'button', class: 'state-option', dataset: { v: st.id }, onclick: () => { draft.state = draft.state === st.id ? '' : st.id; paintStates(); } },
        h('b', { text: st.id }), h('span', { text: st.name })));
    }
    body.append(states); paintStates();

    body.append(h('div', { class: 'section-title', text: 'B 层行动族：可接受 / 有条件 / 不可接受 / 无法判断' }));
    const table = h('div', { class: 'family-table' });
    for (const fam of S.status.families) {
      const item = draft.families[fam.id] || (draft.families[fam.id] = { judgement: '', condition: '' });
      const seg = h('div', { class: 'segmented judge' });
      const paint = () => $$('button', seg).forEach(b => b.classList.toggle('active', b.dataset.v === item.judgement));
      JUDGE.forEach(([v, label]) => seg.append(h('button', { type: 'button', dataset: { v }, text: label, onclick: () => { item.judgement = item.judgement === v ? '' : v; paint(); } })));
      paint();
      table.append(h('div', { class: 'family-row' }, h('span', { class: 'name', text: fam.name }), seg,
        h('input', { class: 'input', placeholder: '条件或理由（可选）', value: item.condition || '', oninput: e => { item.condition = e.target.value; } })));
    }
    body.append(table);
    const field = (label, key, multiline, placeholder) => h('div', { class: 'field' }, h('label', { text: label }),
      multiline ? h('textarea', { class: 'input', placeholder, oninput: e => { draft[key] = e.target.value; } }, draft[key])
        : h('input', { class: 'input', placeholder, value: draft[key], oninput: e => { draft[key] = e.target.value; } }));
    body.append(h('div', { class: 'grid-2' },
      h('div', {}, field('缺失的关键信息', 'missing', true, '例如：最近一次增强 CT/MRI 疗效评价、AFP、Child-Pugh'), field('建议复评时机', 'reassess', false, '例如：4–6 周后影像复查')),
      h('div', {}, field('备注', 'note', true, '其他想法'), field('记录人', 'reviewer', false, '姓名缩写或代号'))));
    const btn = h('button', { class: 'primary-btn', text: '保存记录', onclick: () => saveMarks(draft, btn) });
    body.append(h('div', { class: 'form-foot' },
      h('small', { text: '保存时会一并记录“是否已查看后续病程”和“是否已咨询 AI”。日期会自动换算为相对天数。' }), btn));
  }
  async function saveMarks(draft, btn) {
    btn.disabled = true;
    const families = {};
    for (const [k, v] of Object.entries(draft.families)) if (v.judgement || (v.condition || '').trim()) families[k] = { judgement: v.judgement || null, condition: v.condition || '' };
    try {
      const res = await api.post('/api/v2/marks', { patient_id: S.pid, node_id: S.nodeId, revision: S.node.marks_revision, record: { ...draft, families } });
      S.node.record = res.record; S.node.marks_revision = res.revision;
      savePref('reviewer', draft.reviewer);
      const n = currentNode(); if (n) n.marked = true;
      renderNodeStrip(); renderTab(); toast('已保存');
    } catch (e) { toast(e.message); } finally { btn.disabled = false; }
  }

  function tabAfter(body) {
    if (!S.hindsight) {
      body.append(h('div', { class: 'lock-card' }, h('h3', { text: '节点之后的真实病程已隐藏' }),
        h('p', { text: '查看后会记录为“已查看后续病程”。如果还没填写 B 层判断，建议先填写再查看，避免后见之明影响判断。' }),
        h('button', { class: 'primary-btn', text: '显示后续病程', onclick: revealAfter })));
      return;
    }
    const hs = S.hindsight, w = hs.within_window;
    body.append(h('div', { class: 'callout ' + (w.positive ? 'warn' : 'accent') },
      h('b', { text: `节点出院后 ${hs.window_days} 天内：` }),
      `再住院 ${w.admissions} 次；根治性治疗：${w.curative.length ? classNames(w.curative) : '无'}；新的转换治疗：${w.new_switch.length ? classNames(w.new_switch) : '无'}；院内死亡：${w.death ? '是' : '否'}。`,
      h('br'), hs.label_note,
      hs.no_readmission ? h('div', { text: '之后没有再住院记录（不等于病情稳定）。' }) : null,
      hs.followup_complete ? null : h('div', { text: '180 天随访不完整（节点出院晚于 2025-07-04）。' })));
    body.append(h('div', { class: 'section-title', text: '本次节点住院（第 0 天）' }));
    detailBlocks(body, hs.node_admission);
    body.append(h('div', { class: 'section-title', text: `之后的住院（${hs.future.length} 次）` }));
    const list = h('div', { class: 'adm-list' });
    hs.future.forEach(a => list.append(admCard(a, { mode: 'full' })));
    if (!hs.future.length) list.append(h('div', { class: 'empty', text: '没有之后的住院记录' }));
    body.append(list);
  }
  async function revealAfter() {
    try {
      S.hindsight = await api.get('/api/v2/hindsight', { id: S.pid, node: S.nodeId });
      S.node.audit.full_course_viewed = true;
      renderTab();
    } catch (e) { toast(e.message); }
  }

  function tabDetail(body) {
    if (!S.detail) { body.append(h('div', { class: 'empty', text: '在时间轴或列表中点选一次住院，查看首页明细。' })); return; }
    detailBlocks(body, S.detail);
  }
  function detailBlocks(body, d) {
    body.append(h('div', { class: 'lead' }, h('span', { class: 'tag accent', text: d.ref }), h('span', { class: 'tag', text: dayText(d.admission_day) + '入院' }),
      h('span', { class: 'tag', text: `住院 ${d.los_days ?? '—'} 天` }), ...classTags(d.classes), d.death ? h('span', { class: 'tag danger', text: '院内死亡' }) : null));
    const dx = h('table', { class: 'plain' }, h('thead', {}, h('tr', {}, h('th', { text: '类型' }), h('th', { text: '诊断' }), h('th', { text: '编码' }))),
      h('tbody', {}, ...(d.diagnoses || []).map(x => h('tr', {}, h('td', { text: x.kind }), h('td', { text: x.name }), h('td', { class: 'code', text: x.code || '' })))));
    const procs = h('table', { class: 'plain' }, h('thead', {}, h('tr', {}, h('th', { text: '手术操作' }), h('th', { text: '时间' }), h('th', { text: '类别' }))),
      h('tbody', {}, ...(d.procedures || []).map(p => h('tr', {}, h('td', { text: p.name }), h('td', { class: 'code', text: dayText(p.day) }), h('td', {}, classTags(p.classes))))));
    body.append(h('div', { class: 'grid-2' },
      h('div', {}, h('div', { class: 'section-title', text: `诊断（${(d.diagnoses || []).length}）` }), (d.diagnoses || []).length ? dx : h('div', { class: 'empty', text: '无诊断记录' })),
      h('div', {}, h('div', { class: 'section-title', text: `手术操作（${(d.procedures || []).length}）` }), (d.procedures || []).length ? procs : h('div', { class: 'empty', text: '无手术操作记录' }),
        (d.procedure_summaries || []).length ? h('div', { class: 'callout', style: { marginTop: '8px' } }, h('b', { text: '院内手术名称：' }), d.procedure_summaries.join('；')) : null)));
    const fields = Object.entries(d.fields || {});
    const costs = Object.entries((d.costs && d.costs.items) || {}).filter(([k]) => k !== '总费用');
    const maxCost = Math.max(1, ...costs.map(([, v]) => v));
    body.append(h('div', { class: 'grid-2' },
      h('div', {}, h('div', { class: 'section-title', text: '其他首页字段' }),
        fields.length ? h('dl', { class: 'kv' }, ...fields.flatMap(([k, v]) => [h('dt', { text: k }), h('dd', { text: String(v) })])) : h('div', { class: 'empty', text: '无' })),
      h('div', {}, h('div', { class: 'section-title', text: `费用 · 总计 ${money(d.costs && d.costs.total)}${d.costs && d.costs.out_of_pocket ? ' · 自付 ' + money(d.costs.out_of_pocket) : ''}` }),
        ...costs.slice(0, 10).map(([k, v]) => h('div', { class: 'cost-row' }, h('span', { text: k }), h('div', { class: 'bar' }, h('i', { style: { width: (v / maxCost * 100).toFixed(1) + '%' } })), h('span', { class: 'num', text: money(v) }))))));
  }
  async function openAdmission(ref, opts = {}) {
    const mode = opts.mode || (S.mode === 'locked' ? 'locked' : 'full');
    try {
      S.detail = await api.get('/api/v2/admission', { id: S.pid, ref, node: S.nodeId, mode });
      S.selectedRef = ref; S.tab = 'detail';
      renderTabs(); renderTab(); renderTimeline();
      $('#tabs').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    } catch (e) { toast(e.message); }
  }

  // ---------- assistant: providers ----------
  const provider = () => (S.status.assistant ? S.status.assistant.providers.find(p => p.provider === $('#providerSelect').value) : null);
  function renderProviders() {
    const a = S.status.assistant;
    const ps = $('#providerSelect');
    ps.replaceChildren(...a.providers.map(p => h('option', { value: p.provider, text: p.label + (p.configured ? '' : '（未配置）') })));
    const saved = loadPref('provider');
    const pick = a.providers.find(p => p.provider === saved && p.configured) || a.providers.find(p => p.configured) || a.providers[0];
    if (pick) ps.value = pick.provider;
    const effort = loadPref('effort');
    if (effort) $('#effortSelect').value = effort;
    renderModels(); renderExportBanner();
  }
  function renderModels() {
    const p = provider(), ms = $('#modelSelect');
    ms.replaceChildren(...(p ? p.models : []).map(m => h('option', { value: m.id, text: m.label })));
    const saved = loadPref('model.' + (p ? p.provider : ''));
    if (p && saved && p.models.some(m => m.id === saved)) ms.value = saved;
    ms.disabled = !p || !p.models.length;
  }
  function renderExportBanner() {
    const a = S.status.assistant, p = provider(), b = $('#exportBanner'), dot = $('#assistantDot');
    const ready = a.allow_export && p && p.configured;
    if (!a.allow_export) {
      b.className = 'export-banner off';
      b.replaceChildren(h('b', { text: '未授权外发病例。' }), '当前不会把任何病例内容发给云端模型。具备伦理批准、个人信息影响评估和委托处理协议后，用 ', h('code', { text: '--allow-sensitive-export' }), ' 启动服务。');
    } else if (p && p.provider === 'demo') {
      b.className = 'export-banner on';
      b.replaceChildren(h('b', { text: '演示脚本：' }), '回答是预设的，不连接任何模型，也不发送任何内容。');
    } else if (!p || !p.configured) {
      b.className = 'export-banner off';
      b.replaceChildren(h('b', { text: `${p ? p.label : '云端接口'}未配置。` }), ' ', p ? p.setup : '');
    } else {
      b.className = 'export-banner on';
      b.replaceChildren('脱敏上下文（研究编号、相对天数、诊断与操作）会发送到 ', h('code', { text: p.destination || '云端接口' }), '；不含姓名、证件号和日期。');
    }
    dot.className = 'dot ' + (S.chat.streaming ? 'busy' : ready ? 'ok' : 'warn');
    $('#assistantSub').textContent = p ? `${p.label} · 流式` : '云端模型 · 流式';
    $('#sendBtn').disabled = !S.chat.streaming && !ready;
  }

  // ---------- assistant: conversation ----------
  function renderContextChip() {
    const chip = $('#contextChip'), n = currentNode(), mode = chatMode();
    if (!S.pid) { chip.className = 'context-chip'; chip.textContent = '未选择患者'; return; }
    if (mode === 'locked') {
      const refs = S.node ? S.node.visible_refs : [];
      chip.className = 'context-chip locked';
      chip.textContent = `🔒 时间锁 · 第 ${n.k} 次 TACE 节点 · 可见 ${refs.length ? refs[0] + '–' + refs[refs.length - 1] : '无'}`;
    } else if (mode === 'hindsight') {
      chip.className = 'context-chip hindsight'; chip.textContent = `后见之明 · 第 ${n.k} 次节点 · 含之后病程`;
    } else {
      chip.className = 'context-chip'; chip.textContent = '全病程 · 全部住院';
    }
  }
  function renderQuickPrompts() {
    const box = $('#quickPrompts');
    box.replaceChildren(...(S.pid ? PROMPTS[chatMode()] : []).map(([label, text]) => h('button', { type: 'button', text: label, title: text, onclick: () => send(text) })));
  }
  function resetChat() {
    if (S.chat.streaming) return;
    S.chat = { id: '', messages: [], streaming: false, streamId: '', controller: null };
    renderChat(); renderContextChip(); renderQuickPrompts(); renderExportBanner();
    $('#historySelect').value = '';
  }
  async function refreshHistory() {
    const sel = $('#historySelect');
    sel.replaceChildren(h('option', { value: '', text: '历史对话' }));
    if (!S.pid) return;
    try {
      const { chats } = await api.get('/api/v2/chats', { id: S.pid });
      const mode = chatMode();
      chats.filter(c => c.node_id === S.nodeId && c.mode === mode).forEach(c =>
        sel.append(h('option', { value: c.chat_id, text: `${new Date(c.updated_at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} · ${c.title || '对话'}` })));
      if (S.chat.id) sel.value = S.chat.id;
    } catch { /* history is optional */ }
  }
  async function loadChat(chatId) {
    if (!chatId) { resetChat(); return; }
    try {
      const chat = await api.get('/api/v2/chat', { id: S.pid, chat: chatId });
      S.chat = { id: chat.chat_id, messages: chat.messages, streaming: false, streamId: '', controller: null };
      const p = S.status.assistant.providers.find(x => x.provider === chat.provider);
      if (p) { $('#providerSelect').value = p.provider; renderModels(); $('#modelSelect').value = chat.model; }
      if (chat.effort) $('#effortSelect').value = chat.effort;
      renderChat(); renderExportBanner();
    } catch (e) { toast(e.message); }
  }

  function renderChat() {
    const box = $('#messages');
    box.replaceChildren();
    if (!S.chat.messages.length) {
      box.append(h('div', { class: 'chat-empty' },
        h('b', { text: S.pid ? '问问这个节点' : '先在左侧选择患者' }),
        h('span', { text: S.pid ? (chatMode() === 'locked' ? 'AI 只看得到第 0 天之前已出院的住院。回答会实时显示思考过程、工具调用和引用的住院编号。' : 'AI 能看到全部住院。回答会区分“当时可见”和“事后才知道”。') : '工作台会把病例整理成脱敏上下文，再交给你选的云端模型。' })));
      return;
    }
    for (const m of S.chat.messages) box.append(m.role === 'user' ? userBubble(m.content) : aiBlock(m, false).root);
    box.scrollTop = box.scrollHeight;
  }
  const userBubble = text => h('div', { class: 'msg-user', text });

  function aiBlock(msg, live) {
    const root = h('div', { class: 'msg-ai' });
    const meta = h('div', { class: 'msg-meta' });
    const think = h('details', { class: 'thinking' });
    const thinkSum = h('summary'), thinkBody = h('div', { class: 'body' });
    think.append(thinkSum, thinkBody);
    const tools = h('div', { class: 'tools' }), answer = h('div', { class: 'answer' }), warns = h('div', { class: 'warnings' });
    const status = h('div', { class: 'msg-status' }, h('span', { class: 'live' }), h('span', { text: '正在连接云端模型…' }));
    root.append(meta, think, tools, status, answer, warns);
    const toolEls = {};
    let pending = null, answerText = '', thinkingText = '';
    const toolLine = (ev, state) => h('div', { class: 'tool ' + state }, h('b', { text: TOOL_NAMES[ev.name] || ev.name }),
      h('span', { text: [ev.input && (ev.input.ref || ev.input.keyword), state === 'pending' ? '调用中…' : ev.summary].filter(Boolean).join(' · ') }));
    const api_ = {
      root,
      meta(text) { meta.textContent = text; },
      status(text) { status.lastChild.textContent = text; },
      thinking(text) {
        thinkingText = text; think.hidden = false;
        if (!answerText) think.open = true;
        thinkSum.replaceChildren(h('span', { class: 'live' }), ' 思考中…');
        thinkBody.textContent = text; thinkBody.scrollTop = thinkBody.scrollHeight;
        api_.status('思考中');
      },
      answer(text) {
        if (!answerText && text) { think.open = false; if (thinkingText) thinkSum.textContent = `思考过程（${thinkingText.length} 字）`; status.hidden = true; }
        answerText = text;
        if (pending) return;
        pending = requestAnimationFrame(() => { pending = null; answer.innerHTML = md(answerText) + '<span class="caret"></span>'; scrollChat(); });
      },
      toolStart(ev) { const el = toolLine(ev, 'pending'); toolEls[ev.id] = el; tools.append(el); api_.status('调用工具：' + (TOOL_NAMES[ev.name] || ev.name)); scrollChat(); },
      toolDone(ev) { const el = toolLine(ev, ev.error ? 'err' : ''); if (toolEls[ev.id]) toolEls[ev.id].replaceWith(el); else tools.append(el); toolEls[ev.id] = el; },
      finish({ done, error }) {
        if (pending) { cancelAnimationFrame(pending); pending = null; }
        status.hidden = true;
        answer.innerHTML = md(answerText);
        if (thinkingText) { thinkSum.textContent = `思考过程（${thinkingText.length} 字）`; think.open = false; } else think.hidden = true;
        if (done) {
          meta.textContent = metaText(done);
          (done.warnings || []).forEach(w => warns.append(h('span', { class: 'tag warn', text: '⚠ ' + w })));
          if (!answerText) answer.append(h('div', { class: 'msg-status', text: '（模型没有给出文字回答）' }));
        }
        if (error) root.append(h('div', { class: 'msg-error', text: error }));
      },
    };
    if (live) {
      think.hidden = true;
    } else {
      status.hidden = true;
      meta.textContent = metaText(msg);
      if (msg.thinking) { thinkSum.textContent = `思考过程（${msg.thinking.length} 字）`; thinkBody.textContent = msg.thinking; } else think.hidden = true;
      (msg.tool_events || []).forEach(ev => tools.append(toolLine(ev, '')));
      answer.innerHTML = md(msg.content || '');
      (msg.warnings || []).forEach(w => warns.append(h('span', { class: 'tag warn', text: '⚠ ' + w })));
    }
    return api_;
  }
  function metaText(m) {
    const u = m.usage || {};
    return [m.served_model, m.seconds != null ? `${m.seconds} 秒` : '', u.input ? `输入 ${fmtInt(u.input)}` : '', u.output ? `输出 ${fmtInt(u.output)} tokens` : '', u.reasoning ? `其中推理 ${fmtInt(u.reasoning)}` : '', u.cache_read ? `缓存 ${fmtInt(u.cache_read)}` : ''].filter(Boolean).join(' · ');
  }
  function scrollChat() {
    const box = $('#messages');
    if (box.scrollHeight - box.scrollTop - box.clientHeight < 160) box.scrollTop = box.scrollHeight;
  }

  function setStreaming(on, streamId = '') {
    S.chat.streaming = on; S.chat.streamId = on ? streamId : '';
    const btn = $('#sendBtn');
    btn.textContent = on ? '停止' : '发送';
    btn.classList.toggle('stop', on);
    $$('#quickPrompts button').forEach(b => { b.disabled = on; });
    renderExportBanner();
  }

  async function send(text) {
    text = (text || '').trim();
    if (!text || S.chat.streaming) return;
    if (!S.pid) { toast('请先选择患者'); return; }
    const a = S.status.assistant, p = provider();
    if (!a.allow_export) { toast('未授权外发病例：见右侧提示'); return; }
    if (!p || !p.configured) { toast((p ? p.label : '云端接口') + '未配置'); return; }
    const streamId = Math.random().toString(16).slice(2, 14);
    const payload = { patient_id: S.pid, node_id: S.nodeId, mode: chatMode(), chat_id: S.chat.id, message: text,
      provider: p.provider, model: $('#modelSelect').value, effort: $('#effortSelect').value, stream_id: streamId };
    const box = $('#messages');
    if (!S.chat.messages.length) box.replaceChildren();
    const bubble = userBubble(text);
    box.append(bubble);
    const live = aiBlock({}, true);
    box.append(live.root);
    box.scrollTop = box.scrollHeight;
    $('#composerInput').value = '';
    setStreaming(true, streamId);
    const controller = new AbortController();
    S.chat.controller = controller;
    const started = performance.now();
    let answer = '', thinking = '', done = null, error = null, firstToken = false;
    const timer = setInterval(() => { if (!firstToken) live.status(`模型阅读病例、推理中 · ${((performance.now() - started) / 1000).toFixed(0)} 秒`); }, 500);
    const handle = ev => {
      if (ev.type === 'meta') {
        S.chat.id = ev.chat_id;
        live.meta(`${ev.model} → ${ev.destination}`);
        if (ev.user && ev.user !== text) { bubble.textContent = ev.user; bubble.title = '发送前已隐去身份信息、日期换算为相对天数'; }
      } else if (ev.type === 'thinking') { firstToken = true; thinking += ev.delta; live.thinking(thinking); }
      else if (ev.type === 'content') { firstToken = true; answer += ev.delta; live.answer(answer); }
      else if (ev.type === 'tool_call') { firstToken = true; live.toolStart(ev); }
      else if (ev.type === 'tool_result') live.toolDone(ev);
      else if (ev.type === 'status') live.status(ev.text);
      else if (ev.type === 'done') done = ev;
      else if (ev.type === 'error') error = ev.message;
      else if (ev.type === 'stopped') error = '已停止生成';
    };
    try {
      const res = await fetch('/api/v2/chat/stream', { method: 'POST', signal: controller.signal,
        headers: { 'Content-Type': 'application/json', 'X-HCC-Token': TOKEN }, body: JSON.stringify(payload) });
      if (!res.ok || !res.body) { const d = await res.json().catch(() => ({})); throw new Error(d.error || '请求失败 ' + res.status); }
      const reader = res.body.getReader(), dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done: end } = await reader.read();
        if (end) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (line) { try { handle(JSON.parse(line)); } catch { /* ignore a malformed line */ } }
        }
      }
    } catch (e) {
      error = e.name === 'AbortError' ? '已停止生成' : e.message;
    }
    clearInterval(timer);
    if (!done && !error) error = '连接中断，回答没有保存';
    live.finish({ done, error });
    setStreaming(false);
    if (done) {
      const firstTurn = !S.chat.messages.length;
      S.chat.messages.push({ role: 'user', content: bubble.textContent }, { role: 'assistant', content: answer, thinking, ...done });
      if (S.node) {
        S.node.audit.ai_consulted = true;
        if (firstTurn) S.node.audit.chats = (S.node.audit.chats || 0) + 1;
        if (S.tab === 'blayer') renderTab();
      }
      refreshHistory();
    } else if (!S.chat.messages.length) {
      S.chat.id = '';  // a failed first turn is never saved on the server
    }
  }
  async function stop() {
    const id = S.chat.streamId;
    if (!id) return;
    try { await api.post('/api/v2/chat/stop', { stream_id: id }); } catch { /* fall through to abort */ }
    setTimeout(() => { if (S.chat.streaming && S.chat.controller) S.chat.controller.abort(); }, 1500);
  }

  // ---------- safe markdown (escape first, then add our own tags) ----------
  function esc(t) { return t.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function inline(t) {
    t = esc(t);
    t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
    t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    t = t.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
    t = t.replace(/(^|[^A-Za-z0-9])(E\d{1,4})(?![0-9])/g, '$1<button type="button" class="ref-link" data-ref="$2">$2</button>');
    return t;
  }
  const splitRow = line => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
  function md(src) {
    const lines = String(src || '').replace(/\r/g, '').split('\n');
    const out = [];
    let i = 0;
    const isBlock = l => /^```|^#{1,4}\s|^\s*[-*+]\s+|^\s*\d+[.、)]\s+|^>\s?|^\s*\|.*\|\s*$/.test(l);
    while (i < lines.length) {
      const line = lines[i];
      if (/^```/.test(line)) {
        const buf = []; i++;
        while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
        i++; out.push('<pre><code>' + esc(buf.join('\n')) + '</code></pre>'); continue;
      }
      const hm = line.match(/^(#{1,4})\s+(.*)$/);
      if (hm) { const lv = Math.min(4, hm[1].length + 1); out.push(`<h${lv}>${inline(hm[2])}</h${lv}>`); i++; continue; }
      if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
        const head = splitRow(line); i += 2;
        const rows = [];
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(splitRow(lines[i++]));
        out.push('<table><thead><tr>' + head.map(c => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>' +
          rows.map(r => '<tr>' + r.map(c => `<td>${inline(c)}</td>`).join('') + '</tr>').join('') + '</tbody></table>');
        continue;
      }
      if (/^\s*[-*+]\s+/.test(line) || /^\s*\d+[.、)]\s+/.test(line)) {
        const ordered = /^\s*\d+[.、)]\s+/.test(line);
        const re = ordered ? /^\s*\d+[.、)]\s+/ : /^\s*[-*+]\s+/;
        const items = [];
        while (i < lines.length && (re.test(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && items.length))) {
          if (re.test(lines[i])) items.push(lines[i].replace(re, ''));
          else items[items.length - 1] += ' ' + lines[i].trim();
          i++;
        }
        out.push((ordered ? '<ol>' : '<ul>') + items.map(it => `<li>${inline(it)}</li>`).join('') + (ordered ? '</ol>' : '</ul>'));
        continue;
      }
      if (/^>\s?/.test(line)) {
        const buf = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ''));
        out.push('<blockquote>' + inline(buf.join(' ')) + '</blockquote>'); continue;
      }
      if (/^\s*(---|\*\*\*)\s*$/.test(line)) { out.push('<hr>'); i++; continue; }
      if (!line.trim()) { i++; continue; }
      const buf = [line]; i++;
      while (i < lines.length && lines[i].trim() && !isBlock(lines[i])) buf.push(lines[i++]);
      out.push('<p>' + buf.map(inline).join('<br>') + '</p>');
    }
    return out.join('');
  }

  // ---------- voice & upload (both processed locally by the workbench server) ----------
  let recorder = null;
  const note = text => { $('#composerNote').textContent = text; };
  function insertText(text, input = $('#composerInput')) {
    input.value = input.value ? input.value.replace(/\s*$/, '') + '\n' + text : text;
    input.focus();
  }
  const blobToBase64 = blob => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(new Error('读取文件失败'));
    reader.readAsDataURL(blob);
  });
  async function toggleVoice(target = $('#composerInput'), button = $('#voiceBtn'), say = note) {
    if (!S.status.voice_configured) { toast('本地语音模型未配置（启动时用 --voice-model）'); return; }
    if (recorder) { recorder.stop(); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const chunks = [];
      recorder = new MediaRecorder(stream);
      recorder.ondataavailable = e => chunks.push(e.data);
      recorder.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        const blob = new Blob(chunks, { type: recorder.mimeType });
        recorder = null; button.classList.remove('recording'); say('正在本机转写…');
        try { const r = await api.post('/api/voice', { data: await blobToBase64(blob) }); insertText(r.text, target); say('已转写，请核对药名、剂量和否定词'); }
        catch (e) { toast(e.message); say(''); }
      };
      recorder.start(); button.classList.add('recording'); say('录音中，再点一次结束');
    } catch (e) { toast('无法使用麦克风：' + e.message); }
  }
  async function upload(file, target = $('#composerInput'), say = note) {
    if (!file) return;
    if (file.size > 12 * 1024 * 1024) { toast('文件超过 12 MB'); return; }
    say('正在本机提取文字…');
    try {
      const r = await api.post('/api/upload', { filename: file.name, data: await blobToBase64(file) });
      insertText(`【医生补充 · ${file.name}】\n${r.text}`, target);
      say(`已提取 ${fmtInt(r.characters)} 字（本机处理）`);
    } catch (e) { toast(e.message); say(''); }
  }

  // ---------- treatment map (merged from the old /flow page; whole course) ----------
  const ACTION_LABELS = { TACE: '介入栓塞（TACE）', RESECTION: '肝切除', ABLATION: '消融', HAIC: '肝动脉灌注化疗', RADIATION: '放疗',
    SYSTEMIC: '系统治疗', MULTIMODAL: '多类治疗', OTHER: '其他／未明确', TRANSPLANT: '肝移植' };
  const GOAL_LABELS = { DIRECT_CURATIVE: '直接根治', ENABLE_CURATIVE: '争取根治机会', DISEASE_CONTROL: '控制疾病', PREVENT_RECURRENCE: '预防复发',
    SYMPTOM_COMFORT: '缓解症状', MIXED: '多个治疗目的', UNKNOWN: '待明确', eligible: '具备根治条件', ineligible: '当前不具备根治条件', uncertain: '根治条件待评估' };
  const EVIDENCE_KINDS = [['clinical_note', '病历 / 状态'], ['imaging_report', '影像报告'], ['laboratory', '化验 / 检查'], ['drug_administration', '给药 / 治疗'], ['followup', '随访'], ['doctor_review', '医生复核']];
  const NODE_W = 240, NODE_H = 118;
  const M = { pid: '', graph: null, branch: '', scale: 0.55, tx: 30, ty: 30, selected: null, side: 'analysis', linkFrom: null, drag: null, job: null, jobInfo: null, frame: null, generation: 0, editor: null };
  const when = v => (v ? String(v).replace('T', ' ').slice(0, 16) : '时间待补');
  const pct = v => (v == null ? '—' : (v * 100).toFixed(1) + '%');

  function mapReset() { Object.assign(M, { pid: '', graph: null, branch: '', selected: null, side: 'analysis', linkFrom: null, drag: null, job: null, jobInfo: null }); }

  async function loadMap(center = false) {
    const pid = S.pid, branch = M.branch, generation = ++M.generation;
    const graph = await api.get('/api/v2/map', { id: pid, branch });
    if (generation !== M.generation || pid !== S.pid) return;
    M.pid = pid; M.graph = graph;
    if (S.node) S.node.audit.full_course_viewed = true;
    if (center) { if (graph.nodes.length <= 40) setTimeout(mapFit, 0); else mapFocusCurrent(); } else drawMap();
    renderMapSide();
  }

  function tabMap(body) {
    if (S.mode === 'locked') {
      body.append(h('div', { class: 'lock-card' }, h('h3', { text: '治疗地图包含全部病程' }),
        h('p', { text: '地图会显示节点之后的住院和后续分支，打开会记录为“已查看后续病程”。如果还没填写 B 层判断，建议先填写。' }),
        h('button', { class: 'primary-btn', text: '切到全病程并打开地图', onclick: () => { S.tab = 'map'; setMode('full'); } })));
      return;
    }
    const engine = h('span', { class: 'map-engine', id: 'mapEngine' });
    const toolbar = h('div', { class: 'map-toolbar' },
      h('div', { class: 'map-tools' },
        h('button', { class: 'ghost-btn small', text: '＋ 补录', title: '从选中的节点（默认当前记录）继续', onclick: () => mapEditor(M.selected && M.selected.kind === 'node' ? M.selected.id : null) }),
        h('button', { class: 'ghost-btn small', text: '↗ 连线', onclick: () => mapLinkEditor() }),
        h('button', { class: 'ghost-btn small', text: '↶ 撤销', title: '恢复到上一版补录记录', onclick: mapUndo }),
        h('button', { class: 'ghost-btn small', text: '版本', onclick: mapVersions }),
        h('span', { class: 'divider' }),
        h('button', { class: 'ghost-btn small', text: '−', 'aria-label': '缩小', onclick: () => mapZoom(1 / 1.2) }),
        h('span', { class: 'zoom', id: 'mapZoom', text: '' }),
        h('button', { class: 'ghost-btn small', text: '＋', 'aria-label': '放大', onclick: () => mapZoom(1.2) }),
        h('button', { class: 'ghost-btn small', text: '适应全图', onclick: mapFit }),
        h('button', { class: 'ghost-btn small', text: '定位当前', onclick: mapFocusCurrent }),
        h('button', { class: 'ghost-btn small', text: '↺ 自动布局', onclick: mapResetLayout }),
        h('button', { class: 'ghost-btn small', text: document.querySelector('.node-card.map-max') ? '⤡ 还原' : '⛶ 放大', onclick: mapToggleMax })),
      engine);
    const canvas = h('div', { class: 'map-canvas', id: 'mapCanvas', tabindex: '0', 'aria-label': '治疗地图画布：拖动平移，滚轮缩放，拖动节点调整布局' },
      h('div', { class: 'map-world', id: 'mapWorld' }, s('svg', { class: 'map-edges', id: 'mapEdges' }), h('div', { id: 'mapLabels' }), h('div', { id: 'mapNodes' })),
      h('div', { class: 'map-hint', id: 'mapHint', text: '拖动画布平移 · 滚轮缩放 · 拖动节点调整布局 · 点击查看详情' }));
    body.append(toolbar, h('div', { class: 'map-body' }, canvas, h('aside', { class: 'map-side', id: 'mapSide' }, h('div', { class: 'empty', text: '正在读取治疗地图…' }))));
    bindMapCanvas(canvas);
    if (M.pid === S.pid && M.graph) { drawMap(); renderMapSide(); } else { M.branch = ''; M.selected = null; M.side = 'analysis'; loadMap(true).catch(e => toast(e.message)); }
  }
  function mapToggleMax() {
    const card = document.querySelector('.node-card');
    card.classList.toggle('map-max');
    document.body.classList.toggle('map-maxed', card.classList.contains('map-max'));
    renderTab();
  }

  function mapBounds() {
    const n = M.graph.nodes;
    return { minX: Math.min(0, ...n.map(x => x.x)) - 60, minY: Math.min(...n.map(x => x.y)) - 60,
      maxX: Math.max(400, ...n.map(x => x.x + NODE_W)) + 60, maxY: Math.max(...n.map(x => x.y + NODE_H)) + 60 };
  }
  function mapFit() {
    const c = $('#mapCanvas'); if (!c || !M.graph) return;
    const b = mapBounds(), r = c.getBoundingClientRect();
    M.scale = Math.max(0.02, Math.min(0.9, (r.width - 40) / (b.maxX - b.minX), (r.height - 40) / (b.maxY - b.minY)));
    M.tx = (r.width - (b.maxX - b.minX) * M.scale) / 2 - b.minX * M.scale;
    M.ty = (r.height - (b.maxY - b.minY) * M.scale) / 2 - b.minY * M.scale;
    drawMap();
  }
  function mapFocus(node, scale = 0.75) {
    const c = $('#mapCanvas'); if (!c || !node) return;
    const r = c.getBoundingClientRect();
    M.scale = scale; M.tx = r.width * 0.35 - (node.x + NODE_W / 2) * scale; M.ty = r.height / 2 - (node.y + NODE_H / 2) * scale;
    drawMap();
  }
  function mapFocusCurrent() {
    if (!M.graph) return;
    mapFocus(M.graph.nodes.find(n => n.id === M.graph.current_id) || M.graph.nodes[M.graph.nodes.length - 1], 0.6);
  }
  function mapZoom(mult, cx, cy) {
    const c = $('#mapCanvas'); if (!c) return;
    const r = c.getBoundingClientRect();
    cx = cx ?? r.width / 2; cy = cy ?? r.height / 2;
    const next = Math.max(0.02, Math.min(1.6, M.scale * mult));
    M.tx = cx - (cx - M.tx) * next / M.scale; M.ty = cy - (cy - M.ty) * next / M.scale; M.scale = next;
    drawMap();
  }
  function drawMap() {
    // rAF for smooth panning; a timer fallback because hidden or throttled panes may never fire frames.
    if (M.frame) return;
    const run = () => { if (!M.frame) return; M.frame = null; paintMap(); };
    M.frame = requestAnimationFrame(run) || -1;
    setTimeout(run, 80);
  }
  function edgePath(a, z) {
    const sx = a.x + NODE_W, sy = a.y + NODE_H / 2, ex = z.x, ey = z.y + NODE_H / 2;
    if (ex > sx + 20) {
      const bend = Math.max(50, (ex - sx) * 0.45);
      return { d: `M${sx},${sy} C${sx + bend},${sy} ${ex - bend},${ey} ${ex},${ey}`, x: (sx + ex) / 2, y: (sy + ey) / 2 };
    }
    const mid = Math.max(a.y, z.y) - Math.abs(a.y - z.y) / 2 + (z.y > a.y ? -60 : NODE_H + 60);
    return { d: `M${sx},${sy} H${sx + 40} V${mid} H${ex - 40} V${ey} H${ex}`, x: (sx + ex) / 2, y: mid };
  }
  function paintMap() {
    const world = $('#mapWorld'), c = $('#mapCanvas');
    if (!world || !M.graph) return;
    world.style.transform = `translate(${M.tx}px,${M.ty}px) scale(${M.scale})`;
    $('#mapZoom').textContent = Math.round(M.scale * 100) + '%';
    const r = c.getBoundingClientRect();
    const l = -M.tx / M.scale - 300, t = -M.ty / M.scale - 300, rr = l + r.width / M.scale + 600, b = t + r.height / M.scale + 600;
    const nodes = new Map(M.graph.nodes.map(n => [n.id, n]));
    const visible = M.graph.nodes.filter(n => n.x + NODE_W > l && n.x < rr && n.y + NODE_H > t && n.y < b);
    const box = $('#mapNodes');
    box.replaceChildren(...visible.map(n => {
      const prob = n.probabilities && n.probabilities.next_recorded_action_probability;
      const head = n.kind === 'forecast' ? `后续分支 ${String(n.rank).padStart(2, '0')}` : n.kind === 'operation' ? '状态 · ' + when(n.time) : when(n.time);
      const el = h('div', {
        class: ['map-node', n.kind, n.mode, n.current ? 'current' : '', M.selected && M.selected.id === n.id ? 'selected' : '', M.linkFrom === n.id ? 'link-from' : ''].join(' '),
        dataset: { node: n.id }, role: 'button', tabindex: '0', 'aria-label': n.title || head,
        style: { left: n.x + 'px', top: n.y + 'px', width: NODE_W + 'px', height: NODE_H + 'px' },
      },
      h('div', { class: 'mn-head' }, h('span', { text: head }), h('span', { class: 'mn-origin', text: n.origin || '' })),
      n.kind === 'operation' ? null : h('div', { class: 'mn-title', text: n.title }),
      h('div', { class: 'mn-summary', text: n.summary || '' }),
      h('div', { class: 'mn-foot' },
        prob != null ? h('span', { class: 'tag violet', text: '下次治疗 ' + pct(prob) }) : n.intent ? h('span', { class: 'tag', text: n.intent }) : null,
        n.current ? h('span', { class: 'tag accent', text: '● 当前记录' }) : null,
        n.death ? h('span', { class: 'tag danger', text: '院内死亡' }) : null));
      return el;
    }));
    const svg = $('#mapEdges');
    const bounds = mapBounds();
    svg.setAttribute('width', bounds.maxX + 400); svg.setAttribute('height', bounds.maxY + 400);
    const defs = s('defs', {},
      s('marker', { id: 'mArrow', markerWidth: 8, markerHeight: 8, refX: 7, refY: 4, orient: 'auto' }, s('path', { d: 'M0 0 L8 4 L0 8', style: { fill: 'var(--faint)' } })),
      s('marker', { id: 'mArrowPlan', markerWidth: 8, markerHeight: 8, refX: 7, refY: 4, orient: 'auto' }, s('path', { d: 'M0 0 L8 4 L0 8', style: { fill: 'var(--c-systemic)' } })));
    const paths = [], labels = [];
    for (const e of M.graph.edges) {
      const a = nodes.get(e.source), z = nodes.get(e.target);
      if (!a || !z) continue;
      if (Math.max(a.x, z.x) + NODE_W < l || Math.min(a.x, z.x) > rr || Math.max(a.y, z.y) + NODE_H < t - 200 || Math.min(a.y, z.y) > b + 200) continue;
      const g = edgePath(a, z), planned = e.mode === 'planned';
      paths.push(s('path', { class: 'map-edge' + (planned ? ' planned' : '') + (M.selected && M.selected.id === e.id ? ' selected' : ''), d: g.d,
        'marker-end': `url(#${planned ? 'mArrowPlan' : 'mArrow'})`, onclick: () => mapChoose(e.id, 'edge') }));
      if (M.scale > 0.4 && e.label) {
        labels.push(h('button', { class: 'map-label' + (planned ? ' planned' : ''), title: e.label, text: e.label.length > 18 ? e.label.slice(0, 18) + '…' : e.label,
          style: { left: g.x + 'px', top: g.y + 'px' }, onclick: ev => { ev.stopPropagation(); mapChoose(e.id, 'edge'); } }));
      }
    }
    svg.replaceChildren(defs, ...paths);
    $('#mapLabels').replaceChildren(...labels);
    const hint = $('#mapHint');
    if (hint) hint.textContent = M.linkFrom ? '连线模式：点击终点节点（Esc 取消）' : `${M.graph.episodes.length} 个就诊阶段 · ${M.graph.edges.filter(e => e.procedure_id).length} 项操作 · 版本 v${M.graph.revision}`;
  }

  function bindMapCanvas(canvas) {
    canvas.addEventListener('wheel', e => {
      e.preventDefault();
      const r = canvas.getBoundingClientRect();
      mapZoom(e.deltaY < 0 ? 1.1 : 1 / 1.1, e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });
    canvas.addEventListener('pointerdown', e => {
      if (e.button !== 0 || e.target.closest('.map-label')) return;
      const nodeEl = e.target.closest('.map-node');
      const node = nodeEl ? M.graph.nodes.find(n => n.id === nodeEl.dataset.node) : null;
      M.drag = { id: node ? node.id : null, x: e.clientX, y: e.clientY, ox: node ? node.x : M.tx, oy: node ? node.y : M.ty, moved: false };
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', e => {
      const d = M.drag; if (!d) return;
      const dx = e.clientX - d.x, dy = e.clientY - d.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) d.moved = true;
      if (!d.moved) return;
      if (d.id) { const n = M.graph.nodes.find(x => x.id === d.id); n.x = d.ox + dx / M.scale; n.y = d.oy + dy / M.scale; }
      else { M.tx = d.ox + dx; M.ty = d.oy + dy; }
      drawMap();
    });
    canvas.addEventListener('pointerup', async e => {
      const d = M.drag; M.drag = null;
      if (!d) return;
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
      if (d.id && !d.moved) { mapChoose(d.id, 'node'); return; }
      if (d.id && d.moved) {
        const n = M.graph.nodes.find(x => x.id === d.id);
        try { await api.post('/api/flow/layout', { patient_id: S.pid, branch_id: M.branch, positions: { [n.id]: { x: Math.round(n.x), y: Math.round(n.y) } } }); }
        catch (err) { toast('布局未保存：' + err.message); }
      }
    });
    canvas.addEventListener('keydown', e => { if (e.key === 'Escape' && M.linkFrom) { M.linkFrom = null; drawMap(); } });
  }

  function mapChoose(id, kind) {
    if (M.linkFrom && kind === 'node') {
      const source = M.linkFrom; M.linkFrom = null;
      if (source !== id) { mapLinkEditor(source, id); drawMap(); return; }
    }
    M.selected = { id, kind }; M.side = 'detail';
    drawMap(); renderMapSide();
  }

  function sideTabs() {
    return h('div', { class: 'segmented side-tabs' }, ...[['analysis', 'AI 分析'], ['detail', '详情'], ['edit', '补录']].map(([k, label]) =>
      h('button', { class: M.side === k ? 'active' : '', text: label, onclick: () => { if (k === 'edit') mapEditor(); else { M.side = k; renderMapSide(); } } })));
  }
  function renderMapSide() {
    const side = $('#mapSide'); if (!side || !M.graph) return;
    const engine = $('#mapEngine');
    if (engine) engine.textContent = M.graph.analysis_available ? `AI 分析：${M.graph.analysis_engine}` : 'AI 分析未配置';
    if (M.side === 'edit' && M.editor) { side.replaceChildren(sideTabs(), M.editor); return; }
    side.replaceChildren(sideTabs(), M.side === 'detail' ? mapDetail() : mapAnalysis());
  }

  function probBars(map) {
    return Object.entries(map || {}).sort((a, b) => b[1] - a[1]).map(([k, v]) => h('div', { class: 'cost-row' },
      h('span', { text: GOAL_LABELS[k] || ACTION_LABELS[k] || k }), h('div', { class: 'bar' }, h('i', { style: { width: (v * 100).toFixed(1) + '%' } })), h('span', { class: 'num', text: pct(v) })));
  }
  function mapAnalysis() {
    const box = h('div', { class: 'side-body' });
    const a = M.graph.analysis && M.graph.analysis.analysis;
    const forecasts = M.graph.nodes.filter(n => n.kind === 'forecast').sort((x, y) => x.rank - y.rank);
    if (M.jobInfo) {
      box.append(h('div', { class: 'callout accent' }, h('b', { text: 'AI 分析进行中：' }), M.jobInfo.stage || '排队中'),
        h('ol', { class: 'job-steps' }, ...(M.jobInfo.events || []).map(ev => h('li', { text: `${ev.stage}` }))));
    }
    if (a) {
      box.append(h('div', { class: 'section-title', text: '当前判断' }), h('p', { class: 'side-summary', text: a.summary_zh }),
        h('span', { class: 'tag accent', text: a.intent_zh }));
      box.append(h('div', { class: 'section-title', text: `条件路径（${a.branches.length}）` }));
      a.branches.forEach((br, i) => box.append(h('div', { class: 'branch-card' },
        h('b', { text: `${String(i + 1).padStart(2, '0')} · ${br.title}` }), h('p', { text: br.conditions }), h('p', { class: 'muted', text: '下一阶段：' + br.next_stage }),
        h('button', { class: 'ghost-btn small', text: '在图上查看 ↗', onclick: () => { const n = forecasts.find(f => f.rank === i + 1); if (n) { mapChoose(n.id, 'node'); mapFocus(n); } } }))));
      if (a.questions && a.questions.length) box.append(h('div', { class: 'section-title', text: '优先补充的信息' }), h('ul', { class: 'plain-list' }, ...a.questions.map(q => h('li', { text: q }))));
      const refs = ((M.graph.analysis.public_evidence || {}).references || []).filter(r => String(r.url).startsWith('https://'));
      if (refs.length) box.append(h('div', { class: 'section-title', text: '检索来源' }), ...refs.map(r => h('a', { class: 'ref-a', href: r.url, target: '_blank', rel: 'noopener noreferrer', text: `${r.id} · ${r.title} ↗` })));
      box.append(h('p', { class: 'muted small', text: `相似患者 ${fmtInt((M.graph.analysis.local_retrieval || {}).patients || 0)} 名 · 保存于 ${when(M.graph.analysis.created_at)} · ${M.graph.analysis.model || ''}` }));
    } else if (!M.jobInfo) {
      box.append(h('div', { class: 'callout' }, '画布右端的紫色虚线是本地模型给出的后续分支（下一次住院的治疗类别概率）。AI 分析会结合病程、相似患者和公开指南，整理每条分支的适用条件。'));
    }
    if (forecasts.length && !a) {
      box.append(h('div', { class: 'section-title', text: '本地模型分支' }), ...forecasts.map(n => h('button', { class: 'branch-row', onclick: () => { mapChoose(n.id, 'node'); mapFocus(n); } },
        h('span', { text: n.title }), h('span', { class: 'num', text: pct(n.probabilities && n.probabilities.next_recorded_action_probability) }))));
    }
    const web = h('input', { type: 'checkbox', id: 'mapUseWeb', checked: true });
    box.append(h('div', { class: 'form-foot' }, h('label', { class: 'check' }, web, ' 检索公开指南（不发送病例）'),
      h('button', { class: 'primary-btn', text: a ? '重新分析' : '生成 AI 分析', disabled: !M.graph.analysis_available || !!M.jobInfo, onclick: () => mapAnalyze(true, web.checked) })));
    if (!M.graph.analysis_available) box.append(h('p', { class: 'muted small', text: '需要以 --allow-sensitive-export 启动并保存 OpenAI 密钥。' }));
    return box;
  }

  function mapDetail() {
    const box = h('div', { class: 'side-body' });
    const sel = M.selected;
    const item = sel && (sel.kind === 'edge' ? M.graph.edges.find(e => e.id === sel.id) : M.graph.nodes.find(n => n.id === sel.id));
    if (!item) { box.append(h('div', { class: 'empty', text: '点击地图上的节点或连线查看详情。' })); return box; }
    box.append(h('div', { class: 'eyebrow', text: sel.kind === 'edge' ? '治疗连线' : '病程状态' }), h('h3', { class: 'side-title', text: item.title || item.label || '' }),
      h('p', { class: 'muted small', text: `${when(item.time)} · ${item.origin || (item.mode === 'planned' ? '拟采取' : '记录')}` }));
    if (sel.kind === 'edge') {
      if (item.operation) box.append(h('dl', { class: 'kv' }, ...['name', 'time', 'time_status', 'record_type', 'slot'].filter(k => item.operation[k] != null).flatMap(k => [h('dt', { text: k }), h('dd', { text: String(item.operation[k]) })])));
      if (item.details && item.details.length) box.append(h('div', { class: 'section-title', text: '院内汇总原文' }), ...item.details.map(p => h('p', { text: p.name })));
      return box;
    }
    if (item.summary) box.append(h('p', { class: 'side-summary', text: item.summary }));
    if (item.operations) box.append(h('div', { class: 'section-title', text: `${item.operations.length} 条操作记录` }), ...item.operations.map(p => h('p', { text: `${p.name} · ${when(p.time)}` })));
    if (item.summary_details && item.summary_details.length) box.append(h('div', { class: 'section-title', text: '院内汇总' }), ...item.summary_details.map(p => h('p', { text: p.name })));
    if (item.ai_summary || item.intent || item.candidacy) {
      box.append(h('div', { class: 'section-title', text: 'AI 回顾性重建（使用了后续住院信息，只作参考）' }),
        item.ai_summary ? h('p', { text: item.ai_summary }) : null, item.intent ? h('p', { text: '治疗目的：' + item.intent }) : null,
        item.candidacy ? h('p', { text: '根治条件：' + item.candidacy }) : null);
    }
    if (item.branch) {
      for (const [k, label] of [['conditions', '适用条件与讨论顺序'], ['next_stage', '下一阶段'], ['later_stage', '更远阶段'], ['medication_discussion', '用药讨论'], ['procedure_discussion', '操作讨论']]) {
        if (item.branch[k]) box.append(h('div', { class: 'section-title', text: label }), h('p', { text: item.branch[k] }));
      }
    }
    const p = item.probabilities;
    if (p) {
      box.append(h('div', { class: 'section-title', text: '模型概率' }),
        h('div', { class: 'cost-row' }, h('span', { text: '下一次住院采用该治疗' }), h('div', { class: 'bar' }, h('i', { style: { width: ((p.next_recorded_action_probability || 0) * 100).toFixed(1) + '%' } })), h('span', { class: 'num', text: pct(p.next_recorded_action_probability) })),
        h('div', { class: 'section-title', text: '该治疗条件下 · 下一阶段意图' }), ...probBars(p.astra_next_intent_probabilities),
        h('div', { class: 'section-title', text: '该治疗条件下 · 根治条件' }), ...probBars(p.astra_next_candidacy_probabilities),
        p.predicted_record_gap_days != null ? h('p', { class: 'muted small', text: `下一次住院记录预计间隔约 ${Math.round(p.predicted_record_gap_days)} 天` }) : null,
        h('p', { class: 'muted small', text: '统计对象是下一次住院的记录与 AI 重建标签，不是疗效概率。' }));
    }
    const actions = h('div', { class: 'button-row' },
      h('button', { class: 'ghost-btn small', text: '＋ 从这里补录', onclick: () => mapEditor(item.id) }),
      h('button', { class: 'ghost-btn small', text: '↗ 从这里连线', onclick: () => { M.linkFrom = item.id; drawMap(); toast('请点击连线的终点节点'); } }));
    if (item.kind === 'manual') {
      actions.append(h('button', { class: 'ghost-btn small', text: '更正此记录', onclick: () => mapEditor(item.parent_id, item) }));
      if (item.mode === 'planned') {
        actions.append(h('button', { class: 'ghost-btn small', text: '分析这条方案', onclick: async () => { M.branch = item.id; await loadMap(); mapAnalyze(false, true); } }),
          h('button', { class: 'ghost-btn small', text: '补录为已发生', onclick: () => mapEditor(M.graph.current_id, { ...item, parent_id: M.graph.current_id, mode: 'observed' }) }));
      }
    }
    box.append(actions);
    if (item.clinical_fields) {
      box.append(h('details', { class: 'raw' }, h('summary', { text: '住院原始字段' }),
        h('dl', { class: 'kv' }, ...Object.entries(item.clinical_fields).flatMap(([k, v]) => [h('dt', { text: k }), h('dd', { text: String(v) })]))));
    }
    return box;
  }

  function field(label, control) { return h('label', { class: 'field' }, h('span', { text: label }), control); }
  function select(options, value) { const el = h('select', { class: 'input' }, ...options.map(([v, t]) => h('option', { value: v, text: t }))); el.value = value; return el; }
  function mapEditor(parentId = null, record = null) {
    if (!M.graph) return;
    parentId = parentId || M.graph.current_id;
    const parent = M.graph.nodes.find(n => n.id === parentId);
    const episodes = M.graph.episodes.map(e => [e.id, `${e.title} · ${(e.end || '').slice(0, 10)}`]);
    for (const r of M.graph.records) if (!episodes.some(e => e[0] === r.episode_id)) episodes.push([r.episode_id, '新增就诊阶段']);
    const f = {
      mode: select([['observed', '已发生 · 实线'], ['planned', '拟采取 · 虚线']], (record && record.mode) || (parent && parent.mode === 'planned' ? 'planned' : 'observed')),
      title: h('input', { class: 'input', maxlength: '120', placeholder: '例如：复查后状态', value: (record && record.title) || '' }),
      time: h('input', { class: 'input', type: 'datetime-local', value: ((record && record.time) || '').slice(0, 16) }),
      text: h('textarea', { class: 'input', placeholder: '该阶段的病情、症状和检查' }, (record && record.text) || ''),
      treatment: h('textarea', { class: 'input', placeholder: '已实施或拟采取的治疗、用药、操作' }, (record && record.treatment) || ''),
      intent: h('input', { class: 'input', placeholder: '例如：控制疾病、争取切除机会', value: (record && record.intent) || '' }),
      action: select([['', '未指定'], ...Object.entries(ACTION_LABELS)], (record && record.action) || ''),
      kind: select(EVIDENCE_KINDS, (record && record.evidence_kind) || 'clinical_note'),
      episode: select([['new', '新就诊阶段'], ...episodes], (record && record.episode_id) || 'new'),
      end: h('input', { class: 'input', type: 'datetime-local', value: ((record && record.episode_end) || '').slice(0, 16) }),
    };
    const hint = h('small', { class: 'muted', text: '文件本机解析，语音本机转写。' });
    const say = t => { hint.textContent = t; };
    const voiceBtn = h('button', { type: 'button', class: 'icon-btn', title: '语音输入', text: '🎙', onclick: () => toggleVoice(f.text, voiceBtn, say) });
    const file = h('input', { type: 'file', accept: '.txt,.md,.json,.pdf,.docx', hidden: true, onchange: e => { upload(e.target.files[0], f.text, say); e.target.value = ''; } });
    const submit = h('button', { type: 'submit', class: 'primary-btn', text: record ? '保存更正' : '保存记录' });
    const form = h('form', { class: 'side-body map-form', onsubmit: async e => {
      e.preventDefault();
      if (!f.title.value.trim()) { toast('请填写标题'); return; }
      const payload = { parent_id: parentId, branch_id: M.branch, title: f.title.value, text: f.text.value, treatment: f.treatment.value, intent: f.intent.value,
        mode: f.mode.value, time: f.time.value, action: f.action.value, episode_id: f.episode.value, episode_end: f.end.value, evidence_kind: f.kind.value };
      if (record) payload.id = record.id;
      submit.disabled = true;
      await mapSave('record', payload);
      submit.disabled = false;
    } },
    h('div', { class: 'eyebrow', text: record ? '更正记录' : '继续病程' }), h('p', { class: 'muted small', text: '起点：' + ((parent && parent.title) || '当前记录') }),
    field('记录状态', f.mode), field('标题', f.title), field('发生 / 计划时间', f.time), field('病情、症状和检查', f.text),
    h('div', { class: 'button-row' }, voiceBtn, h('label', { class: 'icon-btn', title: '上传文件' }, '📎', file), hint),
    field('治疗 / 用药 / 操作（显示在连线上）', f.treatment), field('治疗目的', f.intent), field('治疗类别', f.action), field('资料类型', f.kind),
    field('所属就诊阶段', f.episode), field('新阶段已结束时填写结束时间', f.end),
    h('div', { class: 'form-foot' }, h('small', { class: 'muted', text: '“已发生”必须填写时间。' }), submit));
    M.editor = form; M.side = 'edit'; renderMapSide();
  }
  function mapLinkEditor(source = null, target = null) {
    if (!M.graph) return;
    const nodes = M.graph.nodes.map(n => [n.id, `${n.title || '状态'} · ${when(n.time)}`]);
    const src = select(nodes, source || M.graph.current_id), dst = select([['', '请选择'], ...nodes], target || '');
    const label = h('textarea', { class: 'input', placeholder: '治疗、用药或两者之间的联系' });
    const form = h('form', { class: 'side-body map-form', onsubmit: async e => {
      e.preventDefault();
      if (!dst.value || !label.value.trim()) { toast('请选择终点并填写内容'); return; }
      await mapSave('link', { branch_id: M.branch, source: src.value, target: dst.value, label: label.value });
    } },
    h('div', { class: 'eyebrow', text: '绘制治疗连线' }), field('起点', src), field('终点', dst), field('内容', label),
    h('p', { class: 'muted small', text: '也可以在详情里点“从这里连线”，再点终点节点。' }),
    h('div', { class: 'form-foot' }, h('span'), h('button', { type: 'submit', class: 'primary-btn', text: '保存连线' })));
    M.editor = form; M.side = 'edit'; renderMapSide();
  }
  async function mapSave(operation, payload) {
    try {
      const res = await api.post('/api/flow/save', { patient_id: S.pid, revision: M.graph.revision, operation, payload, analyze: false });
      M.branch = res.branch_id || ''; M.editor = null; M.side = 'analysis';
      await loadMap(); toast(`已保存 · v${res.revision}`);
    } catch (e) {
      toast(e.message);
      if (/刷新/.test(e.message)) await loadMap();
    }
  }
  function mapUndo() {
    const last = M.graph && M.graph.versions[M.graph.versions.length - 1];
    if (!last) { toast('当前是原始病程，没有可撤销的补录'); return; }
    mapSave('restore', { revision: last.revision });
  }
  async function mapResetLayout() {
    try { await api.post('/api/flow/layout', { patient_id: S.pid, reset: true, positions: {} }); await loadMap(); mapFit(); toast('已恢复自动布局'); }
    catch (e) { toast(e.message); }
  }
  async function mapVersions() {
    try {
      const res = await api.get('/api/flow/versions', { id: S.pid });
      const dialog = h('dialog', { class: 'versions' },
        h('div', { class: 'dialog-head' }, h('b', { text: '补录版本与已保存分析' }), h('button', { class: 'icon-btn', text: '×', onclick: () => dialog.close() })),
        h('div', { class: 'section-title', text: '补录版本' }),
        ...(res.versions.length ? [...res.versions].reverse().map(v => h('div', { class: 'version-row' },
          h('span', { text: `v${v.revision} · ${when(v.updated_at)} · ${v.records.length} 条补录` }),
          h('button', { class: 'ghost-btn small', text: '恢复此版', onclick: () => { dialog.close(); mapSave('restore', { revision: v.revision }); } }))) : [h('p', { class: 'muted', text: '当前为原始病程版本。' })]),
        h('div', { class: 'section-title', text: '已保存的 AI 分析' }),
        ...(res.analyses.length ? res.analyses.map(a => h('details', {}, h('summary', { text: `v${a.graph_revision ?? '旧版'} · ${when(a.created_at)}` }), h('p', { text: (a.analysis || {}).summary_zh || '' })))
          : [h('p', { class: 'muted', text: '还没有保存的分析。' })]));
      dialog.addEventListener('close', () => dialog.remove());
      document.body.append(dialog); dialog.showModal();
    } catch (e) { toast(e.message); }
  }
  async function mapAnalyze(force, useWeb) {
    if (!M.graph || M.jobInfo) return;
    const pid = S.pid, revision = M.graph.revision, branch = M.branch;
    try {
      const res = await api.post('/api/flow/analyze', { patient_id: pid, revision, branch_id: branch, use_web: useWeb,
        goal: force ? '重新结合当前记录整理治疗条件、优先顺序与下一阶段。' : '' });
      if (res.status === 'cached') { await loadMap(); toast('已恢复这一版本的分析'); return; }
      M.jobInfo = { stage: '排队中', events: [] }; renderMapSide();
      for (;;) {
        const job = await api.get('/api/job', { id: res.job_id });
        if (pid !== S.pid) { M.jobInfo = null; return; }
        M.jobInfo = job; if (S.tab === 'map') renderMapSide();
        if (job.status === 'completed') { M.jobInfo = null; await loadMap(); toast('AI 分析完成，已保存'); return; }
        if (job.status === 'failed') {
          M.jobInfo = null; renderMapSide();
          toast('分析未完成：' + (job.error || '未知错误') + (job.error_status ? `（HTTP ${job.error_status}）` : '')); return;
        }
        await new Promise(r => setTimeout(r, 1500));
      }
    } catch (e) { M.jobInfo = null; renderMapSide(); toast(e.message); }
  }

  // ---------- events ----------
  function bind() {
    let searchTimer = null;
    $('#patientSearch').addEventListener('input', e => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { S.q = e.target.value; loadPatients(true); }, 250); });
    $('#scopeSwitch').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; S.scope = b.dataset.scope; savePref('scope', S.scope); loadPatients(true); });
    $('#loadMore').addEventListener('click', () => loadPatients(false));
    $('#modeSwitch').addEventListener('click', e => { const b = e.target.closest('button'); if (b && !b.disabled) setMode(b.dataset.mode); });
    $('#tabs').addEventListener('click', e => { const b = e.target.closest('button'); if (!b || b.disabled) return; S.tab = b.dataset.tab; renderTabs(); renderTab(); });
    $('#themeToggle').addEventListener('click', cycleTheme);
    $('#togglePatients').addEventListener('click', () => document.body.classList.toggle('show-patients'));
    $('#toggleAssistant').addEventListener('click', () => document.body.classList.toggle('show-assistant'));
    $('#providerSelect').addEventListener('change', () => { savePref('provider', $('#providerSelect').value); renderModels(); if (S.chat.id) { resetChat(); toast('已切换接口，开始新对话'); } renderExportBanner(); });
    $('#modelSelect').addEventListener('change', () => { const p = provider(); if (p) savePref('model.' + p.provider, $('#modelSelect').value); if (S.chat.id) { resetChat(); toast('已切换模型，开始新对话'); } });
    $('#effortSelect').addEventListener('change', () => savePref('effort', $('#effortSelect').value));
    $('#newChat').addEventListener('click', () => { if (S.chat.streaming) { toast('请先停止当前对话'); return; } resetChat(); });
    $('#historySelect').addEventListener('change', e => { if (S.chat.streaming) return; loadChat(e.target.value); });
    $('#composer').addEventListener('submit', e => { e.preventDefault(); if (S.chat.streaming) stop(); else send($('#composerInput').value); });
    $('#composerInput').addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (!S.chat.streaming) send(e.target.value); }
      if (e.key === 'Escape' && S.chat.streaming) stop();
    });
    $('#messages').addEventListener('click', e => { const r = e.target.closest('.ref-link'); if (r && S.pid) openAdmission(r.dataset.ref); });
    $('#voiceBtn').addEventListener('click', () => toggleVoice());
    $('#fileInput').addEventListener('change', e => { upload(e.target.files[0]); e.target.value = ''; });
    let resizeTimer = null;
    window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (S.timeline) renderTimeline(); if (S.tab === 'map') drawMap(); }, 120); });
  }

  async function init() {
    applyTheme(loadPref('theme'));
    bind(); renderLegend();
    try { S.status = await api.get('/api/v2/status'); } catch (e) { toast(e.message); return; }
    renderStatus(); renderWelcomeNotes(); renderProviders(); resetChat();
    await loadPatients(true);
  }
  init();
})();
