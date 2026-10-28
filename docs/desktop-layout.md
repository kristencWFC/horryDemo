# Desktop layout — Horry widgets

Bundle: `https://kcdev2.workflowconcepts.com/horry/widgets/horry-widgets.js` (built by
`npm run build`, served no-cache). **Deploy the widgets first, then upload the layout**
(kc-wiki wxcc-layout-widget-lockstep). Kristen owns `KC_Horry.json`; Claude proposes, she uploads.

## Supervisor: Storm Operations page

`<horry-supervisor>` = Storm Mode on/off + the broadcast line + **outage queue staffing**
(tick the teams that take outage calls → applies to `Q_Horry_Outage`). Add to the
`supervisor` and `supervisorAgent` personas' `navigation`:

```json
{
  "nav": {
    "label": "Storm Operations",
    "icon": "lightning",
    "iconType": "momentum",
    "navigateTo": "horry-storm-ops",
    "align": "top"
  },
  "page": {
    "id": "horry-storm-ops",
    "widgets": {
      "storm": {
        "comp": "horry-supervisor",
        "script": "https://kcdev2.workflowconcepts.com/horry/widgets/horry-widgets.js",
        "attributes": {
          "server": "https://kcdev2.workflowconcepts.com/horry",
          "darkmode": "$STORE.app.darkMode",
          "supervisor": "$STORE.agent.agentName"
        }
      }
    },
    "layout": { "areas": [["storm"]], "size": { "cols": [1], "rows": [1] } }
  }
}
```

Preview the same widget in a browser: `https://kcdev2.workflowconcepts.com/horry/supervisor.html`.

Agent widgets (member card with NISC data, what the AI did, billing assistant) come next and
will be added here.
