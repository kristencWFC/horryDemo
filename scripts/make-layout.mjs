// Builds deploy/desktop-layout/KC_Horry.json from the ICON layout
// (../Desktop Layouts/KC_ICON.json) — a clean single-demo layout with Cisco's standard pieces in
// every persona: interaction-panel slots (IVR transcript, journey, contact history, screen pop),
// supervisor homepage with Analyzer widgets, team performance, recordings, and the reset-widget.
// (2026-10-28: the first cut used KC_HomeServices.json, which carries every demo and whose
// supervisorAgent persona had no standard tabs — Kristen asked for a clean base.)
//
// Swaps ICON's dialer tab + pages for Horry's, and adds Cisco's AI Assistant to the header of the
// personas that take calls (needed for the auto wrap-up summary).
//
//   node scripts/make-layout.mjs   → writes the repo copy + a copy in GitHub KC/Desktop Layouts
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

const base = JSON.parse(readFileSync(join(layoutsDir, 'KC_ICON.json'), 'utf8'));
const removed = [];

/** ICON's own pieces load from its service on our dev box. */
const icon = (node) => /kcdev2\.workflowconcepts\.com\/icon/.test(JSON.stringify(node));

const AI_ASSISTANT = {
  comp: 'ai-assistant',
  script: 'https://ai-assistant.ciscoccservice.com/ai-assistant-widget.js',
  textContent: 'AI Assistant',
  attributes: {
    orgId: '$STORE.agent.orgId',
    accessToken: '$STORE.auth.accessToken',
    agentId: '$STORE.agent.agentId',
    agentName: '$STORE.agent.agentName',
    darkTheme: '$STORE.app.darkMode',
    aniId: '$STORE.agentContact.taskSelected.ani',
    activeCallId: '$STORE.agentContact.taskSelected',
  },
};

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

  // Interaction panel: drop ICON's (md-tab, md-tab-panel) pair, keep Cisco's slot tabs.
  if (a.panel?.comp === 'md-tabs') {
    const ch = a.panel.children;
    const out = [];
    for (let i = 0; i < ch.length; i++) {
      if (ch[i].comp === 'md-tab' && ch[i + 1]?.comp === 'md-tab-panel' && icon(ch[i + 1])) {
        removed.push(`${persona} panel tab: ${ch[i].children?.[0]?.textContent ?? '?'}`);
        i++; // skip its panel too
        continue;
      }
      out.push(ch[i]);
    }
    a.panel.children = out;
  }

  // Header: AI Assistant after agentx-webex for the personas that handle calls.
  if (persona !== 'supervisor' && Array.isArray(a.advancedHeader) && !a.advancedHeader.some((w) => w.comp === 'ai-assistant')) {
    const at = a.advancedHeader.findIndex((w) => w.comp === 'agentx-webex');
    a.advancedHeader.splice(at + 1, 0, structuredClone(AI_ASSISTANT));
  }

  a.navigation = (a.navigation ?? []).filter((n) => {
    if (icon(n.page)) {
      removed.push(`${persona} nav: ${n.nav.label}`);
      return false;
    }
    return true;
  });
  if (persona !== 'agent') a.navigation.unshift(structuredClone(stormOps));
  a.navigation.push(structuredClone(callReview));
}

const text = JSON.stringify(base, null, 2) + '\n';
if (/icon-dialer|kcdev2\.workflowconcepts\.com\/icon|ICON International/.test(text)) throw new Error('ICON references left over');

mkdirSync(join(repo, 'deploy', 'desktop-layout'), { recursive: true });
writeFileSync(join(repo, 'deploy', 'desktop-layout', 'KC_Horry.json'), text);
writeFileSync(join(layoutsDir, 'KC_Horry.json'), text);
console.log(`KC_Horry.json written (${text.length} bytes). Removed:\n  ${removed.join('\n  ')}`);
