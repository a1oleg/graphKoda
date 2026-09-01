import { loadBusinessObjectRoute, loadFunctionBusinessObjectRoutes } from './businessObjectRoutes.js';
import { resolveFunctionEntity } from './gatewayForALL.js';

const CANVAS_MARGIN = 40;
const TITLE_HEIGHT = 72;
const LEGEND_HEIGHT = 34;
const ROUTE_HEADER_HEIGHT = 44;
const ROUTE_WIDTH = 280;
const ROUTE_GAP = 30;
const NODE_WIDTH = 232;
const NODE_HEIGHT = 52;
const NODE_GAP = 16;
const ROUTE_PADDING_X = (ROUTE_WIDTH - NODE_WIDTH) / 2;
const ROUTE_PADDING_TOP = 16;

const ROLE_STYLES = {
  parameter: { fill: '#dae8fc', stroke: '#6c8ebf', font: '#1f1f1f' },
  step: { fill: '#d5e8d4', stroke: '#82b366', font: '#1f1f1f' },
  call: { fill: '#fff2cc', stroke: '#d6b656', font: '#1f1f1f' },
  'async-update': { fill: '#f8cecc', stroke: '#b85450', font: '#1f1f1f' },
  'expects-update': { fill: '#ffe6cc', stroke: '#d79b00', font: '#1f1f1f' },
  default: { fill: '#f5f5f5', stroke: '#666666', font: '#1f1f1f' },
};

function escapeXml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function summarizeRoles(roles) {
  return [...new Set((Array.isArray(roles) ? roles : []).filter(Boolean))];
}

function pickRoleStyle(roles) {
  const normalizedRoles = summarizeRoles(roles);
  for (const role of normalizedRoles) {
    if (ROLE_STYLES[role]) {
      return ROLE_STYLES[role];
    }
  }

  return ROLE_STYLES.default;
}

function buildRouteLayout(routes) {
  const routeHeights = routes.map((route) => {
    const nodeCount = Math.max(1, route.nodes?.length || 0);
    return ROUTE_HEADER_HEIGHT + ROUTE_PADDING_TOP * 2 + nodeCount * NODE_HEIGHT + Math.max(0, nodeCount - 1) * NODE_GAP;
  });

  const tallestRoute = Math.max(160, ...routeHeights);
  const canvasWidth = CANVAS_MARGIN * 2 + routes.length * ROUTE_WIDTH + Math.max(0, routes.length - 1) * ROUTE_GAP;
  const canvasHeight = TITLE_HEIGHT + LEGEND_HEIGHT + tallestRoute + CANVAS_MARGIN;
  const routePositions = new Map();
  const nodePositions = new Map();

  routes.forEach((route, routeIndex) => {
    const routeX = CANVAS_MARGIN + routeIndex * (ROUTE_WIDTH + ROUTE_GAP);
    const routeY = TITLE_HEIGHT + LEGEND_HEIGHT;
    routePositions.set(route.businessObjectKey, {
      x: routeX,
      y: routeY,
      width: ROUTE_WIDTH,
      height: routeHeights[routeIndex],
    });

    const nodes = Array.isArray(route.nodes) ? route.nodes : [];
    nodes.forEach((node, nodeIndex) => {
      const x = routeX + ROUTE_PADDING_X;
      const y = routeY + ROUTE_HEADER_HEIGHT + ROUTE_PADDING_TOP + nodeIndex * (NODE_HEIGHT + NODE_GAP);
      nodePositions.set(`${route.businessObjectKey}::${node.stableId}`, {
        x,
        y,
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
      });
    });
  });

  return {
    canvasWidth,
    canvasHeight,
    routePositions,
    nodePositions,
  };
}

function sortRoutes(routes) {
  return [...routes].sort((a, b) => {
    const edgeDelta = (b.edgeCount || 0) - (a.edgeCount || 0);
    if (edgeDelta) {
      return edgeDelta;
    }

    const nodeDelta = (b.nodeCount || 0) - (a.nodeCount || 0);
    if (nodeDelta) {
      return nodeDelta;
    }

    return String(a.businessObjectKey || '').localeCompare(String(b.businessObjectKey || ''));
  });
}

function renderBusinessObjectRoutesDrawio(titleText, routes) {
  const sortedRoutes = sortRoutes(routes);
  const layout = buildRouteLayout(sortedRoutes);
  const { canvasWidth, canvasHeight, routePositions, nodePositions } = layout;
  const lines = [];

  lines.push('<mxfile host="app.diagrams.net" modified="2026-05-15T00:00:00.000Z" agent="GitHub Copilot" version="24.7.17">');
  lines.push('<diagram id="business-object-routes" name="Business Object Routes">');
  lines.push(`<mxGraphModel dx="${canvasWidth}" dy="${canvasHeight}" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="${canvasWidth}" pageHeight="${canvasHeight}" math="0" shadow="0">`);
  lines.push('<root>');
  lines.push('<mxCell id="0" />');
  lines.push('<mxCell id="1" parent="0" />');

  const title = `Business Object Routes\n${titleText || 'Unknown Scope'}`;
  lines.push(`<mxCell id="title" value="${escapeXml(title)}" style="text;html=1;strokeColor=none;fillColor=none;align=left;verticalAlign=middle;whiteSpace=wrap;rounded=0;fontSize=14;fontStyle=1;" vertex="1" parent="1"><mxGeometry x="40" y="14" width="${canvasWidth - 80}" height="48" as="geometry" /></mxCell>`);

  let legendX = 40;
  for (const [role, style] of Object.entries(ROLE_STYLES)) {
    if (role === 'default') continue;
    lines.push(`<mxCell id="legend-${escapeXml(role)}" value="${escapeXml(role)}" style="rounded=1;whiteSpace=wrap;html=1;fillColor=${style.fill};strokeColor=${style.stroke};fontColor=${style.font};fontStyle=1;fontSize=10;align=center;verticalAlign=middle;" vertex="1" parent="1"><mxGeometry x="${legendX}" y="78" width="100" height="22" as="geometry" /></mxCell>`);
    legendX += 110;
  }

  sortedRoutes.forEach((route, routeIndex) => {
    const routePos = routePositions.get(route.businessObjectKey);
    if (!routePos) return;
    const routeId = `route-${routeIndex}`;
    const routeStyle = pickRoleStyle(route.businessObjectRoles);
    const routeTitle = `${route.businessObjectKey}\n${route.nodeCount} nodes В· ${route.edgeCount} edges`;

    lines.push(`<mxCell id="${routeId}-bg" value="" style="rounded=1;whiteSpace=wrap;html=1;fillColor=${routeStyle.fill};strokeColor=${routeStyle.stroke};opacity=25;" vertex="1" parent="1"><mxGeometry x="${routePos.x}" y="${routePos.y}" width="${routePos.width}" height="${routePos.height}" as="geometry" /></mxCell>`);
    lines.push(`<mxCell id="${routeId}-header" value="${escapeXml(routeTitle)}" style="rounded=1;whiteSpace=wrap;html=1;fillColor=${routeStyle.stroke};strokeColor=${routeStyle.stroke};fontColor=#ffffff;fontStyle=1;fontSize=11;align=center;verticalAlign=middle;" vertex="1" parent="1"><mxGeometry x="${routePos.x}" y="${routePos.y}" width="${routePos.width}" height="${ROUTE_HEADER_HEIGHT}" as="geometry" /></mxCell>`);

    (route.nodes || []).forEach((node, nodeIndex) => {
      const nodePos = nodePositions.get(`${route.businessObjectKey}::${node.stableId}`);
      if (!nodePos) return;
      const nodeStyle = pickRoleStyle(node.businessObjectRoles);
      const nodeLabel = `${node.label || node.stableId}${node.operationIndex !== null && node.operationIndex !== undefined ? `\nop #${node.operationIndex}` : ''}`;
      const tooltip = `${node.stableId}${node.parentFnStableId ? `\nparent: ${node.parentFnStableId}` : ''}`;
      lines.push(`<mxCell id="${routeId}-node-${nodeIndex}" value="${escapeXml(nodeLabel)}" tooltip="${escapeXml(tooltip)}" style="rounded=1;whiteSpace=wrap;html=1;fillColor=${nodeStyle.fill};strokeColor=${nodeStyle.stroke};fontColor=${nodeStyle.font};fontSize=10;align=center;verticalAlign=middle;" vertex="1" parent="1"><mxGeometry x="${nodePos.x}" y="${nodePos.y}" width="${nodePos.width}" height="${nodePos.height}" as="geometry" /></mxCell>`);
    });

    (route.edges || []).forEach((edge, edgeIndex) => {
      const sourceIndex = (route.nodes || []).findIndex((node) => node.stableId === edge.sourceStableId);
      const targetIndex = (route.nodes || []).findIndex((node) => node.stableId === edge.targetStableId);
      if (sourceIndex < 0 || targetIndex < 0) return;
      const edgeStyle = pickRoleStyle(edge.businessObjectRoles);
      const edgeLabel = edge.type === 'NEXT' ? '' : edge.type;
      lines.push(`<mxCell id="${routeId}-edge-${edgeIndex}" value="${escapeXml(edgeLabel)}" style="edgeStyle=orthogonalEdgeStyle;rounded=1;orthogonalLoop=1;jettySize=auto;html=1;strokeColor=${edgeStyle.stroke};strokeWidth=1.5;endArrow=block;endFill=1;" edge="1" source="${routeId}-node-${sourceIndex}" target="${routeId}-node-${targetIndex}" parent="1"><mxGeometry relative="1" as="geometry" /></mxCell>`);
    });
  });

  lines.push('</root>');
  lines.push('</mxGraphModel>');
  lines.push('</diagram>');
  lines.push('</mxfile>');
  return lines.join('\n');
}

function renderFunctionBusinessObjectRoutesDrawio(fn, routes) {
  return renderBusinessObjectRoutesDrawio(fn?.label || fn?.name || fn?.stableId || 'Unknown Function', routes);
}

export async function loadFunctionBusinessObjectRoutesDiagram(driver, database, selector) {
  try {
    const fn = await resolveFunctionEntity(driver, database, selector);
    if (!fn?.stableId) {
      return {
        available: false,
        error: 'Function could not be resolved for functionBusinessObjectRoutesDiagram.',
        function: null,
        routeCount: 0,
        nodeCount: 0,
        edgeCount: 0,
        drawioXml: null,
        payload: null,
      };
    }

    const routes = await loadFunctionBusinessObjectRoutes(driver, database, fn);
    const drawioXml = renderFunctionBusinessObjectRoutesDrawio(fn, routes);
    return {
      available: true,
      error: null,
      function: fn,
      routeCount: routes.length,
      nodeCount: routes.reduce((sum, route) => sum + (route.nodeCount || 0), 0),
      edgeCount: routes.reduce((sum, route) => sum + (route.edgeCount || 0), 0),
      drawioXml,
      payload: JSON.stringify({
        function: fn,
        routes,
      }),
    };
  } catch (err) {
    return {
      available: false,
      error: String(err?.message || err),
      function: null,
      routeCount: 0,
      nodeCount: 0,
      edgeCount: 0,
      drawioXml: null,
      payload: null,
    };
  }
}

export async function loadBusinessObjectRouteDiagram(driver, database, businessObjectKey) {
  try {
    const route = await loadBusinessObjectRoute(driver, database, businessObjectKey);
    if (!route) {
      return {
        available: false,
        error: 'Business object route could not be resolved for businessObjectRouteDiagram.',
        businessObjectKey: businessObjectKey || null,
        nodeCount: 0,
        edgeCount: 0,
        drawioXml: null,
        payload: null,
      };
    }

    const drawioXml = renderBusinessObjectRoutesDrawio(route.businessObjectKey, [route]);
    return {
      available: true,
      error: null,
      businessObjectKey: route.businessObjectKey,
      nodeCount: route.nodeCount || 0,
      edgeCount: route.edgeCount || 0,
      drawioXml,
      payload: JSON.stringify({ route }),
    };
  } catch (err) {
    return {
      available: false,
      error: String(err?.message || err),
      businessObjectKey: businessObjectKey || null,
      nodeCount: 0,
      edgeCount: 0,
      drawioXml: null,
      payload: null,
    };
  }
}

