// Drop-in member web-chat bubble for the demo site (donor: home-services chat-bubble.js).
// Self-contained: injects its own DOM + styles and talks to the chat API with RELATIVE
// paths (works at / and behind /horry/). Usage: <script src="chat-bubble.js"></script>
// then horryChat.init(). Polls every 1.5 s — no socket needed behind the nginx prefix.
(function () {
  'use strict';

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const CSS = `
  #hecc-bubble { position: fixed; right: 22px; bottom: 22px; height: 56px; padding: 0 22px 0 18px; border-radius: 28px;
    border: none; background: #c2521b; color: #fff; font: 600 15px/1 'IBM Plex Sans', system-ui, sans-serif; cursor: pointer;
    box-shadow: 0 8px 24px rgba(20, 30, 40, .3); z-index: 900; display: inline-flex; align-items: center; gap: 9px; }
  #hecc-bubble:hover { filter: brightness(1.06); }
  #hecc-bubble svg { width: 22px; height: 22px; }
  #hecc-panel { position: fixed; right: 22px; bottom: 90px; width: min(380px, calc(100vw - 32px)); height: min(590px, calc(100vh - 120px));
    background: #fffdf9; color: #1d1b18; border: 1px solid #e2dccf; border-radius: 14px; box-shadow: 0 18px 50px rgba(20, 30, 40, .28);
    display: none; flex-direction: column; overflow: hidden; z-index: 901; font: 15px/1.5 'IBM Plex Sans', system-ui, sans-serif; text-align: left; }
  #hecc-panel.open { display: flex; }
  #hecc-panel .phead { background: #123a5e; color: #fff; padding: 12px 14px; display: flex; align-items: center; gap: 10px; }
  #hecc-panel .pdot { width: 9px; height: 9px; border-radius: 50%; background: #58d68d; flex: none; }
  #hecc-panel .pwho { font-weight: 600; font-size: 14px; }
  #hecc-panel .psub { font-size: 11.5px; opacity: .8; }
  #hecc-panel .pbtns { margin-left: auto; display: flex; align-items: center; gap: 6px; }
  #hecc-panel .pclose { border: none; background: transparent; color: #fff; font-size: 18px; cursor: pointer; padding: 2px 6px; }
  #hecc-end { background: transparent; color: rgba(255,255,255,.85); font: 600 11px 'IBM Plex Sans', sans-serif; letter-spacing: .04em;
    cursor: pointer; padding: 4px 8px; border-radius: 6px; border: 1px solid rgba(255,255,255,.35); }
  #hecc-start { padding: 20px 18px; display: flex; flex-direction: column; gap: 10px; }
  #hecc-start p { margin: 0 0 4px; color: #6b655c; font-size: 13.5px; }
  #hecc-start label { font-size: 12px; color: #6b655c; margin-bottom: -6px; }
  #hecc-start input { font: inherit; font-size: 14px; padding: 10px 12px; border: 1px solid #d9d2c4; border-radius: 8px; background: #fff; }
  #hecc-start button { font: inherit; font-weight: 600; padding: 11px; border: none; border-radius: 8px; background: #c2521b; color: #fff; cursor: pointer; margin-top: 4px; }
  #hecc-start .fine { font-size: 11.5px; color: #8a8378; margin: 2px 0 0; }
  #hecc-msgs { flex: 1; min-height: 0; overflow-y: auto; padding: 14px; display: none; flex-direction: column; gap: 8px; background: #f7f4ee; }
  #hecc-msgs .m { max-width: 84%; padding: 8px 12px; border-radius: 12px; font-size: 13.5px; white-space: pre-wrap; overflow-wrap: anywhere; }
  #hecc-msgs .m.visitor { align-self: flex-end; background: #123a5e; color: #fff; border-bottom-right-radius: 3px; }
  #hecc-msgs .m.assistant, #hecc-msgs .m.agent { align-self: flex-start; background: #fff; border: 1px solid #e2dccf; border-bottom-left-radius: 3px; }
  #hecc-msgs .m.agent { border-left: 3px solid #2f7d4f; }
  #hecc-msgs .m .who { display: block; font-size: 10.5px; font-weight: 600; color: #6b655c; margin-bottom: 2px; }
  #hecc-msgs .m.system { align-self: center; background: #fbeee4; color: #8e3a12; font-size: 12px; border-radius: 999px; padding: 5px 14px; text-align: center; }
  #hecc-msgs .m.system a { display: inline-block; margin-top: 6px; background: #c2521b; color: #fff; text-decoration: none; font-weight: 600; padding: 6px 14px; border-radius: 8px; }
  #hecc-msgs .m.typing { align-self: flex-start; background: #fff; border: 1px solid #e2dccf; color: #6b655c; letter-spacing: 3px; }
  #hecc-chips { display: none; flex-wrap: wrap; gap: 7px; padding: 8px 12px 2px; background: #f7f4ee; }
  #hecc-chips button { font: inherit; font-size: 12.5px; font-weight: 600; padding: 6px 12px; cursor: pointer;
    border: 1.5px solid #c2521b; border-radius: 999px; background: #fff; color: #c2521b; }
  #hecc-chips button:hover { background: #c2521b; color: #fff; }
  #hecc-composer { display: none; gap: 8px; padding: 10px 12px; border-top: 1px solid #e2dccf; background: #fffdf9; }
  #hecc-composer input { flex: 1; font: inherit; font-size: 14px; padding: 9px 12px; border: 1px solid #d9d2c4; border-radius: 8px; }
  #hecc-composer button { font: inherit; font-weight: 600; padding: 9px 16px; border: none; border-radius: 8px; background: #c2521b; color: #fff; cursor: pointer; }
  #hecc-note { font-size: 12.5px; color: #6b655c; text-align: center; padding: 10px 12px 12px; background: #fffdf9; display: none; border-top: 1px solid #e2dccf; }
  #hecc-note button { display: block; margin: 8px auto 0; font: inherit; font-weight: 600; font-size: 13px; padding: 8px 16px; border: 0; border-radius: 8px; background: #c2521b; color: #fff; cursor: pointer; }
  `;

  let root = null;
  let chatId = null;
  let lastSeq = 0;
  let poller = null;
  let typingEl = null;
  let status = 'ai';
  const $ = (id) => document.getElementById(id);
  const ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/></svg>';

  function inject() {
    if (root) return;
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);
    root = document.createElement('div');
    root.innerHTML = `
      <button id="hecc-bubble" type="button" aria-label="Open chat">${ICON}<span>Chat with us</span></button>
      <div id="hecc-panel" role="dialog" aria-label="Chat with Horry Electric">
        <div class="phead">
          <span class="pdot" id="hecc-dot"></span>
          <div><div class="pwho" id="hecc-who">Savannah</div><div class="psub" id="hecc-sub">Virtual assistant · Horry Electric</div></div>
          <span class="pbtns">
            <button id="hecc-end" type="button" style="display:none">End chat</button>
            <button class="pclose" id="hecc-close" type="button" title="Minimize" aria-label="Minimize">—</button>
          </span>
        </div>
        <div id="hecc-start">
          <p>Outage, bill or payment question? Chat with our virtual assistant — a member services representative can join any time.</p>
          <label for="hecc-name">Your name</label>
          <input id="hecc-name" autocomplete="name" />
          <label for="hecc-contact">Phone number or account number (optional)</label>
          <input id="hecc-contact" inputmode="numeric" autocomplete="off" />
          <button id="hecc-go" type="button">Start chat</button>
          <p class="fine">Never type a card number in chat — payments use a secure link.</p>
        </div>
        <div id="hecc-msgs" aria-live="polite"></div>
        <div id="hecc-chips" role="group" aria-label="Quick replies"></div>
        <div id="hecc-note"></div>
        <div id="hecc-composer">
          <input id="hecc-draft" placeholder="Type a message…" autocomplete="off" aria-label="Message" />
          <button id="hecc-send" type="button">Send</button>
        </div>
      </div>`;
    document.body.appendChild(root);
    $('hecc-bubble').addEventListener('click', open);
    $('hecc-close').addEventListener('click', () => $('hecc-panel').classList.remove('open'));
    $('hecc-go').addEventListener('click', startChat);
    $('hecc-contact').addEventListener('keydown', (e) => { if (e.key === 'Enter') startChat(); });
    $('hecc-send').addEventListener('click', sendMsg);
    $('hecc-draft').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendMsg(); });
    $('hecc-end').addEventListener('click', endChat);
  }

  function open() {
    $('hecc-panel').classList.add('open');
    (chatId ? $('hecc-draft') : $('hecc-name')).focus();
  }

  async function startChat() {
    const btn = $('hecc-go');
    btn.disabled = true;
    try {
      const r = await fetch('api/chat/start', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: $('hecc-name').value.trim(), contact: $('hecc-contact').value.trim() }),
      });
      if (!r.ok) throw new Error('start failed');
      const data = await r.json();
      chatId = data.id;
      $('hecc-start').style.display = 'none';
      $('hecc-msgs').style.display = 'flex';
      $('hecc-composer').style.display = 'flex';
      $('hecc-end').style.display = '';
      for (const m of data.messages) addMsg(m);
      renderChips(data.suggestions);
      poller = setInterval(poll, 1500);
      $('hecc-draft').focus();
    } catch {
      alert('Chat is unavailable right now — please call us at 843-369-2211.');
    } finally {
      btn.disabled = false;
    }
  }

  function renderChips(list) {
    const el = $('hecc-chips');
    el.textContent = '';
    const items = Array.isArray(list) ? list : [];
    for (const s of items) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = s;
      b.addEventListener('click', () => { renderChips([]); sendText(s); });
      el.appendChild(b);
    }
    el.style.display = items.length ? 'flex' : 'none';
  }

  function addMsg(m) {
    if (m.seq <= lastSeq) return;
    lastSeq = m.seq;
    clearTyping();
    const el = document.createElement('div');
    el.className = 'm ' + m.role;
    const who = m.role === 'assistant' ? 'Savannah · virtual assistant' : m.role === 'agent' ? (m.by || 'Member Services') + ' · Horry Electric' : '';
    let body = esc(m.text);
    if (m.link && /^pay\.html\?s=[\w-]+$/.test(m.link.href)) body += '<br><a href="' + esc(m.link.href) + '" target="_blank" rel="noopener">' + esc(m.link.label) + '</a>';
    el.innerHTML = (who ? '<span class="who">' + esc(who) + '</span>' : '') + body;
    $('hecc-msgs').appendChild(el);
    $('hecc-msgs').scrollTop = $('hecc-msgs').scrollHeight;
  }
  function showTyping() {
    if (typingEl || status === 'waiting') return;
    typingEl = document.createElement('div');
    typingEl.className = 'm typing';
    typingEl.textContent = '•••';
    $('hecc-msgs').appendChild(typingEl);
    $('hecc-msgs').scrollTop = $('hecc-msgs').scrollHeight;
    setTimeout(clearTyping, 20000);
  }
  function clearTyping() { if (typingEl) { typingEl.remove(); typingEl = null; } }

  async function sendMsg() {
    const text = $('hecc-draft').value.trim();
    if (!text) return;
    $('hecc-draft').value = '';
    await sendText(text);
  }
  async function sendText(text) {
    if (!text || !chatId) return;
    try {
      const r = await fetch('api/chat/' + encodeURIComponent(chatId) + '/message', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }),
      });
      if (r.ok) { await poll(); if (status === 'ai') showTyping(); }
    } catch { /* the poll keeps the thread truthful */ }
  }

  async function endChat() {
    if (!chatId) return;
    try {
      await fetch('api/chat/' + encodeURIComponent(chatId) + '/close', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ by: 'visitor' }),
      });
      await poll();
    } catch { /* poll catches up */ }
  }

  function setHeader(data) {
    if (data.status === 'agent') {
      $('hecc-who').textContent = 'Connected to ' + (data.agentName || 'Member Services');
      $('hecc-sub').textContent = 'Horry Electric · live agent';
    } else if (data.status === 'waiting') {
      $('hecc-who').textContent = 'Connecting you…';
      $('hecc-sub').textContent = 'A member services representative will join shortly';
      $('hecc-dot').style.background = '#f0b44c';
    } else if (data.status === 'ai') {
      $('hecc-who').textContent = 'Savannah';
      $('hecc-sub').textContent = 'Virtual assistant · Horry Electric';
    }
    if (data.status === 'agent') $('hecc-dot').style.background = '#58d68d';
  }

  async function poll() {
    if (!chatId) return;
    try {
      const r = await fetch('api/chat/' + encodeURIComponent(chatId) + '?after=' + lastSeq);
      if (!r.ok) return;
      const data = await r.json();
      for (const m of data.messages) addMsg(m);
      renderChips(data.suggestions);
      if (data.status !== status) { status = data.status; if (status !== 'ai') clearTyping(); }
      setHeader(data);
      if (data.closed) {
        clearInterval(poller);
        clearTyping();
        $('hecc-composer').style.display = 'none';
        $('hecc-chips').style.display = 'none';
        $('hecc-end').style.display = 'none';
        $('hecc-dot').style.background = '#9aa3ad';
        $('hecc-who').textContent = 'Chat ended';
        const note = $('hecc-note');
        note.style.display = 'block';
        note.textContent = 'This conversation has ended.';
        const again = document.createElement('button');
        again.type = 'button';
        again.textContent = 'Start a new chat';
        again.addEventListener('click', resetChat);
        note.appendChild(again);
      }
    } catch { /* transient — next tick retries */ }
  }

  function resetChat() {
    clearInterval(poller);
    chatId = null; lastSeq = 0; status = 'ai'; clearTyping();
    $('hecc-msgs').textContent = '';
    for (const id of ['hecc-msgs', 'hecc-note', 'hecc-chips', 'hecc-end', 'hecc-composer']) $(id).style.display = 'none';
    $('hecc-start').style.display = 'flex';
    $('hecc-who').textContent = 'Savannah';
    $('hecc-sub').textContent = 'Virtual assistant · Horry Electric';
    $('hecc-dot').style.background = '#58d68d';
    $('hecc-name').focus();
  }

  window.horryChat = {
    init() {
      if (document.body) inject();
      else document.addEventListener('DOMContentLoaded', inject);
    },
    open,
  };
})();
