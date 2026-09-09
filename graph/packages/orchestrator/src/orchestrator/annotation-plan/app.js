/* global cytoscape, lucide */
(() => {
  const $ = id => document.getElementById(id);
  const states = { READY: 'Готова', AVAILABLE: 'Доступна', RUNNING: 'В работе', WAITING: 'Ожидает', REFERENCE: 'Граница / ссылка' };
  const planStates = { COMPLETE: 'Все аннотации готовы', PAUSED: 'План готов', RUNNING: 'Есть задачи в работе', WAITING: 'Ожидание зависимостей' };
  const fields = `jobId rootId requestedRootStableId maxDepth state observedAt
    nodes { id stableId displayName kind profileId profileVersion state referenceOnly blockedBy }
    edges { id from to role dependencyKind ordinal }
    working { id } waiting { id } available { id }`;
  let plan = null;
  let busy = false;
  const params = new URLSearchParams(location.search);
  if (params.get('stableId')) $('stableId').value = params.get('stableId');
  if (/^[0-8]$/.test(params.get('depth'))) $('depth').value = params.get('depth');
  lucide.createIcons();
  const cy = cytoscape({ container: $('graph'), minZoom: 0.05, maxZoom: 2.5, wheelSensitivity: 0.2,
    style: [
      { selector: 'node', style: { shape: 'roundrectangle', width: 220, height: 66,
        'background-color': '#eef1f4', 'border-color': '#a2acb3', 'border-width': 1.5,
        label: 'data(label)', 'font-family': 'Segoe UI', 'font-size': 12,
        'text-wrap': 'wrap', 'text-max-width': 196, 'text-valign': 'center', color: '#27333b' } },
      { selector: 'node[state="READY"]', style: { 'background-color': '#e9f4ed', 'border-color': '#57a478' } },
      { selector: 'node[state="AVAILABLE"]', style: { 'background-color': '#e7f3fa', 'border-color': '#63a9cd' } },
      { selector: 'node[state="RUNNING"]', style: { 'background-color': '#fff4d5', 'border-color': '#bf9529' } },
      { selector: 'node[state="REFERENCE"]', style: { 'background-color': '#f4eff8', 'border-color': '#af98c1', 'border-style': 'dashed' } },
      { selector: 'node.root', style: { 'border-width': 3, 'border-color': '#16747d' } },
      { selector: 'edge', style: { width: 1.3, 'line-color': '#9aaab3', 'target-arrow-color': '#9aaab3',
        'target-arrow-shape': 'triangle', 'curve-style': 'bezier', label: 'data(role)',
        'font-size': 10, color: '#64727b', 'text-background-color': '#fafbfc', 'text-background-opacity': 1, 'text-background-padding': 3 } },
      { selector: ':selected', style: { 'border-color': '#006fa3', 'border-width': 3, 'line-color': '#006fa3', 'target-arrow-color': '#006fa3' } },
      { selector: '.dim', style: { opacity: 0.18 } },
      { selector: '.match', style: { 'border-color': '#006fa3', 'border-width': 3 } },
    ], elements: [] });
  const name = node => node.displayName || node.kind || node.labels?.[0] || 'Сущность';
  function details(node) {
    $('details').replaceChildren();
    if (!node) return;
    const list = document.createElement('dl');
    for (const [key, value] of Object.entries({ Имя: name(node), Состояние: states[node.state] || 'Стартовый узел',
      Профиль: node.profileId ? `${node.profileId} · v${node.profileVersion}` : node.kind,
      stableId: node.stableId, annotationId: node.annotationId || (node.referenceOnly ? null : node.id),
      Зависимости: node.blockedBy?.length ? node.blockedBy.length : null })) {
      if (value == null) continue;
      const dt = document.createElement('dt'); dt.textContent = key;
      const dd = document.createElement('dd'); dd.textContent = value;
      list.append(dt, dd);
    }
    $('details').append(list);
  }
  function select(id) {
    const element = cy.getElementById(id);
    cy.elements().unselect(); element.select();
    cy.animate({ center: { eles: element }, zoom: Math.max(cy.zoom(), 0.65) }, { duration: 180 });
  }
  cy.on('select', 'node', event => details(event.target.data()));
  function render(next, preserve = false) {
    plan = next;
    const zoom = cy.zoom(), pan = cy.pan();
    const selected = cy.$('node:selected').id();
    const previous = new Map(cy.nodes().map(n => [n.id(), n.position()]));
    const sameTopology = next.nodes.length === cy.nodes().length && next.nodes.every(n => previous.has(n.id))
      && next.edges.length === cy.edges().length && next.edges.every(e => cy.getElementById(e.id).length);
    const elements = next.nodes.map(n => ({ data: { ...n,
      label: `${name(n)}\n${n.kind || 'Ссылка'}` }, classes: n.id === next.rootId ? 'root' : '',
      ...(preserve && sameTopology ? { position: previous.get(n.id) } : {}) }));
    elements.push(...next.edges.map(e => ({ data: { ...e, source: e.from, target: e.to } })));
    cy.elements().remove(); cy.add(elements);
    if (preserve && sameTopology) { cy.zoom(zoom); cy.pan(pan); }
    else cy.layout({ name: 'dagre', rankDir: 'TB', nodeSep: 35, rankSep: 85, padding: 32, animate: false }).run();
    for (const key of ['working', 'waiting', 'available']) {
      const list = $(key); list.replaceChildren(); $(key + 'Count').textContent = next[key].length;
      for (const item of next[key]) {
        const node = next.nodes.find(n => n.id === item.id);
        const button = document.createElement('button'); button.textContent = name(node);
        const small = document.createElement('small'); small.textContent = node.stableId;
        button.append(small); button.onclick = () => select(node.id); list.append(button);
      }
      if (!list.childNodes.length) { const empty = document.createElement('span'); empty.className = 'empty'; empty.textContent = 'Нет задач'; list.append(empty); }
    }
    $('counts').textContent = `${next.nodes.length} узлов · ${next.edges.length} связей · глубина ${next.maxDepth}`;
    $('snapshot').textContent = new Date(next.observedAt).toLocaleTimeString('ru');
    $('status').textContent = planStates[next.state] || next.state;
    $('refresh').disabled = false; $('download').disabled = false;
    const node = cy.getElementById(selected || next.rootId); if (node.length) node.select();
    search();
  }
  function search() {
    const term = $('search').value.trim().toLowerCase();
    cy.elements().removeClass('dim match');
    if (!term) return;
    const matches = cy.nodes().filter(n => [n.data('displayName'), n.data('stableId'), n.data('kind')].some(v => String(v || '').toLowerCase().includes(term)));
    cy.elements().addClass('dim'); matches.removeClass('dim').addClass('match'); matches.connectedEdges().removeClass('dim');
  }
  async function query(source, variables) {
    const response = await fetch('/api/annotations/graphql', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: source, variables }) });
    const result = await response.json();
    if (!response.ok || result.errors?.length || !result.data) throw new Error(result.errors?.map(e => e.message).join('\n') || result.error || `HTTP ${response.status}`);
    return result.data;
  }
  async function load(build) {
    if (busy) return;
    busy = true; $('build').disabled = true; $('refresh').disabled = true; $('error').hidden = true;
    $('status').textContent = build ? 'Получение плана…' : 'Обновление…';
    const input = { stableId: $('stableId').value.trim(), maxDepth: Number($('depth').value) };
    try {
      const result = build
        ? await query(`mutation($input:AnnotationPlanInput!){prepareAnnotationPlan(input:$input){${fields}}}`, { input })
        : await query(`query($jobId:ID!){annotationPlan(jobId:$jobId){${fields}}}`, { jobId: plan?.jobId || params.get('jobId') });
      render(build ? result.prepareAnnotationPlan : result.annotationPlan, !build);
      $('stableId').value = plan.requestedRootStableId; $('depth').value = plan.maxDepth;
      const url = new URL(location.href); url.searchParams.set('jobId', plan.jobId); url.searchParams.set('stableId', plan.requestedRootStableId); url.searchParams.set('depth', plan.maxDepth); history.replaceState(null, '', url);
    } catch (error) {
      $('error').textContent = error.message; $('error').hidden = false; $('status').textContent = 'Ошибка получения плана';
    } finally { busy = false; $('build').disabled = false; $('refresh').disabled = !plan; }
  }
  $('prepare').onsubmit = event => { event.preventDefault(); load(true); };
  $('refresh').onclick = () => load(false);
  $('fit').onclick = () => cy.fit(undefined, 30);
  $('root').onclick = () => select(plan?.rootId || 'initial');
  const zoom = factor => cy.zoom({ level: cy.zoom() * factor, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } });
  $('zoomIn').onclick = () => zoom(1.25); $('zoomOut').onclick = () => zoom(0.8);
  $('search').oninput = search;
  $('download').onclick = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(plan, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = 'annotation-plan.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  new ResizeObserver(() => cy.resize()).observe($('graph'));
  const initial = { id: 'initial', displayName: params.get('name') || 'input', stableId: $('stableId').value, label: params.get('name') || 'input' };
  cy.add({ data: initial, classes: 'root' }); cy.layout({ name: 'grid', fit: false }).run(); cy.zoom(1); cy.center(); details(initial);
  if (params.get('jobId')) load(false);
})();
