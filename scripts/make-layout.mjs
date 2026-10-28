// Builds deploy/desktop-layout/KC_Horry.json from the Infinity layout
// (../Desktop Layouts/KC_HomeServices.json, Kristen 2026-10-28: "take Crete or Infinity as the
// base, make a copy, add the widget"). Keeps Cisco's built-ins (AI Assistant, state selector,
// outdial, Analyzer/wallboard, journey, team performance, recordings) and strips every other
// demo's widgets — anything loaded from kcdev2 or the Looker report — then adds Horry's pages.
//
//   node scripts/make-layout.mjs            → writes the repo copy + a copy in Desktop Layouts
//
// Upload rule (kc-wiki wxcc-layout-widget-lockstep): deploy the widget bundle FIRST, then upload.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const layoutsDir = join(repo, '..', 'Desktop Layouts');
const SERVER = 'https://kcdev2.workflowconcepts.com/horry';
const BUNDLE = `${SERVER}/widgets/horry-widgets.js`;

const base = JSON.parse(readFileSync(join(layoutsDir, 'KC_HomeServices.json'), 'utf8'));
const removed = [];

/** Another demo's piece = it loads from our dev box (or the old Looker report). */
const foreign = (node) => /kcdev2\.workflowconcepts\.com|lookerstudio\.google\.com/.test(JSON.stringify(node));

function label(tab) {
  return tab?.children?.[0]?.textContent ?? tab?.attributes?.label ?? '(unlabelled)';
}

/** md-tabs children come in (md-tab, md-tab-panel) pairs; drop a pair when its panel is foreign. */
function cleanTabs(tabs) {
  const out = [];
  for (let i = 0; i < tabs.children.length; i += 2) {
    const [tab, panel] = [tabs.children[i], tabs.children[i + 1]];
    if (foreign(panel)) removed.push(`panel tab: ${label(tab)}`);
    else out.push(tab, panel);
  }
  tabs.children = out;
}

/** advancedHeader is a flat array of header widgets. */
function cleanHeader(header) {
  return (header ?? []).filter((c) => {
    if (foreign(c)) {
      removed.push(`header: ${c.comp}`);
      return false;
    }
    return true;
  });
}

const page = (id, label, icon, widget) => ({
  nav: { label, icon, iconType: 'momentum', navigateTo: id, align: 'top' },
  page: {
    id,
    widgets: { main: { ...widget, wrapper: { title: label, maximizeAreaName: 'app-maximize-area' } } },
    layout: { areas: [['main']], size: { cols: [1], rows: [1] } },
  },
});

const stormOps = page('horry-storm-ops', 'Storm Operations', 'lightning', {
  comp: 'horry-supervisor',
  script: BUNDLE,
  attributes: { darkmode: '$STORE.app.darkMode' },
  properties: { server: SERVER, supervisor: '$STORE.agent.agentName' },
});
const callReview = page('horry-call-review', 'Call Review', 'analysis', {
  comp: 'agentx-wc-iframe',
  attributes: { src: `${SERVER}/dashboard.html` },
  properties: { agentId: '$STORE.agent.agentId' },
});

for (const persona of ['agent', 'supervisor', 'supervisorAgent']) {
  const p = base[persona];
  p.appTitle = 'Horry Electric Cooperative';
  const a = p.area;
  if (a.advancedHeader) a.advancedHeader = cleanHeader(a.advancedHeader);
  if (a.headless && foreign(a.headless)) {
    removed.push(`${persona} headless`);
    delete a.headless;
  }
  if (a.panel?.comp === 'md-tabs') cleanTabs(a.panel);
  a.navigation = (a.navigation ?? []).filter((n) => {
    if (foreign(n.page)) {
      removed.push(`${persona} nav: ${n.nav.label}`);
      return false;
    }
    return true;
  });
  // Supervisors get the storm controls; everyone gets the call review.
  if (persona !== 'agent') a.navigation.unshift(structuredClone(stormOps));
  a.navigation.push(structuredClone(callReview));
}

// A persona whose only panel tab was another demo's (supervisorAgent had just "IHS Caller") would
// be left with an empty tab strip — give it the agent persona's Customer Journey tab.
const journeyPair = (() => {
  const ch = base.agent.area.panel?.children ?? [];
  const i = ch.findIndex((t, k) => k % 2 === 0 && label(t) === 'Customer Journey');
  return i >= 0 ? ch.slice(i, i + 2) : [];
})();
for (const persona of ['supervisor', 'supervisorAgent']) {
  const panel = base[persona].area.panel;
  if (panel?.comp === 'md-tabs' && panel.children.length === 0) panel.children = structuredClone(journeyPair);
}

const text = JSON.stringify(base, null, 2) + '\n';
const leftovers = text.match(/kcdev2\.workflowconcepts\.com\/(?!horry)[a-z]*/g) ?? [];
if (leftovers.length) throw new Error(`foreign references left: ${[...new Set(leftovers)].join(', ')}`);

mkdirSync(join(repo, 'deploy', 'desktop-layout'), { recursive: true });
writeFileSync(join(repo, 'deploy', 'desktop-layout', 'KC_Horry.json'), text);
writeFileSync(join(layoutsDir, 'KC_Horry.json'), text);
console.log(`KC_Horry.json written (${text.length} bytes). Removed:\n  ${[...new Set(removed)].join('\n  ')}`);
