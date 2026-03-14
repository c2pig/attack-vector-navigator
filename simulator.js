/* ── Attack Path Simulator — Core Engine ── */

let cy, scenarioData, searchIndex = [], activePathId = 'all';

const OS_ICONS = { windows: '\u{1F5A5}', linux: '\u{1F427}', mixed: '\u{1F310}' };
const PATH_COLORS = ['#6bb8cc','#e8a87c','#c75a5a','#85e89d','#d2a8ff','#f0e68c','#ff9ff3','#54a0ff'];

/* ── INIT ── */
document.addEventListener('DOMContentLoaded', async () => {
  const params = new URLSearchParams(window.location.search);
  const scenarioId = params.get('scenario');
  if (!scenarioId) { window.location.href = 'index.html'; return; }

  try {
    const resp = await fetch(`scenarios/${scenarioId}.json`);
    if (!resp.ok) throw new Error(`Scenario not found: ${scenarioId}`);
    scenarioData = await resp.json();
  } catch (e) {
    document.getElementById('sim-title').textContent = 'Scenario not found';
    return;
  }

  document.title = scenarioData.title + ' — Attack Path Simulator';
  document.getElementById('sim-title').textContent = scenarioData.title;
  document.getElementById('sim-subtitle').textContent =
    `${scenarioData.environment.machine_count} machines · ${scenarioData.environment.network_count} networks`;

  renderScenarioInfo();
  renderPathSelector();
  initGraph();
  buildSearchIndex();
  initSearch();
  initControls();
});

/* ── SCENARIO INFO OVERLAY ── */
function renderScenarioInfo() {
  const d = scenarioData;
  const ind = d.indicators;
  const indNames = [
    ['difficulty','Difficulty'],['cognitive_load','Cog. Load'],
    ['enumeration_depth','Enum Depth'],['rabbit_hole_risk','Rabbit Holes'],
    ['time_pressure','Time Press.']
  ];

  let html = `<div class="si-title">${d.title}</div>`;
  html += `<div class="si-source">${d.source.join(' · ')} · ${d.designed_by}</div>`;
  html += '<div class="si-indicators">';
  for (const [key, label] of indNames) {
    const val = ind[key] || 0;
    html += `<div class="si-indicator">
      <span class="si-indicator-label">${label}</span>
      <span class="si-bar">${Array.from({length:10},(_,i)=>`<span class="si-bar-seg${i<val?' filled':''}${i<val&&val>=7?' high':''}"></span>`).join('')}</span>
      <span class="si-indicator-val">${val}</span>
    </div>`;
  }
  html += '</div>';

  const isStandalone = (!d.connections || d.connections.length === 0) &&
    (d.attack_paths || []).every(p => (p.steps || []).length <= 1);

  html += '<div class="si-meta">';
  html += `<span class="si-tag">${d.environment.os_distribution.windows||0}W ${d.environment.os_distribution.linux||0}L</span>`;
  if (d.environment.has_ad) html += '<span class="si-tag">AD</span>';
  if (d.environment.has_pivoting) html += '<span class="si-tag">PIVOT</span>';
  if (d.environment.has_client_side) html += '<span class="si-tag">CLIENT-SIDE</span>';
  if (isStandalone) html += '<span class="si-tag standalone">STANDALONE · NO LATERAL</span>';
  if (d.exam_relevance?.pattern_frequency) html += `<span class="si-tag">${d.exam_relevance.pattern_frequency.toUpperCase()} FREQ</span>`;
  for (const t of (d.mitre?.tactics || []).slice(0,5)) {
    html += `<span class="si-tag mitre">${t}</span>`;
  }
  html += '</div>';

  if (d.introduction || d.mental_model || d.key_principles?.length) {
    html += '<div class="si-rationale">';
    if (d.introduction) {
      html += `<div class="si-rationale-block">
        <div class="si-rationale-label">SCENARIO BRIEF</div>
        <div class="si-rationale-text">${escapeHtml(d.introduction)}</div>
      </div>`;
    }
    if (d.mental_model) {
      html += `<div class="si-rationale-block">
        <div class="si-rationale-label">MENTAL MODEL</div>
        <div class="si-rationale-text">${escapeHtml(d.mental_model)}</div>
      </div>`;
    }
    if (d.key_principles?.length) {
      html += `<div class="si-rationale-block">
        <div class="si-rationale-label">KEY PRINCIPLES</div>
        <ul class="si-principles">${d.key_principles.map(p => `<li>${escapeHtml(p)}</li>`).join('')}</ul>
      </div>`;
    }
    html += '</div>';
  }

  document.getElementById('scenario-info').innerHTML = html;
}

/* ── PATH SELECTOR ── */
function renderPathSelector() {
  const container = document.getElementById('path-selector');
  const paths = scenarioData.attack_paths || [];
  paths.forEach((p, i) => {
    const btn = document.createElement('button');
    btn.className = 'path-btn';
    btn.dataset.path = p.id;
    btn.innerHTML = `<span class="path-dot" style="background:${p.color || PATH_COLORS[i % PATH_COLORS.length]}"></span>${p.name}`;
    container.appendChild(btn);
  });

  container.addEventListener('click', e => {
    const btn = e.target.closest('.path-btn');
    if (!btn) return;
    container.querySelectorAll('.path-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activePathId = btn.dataset.path;
    highlightPath(activePathId);
  });
}

/* ── CYTOSCAPE GRAPH ── */
function initGraph() {
  const elements = buildElements();

  cy = cytoscape({
    container: document.getElementById('cy'),
    elements: elements,
    style: getCyStyle(),
    layout: { name: 'preset' },
    minZoom: 0.3,
    maxZoom: 3,
    wheelSensitivity: 0.3,
  });

  runLayout();

  cy.on('tap', 'node[type="machine"]', e => {
    openMachinePanel(e.target.data('machineId'));
  });

  cy.on('dbltap', 'node[type="machine"]', e => {
    openMachinePanel(e.target.data('machineId'));
  });

  cy.on('tap', 'edge', e => {
    const idx = e.target.data('connectionIdx');
    if (idx >= 0) {
      openEdgePanel(idx);
    } else {
      openInferredEdgePanel(e.target);
    }
  });

  cy.on('tap', e => {
    if (e.target === cy) closePanel();
  });

  renderLegend();
  renderStandaloneBanner();
}

function buildElements() {
  const els = [];
  const d = scenarioData;

  for (const net of d.networks) {
    els.push({ data: { id: `net-${net.id}`, label: `${net.label}\n${net.cidr}`, type: 'network' } });
  }

  for (const m of d.machines) {
    const parentNet = m.networks?.[0] ? `net-${m.networks[0]}` : undefined;
    const vulnCount = (m.services || []).reduce((s, svc) => s + (svc.vulnerabilities?.length || 0), 0);
    const icon = OS_ICONS[m.os?.toLowerCase()] || OS_ICONS.mixed;
    els.push({
      data: {
        id: m.id,
        label: `${icon} ${m.label}\n${m.ip}`,
        type: 'machine',
        machineId: m.id,
        os: m.os,
        role: m.role || '',
        parent: parentNet,
        vulnCount,
      }
    });
  }

  (d.connections || []).forEach((c, i) => {
    els.push({
      data: {
        id: `edge-${i}`,
        source: c.from,
        target: c.to,
        label: c.technique || '',
        connectionIdx: i,
        pathIds: c.path_ids || [],
      }
    });
  });

  const machineIds = new Set(d.machines.map(m => m.id));
  const existingEdges = new Set((d.connections || []).map(c => `${c.from}->${c.to}`));
  (d.attack_paths || []).forEach(path => {
    const steps = path.steps || [];
    for (let i = 0; i < steps.length - 1; i++) {
      if (!machineIds.has(steps[i]) || !machineIds.has(steps[i + 1])) continue;
      const key = `${steps[i]}->${steps[i + 1]}`;
      if (!existingEdges.has(key)) {
        existingEdges.add(key);
        els.push({ data: {
          id: `inferred-${steps[i]}-${steps[i + 1]}`,
          source: steps[i], target: steps[i + 1],
          label: '', connectionIdx: -1,
          pathIds: [path.id], inferred: true
        }});
      }
    }
  });

  return els;
}

function getCyStyle() {
  return [
    { selector: 'node[type="network"]', style: {
      'background-color': 'rgba(18,20,26,0.6)',
      'border-color': '#2a3a48',
      'border-width': 1,
      'label': 'data(label)',
      'text-valign': 'top',
      'text-halign': 'center',
      'font-family': 'Share Tech Mono, monospace',
      'font-size': 11,
      'color': '#6a8a9a',
      'text-wrap': 'wrap',
      'text-max-width': 200,
      'padding': 30,
      'shape': 'round-rectangle',
      'text-margin-y': -6,
      'events': 'no',
    }},
    { selector: 'node[type="machine"]', style: {
      'background-color': '#181b22',
      'border-color': '#6bb8cc',
      'border-width': 2,
      'label': 'data(label)',
      'text-valign': 'center',
      'text-halign': 'center',
      'font-family': 'Share Tech Mono, monospace',
      'font-size': 12,
      'color': '#c9d6df',
      'text-wrap': 'wrap',
      'text-max-width': 140,
      'width': 120,
      'height': 60,
      'shape': 'round-rectangle',
      'text-margin-y': 0,
      'transition-property': 'border-color, border-width, opacity',
      'transition-duration': '0.2s',
    }},
    { selector: 'node[type="machine"][os="Windows"]', style: { 'border-color': '#6bb8cc' }},
    { selector: 'node[type="machine"][os="Linux"]', style: { 'border-color': '#85e89d' }},
    { selector: 'edge', style: {
      'width': 2,
      'line-color': '#2a3a48',
      'target-arrow-color': '#2a3a48',
      'target-arrow-shape': 'triangle',
      'curve-style': 'bezier',
      'label': 'data(label)',
      'font-family': 'Share Tech Mono, monospace',
      'font-size': 11,
      'color': '#8ab0c0',
      'text-rotation': 'autorotate',
      'text-margin-y': -10,
      'text-background-color': '#0c0e12',
      'text-background-opacity': 0.85,
      'text-background-padding': 3,
      'text-wrap': 'ellipsis',
      'text-max-width': 140,
      'transition-property': 'line-color, target-arrow-color, width, opacity',
      'transition-duration': '0.2s',
    }},
    { selector: 'edge[?inferred]', style: {
      'line-style': 'dashed',
      'line-dash-pattern': [6, 3],
    }},
    { selector: '.highlighted', style: {
      'border-width': 3,
      'z-index': 10,
    }},
    { selector: 'edge.highlighted', style: {
      'width': 3,
      'z-index': 10,
    }},
    { selector: '.dimmed', style: { 'opacity': 0.15 }},
    { selector: '.search-match', style: {
      'border-color': '#e8a87c',
      'border-width': 3,
      'z-index': 20,
    }},
    { selector: 'edge.search-match', style: {
      'line-color': '#e8a87c',
      'target-arrow-color': '#e8a87c',
      'width': 3,
      'z-index': 20,
    }},
  ];
}

function runLayout() {
  const count = scenarioData.machines.length;
  const sep = count > 10 ? 30 : count > 5 ? 40 : 50;
  const rank = count > 10 ? 60 : count > 5 ? 80 : 100;
  cy.layout({
    name: 'dagre',
    rankDir: 'LR',
    nodeSep: sep,
    rankSep: rank,
    edgeSep: 20,
    padding: 40,
    animate: false,
  }).run();
  cy.fit(undefined, 50);
}

function renderLegend() {
  const legend = document.getElementById('cy-legend');
  legend.innerHTML = `
    <div class="cy-legend-item"><span class="cy-legend-dot" style="background:#6bb8cc;"></span> Windows</div>
    <div class="cy-legend-item"><span class="cy-legend-dot" style="background:#85e89d;"></span> Linux</div>
    <div class="cy-legend-item"><span class="cy-legend-dot" style="background:#e8a87c;"></span> Search Match</div>
  `;
}

function renderStandaloneBanner() {
  const d = scenarioData;
  const isStandalone = (!d.connections || d.connections.length === 0) &&
    (d.attack_paths || []).every(p => (p.steps || []).length <= 1);
  if (!isStandalone) return;

  const cyContainer = document.getElementById('cy');
  const banner = document.createElement('div');
  banner.className = 'standalone-banner';
  banner.innerHTML = `STANDALONE MACHINES · NO LATERAL MOVEMENT<br><span style="font-size:10px;color:#6a8a9a;">Each machine is an independent drill — click any machine to view its attack path</span>`;
  cyContainer.appendChild(banner);
}

/* ── PATH HIGHLIGHTING ── */
function highlightPath(pathId) {
  cy.elements().removeClass('highlighted dimmed');

  if (pathId === 'all') return;

  const path = scenarioData.attack_paths.find(p => p.id === pathId);
  if (!path) return;

  const pathColor = path.color || PATH_COLORS[0];
  const stepIds = new Set(path.steps || []);

  cy.elements().addClass('dimmed');

  cy.nodes(`[type="machine"]`).forEach(n => {
    if (stepIds.has(n.data('machineId'))) {
      n.removeClass('dimmed').addClass('highlighted');
      n.style('border-color', pathColor);
      const parent = n.parent();
      if (parent.length) parent.removeClass('dimmed');
    }
  });

  cy.edges().forEach(e => {
    const pids = e.data('pathIds') || [];
    if (pids.includes(pathId) || (stepIds.has(e.data('source')) && stepIds.has(e.data('target')))) {
      e.removeClass('dimmed').addClass('highlighted');
      e.style({ 'line-color': pathColor, 'target-arrow-color': pathColor });
    }
  });
}

/* ── DETAIL PANEL ── */
function openMachinePanel(machineId) {
  const m = scenarioData.machines.find(x => x.id === machineId);
  if (!m) return;

  const panel = document.getElementById('detail-panel');
  const icon = OS_ICONS[m.os?.toLowerCase()] || '';

  let html = `<div class="dp-header">
    <span class="dp-os-icon">${icon}</span>
    <div>
      <div class="dp-title">${m.label}</div>
      <div class="dp-ip">${m.ip} · ${m.os} · ${m.role || ''}</div>
    </div>
    <button class="dp-close" onclick="closePanel()">✕</button>
  </div>`;

  if (m.services?.length) {
    html += '<div class="dp-section"><div class="dp-section-title">Services</div>';
    for (const svc of m.services) {
      const hasCmds = svc.commands?.length || svc.vulnerabilities?.some(v => v.commands?.length);
      html += `<div class="dp-service${hasCmds ? ' has-cmds' : ''}" onclick="toggleCommands(this)">
        <span class="dp-port">${svc.port}</span>
        <div>
          <div class="dp-svc-name">${svc.name} <span class="dp-svc-version">${svc.version || ''}</span>${hasCmds ? ' <span class="dp-chevron">▾</span>' : ''}</div>`;
      for (const v of (svc.vulnerabilities || [])) {
        html += `<div class="dp-vuln-tag">${v.cve || v.type || ''} ${v.summary || ''}</div>`;
      }
      if (svc.commands?.length || svc.vulnerabilities?.some(v => v.commands?.length)) {
        html += '<div class="dp-commands">';
        const cmds = svc.commands || svc.vulnerabilities?.flatMap(v => v.commands || []) || [];
        for (const cmd of cmds) {
          html += renderCommand(cmd);
        }
        html += '</div>';
      }
      html += '</div></div>';
    }
    html += '</div>';
  }

  if (m.privesc?.length) {
    html += '<div class="dp-section"><div class="dp-section-title">Privilege Escalation</div><div class="dp-chain">';
    for (const p of m.privesc) {
      html += `<div class="dp-privesc-row" onclick="toggleCommands(this)">
        <div class="dp-chain-step">
          <span class="dp-chain-user">${p.from}</span>
          <span class="dp-chain-arrow">→</span>
          <span class="dp-chain-technique">${p.technique}</span>
          <span class="dp-chain-arrow">→</span>
          <span class="dp-chain-user">${p.to}</span>
          ${p.commands?.length ? '<span class="dp-chevron">▾</span>' : ''}
        </div>`;
      if (p.commands?.length) {
        html += '<div class="dp-commands">';
        for (const c of p.commands) {
          html += renderCommand(c);
        }
        html += '</div>';
      }
      html += '</div>';
    }
    html += '</div></div>';
  }

  if (m.credentials?.length) {
    html += '<div class="dp-section"><div class="dp-section-title">Credentials Found</div>';
    for (const cr of m.credentials) {
      html += `<div class="dp-cred">
        <span class="dp-cred-user">${cr.user}</span>
        <span class="dp-cred-type">${cr.type || 'password'}</span>
        <span class="dp-cred-unlocks">→ ${(cr.unlocks || []).join(', ')}</span>
      </div>`;
    }
    html += '</div>';
  }

  if (m.alternatives?.length) {
    html += '<div class="dp-section"><div class="dp-section-title">Alternative Approaches</div>';
    for (const alt of m.alternatives) {
      html += `<div class="dp-alt-label">${alt.source || 'ALT'}: ${alt.description}</div>`;
      if (alt.commands?.length) {
        for (const c of alt.commands) {
          html += `<div class="dp-cmd" onclick="copyCmd(this,'${escapeAttr(c)}')">${escapeHtml(c)}</div>`;
        }
      }
    }
    html += '</div>';
  }

  panel.innerHTML = html;
  panel.classList.add('open');
  updateBreadcrumb('machine', m.label);
}

function openEdgePanel(idx) {
  const c = scenarioData.connections[idx];
  if (!c) return;

  const panel = document.getElementById('detail-panel');
  const fromM = scenarioData.machines.find(m => m.id === c.from);
  const toM = scenarioData.machines.find(m => m.id === c.to);

  let html = `<div class="dp-header">
    <div>
      <div class="dp-title">Lateral Movement</div>
      <div class="dp-ip">${fromM?.label || c.from} → ${toM?.label || c.to}</div>
    </div>
    <button class="dp-close" onclick="closePanel()">✕</button>
  </div>`;

  html += '<div class="dp-section">';
  html += `<div class="dp-edge-from">${fromM?.label || c.from} (${fromM?.ip || ''})</div>`;
  html += '<div class="dp-edge-arrow">↓</div>';
  html += `<div class="dp-edge-to">${toM?.label || c.to} (${toM?.ip || ''})</div>`;
  html += '</div>';

  html += '<div class="dp-section">';
  html += `<div class="dp-section-title">Technique</div>`;
  html += `<div class="dp-edge-technique">${c.technique}</div>`;
  if (c.requires) html += `<div class="dp-edge-requires">Requires: ${c.requires}</div>`;
  if (c.pivot) html += `<div class="dp-edge-requires">Pivot: ${c.pivot}</div>`;
  html += '</div>';

  if (c.commands?.length) {
    html += '<div class="dp-section"><div class="dp-section-title">Commands</div>';
    for (const cmd of c.commands) {
      html += renderCommand(cmd);
    }
    html += '</div>';
  }

  panel.innerHTML = html;
  panel.classList.add('open');
  updateBreadcrumb('connection', `${fromM?.label || c.from} → ${toM?.label || c.to}`);
}

function openInferredEdgePanel(edge) {
  const srcId = edge.data('source');
  const tgtId = edge.data('target');
  const pathIds = edge.data('pathIds') || [];
  const fromM = scenarioData.machines.find(m => m.id === srcId);
  const toM = scenarioData.machines.find(m => m.id === tgtId);
  const paths = (scenarioData.attack_paths || []).filter(p => pathIds.includes(p.id));

  const panel = document.getElementById('detail-panel');

  let html = `<div class="dp-header">
    <div>
      <div class="dp-title">Inferred Connection</div>
      <div class="dp-ip">${fromM?.label || srcId} → ${toM?.label || tgtId}</div>
    </div>
    <button class="dp-close" onclick="closePanel()">✕</button>
  </div>`;

  html += '<div class="dp-section">';
  html += `<div class="dp-edge-from">${fromM?.label || srcId} (${fromM?.ip || ''})</div>`;
  html += '<div class="dp-edge-arrow">↓</div>';
  html += `<div class="dp-edge-to">${toM?.label || tgtId} (${toM?.ip || ''})</div>`;
  html += '</div>';

  if (paths.length) {
    html += '<div class="dp-section"><div class="dp-section-title">Attack Paths</div>';
    for (const p of paths) {
      html += `<div class="dp-edge-technique" style="margin-bottom:6px;">
        <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${p.color || '#6a8a9a'};margin-right:6px;"></span>
        ${escapeHtml(p.name)}
      </div>`;
      if (p.description) html += `<div class="dp-edge-requires">${escapeHtml(p.description)}</div>`;
    }
    html += '</div>';
  }

  html += `<div class="dp-section"><div class="dp-section-title" style="color:#6a8a9a;font-size:11px;">
    This connection was inferred from attack path steps. Click the source or target machine for detailed commands.
  </div></div>`;

  panel.innerHTML = html;
  panel.classList.add('open');
  updateBreadcrumb('connection', `${fromM?.label || srcId} → ${toM?.label || tgtId}`);
}

function closePanel() {
  document.getElementById('detail-panel').classList.remove('open');
  updateBreadcrumb('topology');
}

function toggleCommands(el) {
  const cmds = el.querySelector('.dp-commands');
  if (cmds) cmds.classList.toggle('collapsed');
  const chevron = el.querySelector('.dp-chevron');
  if (chevron) chevron.textContent = cmds?.classList.contains('collapsed') ? '▸' : '▾';
}

function updateBreadcrumb(level, label) {
  const bc = document.getElementById('breadcrumb');
  if (level === 'topology') {
    bc.innerHTML = '<span id="bc-l1" class="bc-active">TOPOLOGY</span>';
  } else if (level === 'machine') {
    bc.innerHTML = `<span id="bc-l1" onclick="closePanel()" style="cursor:pointer;">TOPOLOGY</span>
      <span class="bc-sep">›</span>
      <span class="bc-active">${label}</span>`;
  } else if (level === 'connection') {
    bc.innerHTML = `<span id="bc-l1" onclick="closePanel()" style="cursor:pointer;">TOPOLOGY</span>
      <span class="bc-sep">›</span>
      <span class="bc-active">${label}</span>`;
  }
}

/* ── SEARCH ── */
function buildSearchIndex() {
  searchIndex = [];
  const d = scenarioData;

  for (const m of d.machines) {
    searchIndex.push({ type: 'machine', id: m.id, text: [m.label, m.ip, m.os, m.role].join(' ').toLowerCase(), label: m.label, context: m.ip });

    for (const svc of (m.services || [])) {
      const vulnTexts = (svc.vulnerabilities || []).map(v => [v.cve, v.type, v.summary].join(' ')).join(' ');
      const cmdTexts = (svc.commands || []).concat((svc.vulnerabilities || []).flatMap(v => v.commands || [])).map(c => typeof c === 'string' ? c : c.cmd).join(' ');
      searchIndex.push({
        type: 'service', machineId: m.id,
        text: [svc.port, svc.name, svc.version, vulnTexts, cmdTexts].join(' ').toLowerCase(),
        label: `${svc.port}/${svc.name}`, context: m.label
      });
    }

    for (const cr of (m.credentials || [])) {
      searchIndex.push({
        type: 'credential', machineId: m.id,
        text: [cr.user, cr.type, cr.source, ...(cr.unlocks || [])].join(' ').toLowerCase(),
        label: cr.user, context: `${m.label} → ${(cr.unlocks || []).join(', ')}`
      });
    }

    for (const p of (m.privesc || [])) {
      const cmdTexts = (p.commands || []).join(' ');
      searchIndex.push({
        type: 'technique', machineId: m.id,
        text: [p.technique, p.from, p.to, cmdTexts].join(' ').toLowerCase(),
        label: p.technique, context: `${m.label}: ${p.from} → ${p.to}`
      });
    }
  }

  (d.connections || []).forEach((c, i) => {
    const cmdTexts = (c.commands || []).join(' ');
    searchIndex.push({
      type: 'connection', connectionIdx: i,
      text: [c.technique, c.requires, c.pivot, c.from, c.to, cmdTexts].join(' ').toLowerCase(),
      label: c.technique, context: `${c.from} → ${c.to}`
    });
  });

  for (const tag of (d.technique_tags || [])) {
    searchIndex.push({ type: 'tag', text: tag.toLowerCase(), label: tag, context: 'technique tag' });
  }
}

function initSearch() {
  const input = document.getElementById('search-input');
  const resultsPanel = document.getElementById('search-results');
  const countEl = document.getElementById('search-count');

  let debounce;
  input.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      const q = input.value.trim().toLowerCase();
      if (q.length < 2) {
        resultsPanel.classList.remove('active');
        countEl.textContent = '';
        cy.elements().removeClass('search-match dimmed');
        return;
      }
      performSearch(q);
    }, 200);
  });

  input.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      input.value = '';
      resultsPanel.classList.remove('active');
      countEl.textContent = '';
      cy.elements().removeClass('search-match dimmed');
    }
  });
}

function performSearch(query) {
  const results = searchIndex.filter(item => item.text.includes(query));
  const resultsPanel = document.getElementById('search-results');
  const countEl = document.getElementById('search-count');

  cy.elements().removeClass('search-match dimmed');

  if (results.length === 0) {
    resultsPanel.classList.remove('active');
    countEl.textContent = 'No matches';
    return;
  }

  const matchedMachineIds = new Set();
  const matchedEdgeIdxs = new Set();

  for (const r of results) {
    if (r.machineId) matchedMachineIds.add(r.machineId);
    if (r.type === 'machine') matchedMachineIds.add(r.id);
    if (r.type === 'connection') matchedEdgeIdxs.add(r.connectionIdx);
  }

  if (matchedMachineIds.size > 0 || matchedEdgeIdxs.size > 0) {
    cy.elements().addClass('dimmed');
    cy.nodes('[type="network"]').removeClass('dimmed');

    matchedMachineIds.forEach(mid => {
      const node = cy.getElementById(mid);
      if (node.length) { node.removeClass('dimmed').addClass('search-match'); }
    });

    matchedEdgeIdxs.forEach(idx => {
      const edge = cy.getElementById(`edge-${idx}`);
      if (edge.length) { edge.removeClass('dimmed').addClass('search-match'); }
    });
  }

  const grouped = {};
  for (const r of results) {
    if (!grouped[r.type]) grouped[r.type] = [];
    grouped[r.type].push(r);
  }

  const typeLabels = { machine: 'Machines', service: 'Services', credential: 'Credentials', technique: 'Techniques', connection: 'Connections', tag: 'Tags' };
  const typeIcons = { machine: '◻', service: '⚙', credential: '🔑', technique: '⚔', connection: '↔', tag: '#' };

  let html = '';
  for (const [type, items] of Object.entries(grouped)) {
    html += `<div class="search-group-title">${typeLabels[type] || type} (${items.length})</div>`;
    for (const item of items.slice(0, 10)) {
      html += `<div class="search-result-item" data-type="${item.type}" data-machine="${item.machineId || item.id || ''}" data-edge="${item.connectionIdx ?? ''}">
        <span class="sri-icon">${typeIcons[type] || '·'}</span>
        <span class="sri-label">${escapeHtml(item.label)}</span>
        <span class="sri-context">${escapeHtml(item.context || '')}</span>
      </div>`;
    }
  }

  resultsPanel.innerHTML = html;
  resultsPanel.classList.add('active');

  const machineCount = matchedMachineIds.size;
  const edgeCount = matchedEdgeIdxs.size;
  countEl.textContent = `${machineCount} machine${machineCount !== 1 ? 's' : ''}, ${edgeCount} connection${edgeCount !== 1 ? 's' : ''}`;

  resultsPanel.querySelectorAll('.search-result-item').forEach(el => {
    el.addEventListener('click', () => {
      const type = el.dataset.type;
      if (type === 'connection' && el.dataset.edge !== '') {
        openEdgePanel(parseInt(el.dataset.edge));
      } else if (el.dataset.machine) {
        openMachinePanel(el.dataset.machine);
        const node = cy.getElementById(el.dataset.machine);
        if (node.length) cy.animate({ center: { eles: node }, zoom: 1.5, duration: 300 });
      }
      resultsPanel.classList.remove('active');
    });
  });
}

/* ── CONTROLS ── */
function initControls() {
  document.getElementById('btn-zoom-in').addEventListener('click', () => cy.zoom({ level: cy.zoom() * 1.3, renderedPosition: { x: cy.width()/2, y: cy.height()/2 } }));
  document.getElementById('btn-zoom-out').addEventListener('click', () => cy.zoom({ level: cy.zoom() / 1.3, renderedPosition: { x: cy.width()/2, y: cy.height()/2 } }));
  document.getElementById('btn-fit').addEventListener('click', () => cy.fit(undefined, 40));
  document.getElementById('scenario-info').addEventListener('wheel', e => e.stopPropagation());
}

/* ── COPY ── */
function copyCmd(el, text) {
  navigator.clipboard.writeText(text).then(() => {
    el.classList.add('flash');
    showToast();
    setTimeout(() => el.classList.remove('flash'), 800);
  }).catch(() => {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select(); document.execCommand('copy');
    document.body.removeChild(ta);
    el.classList.add('flash'); showToast();
    setTimeout(() => el.classList.remove('flash'), 800);
  });
}

function showToast() {
  const t = document.getElementById('copy-toast');
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 1000);
}

/* ── COMMAND RENDERER ── */
function renderCommand(cmd) {
  if (typeof cmd === 'string') {
    return `<div class="dp-cmd" onclick="event.stopPropagation();copyCmd(this,'${escapeAttr(cmd)}')">${escapeHtml(cmd)}</div>`;
  }
  const c = cmd.cmd || '';
  let html = '';
  if (cmd.rationale) {
    html += `<div class="dp-cmd-rationale">${escapeHtml(cmd.rationale)}</div>`;
  }
  html += `<div class="dp-cmd" onclick="event.stopPropagation();copyCmd(this,'${escapeAttr(c)}')">${escapeHtml(c)}</div>`;
  return html;
}

/* ── UTILS ── */
function escapeHtml(s) { return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function escapeAttr(s) { return (s||'').replace(/'/g,"\\'").replace(/"/g,'&quot;'); }
