(async () => {
  "use strict";

  /* ───────────── state ───────────── */
  // Which profile is active is decided by the host project (twentysixseven), not by this app.
  // Its server tells us who is signed in; progress is stored per profile and there is no way to switch here.
  const LEGACY_KEY = "dutchTutor.v1";               // storage from before profiles existed
  const ADOPTED_KEY = "dutchTutor.legacyAdopted";   // which profile took over the legacy data
  const dataKey = id => `${LEGACY_KEY}.${encodeURIComponent(id)}`;
  const DAY = 864e5;
  const TR_MAX = 50; // translation history keeps only the newest 50 lookups, so the saved document never bloats
  const INTERVALS = [0, 1, 3, 7, 14, 30]; // days until next review, per box
  const blank = () => ({ cards: {}, done: {}, streak: { last: null, n: 0 }, best: {}, today: { date: null }, tr: [], trOpen: null, trDir: "en", trDel: {}, epoch: 0 });

  const readJson = k => { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch (e) { return null; } };
  const writeJson = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } };

  // -> { id, host } | null (null: not signed in or not served by the hub; the page does not run)
  function blocked() {
    document.body.innerHTML = '<main style="max-width:520px;margin:20vh auto;padding:0 16px;font:400 16px/1.4 Plein,system-ui,sans-serif;color:var(--ink,#303030)"><p style="font-size:1.4rem;font-weight:500;margin:0 0 8px">Sign in first</p><p style="color:var(--muted,#828282);margin:0">This page only opens through your profile. Start the hub and open it from there.</p></main>';
  }
  async function whoAmI() {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 3000);
    try {
      const r = await fetch("/api/me", { credentials: "same-origin", cache: "no-store", signal: ctl.signal });
      if (r.ok) {
        const j = await r.json();
        if (j && typeof j === "object" && "profile" in j) {
          if (j.profile) return { id: String(j.profile), host: true };
          location.replace("/"); return null;
        }
      }
    } catch (e) { /* not served by the hub (file://, plain static server) */ }
    blocked(); return null;
  }

  const who = await whoAmI();
  if (!who) return;
  const profile = who;

  // Keep the newest TR_MAX lookups. Older ones (and the study progress of their cards) are dropped for good.
  function capTr(st) {
    st.tr.sort((x, y) => y.t - x.t);
    capTr.dropped = st.tr.splice(TR_MAX);
    const live = new Set(st.tr.map(r => "t:" + r.nl));
    for (const id of Object.keys(st.cards)) if (id.startsWith("t:") && !live.has(id)) delete st.cards[id];
    const del = Object.entries(st.trDel || {}); // deletion markers only need to outlive stale devices; keep the newest few
    if (del.length > TR_MAX * 4) st.trDel = Object.fromEntries(del.sort((x, y) => y[1] - x[1]).slice(0, TR_MAX * 4));
    return st;
  }

  function loadData(id) {
    if (!readJson(dataKey(id)) && !localStorage.getItem(ADOPTED_KEY)) {
      // one-time: the first profile to open the app inherits progress saved before profiles existed
      const old = readJson(`${LEGACY_KEY}.p1`) || readJson(LEGACY_KEY);
      if (old) { writeJson(dataKey(id), old); try { localStorage.setItem(ADOPTED_KEY, id); } catch (e) { /* ignore */ } }
    }
    return capTr(Object.assign(blank(), readJson(dataKey(id)) || {}));
  }
  let S = loadData(profile.id);
  const writeLocal = () => writeJson(dataKey(profile.id), S);
  const save = () => { writeLocal(); schedulePush(); };

  /* ───────────── sync with the host ─────────────
   * The host stores one JSON document per profile (GET/PUT /api/progress/dutch-tutor) so progress follows you
   * between devices. localStorage stays as an offline cache. Devices can change progress independently, so
   * whenever two versions meet they are merged (never overwritten): see mergeState. */
  const PROGRESS_URL = "/api/progress/dutch-tutor";
  const sync = { rev: null, last: null, timer: null, retry: null, busy: false, dirty: false, state: "idle" };
  const SYNC_TEXT = { idle: "Waiting to sync", synced: "Synced across your devices", saving: "Saving…",
    offline: "Offline. Changes are kept on this device and will sync when the connection is back." };
  const core = s => { const { trOpen, trDir, ...rest } = s; return rest; }; // trOpen/trDir are per-device UI prefs: never synced
  const canon = v => JSON.stringify(v, (k, x) => (x && typeof x === "object" && !Array.isArray(x)
    ? Object.fromEntries(Object.entries(x).sort(([p], [q]) => (p < q ? -1 : 1))) : x));
  const differs = (x, y) => canon(core(Object.assign(blank(), x))) !== canon(core(Object.assign(blank(), y)));

  const snap = () => canon(core(Object.assign(blank(), S))); // what a push would send, to skip no-op pushes

  function mergeState(a, b) { // a = this device, b = other copy
    b = Object.assign(blank(), b);
    const ea = a.epoch || 0, eb = b.epoch || 0;
    if (ea !== eb) { // one side was reset: the newer reset wins outright
      const w = JSON.parse(JSON.stringify(ea > eb ? a : b));
      w.trOpen = a.trOpen; w.trDir = a.trDir;
      return w;
    }
    const m = blank();
    m.epoch = ea; m.trOpen = a.trOpen; m.trDir = a.trDir;
    for (const id of new Set([...Object.keys(a.cards), ...Object.keys(b.cards)])) { // per card: the most recently answered wins
      const x = a.cards[id], y = b.cards[id];
      m.cards[id] = !y || (x && (x.at || 0) >= (y.at || 0)) ? x : y;
    }
    m.done = { ...b.done, ...a.done };
    const sa = a.streak, sb = b.streak;
    m.streak = (sa.last || "") > (sb.last || "") || ((sa.last || "") === (sb.last || "") && sa.n >= sb.n) ? sa : sb;
    for (const k of new Set([...Object.keys(a.best), ...Object.keys(b.best)])) m.best[k] = Math.min(a.best[k] ?? Infinity, b.best[k] ?? Infinity);
    m.today = a.today.date === b.today.date ? { ...b.today, ...a.today } : (a.today.date || "") > (b.today.date || "") ? a.today : b.today;
    m.trDel = { ...b.trDel };
    for (const [k, t] of Object.entries(a.trDel)) m.trDel[k] = Math.max(t, m.trDel[k] || 0);
    const byNl = new Map();
    for (const r of [...b.tr, ...a.tr]) {
      const cur = byNl.get(r.nl);
      byNl.set(r.nl, cur ? { ...(r.t > cur.t ? r : cur), n: Math.max(cur.n || 1, r.n || 1) } : { ...r });
    }
    m.tr = [...byNl.values()].filter(r => !(m.trDel[r.nl] >= r.t)).sort((p, q) => q.t - p.t); // removed lookups stay removed
    return capTr(m); // the two histories together can exceed the cap: the newest TR_MAX win
  }

  async function remote(method, body, { keepalive = false, ms = 8000 } = {}) {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), ms);
    try {
      const r = await fetch(PROGRESS_URL, { method, credentials: "same-origin", cache: "no-store", keepalive, signal: ctl.signal,
        headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined });
      if (r.status === 401) { location.replace("/"); throw new Error("signed out"); }
      return { status: r.status, json: await r.json().catch(() => ({})) };
    } finally { clearTimeout(timer); }
  }

  function setStatus(st) {
    sync.state = st;
    const badge = document.querySelector(".prof-badge");
    if (badge) { badge.title = `${profile.id}. ${SYNC_TEXT[st]}`; badge.firstChild.className = st; }
  }
  function schedulePush(delay = 1500) {
    if (!profile.host || snap() === sync.last) return;
    clearTimeout(sync.timer);
    sync.timer = setTimeout(() => pushNow(false), delay);
    if (sync.state === "synced") setStatus("saving");
  }
  async function pushNow(keepalive) {
    if (!profile.host) return;
    clearTimeout(sync.timer); sync.timer = null;
    if (sync.busy) { sync.dirty = true; return; }
    sync.busy = true;
    let pulledIn = false;
    try {
      for (let attempt = 0; ; attempt++) {
        sync.dirty = false;
        const sent = snap();
        if (sent === sync.last) break; // nothing new to send
        setStatus("saving");
        const { status, json } = await remote("PUT", { data: core(S), rev: sync.rev ?? 0 }, { keepalive });
        if (status === 200) { sync.rev = json.rev; sync.last = sent; break; }
        if (status === 409 && attempt < 3) { // another device saved first: merge its copy in and try again
          S = mergeState(S, json.data || {}); sync.rev = json.rev; writeLocal(); refreshCards(); pulledIn = true;
          continue;
        }
        throw new Error("HTTP " + status);
      }
      clearTimeout(sync.retry); sync.retry = null;
      setStatus("synced");
    } catch (e) {
      setStatus("offline");
      if (!sync.retry) sync.retry = setTimeout(() => { sync.retry = null; pushNow(false); }, 30000);
    } finally {
      sync.busy = false;
      if (pulledIn) { drawRecent(); inSession() ? drawNav(currentSection) : route(); } // another device's progress arrived
      if (sync.dirty) schedulePush(300);
    }
  }

  const inSession = () => ["study", "practice", "convo", "review", "quick"].includes(decodeURIComponent(location.hash).split("/")[1]);
  async function pull() { // bring in what other devices saved; never interrupts a quiz in progress
    if (!profile.host || sync.busy) return;
    try {
      const { status, json } = await remote("GET");
      if (status !== 200) throw new Error("HTTP " + status);
      sync.rev = json.rev;
      if (json.data) {
        const merged = mergeState(S, json.data);
        const changed = differs(merged, S);
        S = merged; if (changed) writeLocal();
        if (changed) { refreshCards(); drawRecent(); inSession() ? drawNav(currentSection) : route(); }
        if (differs(merged, json.data)) schedulePush(300); else { sync.last = snap(); setStatus("synced"); }
      } else setStatus("synced");
    } catch (e) { setStatus("offline"); }
  }

  if (profile.host) { // first load: merge what's on the server before drawing anything (short wait, then fall back to the local copy)
    try {
      const { status, json } = await remote("GET", null, { ms: 3000 });
      if (status !== 200) throw new Error("HTTP " + status);
      sync.rev = json.rev;
      if (json.data) {
        const merged = mergeState(S, json.data);
        S = merged; writeLocal();
        if (differs(merged, json.data)) { sync.state = "saving"; setTimeout(() => schedulePush(0), 0); }
        else { sync.state = "synced"; sync.last = snap(); }
      } else if (differs(S, blank())) { sync.state = "saving"; setTimeout(() => schedulePush(0), 0); }
      else { sync.state = "synced"; sync.last = snap(); }
    } catch (e) {
      sync.state = "offline";
      sync.retry = setTimeout(() => { sync.retry = null; pull(); pushNow(false); }, 15000);
    }
  }

  const dayStr = (t = Date.now()) => new Date(t).toLocaleDateString("sv");
  function today() {
    if (S.today.date !== dayStr()) S.today = { date: dayStr() };
    return S.today;
  }
  function markActive(flag) {
    const d = dayStr();
    if (S.streak.last !== d) {
      S.streak.n = S.streak.last === dayStr(Date.now() - DAY) ? S.streak.n + 1 : 1;
      S.streak.last = d;
    }
    if (flag) today()[flag] = true;
    save();
  }
  const streak = () => (S.streak.last === dayStr() || S.streak.last === dayStr(Date.now() - DAY) ? S.streak.n : 0);

  /* ───────────── content index ───────────── */
  const units = DATA.units;
  const decks = {};
  const KIND = { vocab: "Vocabulary", phrases: "Phrases" };
  units.forEach((u, i) => {
    u.n = i + 1;
    for (const kind of ["vocab", "phrases"]) {
      const id = `${u.id}:${kind}`;
      decks[id] = {
        id, unit: u, kind,
        title: `${KIND[kind]} · ${u.sub}`,
        cards: u[kind].map(([nl, en, a, b]) =>
          kind === "vocab" ? { id: "v:" + nl, nl, en, exNl: a, exEn: b, kind } : { id: "p:" + nl, nl, en, note: a, kind }),
      };
    }
  });
  const baseCards = Object.values(decks).flatMap(d => d.cards);
  // everything looked up in the translator becomes a deck of its own
  const myDeck = { id: "my:words", kind: "saved", unit: null, title: "My words", cards: [] };
  decks[myDeck.id] = myDeck;
  let allCards = baseCards;
  function refreshCards() {
    myDeck.cards = S.tr.map(r => ({ id: "t:" + r.nl, nl: r.nl, en: r.en, kind: "saved", rec: r }));
    allCards = baseCards.concat(myDeck.cards);
  }
  refreshCards();
  const unitById = id => units.find(u => u.id === id);

  const cardState = id => S.cards[id] || { box: 0, due: 0 };
  const learned = cards => cards.filter(c => cardState(c.id).box > 0).length;
  const dueCards = () => allCards.filter(c => { const s = cardState(c.id); return s.box > 0 && s.due <= Date.now(); });

  function grade(card, correct, missedBefore) {
    const st = { ...cardState(card.id) };
    if (!correct) { st.box = Math.min(st.box, 1); st.due = Date.now(); }
    else if (missedBefore) { st.box = 1; st.due = Date.now() + DAY; }
    else { st.box = Math.min(5, st.box + 1); st.due = Date.now() + INTERVALS[st.box] * DAY; }
    st.at = Date.now();
    S.cards[card.id] = st;
    save();
  }

  /* ───────────── helpers ───────────── */
  const app = document.getElementById("app");
  let keyHandler = null;
  let cleanup = null;

  function h(tag, attrs, ...kids) {
    const [name, ...cls] = tag.split(".");
    const e = document.createElement(name || "div");
    if (cls.length) e.className = cls.join(" ");
    for (const k in attrs || {}) {
      const v = attrs[k];
      if (v == null || v === false) continue;
      if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else if (k === "html") e.innerHTML = v;
      else if (k === "class") e.className += " " + v;
      else e.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid == null || kid === false || kid === "") continue;
      e.append(kid.nodeType ? kid : document.createTextNode(kid));
    }
    return e;
  }

  function shuffle(a) {
    a = a.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  const norm = s => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/\(.*?\)/g, "").replace(/['’`"]/g, "").replace(/[^a-z0-9]+/g, " ").trim();

  function lev(a, b) {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++)
      for (let j = 1; j <= b.length; j++)
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[a.length][b.length];
  }

  // "ok" | "article" (right word, forgot de/het) | "typo" | "no"
  function checkTyped(input, target) {
    const a = norm(input), b = norm(target);
    if (!a) return "no";
    if (a === b) return "ok";
    if (b.replace(/^(de|het|een) /, "") === a) return "article";
    if (b.length >= 6 && lev(a, b) <= Math.max(1, Math.floor(b.length / 12))) return "typo";
    return "no";
  }

  /* speech */
  let voice = null;
  const synth = window.speechSynthesis;
  function pickVoice() {
    const vs = synth.getVoices();
    voice = vs.find(v => v.lang === "nl-NL") || vs.find(v => v.lang.startsWith("nl")) || null;
  }
  if (synth) { pickVoice(); synth.addEventListener && synth.addEventListener("voiceschanged", pickVoice); }
  function speak(text) {
    if (!synth) return;
    synth.cancel();
    const u = new SpeechSynthesisUtterance(text.replace(/\(.*?\)/g, "").replace(/[🎉…]/g, ""));
    u.lang = "nl-NL";
    if (voice) u.voice = voice;
    u.rate = 0.9;
    synth.speak(u);
  }
  const spk = text => synth ? h("button.spk", { type: "button", title: "Listen", "aria-label": "Listen", onclick: e => { e.stopPropagation(); speak(text); } }, "▶") : null;

  const bar = frac => h(".bar", {}, h("i", { style: `width:${Math.round(Math.max(0, Math.min(1, frac)) * 100)}%` }));

  function frame(back, progress, ...kids) {
    keyHandler = null;
    app.replaceChildren(h(".frame", {},
      h(".frame-top", {}, h("a.x", { href: back, title: "Close", "aria-label": "Close" }, "✕"), progress == null ? null : bar(progress)),
      ...kids));
    window.scrollTo(0, 0);
  }

  function contBtn(label, fn) {
    const b = h("button.btn.primary", { type: "button", onclick: fn }, label);
    setTimeout(() => b.focus(), 0);
    return b;
  }

  function termRow(c, onRemove) {
    const box = cardState(c.id).box;
    return h(".term", {},
      spk(c.nl) || h("span"),
      h(".nl", {}, c.nl),
      h(".en", {}, c.en),
      h(".row", { style: "flex-wrap:nowrap" },
        h(".dots", { title: `Memory strength ${box}/5` }, [1, 2, 3, 4, 5].map(i => h("i", { class: i <= box ? "on" : "" }))),
        onRemove ? h("button.x.rm", { type: "button", title: "Remove", "aria-label": `Remove ${c.nl}`, onclick: () => onRemove(c) }, "✕") : null),
      c.rec ? h(".ex", {}, `${c.rec.dir === "en" ? "EN → NL" : "NL → EN"} · ${new Date(c.rec.t).toLocaleDateString()}${c.rec.n > 1 ? ` · looked up ${c.rec.n}×` : ""}`) :
      c.exNl ? h(".ex", {}, c.exNl, " — ", c.exEn) : c.note ? h(".ex", {}, c.note) : null);
  }

  /* ───────────── track logic ───────────── */
  function steps(u) {
    const v = decks[u.id + ":vocab"], p = decks[u.id + ":phrases"];
    const lv = learned(v.cards), lp = learned(p.cards);
    return [
      { name: "Vocabulary", href: `#/deck/${v.id}`, start: `#/study/${v.id}/learn`, label: `${lv}/${v.cards.length}`, done: lv === v.cards.length },
      { name: "Phrases", href: `#/deck/${p.id}`, start: `#/study/${p.id}/learn`, label: `${lp}/${p.cards.length}`, done: lp === p.cards.length },
      { name: "Grammar", href: `#/grammar/${u.id}`, start: `#/grammar/${u.id}`, label: S.done[u.id + ":grammar"] ? "✓" : "lesson", done: !!S.done[u.id + ":grammar"] },
      { name: "Conversation", href: `#/convo/${u.id}`, start: `#/convo/${u.id}`, label: S.done[u.id + ":convo"] ? "✓" : "chat", done: !!S.done[u.id + ":convo"] },
    ];
  }
  function nextStep() {
    for (const u of units) {
      const s = steps(u).find(s => !s.done);
      if (s) return { unit: u, step: s };
    }
    return null;
  }

  /* ───────────── views ───────────── */
  function home() {
    const t = today();
    const due = dueCards().length;
    const nxt = nextStep();
    const hr = new Date().getHours();
    const greet = hr < 12 ? "Goedemorgen!" : hr < 18 ? "Goedemiddag!" : "Goedenavond!";
    const total = learned(allCards);

    let msg;
    if (!total) msg = "Welcome. We'll build up from what you know to chatting with friends at the bar and on the pitch. Start with step 2 below: ten words, a few minutes.";
    else if (due) msg = `You have ${due} card${due === 1 ? "" : "s"} ready for review. Do those first, they're the ones you're about to forget.`;
    else if (nxt) msg = `Nothing to review right now. Let's keep moving in unit ${nxt.unit.n}.`;
    else msg = "You've finished the whole track. Keep the reviews going and re-run conversations until every reply is first try.";

    const task = (done, href, title, sub) => h(href && !done ? "a.task" : ".task", { href: href && !done ? href : null, class: done ? "done" : "" },
      h(".tick", {}, done ? "✓" : ""), h(".grow", {}, h("b", {}, title), h(".small.muted", {}, sub)), !done && href ? h("span.go", {}, "Start →") : null);

    app.replaceChildren(h(".stack", {},
      h(".hero", {}, h(".eyebrow", {}, "Your Dutch tutor"), h(".nl", {}, greet), h("p.muted", {}, msg)),
      h(".stats", {},
        h(".stat", {}, h("b", {}, streak()), h("span", {}, "day streak")),
        h(".stat", {}, h("b", {}, `${total}/${allCards.length}`), h("span", {}, "cards learned")),
        h(".stat", {}, h("b", {}, due), h("span", {}, "due for review"))),
      h(".card", {},
        h("h2", {}, "Today's session"),
        h(".tasks", {},
          task(!due && (t.review || total > 0), due ? "#/review" : null, due ? `Review ${due} due card${due === 1 ? "" : "s"}` : "Review",
            due ? "Spaced repetition: cards come back just before you forget them." : total ? "Nothing due. Come back tomorrow." : "Unlocks once you've learned your first cards."),
          nxt ? task(!!t.step, nxt.step.start, `Unit ${nxt.unit.n}: ${nxt.step.name}`, `${nxt.unit.title} · ${nxt.unit.sub}`)
              : task(true, null, "Track complete", "All eight units done."),
          task(!!t.quick, "#/quick", "Quick-fire sentences", "Build six phrases from scrambled words. Trains word order."))),
      h("h2", {}, "Learning track"),
      h(".units", {}, units.map(u => {
        const st = steps(u);
        const complete = st.every(s => s.done);
        return h(".card.unit", { class: complete ? "complete" : nxt && nxt.unit === u ? "next" : "" },
          h(".unit-head", {}, h(".unit-num", {}, complete ? "✓" : u.n),
            h("div", {}, h("h3", {}, u.title), h(".small.muted", {}, u.sub))),
          h("p.small.muted", {}, u.goal),
          h(".steps", {}, st.map(s => h("a.step", { href: s.href, class: s.done ? "done" : "" }, s.name, h("span", {}, s.label)))));
      }))));
  }

  function listView(kind) {
    const head = {
      vocab: ["Vocabulary", "High-frequency spoken words, each with a sentence you could actually say."],
      phrases: ["Phrases", "Ready-made chunks. Fluency is mostly knowing these by heart."],
      grammar: ["Grammar", "Only the rules that change how you sound in conversation."],
      convos: ["Conversations", "Practise replying. The tutor explains why each answer works or doesn't."],
    }[kind];
    const rows = units.map(u => {
      if (kind === "vocab" || kind === "phrases") {
        const d = decks[`${u.id}:${kind}`], n = learned(d.cards);
        return h("a.card.item", { href: `#/deck/${d.id}` },
          h(".unit-num", {}, u.n),
          h(".grow", {}, h("b", {}, u.title), h(".small.muted", {}, u.sub), h("div", { style: "margin-top:8px" }, bar(n / d.cards.length))),
          h(".pct", {}, `${n}/${d.cards.length}`));
      }
      const g = kind === "grammar";
      const done = S.done[`${u.id}:${g ? "grammar" : "convo"}`];
      return h("a.card.item", { href: `#/${g ? "grammar" : "convo"}/${u.id}` },
        h(".unit-num", {}, u.n),
        h(".grow", {}, h("b", {}, g ? u.grammar.title : u.convo.title), h(".small.muted", {}, g ? `${u.grammar.exercises.length} exercises` : u.convo.scene)),
        h(".pct", {}, done ? "✓ done" : ""));
    });
    app.replaceChildren(h(".stack", {}, h("div", {}, h("h1", {}, head[0]), h("p.muted", {}, head[1])), h(".list", {}, rows)));
  }

  function deckView(deck) {
    const n = learned(deck.cards);
    const mode = (m, title, sub) => h("a.mode", { href: `#/study/${deck.id}/${m}` }, h("b", {}, title), h("span", {}, sub));
    const best = S.best[deck.id];
    const saved = deck.kind === "saved";
    if (saved && !deck.cards.length) {
      return app.replaceChildren(h(".stack", {},
        h("div", {}, h(".eyebrow", {}, "Translation history"), h("h1", {}, "My words")),
        h(".card", {}, h("p.muted", {}, "Nothing here yet. Everything you look up in the translator is saved on this page, and you can then study it with flashcards and quizzes like any other deck."),
          h("p", { style: "margin-top:12px" }, h("button.btn.primary", { type: "button", onclick: () => setTranslator(true, true) }, "Open translator")))));
    }
    app.replaceChildren(h(".stack", {},
      h("div", {}, h(".eyebrow", {}, saved ? "Translation history" : `Unit ${deck.unit.n} · ${deck.unit.title}`), h("h1", {}, deck.title),
        saved ? h("p.muted", {}, `Your ${TR_MAX} most recent lookups in the translator, newest first. When it's full, the oldest one drops off (with its study progress). Learned words join your daily review.`) : null,
        h(".row", { style: "margin-top:10px" }, h("div", { style: "flex:1" }, bar(n / deck.cards.length)), h("span.small.muted", {}, `${n}/${deck.cards.length} learned`))),
      h(".modes", {},
        mode("flash", "Flashcards", "Flip through and self-check"),
        mode("learn", "Learn", "Multiple choice, 10 at a time"),
        mode("write", "Write", "Type the Dutch from memory"),
        mode("match", "Match", best ? `Best: ${best.toFixed(1)}s` : "Pair them up against the clock"),
        deck.kind === "phrases" ? mode("build", "Build", "Unscramble the sentence") : null),
      h(".card", {}, h(".terms", {}, deck.cards.map(c => termRow(c, saved ? removeSaved : null))))));
  }

  function removeSaved(c) {
    S.tr = S.tr.filter(r => r !== c.rec);
    S.trDel[c.nl] = Date.now(); // tombstone, so other devices don't bring it back
    delete S.cards[c.id];
    save(); refreshCards(); drawRecent();
    if (location.hash === "#/saved") route();
  }

  /* shared feedback block for card quizzes */
  function cardFeedback(ok, c, note, next) {
    return h(".fb", { class: ok ? "ok" : "bad" },
      h(".head", {}, ok ? "Goed zo!" : "Niet helemaal"),
      note ? h(".small", {}, note) : null,
      h(".ans", {}, c.nl, spk(c.nl), h("span.muted", { style: "font-weight:400" }, "  ·  " + c.en)),
      c.exNl ? h(".ex", {}, h("span", {}, c.exNl), spk(c.exNl), h(".muted", {}, c.exEn)) : c.note ? h(".ex.muted", {}, c.note) : null,
      contBtn("Continue", next));
  }

  // mode: "learn" (multiple choice) | "write" (typed) | "review" (mixed by strength)
  function quiz(cards, o) {
    let queue = shuffle(cards).map(c => ({ c, missed: false }));
    const total = queue.length;
    let done = 0, firstTry = 0;
    const missed = [];

    function next() {
      if (!queue.length) return finish();
      const it = queue[0];
      const type = o.mode === "learn" ? "mc" : o.mode === "write" ? "type" : cardState(it.c.id).box >= 3 ? "type" : "mc";
      const body = h(".q");
      frame(o.back, done / total, h(".small.muted", {}, o.title), body);
      (type === "mc" ? mc : typed)(it, body);
    }

    function answer(it, ok, body, note) {
      grade(it.c, ok, it.missed);
      queue.shift();
      if (ok) { done++; if (!it.missed) firstTry++; }
      else {
        if (!it.missed) missed.push(it.c);
        it.missed = true;
        queue.splice(Math.min(3, queue.length), 0, it);
      }
      body.append(cardFeedback(ok, it.c, note, next));
    }

    function mc(it, body) {
      const c = it.c;
      const from = Math.random() < 0.5 ? "nl" : "en", to = from === "nl" ? "en" : "nl";
      const pool = cards.length >= 4 ? cards : cards.concat(baseCards.filter(x => x.kind === (c.kind === "saved" ? "vocab" : c.kind)));
      const seen = new Set([c[to]]);
      const wrong = shuffle(pool).filter(x => x.id !== c.id && !seen.has(x[to]) && seen.add(x[to])).slice(0, 3);
      const opts = shuffle([c, ...wrong]);
      let answered = false;
      const btns = opts.map((x, i) => h("button.opt", { type: "button", onclick: () => pick(i) }, h("kbd", {}, i + 1), x[to]));
      function pick(i) {
        if (answered) return;
        answered = true; keyHandler = null;
        btns.forEach((b, j) => { b.disabled = true; if (opts[j] === c) b.classList.add("right"); else if (j === i) b.classList.add("wrong"); });
        answer(it, opts[i] === c, body);
      }
      body.append(
        h(".prompt-label", {}, from === "nl" ? "What does this mean?" : "How do you say this in Dutch?"),
        h(".prompt", {}, c[from], from === "nl" ? spk(c.nl) : null),
        h(".opts", {}, btns));
      keyHandler = e => { const n = +e.key; if (n >= 1 && n <= btns.length) pick(n - 1); };
    }

    function typed(it, body) {
      const c = it.c;
      const input = h("input", { type: "text", autocomplete: "off", autocapitalize: "off", autocorrect: "off", spellcheck: "false", placeholder: "Type the Dutch…", "aria-label": "Your answer in Dutch" });
      const submit = h("button.btn.primary", { type: "submit" }, "Check");
      const skip = h("button.btn", { type: "button", onclick: () => settle("no", true) }, "Don't know");
      function settle(res, skipped) {
        input.disabled = submit.disabled = skip.disabled = true;
        const note = res === "typo" ? "Small typo, counted as correct. Check the spelling:"
          : res === "article" ? "Right word. Learn it with its article:"
          : res === "no" && !skipped ? `You wrote: ${input.value}` : null;
        answer(it, res !== "no", body, note);
      }
      body.append(
        h(".prompt-label", {}, "Type this in Dutch"),
        h(".prompt", {}, c.en),
        h("form.field", { onsubmit: e => { e.preventDefault(); if (input.value.trim()) settle(checkTyped(input.value, c.nl)); } }, input, submit),
        h("div", {}, skip));
      setTimeout(() => input.focus(), 0);
    }

    function finish() {
      markActive(o.flag);
      frame(o.back, 1, h(".card.summary", {},
        h(".eyebrow", {}, "Klaar!"),
        h(".score", {}, `${firstTry}/${total}`),
        h("p.muted", {}, missed.length ? "right first time. These need another look:" : "right first time. Lekker bezig!"),
        missed.length ? h(".terms", {}, missed.map(termRow)) : null,
        h(".row", {}, o.again ? h("button.btn", { type: "button", onclick: o.again }, "Another round") : null, h("a.btn.primary", { href: o.back }, "Done"))));
    }

    next();
  }

  function flashcards(deck) {
    const cards = shuffle(deck.cards);
    const back = deck.kind === "saved" ? "#/saved" : `#/deck/${deck.id}`;
    let i = 0, flipped = false, front = "nl", known = 0;

    function draw() {
      if (i >= cards.length) {
        markActive();
        return frame(back, 1, h(".card.summary", {}, h(".eyebrow", {}, "Klaar!"), h(".score", {}, `${known}/${cards.length}`), h("p.muted", {}, "marked as known."),
          h(".row", {}, h("button.btn", { type: "button", onclick: () => flashcards(deck) }, "Again"), h("a.btn.primary", { href: back }, "Done"))));
      }
      const c = cards[i];
      const showNl = (front === "nl") !== flipped;
      const face = h("button.flash", { type: "button", onclick: flip, "aria-label": "Flip card" },
        h(".big", {}, showNl ? c.nl : c.en, showNl ? spk(c.nl) : null),
        flipped && c.exNl ? h(".ex", {}, c.exNl, spk(c.exNl), h("div", {}, c.exEn)) : null,
        flipped && c.note ? h(".ex", {}, c.note) : null,
        !flipped ? h(".hint", {}, "Click or press Space to flip") : null);
      frame(back, i / cards.length,
        h(".row", { style: "justify-content:space-between" }, h(".small.muted", {}, `${deck.title} · ${i + 1}/${cards.length}`),
          h("button.link.small", { type: "button", onclick: () => { front = front === "nl" ? "en" : "nl"; flipped = false; draw(); } }, front === "nl" ? "Show English first" : "Show Dutch first")),
        face,
        h(".flash-actions", {},
          h("button.btn", { type: "button", onclick: () => rate(false) }, "← Still learning"),
          h("button.btn.primary", { type: "button", onclick: () => rate(true) }, "Know it →")));
      keyHandler = e => {
        if (e.key === " ") { e.preventDefault(); flip(); }
        else if (e.key === "ArrowRight") rate(true);
        else if (e.key === "ArrowLeft") rate(false);
      };
    }
    function flip() { flipped = !flipped; draw(); }
    function rate(ok) {
      const st = cardState(cards[i].id);
      if (ok) { known++; if (st.box === 0) grade(cards[i], true, true); }
      else if (st.box > 0) grade(cards[i], false);
      i++; flipped = false; draw();
    }
    draw();
  }

  function matchGame(deck) {
    const back = deck.kind === "saved" ? "#/saved" : `#/deck/${deck.id}`;
    const cards = shuffle(deck.cards).slice(0, 6);
    const tiles = shuffle(cards.flatMap(c => [{ c, side: "nl" }, { c, side: "en" }]));
    let sel = null, left = cards.length, penalty = 0, locked = false;
    const start = performance.now();
    const elapsed = () => (performance.now() - start) / 1000 + penalty;
    const timer = h("span.timer", {}, "0.0s");
    const iv = setInterval(() => { timer.textContent = elapsed().toFixed(1) + "s"; }, 100);
    cleanup = () => clearInterval(iv);

    tiles.forEach(t => { t.el = h("button.mtile", { type: "button", onclick: () => click(t) }, t.c[t.side]); });
    function click(t) {
      if (locked || t === sel) return;
      if (!sel) { sel = t; t.el.classList.add("sel"); return; }
      const a = sel; sel = null;
      a.el.classList.remove("sel");
      if (a.c === t.c && a.side !== t.side) {
        a.el.classList.add("gone"); t.el.classList.add("gone");
        if (--left === 0) win();
      } else {
        penalty += 1; locked = true;
        a.el.classList.add("miss"); t.el.classList.add("miss");
        setTimeout(() => { a.el.classList.remove("miss"); t.el.classList.remove("miss"); locked = false; }, 450);
      }
    }
    function win() {
      clearInterval(iv);
      const time = elapsed(), prev = S.best[deck.id];
      const record = !prev || time < prev;
      if (record) S.best[deck.id] = time;
      markActive();
      frame(back, 1, h(".card.summary", {}, h(".eyebrow", {}, record ? "New best!" : "Klaar!"), h(".score", {}, time.toFixed(1) + "s"),
        h("p.muted", {}, penalty ? `Includes ${penalty}s of penalties for wrong pairs.` : "No mistakes."),
        prev && !record ? h("p.muted", {}, `Your best: ${prev.toFixed(1)}s`) : null,
        h(".row", {}, h("button.btn", { type: "button", onclick: () => matchGame(deck) }, "Play again"), h("a.btn.primary", { href: back }, "Done"))));
    }
    frame(back, null,
      h(".row", { style: "justify-content:space-between" }, h(".small.muted", {}, "Match each Dutch term with its meaning. Wrong pair: +1s"), timer),
      h(".match", {}, tiles.map(t => t.el)));
  }

  /* ───────────── exercises (grammar + sentence building) ───────────── */
  const tilesOf = s => s.replace(/[.,!?]/g, "").trim().split(/\s+/).map((w, i) => (i === 0 ? w[0].toLowerCase() + w.slice(1) : w));

  function practice(exs, o) {
    let i = 0, score = 0;

    function next() {
      if (i >= exs.length) return finish();
      const ex = exs[i];
      const body = h(".q");
      frame(o.back, i / exs.length, h(".small.muted", {}, `${o.title} · ${i + 1}/${exs.length}`), body);
      const done = (ok, correct) => {
        if (ok) score++;
        i++;
        body.append(h(".fb", { class: ok ? "ok" : "bad" },
          h(".head", {}, ok ? "Goed zo!" : "Niet helemaal"),
          correct ? h(".ans", {}, correct, spk(correct)) : null,
          ex.why ? h(".small", {}, ex.why) : null,
          contBtn("Continue", next)));
      };
      ({ mc: exMc, gap: exGap, order: exOrder })[ex.t](ex, body, done);
    }

    function exMc(ex, body, done) {
      const opts = shuffle(ex.o);
      let answered = false;
      const btns = opts.map((t, k) => h("button.opt", { type: "button", onclick: () => pick(k) }, h("kbd", {}, k + 1), t));
      function pick(k) {
        if (answered) return;
        answered = true; keyHandler = null;
        btns.forEach((b, j) => { b.disabled = true; if (opts[j] === ex.o[0]) b.classList.add("right"); else if (j === k) b.classList.add("wrong"); });
        const full = ex.q.includes("___") ? ex.q.replace("___", ex.o[0]).replace(/\s*\(.*?\)/g, "") : null;
        done(opts[k] === ex.o[0], full);
      }
      body.append(h(".prompt", {}, ex.q), h(".opts", {}, btns));
      keyHandler = e => { const n = +e.key; if (n >= 1 && n <= btns.length) pick(n - 1); };
    }

    function exGap(ex, body, done) {
      const input = h("input", { type: "text", autocomplete: "off", autocapitalize: "off", autocorrect: "off", spellcheck: "false", placeholder: "Fill the gap…", "aria-label": "Missing word" });
      const submit = h("button.btn.primary", { type: "submit" }, "Check");
      body.append(
        h(".prompt-label", {}, "Fill in the missing word"),
        h(".prompt", {}, ex.q),
        h("form.field", { onsubmit: e => {
          e.preventDefault();
          if (!input.value.trim()) return;
          input.disabled = submit.disabled = true;
          done(ex.a.some(a => norm(a) === norm(input.value)), ex.q.replace(/___(\s*\(.*?\))?/, ex.a[0]));
        } }, input, submit));
      setTimeout(() => input.focus(), 0);
    }

    function exOrder(ex, body, done) {
      const answers = [].concat(ex.nl).map(a => tilesOf(a).join(" "));
      const words = tilesOf([].concat(ex.nl)[0]);
      let bank = shuffle(words.map(w => ({ w })));
      if (words.length > 1 && bank.map(t => t.w).join(" ") === answers[0]) bank.reverse();
      let picked = [], locked = false;
      const slot = h(".slot", { "aria-label": "Your sentence" }), bankEl = h(".bank");
      const check = h("button.btn.primary", { type: "button", disabled: true, onclick: () => {
        locked = true; check.disabled = true; draw();
        const show = ex.show || (answers[0][0].toUpperCase() + answers[0].slice(1) + (/\?\s*$/.test(ex.en) ? "?" : "."));
        done(answers.includes(picked.map(t => t.w).join(" ")), show);
      } }, "Check");
      const tile = (t, fn) => h("button.tile", { type: "button", disabled: locked, onclick: fn }, t.w);
      function draw() {
        slot.replaceChildren(...picked.map(t => tile(t, () => { picked = picked.filter(x => x !== t); bank.push(t); draw(); })));
        bankEl.replaceChildren(...bank.map(t => tile(t, () => { bank = bank.filter(x => x !== t); picked.push(t); draw(); })));
        if (!locked) check.disabled = bank.length > 0;
      }
      draw();
      body.append(h(".prompt-label", {}, "Put the words in the right order"), h(".prompt", {}, ex.en), slot, bankEl, h("div", {}, check));
    }

    function finish() {
      const pass = score / exs.length >= 0.7;
      if (o.onDone) o.onDone(pass);
      markActive(o.flag);
      frame(o.back, 1, h(".card.summary", {},
        h(".eyebrow", {}, pass ? "Klaar!" : "Bijna!"),
        h(".score", {}, `${score}/${exs.length}`),
        h("p.muted", {}, pass ? "Nicely done." : o.needPass ? "You need 70% to tick this off. Reread the lesson and try again." : "Have another go to lock these in."),
        h(".row", {}, h("button.btn", { type: "button", onclick: o.again }, "Try again"), h("a.btn.primary", { href: o.back }, "Done"))));
    }

    next();
  }

  const buildable = cards => cards.filter(c => tilesOf(c.nl).length >= 3);
  const toOrder = c => ({ t: "order", en: c.en, nl: c.nl, show: c.nl, why: c.note });

  function grammarView(u) {
    const g = u.grammar;
    app.replaceChildren(h(".stack", { style: "max-width:680px;margin:0 auto" },
      h("div", {}, h(".eyebrow", {}, `Unit ${u.n} · Grammar`), h("h1", {}, g.title), h("p.muted", { style: "margin-top:8px", html: g.intro })),
      h(".card.lesson.stack", {}, g.sections.map(s => h(".sec", {},
        h("h3", {}, s.h),
        s.p ? h("p", { html: s.p }) : null,
        s.ex.length ? h(".exs", {}, s.ex.map(([nl, en]) => h(".exline", {}, spk(nl), h("b", {}, nl), h("span.muted.small", {}, en)))) : null))),
      h(".row", {}, h("a.btn.primary", { href: `#/practice/${u.id}` }, `Practise · ${g.exercises.length} exercises`),
        S.done[u.id + ":grammar"] ? h("span.small.muted", {}, "✓ completed") : null)));
  }

  function convoView(u) {
    const c = u.convo;
    const back = "#/convos";
    let i = 0, first = 0;
    const log = h(".chat"), choices = h(".choices");

    const bubble = (who, nl, en) => {
      const tr = h(".en", { hidden: true }, en);
      return h(".bubble", {}, h(".who", {}, who),
        h("div", {}, nl, spk(nl), h("button.tr", { type: "button", onclick: () => { tr.hidden = !tr.hidden; } }, "EN")), tr);
    };
    const scroll = el => setTimeout(() => el.scrollIntoView({ behavior: "smooth", block: "center" }), 30);

    function turn() {
      if (i >= c.turns.length) return end();
      const t = c.turns[i];
      log.append(bubble(t.who || c.who, t.nl, t.en));
      let tried = false;
      const fb = h("div");
      choices.replaceChildren(h(".prompt-label", {}, "Pick the most natural reply:"),
        ...shuffle(t.opts).map(([txt, good, why]) => {
          const b = h("button.opt", { type: "button", onclick: () => {
            if (good) {
              if (!tried) first++;
              log.append(h(".bubble.me", {}, txt, spk(txt)), h(".note", {}, why));
              i++; turn();
            } else {
              tried = true; b.disabled = true; b.classList.add("wrong");
              fb.replaceChildren(h(".note.bad", {}, why, " Try another."));
            }
          } }, txt);
          return b;
        }), fb);
      scroll(choices);
    }

    function end() {
      S.done[u.id + ":convo"] = true;
      markActive("step");
      log.append(bubble(c.who, c.end.nl, c.end.en));
      choices.replaceChildren(h(".card.summary", {},
        h(".eyebrow", {}, "Gesprek klaar!"),
        h(".score", {}, `${first}/${c.turns.length}`),
        h("p.muted", {}, first === c.turns.length ? "Every reply right first time." : "replies right first time. Run it again until it's automatic."),
        h(".row", {}, h("button.btn", { type: "button", onclick: () => convoView(u) }, "Again"), h("a.btn.primary", { href: "#/" }, "Back to track"))));
      scroll(choices);
    }

    frame(back, null,
      h("div", {}, h(".eyebrow", {}, `Unit ${u.n} · Conversation`), h("h1", {}, c.title), h("p.muted", { style: "margin-top:6px" }, c.scene),
        h("p.small.muted", { style: "margin-top:6px" }, "Tap ▶ to listen, EN for a translation. Try to answer before you peek.")),
      log, choices);
    turn();
  }

  function review() {
    const due = shuffle(dueCards()).slice(0, 20);
    if (!due.length) {
      today().review = true; save();
      const nxt = nextStep();
      return app.replaceChildren(h(".card.summary", { style: "max-width:560px;margin:40px auto" },
        h(".eyebrow", {}, "Review"), h("h1", {}, "Niets te doen!"),
        h("p.muted", {}, learned(allCards) ? "No cards are due right now. They come back after 1, 3, 7, 14 and 30 days." : "Learn some vocabulary or phrases first, then they'll show up here for review."),
        nxt ? h("a.btn.primary", { href: nxt.step.start }, `Continue: Unit ${nxt.unit.n} ${nxt.step.name}`) : h("a.btn.primary", { href: "#/" }, "Back to track")));
    }
    quiz(due, { mode: "review", title: "Review", back: "#/", flag: "review", again: dueCards().length > due.length ? route : null });
  }

  function quick() {
    const started = Object.values(decks).filter(d => d.kind === "phrases" && learned(d.cards) > 0);
    const pool = buildable((started.length ? started : [decks["u1:phrases"]]).flatMap(d => d.cards));
    practice(shuffle(pool).slice(0, 6).map(toOrder), { title: "Quick-fire sentences", back: "#/", flag: "quick", again: route });
  }

  /* ───────────── translator sidebar ───────────── */
  const LANG = { en: "English", nl: "Dutch" };
  const wide = () => window.matchMedia("(min-width: 1000px)").matches;
  const trPanel = document.getElementById("translator");
  const trToggle = document.getElementById("tr-toggle");
  const trInput = h("textarea", { rows: 3, maxlength: 400, "aria-label": "Text to translate" });
  const trOut = h(".tr-out", { "aria-live": "polite" });
  const trRecent = h(".tr-recent");
  const trDirBtn = h("button.btn.tr-dir", { type: "button", title: "Swap languages", onclick: () => { S.trDir = S.trDir === "en" ? "nl" : "en"; save(); drawDir(); trInput.focus(); } });
  const trGo = h("button.btn.primary", { type: "submit" }, "Translate");

  function drawDir() {
    const to = S.trDir === "en" ? "nl" : "en";
    trDirBtn.replaceChildren(h("b", {}, LANG[S.trDir]), h("span", { "aria-hidden": "true" }, "⇄"), h("b", {}, LANG[to]));
    trInput.placeholder = S.trDir === "en" ? "Type English…" : "Typ Nederlands…";
    trInput.lang = S.trDir;
  }

  function setTranslator(open, focus) {
    S.trOpen = open; save();
    document.body.classList.toggle("tr-open", open);
    trPanel.hidden = !open;
    trToggle.setAttribute("aria-expanded", open);
    if (open && focus) setTimeout(() => trInput.focus(), 0);
  }

  // Google's public endpoint translates casual language best; MyMemory is the fallback.
  async function fetchJson(url) {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 10000);
    try {
      const r = await fetch(url, { signal: ctl.signal });
      if (!r.ok) throw new Error("HTTP " + r.status);
      return await r.json();
    } finally { clearTimeout(timer); }
  }
  async function viaGoogle(text, from, to) {
    const j = await fetchJson(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=${from}&tl=${to}&dt=t&q=${encodeURIComponent(text)}`);
    const out = j[0].map(seg => seg[0]).join("").trim();
    if (!out) throw new Error("empty");
    return out;
  }
  async function viaMyMemory(text, from, to) {
    const j = await fetchJson(`https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${from}|${to}`);
    const out = (j.responseData && j.responseData.translatedText || "").trim();
    if (String(j.responseStatus) !== "200" || !out || /^MYMEMORY WARNING/i.test(out)) throw new Error("MyMemory unavailable");
    const ta = document.createElement("textarea"); ta.innerHTML = out; // decode &#39; and friends
    return ta.value;
  }
  async function translate(text, from, to) {
    try { return await viaGoogle(text, from, to); }
    catch (e) { return await viaMyMemory(text, from, to); }
  }

  let trDropped = ""; // lookups pushed out of the history by the last save
  function saveTranslation(src, out, from) {
    const nl = from === "nl" ? src : out, en = from === "nl" ? out : src;
    let rec = S.tr.find(r => norm(r.nl) === norm(nl) && norm(r.en) === norm(en));
    if (rec) { S.tr = S.tr.filter(r => r !== rec); rec.n = (rec.n || 1) + 1; rec.t = Date.now(); }
    else {
      if (S.tr.some(r => r.nl === nl)) return null; // same Dutch already saved with another meaning: keep the older card
      rec = { nl, en, dir: from, t: Date.now(), n: 1 };
    }
    S.tr.unshift(rec);
    capTr(S);
    trDropped = capTr.dropped.map(r => r.nl).join(", ");
    save(); refreshCards();
    return rec;
  }

  function drawRecent() {
    const rows = S.tr.slice(0, 6);
    trRecent.replaceChildren(
      h(".row", { style: "justify-content:space-between" }, h("b.small", {}, "Recent"), S.tr.length ? h("a.small", { href: "#/saved" }, `All ${S.tr.length}/${TR_MAX} →`) : null),
      ...(rows.length ? rows.map(r => h(".tr-item", {}, h("div", {}, h("b", {}, r.nl), spk(r.nl)), h(".small.muted", {}, r.en)))
        : [h("p.small.muted", {}, "Your lookups are saved here and under My words, so you can study them later.")]));
  }

  async function onTranslate(e) {
    e.preventDefault();
    const text = trInput.value.trim().replace(/\s+/g, " ");
    if (!text || trGo.disabled) return;
    const from = S.trDir, to = from === "en" ? "nl" : "en";
    trGo.disabled = true;
    trOut.replaceChildren(h("p.small.muted", {}, "Translating…"));
    try {
      const out = await translate(text, from, to);
      const nl = from === "nl" ? text : out;
      const same = norm(out) === norm(text);
      const rec = same ? null : saveTranslation(text, out, from);
      trOut.replaceChildren(h(".tr-result", {},
        h(".small.muted", {}, LANG[to]),
        h(".tr-big", { lang: to }, out, spk(nl)),
        h(".small.muted", {}, same ? "Same in both languages (or not recognised), so not saved."
          : rec ? ["Saved to ", h("a", { href: "#/saved" }, "My words"), (rec.n > 1 ? ` · looked up ${rec.n}×` : "") + (trDropped ? ` · oldest lookup (${trDropped}) removed: history keeps ${TR_MAX}` : "")]
          : ["Already in ", h("a", { href: "#/saved" }, "My words"), " with a different translation."])));
      drawRecent(); drawNav(currentSection);
      if (location.hash === "#/saved") route();
    } catch (err) {
      trOut.replaceChildren(h(".note.bad", {}, navigator.onLine === false ? "You're offline. The translator needs an internet connection."
        : "Couldn't reach the translation service. Check your connection and try again."));
    } finally { trGo.disabled = false; }
  }

  trPanel.append(
    h(".row", { style: "justify-content:space-between" }, h("h2", {}, "Translator"),
      h("button.x", { type: "button", title: "Close translator", "aria-label": "Close translator", onclick: () => setTranslator(false) }, "✕")),
    h("form.tr-form", { onsubmit: onTranslate }, trDirBtn, trInput, trGo),
    trOut, trRecent,
    h("p.tr-foot", {}, "Text you translate is sent to Google Translate (MyMemory as backup). Don't paste anything private."));
  trInput.addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); trGo.click(); } });
  trToggle.addEventListener("click", () => setTranslator(trPanel.hidden, true));
  drawDir(); drawRecent();
  setTranslator(S.trOpen == null ? wide() : S.trOpen && wide());

  /* ───────────── router ───────────── */
  const NAV = [["#/", "Track"], ["#/vocab", "Vocabulary"], ["#/phrases", "Phrases"], ["#/grammar", "Grammar"], ["#/convos", "Conversations"], ["#/saved", "My words"], ["#/review", "Review"]];
  let currentSection = "#/";

  function drawNav(section) {
    currentSection = section;
    const due = dueCards().length;
    document.getElementById("nav").replaceChildren(...NAV.map(([href, label]) =>
      h("a", { href, class: href === section ? "on" : "" }, label,
        href === "#/review" && due ? h("span.count", {}, due) : href === "#/saved" && S.tr.length ? h("span.count.quiet", {}, S.tr.length) : null)));
  }

  function route() {
    if (cleanup) { cleanup(); cleanup = null; }
    if (synth) synth.cancel();
    keyHandler = null;
    const [, a, b, c] = decodeURIComponent(location.hash).split("/");
    const deck = decks[b], unit = unitById(b);
    let section = "#/";

    if (a === "vocab" || a === "phrases" || a === "convos" || (a === "grammar" && !unit)) { section = "#/" + a; listView(a); }
    else if (a === "saved" || (deck === myDeck && a === "deck")) { section = "#/saved"; deckView(myDeck); }
    else if (a === "deck" && deck) { section = "#/" + deck.kind; deckView(deck); }
    else if (a === "study" && deck) {
      section = "#/" + deck.kind;
      const back = deck === myDeck ? "#/saved" : `#/deck/${deck.id}`;
      const title = deck === myDeck ? "My words" : `Unit ${deck.unit.n} · ${KIND[deck.kind]}`;
      if (!deck.cards.length) { location.hash = back; return; }
      if (c === "flash") flashcards(deck);
      else if (c === "match") matchGame(deck);
      else if (c === "build") practice(shuffle(buildable(deck.cards)).slice(0, 8).map(toOrder), { title: `${title} · Build`, back, again: route });
      else {
        // weakest cards first, ten per round
        const round = shuffle(deck.cards).sort((x, y) => cardState(x.id).box - cardState(y.id).box).slice(0, 10);
        quiz(round, { mode: c === "write" ? "write" : "learn", title: `${title} · ${c === "write" ? "Write" : "Learn"}`, back, flag: deck === myDeck ? null : "step", again: route });
      }
    }
    else if (a === "grammar" && unit) { section = "#/grammar"; grammarView(unit); }
    else if (a === "practice" && unit) {
      section = "#/grammar";
      practice(unit.grammar.exercises, {
        title: unit.grammar.title, back: `#/grammar/${unit.id}`, flag: "step", needPass: true, again: route,
        onDone: pass => { if (pass) S.done[unit.id + ":grammar"] = true; },
      });
    }
    else if (a === "convo" && unit) { section = "#/convos"; convoView(unit); }
    else if (a === "review") { section = "#/review"; review(); }
    else if (a === "quick") quick();
    else home();

    drawNav(section);
    if (!["study", "practice", "convo", "review", "quick"].includes(a)) window.scrollTo(0, 0);
  }

  document.addEventListener("keydown", e => {
    if (!keyHandler || e.metaKey || e.ctrlKey || e.altKey) return;
    if (/^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
    keyHandler(e);
  });
  document.getElementById("reset").addEventListener("click", () => {
    if (confirm(`Reset all progress for "${profile.id}"? This clears learned cards, streak, completed lessons and My words. Other profiles are not affected.`)) {
      const open = S.trOpen;
      S = blank(); S.trOpen = open; S.epoch = Date.now(); save(); refreshCards(); drawDir(); drawRecent(); trOut.replaceChildren();
      location.hash = "#/"; route();
    }
  });

  /* ───────────── active profile (read-only) ───────────── */
  document.getElementById("profile").replaceChildren(
    h("span.prof-badge", { title: profile.id },
      h("i", { "aria-hidden": "true", class: sync.state }), profile.id));
  if (profile.host) setStatus(sync.state);
  document.getElementById("foot-note").textContent =
    `Progress syncs to the profile "${profile.id}", so you can pick it up on any device you sign in on.`;
  if (profile.host) {
    const flush = () => { if (sync.state !== "synced" || sync.timer) pushNow(true); };
    document.addEventListener("visibilitychange", () => (document.hidden ? flush() : pull()));
    window.addEventListener("pagehide", flush);
    window.addEventListener("online", () => { pushNow(false); pull(); });
    window.addEventListener("focus", pull);
  }
  window.addEventListener("storage", e => { // another tab of the same profile changed the data
    if (e.key === dataKey(profile.id)) { S = loadData(profile.id); refreshCards(); drawRecent(); route(); }
  });

  window.addEventListener("hashchange", route);
  route();
})();
