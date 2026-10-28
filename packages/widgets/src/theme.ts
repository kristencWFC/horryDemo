// Design tokens for the Horry widgets: co-op navy, storm amber accent. Light by
// default; :host([darkmode="true"]) follows the WxCC Desktop's dark theme.
import { css } from 'lit';

export const themeStyles = css`
  :host {
    --h-bg: #ffffff;
    --h-soft: #f3f5f8;
    --h-border: #d6dce4;
    --h-text: #1b2633;
    --h-dim: #5f6c7b;
    --h-navy: #123a5e;
    --h-accent: #b8620a;
    --h-accent-soft: #fdf0e1;
    --h-ok: #1a7a3c;
    --h-ok-soft: #e6f5eb;
    --h-warn: #8a5a00;
    --h-warn-soft: #fdf3dd;
    --h-danger: #a61b1b;
    --h-danger-soft: #fde8e8;

    display: block;
    font: 13px/1.45 'Segoe UI', system-ui, sans-serif;
    color: var(--h-text);
    background: var(--h-bg);
    padding: 12px;
    box-sizing: border-box;
    height: 100%;
    overflow: auto;
  }
  :host([darkmode='true']) {
    --h-bg: #161c23;
    --h-soft: #1e262f;
    --h-border: #34404d;
    --h-text: #e3e8ee;
    --h-dim: #95a3b2;
    --h-navy: #a9c3df;
    --h-accent: #f0a050;
    --h-accent-soft: #3a2614;
    --h-ok: #6fd394;
    --h-ok-soft: #15301f;
    --h-warn: #e8c27a;
    --h-warn-soft: #382a10;
    --h-danger: #f4a9a8;
    --h-danger-soft: #3d1517;
  }
  * { box-sizing: border-box; }
  h2 { font-size: 14px; margin: 0; color: var(--h-navy); }
  h3 { font-size: 12px; margin: 0; text-transform: uppercase; letter-spacing: 0.05em; color: var(--h-dim); }
  button {
    font: inherit; padding: 6px 12px; border-radius: 6px; cursor: pointer;
    border: 1px solid var(--h-border); background: var(--h-bg); color: var(--h-text);
  }
  button:hover:not(:disabled) { border-color: var(--h-text); }
  button:disabled { opacity: 0.5; cursor: default; }
  button:focus-visible, input:focus-visible { outline: 2px solid var(--h-accent); outline-offset: 2px; }
  button.primary { background: var(--h-accent); border-color: var(--h-accent); color: #fff; font-weight: 600; }
  :host([darkmode='true']) button.primary { color: #1b1206; }
  .card { border: 1px solid var(--h-border); border-radius: 8px; padding: 12px; display: grid; gap: 10px; background: var(--h-bg); }
  .pill { display: inline-block; font-size: 11px; padding: 1px 8px; border-radius: 10px; border: 1px solid var(--h-border); color: var(--h-dim); white-space: nowrap; }
  .pill.ok { border-color: var(--h-ok); color: var(--h-ok); }
  .pill.warn { border-color: var(--h-warn); color: var(--h-warn); }
  .pill.bad { border-color: var(--h-danger); color: var(--h-danger); }
  .dim { color: var(--h-dim); }
  .note { border-left: 3px solid var(--h-warn); background: var(--h-warn-soft); padding: 8px 10px; border-radius: 0 6px 6px 0; }
  .err { border-left: 3px solid var(--h-danger); background: var(--h-danger-soft); padding: 8px 10px; border-radius: 0 6px 6px 0; }
`;
