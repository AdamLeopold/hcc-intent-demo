'use strict';
// Static site: stands in for the workbench server inside the browser, for both the treatment map
// (flow.js) and the repeat-TACE workbench (workbench.js). Reads come from data.json (pre-computed
// from script-generated patients); records, chats and "viewed full course" flags live only in this
// page. Nothing is sent anywhere. The same file serves the Chinese and English pages (<html lang="en">).
// Built by scripts/build_static_demo.py; visible messages must not use demo wording (build check).
(() => {
  const realFetch = window.fetch.bind(window);
  const EN = (document.documentElement.lang || '').startsWith('en');
  const L = (zh, en) => (EN ? en : zh);
  let DATA = null;
  const ready = realFetch('data.json').then(r => r.json()).then(d => { DATA = d; });
  const S = { marks: {}, revealed: new Set(), chats: {}, stopped: new Set() };
  const clone = v => JSON.parse(JSON.stringify(v));
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const now = () => new Date().toISOString();
  const wait = ms => new Promise(r => setTimeout(r, ms));

  function canonical(url) {
    const u = new URL(url, location.href);
    const params = [...u.searchParams.entries()].filter(([, v]) => v !== '').sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return { path: u.pathname.replace(/^.*?(\/api\/)/, '/api/'), params: Object.fromEntries(params),
      key: u.pathname.replace(/^.*?(\/api\/)/, '/api/') + (params.length ? '?' + params.map(([k, v]) => `${k}=${v}`).join('&') : '') };
  }
  function stored(key) { const hit = DATA.responses[key]; return hit ? { status: hit.status, body: clone(hit.body) } : null; }
  function reply(key) { const hit = stored(key); return hit ? json(hit.body, hit.status) : json({ error: L('暂无这项数据', 'No data for this request') }, 404); }
  const marksOf = pid => (S.marks[pid] = S.marks[pid] || { revision: 0, nodes: {} });
  const chatsOf = pid => (S.chats[pid] = S.chats[pid] || []);
  const reveal = (pid, node) => S.revealed.add(`${pid}|${node || '*'}`);
  function audit(pid, node) {
    const viewed = S.revealed.has(`${pid}|${node}`) || S.revealed.has(`${pid}|*`);
    const chats = chatsOf(pid).filter(c => c.node_id === node).length;
    return { full_course_viewed: viewed, first_reveal_at: viewed ? now() : null, ai_consulted: chats > 0, chats };
  }
  function nodeData(pid, node) { const hit = stored(`/api/v2/node?id=${pid}&node=${node}`); return hit && hit.status === 200 ? hit.body : null; }

  async function get(url) {
    await ready;
    const { path, params, key } = canonical(url);
    const pid = params.id;
    switch (path) {
      case '/api/v2/patients': {
        const base = stored(`/api/v2/patients?offset=0&scope=${params.scope || 'hcc_nodes'}`).body;
        const q = (params.q || '').toLowerCase();
        const list = base.patients.filter(p => !q || (p.display_name + ' ' + p.patient_id).toLowerCase().includes(q))
          .map(p => ({ ...p, marked_nodes: Object.keys(marksOf(p.patient_id).nodes).length }));
        return json({ patients: list, total: list.length, offset: 0, has_more: false });
      }
      case '/api/v2/patient': {
        const hit = stored(key); if (!hit) return json({ error: L('患者不存在', 'No such patient') }, 400);
        const marks = marksOf(pid).nodes;
        hit.body.nodes.forEach(n => { n.marked = n.node_id in marks; });
        hit.body.chats = chatsOf(pid).map(c => summary(c));
        return json(hit.body, hit.status);
      }
      case '/api/v2/node': {
        const hit = stored(key); if (!hit || hit.status !== 200) return reply(key);
        const m = marksOf(pid);
        Object.assign(hit.body, { record: m.nodes[params.node] || null, marks_revision: m.revision, audit: audit(pid, params.node) });
        return json(hit.body);
      }
      case '/api/v2/timeline': if (params.mode === 'full') reveal(pid, params.node); return reply(key);
      case '/api/v2/hindsight': reveal(pid, params.node); return reply(key);
      case '/api/v2/admission': if (params.mode === 'full') reveal(pid, params.node); return reply(key);
      case '/api/v2/map': reveal(pid, ''); return reply(`/api/v2/map?id=${pid}`);
      case '/api/v2/chats': return json({ chats: chatsOf(pid).map(c => summary(c)) });
      case '/api/v2/chat': { const c = chatsOf(pid).find(x => x.chat_id === params.chat); return c ? json(clone(c)) : json({ error: L('对话不存在', 'No such chat') }, 400); }
      case '/api/flow/patients': {
        const base = stored('/api/flow/patients?offset=0').body;
        const q = (params.q || '').trim().toLowerCase();
        const list = base.patients.filter(p => !q || (p.display_name + p.patient_id).toLowerCase().includes(q));
        return json({ patients: Number(params.offset || 0) ? [] : list, total: list.length, offset: Number(params.offset || 0), has_more: false });
      }
      // The treatment map page reads the same graph the workbench map tab shows.
      case '/api/flow': return params.branch ? reply(key) : reply(`/api/v2/map?id=${pid}`);
      case '/api/job': return json({ error: L('任务不存在', 'No such job') }, 404);
      default: return reply(key);
    }
  }
  const summary = c => ({ chat_id: c.chat_id, node_id: c.node_id, mode: c.mode, model: c.model, created_at: c.created_at,
    updated_at: c.updated_at, turns: c.messages.filter(m => m.role === 'user').length, title: (c.messages[0] || {}).content.slice(0, 40) });

  async function post(url, body) {
    await ready;
    const { path } = canonical(url);
    switch (path) {
      case '/api/v2/marks': {
        const m = marksOf(body.patient_id), rec = body.record || {};
        if (body.revision !== m.revision) return json({ error: L('记录已被更新，请刷新后再保存', 'The record was updated elsewhere; refresh and save again') }, 400);
        if (!rec.state && !Object.keys(rec.families || {}).length && !(rec.missing || rec.reassess || rec.note || '').trim())
          return json({ error: L('请至少填写状态、一个方案判断或缺失信息', 'Fill in at least a state, one action-family judgement or the missing information') }, 400);
        const a = audit(body.patient_id, body.node_id);
        m.nodes[body.node_id] = { ...rec, saved_at: now(), full_course_viewed_before_saving: a.full_course_viewed,
          ai_consulted_before_saving: a.ai_consulted, status: 'workbench_note_not_reference_standard' };
        m.revision += 1;
        return json({ revision: m.revision, record: m.nodes[body.node_id] });
      }
      case '/api/v2/chat/stream': return chatStream(body);
      case '/api/v2/chat/stop': S.stopped.add(body.stream_id); return json({ stopped: true });
      case '/api/flow/save': return json({ error: L('只读模式：治疗地图的修改不会保存。', 'Read-only mode: changes to the treatment map are not saved.') }, 400);
      case '/api/flow/layout': return json({ saved: true, revision: 0 });
      case '/api/flow/analyze': {
        const map = stored(`/api/v2/map?id=${body.patient_id}`);
        return map && map.body.analysis ? json({ status: 'cached' })
          : json({ error: L(`只读模式不运行新的 AI 分析；${DATA.featured.name} 的治疗地图有已保存的分析。`,
            `Read-only mode runs no new AI analysis; the treatment map of ${DATA.featured.name} has a saved analysis.`) }, 400);
      }
      case '/api/upload': {
        if (!/\.(txt|md|json)$/i.test(body.filename || '')) return json({ error: L('只读模式只在本页读取 TXT、Markdown、JSON 文件', 'Read-only mode reads only TXT, Markdown and JSON files, inside this page') }, 400);
        const bytes = Uint8Array.from(atob(body.data || ''), c => c.charCodeAt(0));
        const text = new TextDecoder().decode(bytes).trim();
        return json({ text, characters: text.length, processing: 'local_only' });
      }
      case '/api/voice': return json({ error: L('当前环境不支持语音输入', 'Voice input is not available here') }, 400);
      default: return json({ error: L('当前不支持这项操作', 'This action is not available here') }, 404);
    }
  }

  // ---------- scripted chat ----------
  const CLASS = EN
    ? { TACE: 'TACE', RESECTION: 'resection', ABLATION: 'ablation', TRANSPLANT: 'transplant', HAIC: 'HAIC', RADIATION: 'radiotherapy', SYSTEMIC: 'systemic therapy' }
    : { TACE: 'TACE', RESECTION: '切除', ABLATION: '消融', TRANSPLANT: '移植', HAIC: 'HAIC', RADIATION: '放疗', SYSTEMIC: '系统治疗' };
  const cls = cs => (cs && cs.length ? cs.map(c => CLASS[c] || c).join(L('、', ', ')) : L('未识别治疗', 'unrecognised treatment'));
  const FAMILY_ROWS = EN ? [
    ['Continue TACE', 'Complete or partial response on imaging after the last TACE, liver function tolerable', 'Contrast CT/MRI response, Child-Pugh or ALBI'],
    ['Adjust the TACE approach', 'Residual viable lesion or incomplete embolization', 'Previous embolization extent, feeding arteries'],
    ['Switch to systemic or combination therapy', 'No response to two consecutive TACE, or vascular invasion or extrahepatic metastasis', 'mRECIST response, portal vein, stage'],
    ['Switch to HAIC or radiotherapy', 'Intrahepatic lesions unsuitable for further embolization, or portal vein tumour thrombus', 'Blood supply, target, normal-liver reserve'],
    ['Curative assessment', 'After downstaging, lesion number and size meet criteria for resection, ablation or transplant', 'Lesion number, size, location, liver reserve'],
    ['Palliative support', 'Decompensated liver function or poor performance status', 'Ascites, bilirubin, ECOG'],
    ['Gather missing data first', 'Response and liver-function data missing (common when only the discharge abstract is available)', 'Retrieve imaging reports and lab results'],
    ['Refer to MDT', 'A chance of cure appears, or a strategy switch is disputed', 'Collect staging and tolerance data'],
  ] : [
    ['继续 TACE', '上次 TACE 后影像评估为完全或部分缓解，肝功能可耐受', '增强 CT/MRI 疗效评价、Child-Pugh 或 ALBI'],
    ['调整 TACE 方案', '有残余活性病灶或栓塞不完全', '既往栓塞范围、供血动脉'],
    ['转系统或联合治疗', '连续两次 TACE 不应答，或出现血管侵犯、肝外转移', 'mRECIST 疗效、门静脉、分期'],
    ['转 HAIC 或放疗', '肝内病灶不宜再栓塞，或合并门静脉癌栓', '血供、靶区、正常肝储备'],
    ['根治性评估', '降期后病灶数目和大小进入切除、消融或移植标准', '病灶数目、大小、位置、肝储备'],
    ['姑息支持', '肝功能失代偿或体能差', '腹水、胆红素、ECOG'],
    ['先补资料', '疗效与肝功能资料缺失（只有首页时常见）', '调阅影像报告和化验'],
    ['提交 MDT', '出现根治机会或策略转换有争议', '汇总分期与耐受性资料'],
  ];
  const dash = v => v ?? '—';
  function visibleLines(nd) {
    return nd.visible.map(a => (EN
      ? `- ${a.ref} (day ${a.admission_day}): ${cls(a.classes)}, stay ${dash(a.los_days)} d; ${a.main_diagnosis || 'no primary diagnosis'}`
      : `- ${a.ref}（第 ${a.admission_day} 天）：${cls(a.classes)}，住院 ${dash(a.los_days)} 天；${a.main_diagnosis || '无主要诊断'}`)).join('\n');
  }
  function firedRules(nd) { return nd.rules.filter(r => r.fired); }
  const familyTable = () => FAMILY_ROWS.map(r => `| ${r[0]} | ${r[1]} | ${r[2]} |`).join('\n');
  function brief(nd) {
    const f = nd.features, fired = firedRules(nd);
    if (EN) return `**Conclusion:** from the discharge abstract alone, Layer A leans to **S4 (cannot judge)**. ${f.n_prior_tace} prior TACE make this a point to reassess, but imaging response and liver function are not visible.

### Course visible at the time
${visibleLines(nd)}

### Basis for Layer A
- TACE admission #${nd.node.k}; ${dash(f.days_since_last_tace)} days since discharge from the last TACE, ${dash(f.days_since_first_tace)} days since the first TACE.
- Rule alerts: ${fired.length ? fired.map(r => r.title).join('; ') : 'none'}.
- Without a response assessment, S1 (continuing is reasonable), S2 (suspected failure) and S3 (curative window) cannot be told apart.

### Layer B action families
| Action family | When it applies | What to check |
|---|---|---|
${familyTable()}

### Missing information and reassessment
1. Response on the latest contrast CT/MRI (mRECIST)
2. AFP, bilirubin, albumin (ALBI), coagulation
3. Portal vein involvement, extrahepatic metastasis, performance status

Collect these before the treatment decision on Day 0, then judge again.`;
    return `**结论：** 只凭病案首页，A 层倾向 **S4（无法判断）**。既往 ${f.n_prior_tace} 次 TACE 是复评的时点，但看不到影像疗效和肝功能。

### 当时可见病程
${visibleLines(nd)}

### A 层依据
- 第 ${nd.node.k} 次 TACE 入院；距上次 TACE 出院 ${dash(f.days_since_last_tace)} 天，距首次 TACE ${dash(f.days_since_first_tace)} 天。
- 规则提示：${fired.length ? fired.map(r => r.title).join('；') : '无'}。
- 缺少疗效评价，无法区分 S1（继续合理）、S2（疑似失效）和 S3（根治窗口）。

### B 层行动族
| 行动族 | 适用条件 | 需要核对 |
|---|---|---|
${familyTable()}

### 缺失信息与复评
1. 最近一次增强 CT/MRI 的疗效评价（mRECIST）
2. AFP、胆红素、白蛋白（ALBI）、凝血
3. 门静脉受累、肝外转移、体能状态

建议在第 0 天治疗决策前补齐以上资料再判断。`;
  }
  function missing(nd) {
    if (EN) return `To decide at TACE node #${nd.node.k}, this is the information missing most, in order of importance:

1. **Imaging response after the last TACE** (contrast CT/MRI, mRECIST): decides between S1 and S2.
2. **Liver function** (bilirubin, albumin, ALBI or Child-Pugh): decides whether embolization can continue or a switch to systemic therapy is needed.
3. **Tumour burden and vascular invasion** (lesion number, size, portal vein): decides whether a curative window exists (S3).
4. **AFP trend**: supports the response assessment.
5. **Performance status (ECOG)**: decides between palliative support and active treatment.

The ${nd.visible.length} admissions visible at the time (${nd.visible_refs.join(', ')}) only have diagnosis and procedure names; none of the above is in the discharge abstract.`;
    return `要对第 ${nd.node.k} 次 TACE 节点做决定，按重要性最缺这些信息：

1. **上次 TACE 后的影像疗效**（增强 CT/MRI，mRECIST）：决定是 S1 还是 S2。
2. **肝功能**（胆红素、白蛋白、ALBI 或 Child-Pugh）：决定能否继续栓塞或转系统治疗。
3. **肿瘤负荷与血管侵犯**（病灶数目、大小、门静脉）：决定是否存在根治窗口（S3）。
4. **AFP 动态**：辅助判断疗效。
5. **体能状态（ECOG）**：决定姑息支持还是积极治疗。

当时可见的 ${nd.visible.length} 次住院（${nd.visible_refs.join('、')}）只有诊断和操作名称，以上信息都不在病案首页里。`;
  }
  function rules(nd) {
    const fired = firedRules(nd);
    if (!fired.length) return L('这个节点没有触发规则提示。只有首页信息时，规则提示本身也只是“该复评了”的信号，不是疗效判断。',
      'No rule alert fired at this node. With only the discharge abstract, a rule alert is itself just a “time to reassess” signal, not a response assessment.');
    if (EN) return `${fired.length} rule alerts fired at this node:

${fired.map(r => `- **${r.title}**: ${r.detail}`).join('\n')}

**Limits:** these rules only look at counts, intervals and diagnosis codes. Real “TACE refractoriness” needs two consecutive imaging response assessments, which the discharge abstract does not contain.`;
    return `这个节点触发了 ${fired.length} 条规则提示：

${fired.map(r => `- **${r.title}**：${r.detail}`).join('\n')}

**局限：** 这些规则只看次数、间隔和诊断编码。是否真正“TACE 不应答”，需要连续两次影像疗效评价；病案首页里没有这类信息。`;
  }
  const rate = g => (g.rate == null ? '—' : (g.rate * 100).toFixed(1) + '%');
  function cohort(nd) {
    const c = nd.cohort;
    if (!c.available) return L('队列参考不可用：', 'Cohort reference unavailable: ') + c.reason;
    if (EN) return `How often similar nodes in this hospital actually switched treatment within 180 days:

| Reference group | Nodes | Patients | Switched | Rate |
|---|---|---|---|---|
${c.groups.map(g => `| ${g.label} | ${g.nodes} | ${g.patients} | ${g.positive} | ${rate(g)} |`).join('\n')}

**What it tells us:** what this hospital actually did at similar nodes in the past. **What it does not tell us:** efficacy, benefit, or what this patient “should” have. The sample is tiny, so the numbers are only illustrative.`;
    return `本院同类节点在 180 天内实际发生转换的频率：

| 参考组 | 节点 | 患者 | 发生转换 | 频率 |
|---|---|---|---|---|
${c.groups.map(g => `| ${g.label} | ${g.nodes} | ${g.patients} | ${g.positive} | ${rate(g)} |`).join('\n')}

**能说明什么：** 本院过去在类似节点上实际怎么做。**不能说明什么：** 疗效、获益，或这位患者“应该”怎么做。样本很小，数字只作示意。`;
  }
  function compare(nd, hs) {
    const w = hs.within_window;
    if (EN) return `### Visible at the node
${visibleLines(nd)}

### Known only in hindsight
- Within ${hs.window_days} days after node discharge: ${w.admissions} readmissions; curative treatment: ${w.curative.length ? cls(w.curative) : 'none'}; new switch treatment: ${w.new_switch.length ? cls(w.new_switch) : 'none'}; in-hospital death: ${w.death ? 'yes' : 'no'}.

### Comparison
At the time, the discharge abstract only showed ${nd.features.n_prior_tace} TACE and diagnosis codes; ${w.positive ? 'the switch that followed had no direct basis visible at the time' : 'no switch followed, and nothing visible at the time required one'}. The decision made then can only be judged on what was known then; the later outcome only explains what happened (${hs.label_note}).`;
    return `### 节点当时可见
${visibleLines(nd)}

### 事后才知道
- 节点出院后 ${hs.window_days} 天内再住院 ${w.admissions} 次；根治性治疗：${w.curative.length ? cls(w.curative) : '无'}；新的转换治疗：${w.new_switch.length ? cls(w.new_switch) : '无'}；院内死亡：${w.death ? '是' : '否'}。

### 对比
当时首页只有 ${nd.features.n_prior_tace} 次 TACE 和诊断编码，${w.positive ? '之后发生的转换在当时看不到直接依据' : '之后没有发生转换，当时也看不到必须转换的依据'}。评价当时的决策只能用当时的信息；事后结局只用来解释发生了什么（${hs.label_note}）。`;
  }
  function chronology(pid) {
    const t = stored(`/api/v2/timeline?id=${pid}&mode=full`).body;
    if (EN) return `### All admissions (Day 0 = first admission)
${t.admissions.map(a => `- ${a.ref} (day ${a.admission_day}${a.node_k ? `, TACE node #${a.node_k}` : ''}): ${cls(a.classes)}, stay ${dash(a.los_days)} d${a.death ? ', in-hospital death' : ''}`).join('\n')}

### Treatment sequence
${t.admissions.map(a => cls(a.classes)).join(' → ')}`;
    return `### 全部住院（第 0 天 = 首次入院）
${t.admissions.map(a => `- ${a.ref}（第 ${a.admission_day} 天${a.node_k ? `，第 ${a.node_k} 次 TACE 节点` : ''}）：${cls(a.classes)}，住院 ${dash(a.los_days)} 天${a.death ? '，院内死亡' : ''}`).join('\n')}

### 治疗序列
${t.admissions.map(a => cls(a.classes)).join(' → ')}`;
  }
  // Which scripted answer a question gets; the preset prompts in the workbench contain these words.
  const KIND = EN
    ? { cost: /cost/i, brief: /brief/i, missing: /missing/i, rules: /rule alert/i, cohort: /cohort|how often/i }
    : { cost: /费用/, brief: /简报/, missing: /缺哪些信息|最缺/, rules: /规则提示/, cohort: /队列参考|频率/ };
  function answer(req, mode) {
    const pid = req.patient_id, node = req.node_id, text = req.message || '';
    const nd = node ? nodeData(pid, node) : null;
    const pick = kind => KIND[kind].test(text) && kind;
    const kind = mode === 'full' ? (pick('cost') || 'chronology')
      : mode === 'hindsight' ? 'compare'
      : pick('brief') || pick('missing') || pick('rules') || pick('cohort') || 'free';
    const canned = DATA.canned[`${pid}|${node}|${mode}|${kind}`];
    if (canned) return { model: canned.model, thinking: canned.thinking, content: canned.content, tools: [] };
    const base = { model: L('离线模式', 'Offline mode'), tools: [] };
    if (kind === 'brief') return { ...base, content: brief(nd), thinking: L(
      `读取第 ${nd.node.k} 次 TACE 节点当时可见的 ${nd.visible.length} 次住院；对照规则提示和派生特征；首页没有影像和检验，所以状态只能给 S4；再按 8 个行动族列出条件。`,
      `Read the ${nd.visible.length} admissions visible at TACE node #${nd.node.k}; check the rule alerts and derived features; the discharge abstract has no imaging or labs, so the state can only be S4; then list the conditions for the 8 action families.`) };
    if (kind === 'missing') return { ...base, content: missing(nd), thinking: L('列出做这个决定需要、但病案首页里没有的信息，按对判断的影响排序。',
      'List the information this decision needs that the discharge abstract lacks, ranked by its effect on the judgement.') };
    if (kind === 'rules') return { ...base, content: rules(nd), thinking: L('逐条看触发的规则提示，并说明它们只依据次数、间隔和编码。',
      'Go through each fired rule alert and explain that it relies only on counts, intervals and codes.') };
    if (kind === 'cohort') return { ...base, content: cohort(nd), thinking: L('调用队列参考工具，取同类节点的实际转换频率。',
      'Call the cohort reference tool to get how often similar nodes actually switched.'),
      tools: [{ name: 'cohort_reference', input: {}, summary: nd.cohort.available
        ? nd.cohort.groups.map(g => L(`${g.label}：${g.nodes} 个节点`, `${g.label}: ${g.nodes} nodes`)).join(L('；', '; ')) : L('不可用', 'unavailable') }] };
    if (kind === 'compare') {
      const hs = stored(`/api/v2/hindsight?id=${pid}&node=${node}`).body;
      const switched = hs.within_window.positive;
      return { ...base, content: compare(nd, hs), thinking: L('先列节点当时可见的信息，再调用后续病程工具，最后把两者分开写。',
        'First list what was visible at the node, then call the follow-up tool, and keep the two apart in the answer.'),
        tools: [{ name: 'get_followup', input: {}, summary: L(`之后 ${hs.future.length} 次住院；180 天内转换：${switched ? '是' : '否'}`,
          `${hs.future.length} later admissions; switch within 180 days: ${switched ? 'yes' : 'no'}`) }] };
    }
    if (kind === 'chronology' || kind === 'cost') return { ...base, content: chronology(pid), thinking: L('按时间整理全部住院和治疗类别。',
      'Lay out all admissions and treatment classes in time order.') };
    return { ...base, thinking: L('离线模式：返回这个节点的简报。', 'Offline mode: returning the brief for this node.'),
      content: L('*离线模式只回答固定的几类问题（简报、缺失信息、规则提示、队列参考）。下面是这个节点的简报。*\n\n',
        '*Offline mode answers a fixed set of questions (brief, missing information, rule alerts, cohort reference). Below is the brief for this node.*\n\n') + brief(nd) };
  }
  function chatStream(req) {
    const mode = req.mode === 'full' && req.node_id ? 'hindsight' : req.mode || 'locked';
    const pid = req.patient_id, list = chatsOf(pid);
    let chat = req.chat_id ? list.find(c => c.chat_id === req.chat_id) : null;
    if (!chat) {
      chat = { chat_id: 'C-' + Math.random().toString(16).slice(2, 14).padEnd(24, '0'), patient_id: pid, node_id: req.node_id || '', mode,
        model: 'offline', provider: 'offline', created_at: now(), updated_at: now(), messages: [] };
    }
    const plan = answer(req, mode);
    const encoder = new TextEncoder();
    const started = performance.now();
    const stream = new ReadableStream({
      async start(controller) {
        const send = ev => controller.enqueue(encoder.encode(JSON.stringify(ev) + '\n'));
        const stopped = () => S.stopped.has(req.stream_id);
        send({ type: 'meta', chat_id: chat.chat_id, stream_id: req.stream_id, provider: 'offline', model: plan.model, mode, node_id: chat.node_id,
          destination: L('本机（不联网）', 'This computer (offline)'), context_chars: 0, user: req.message });
        await wait(600);
        for (let i = 0; i < plan.thinking.length; i += 4) { if (stopped()) { send({ type: 'stopped' }); controller.close(); return; } send({ type: 'thinking', delta: plan.thinking.slice(i, i + 4) }); await wait(28); }
        for (const [n, t] of plan.tools.entries()) {
          send({ type: 'tool_call', id: 't' + n, name: t.name }); await wait(500);
          send({ type: 'tool_result', id: 't' + n, name: t.name, input: t.input, summary: t.summary, error: false });
        }
        for (let i = 0; i < plan.content.length; i += 5) { if (stopped()) { send({ type: 'stopped' }); controller.close(); return; } send({ type: 'content', delta: plan.content.slice(i, i + 5) }); await wait(16); }
        const seconds = Math.round((performance.now() - started) / 100) / 10;
        chat.messages.push({ role: 'user', content: req.message, created_at: now() },
          { role: 'assistant', content: plan.content, thinking: plan.thinking, tool_events: plan.tools, warnings: [], usage: {}, served_model: plan.model, seconds, created_at: now() });
        chat.updated_at = now();
        if (!list.includes(chat)) list.push(chat);
        send({ type: 'done', chat_id: chat.chat_id, warnings: [], usage: {}, served_model: plan.model, seconds });
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } });
  }

  window.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (!/\/api\//.test(new URL(url, location.href).pathname)) return realFetch(input, init);
    try {
      if ((init.method || 'GET').toUpperCase() === 'POST') return await post(url, JSON.parse(init.body || '{}'));
      return await get(url);
    } catch (err) {
      return json({ error: L('数据读取失败：', 'Could not read the data: ') + err.message }, 500);
    }
  };
})();
