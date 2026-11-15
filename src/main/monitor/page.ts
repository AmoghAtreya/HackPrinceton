import { HOW_IT_WORKS } from './how-it-works.ts'

/**
 * The Learning Monitor page. Served by the monitor server to the Triage
 * monitor window and, when sharing is on, to a browser on a second device.
 * All event text is inserted with textContent, never as HTML.
 */
export function monitorPage(nonce: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Triage Learning Monitor</title>
<style>
  :root { --bg:#f6f1e8; --card:#fffaf2; --ink:#2b2119; --muted:#8b7765; --line:#e6dccd; --accent:#c4562c; --graph:#3a6ea5; --chain:#6a4fb3; --ok:#3f7a46; --warn:#b0561e; --bar:#ece2d3; }
  @media (prefers-color-scheme: dark) { :root { --bg:#17130f; --card:#211b16; --ink:#f1e7da; --muted:#a8968a; --line:#3a2f26; --bar:#33291f; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:13px/1.45 -apple-system, "Segoe UI", system-ui, sans-serif; }
  header { display:flex; flex-wrap:wrap; align-items:center; gap:10px 16px; padding:14px 18px; border-bottom:1px solid var(--line); }
  header h1 { font:600 17px/1.2 Georgia, serif; margin:0; }
  .live { display:inline-flex; align-items:center; gap:6px; font-size:11px; color:var(--muted); }
  .dot { width:8px; height:8px; border-radius:50%; background:#aaa; } .dot.on { background:var(--ok); box-shadow:0 0 0 3px #3f7a4633; }
  .share { margin-left:auto; font-size:11px; color:var(--muted); overflow-wrap:anywhere; }
  .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(120px,1fr)); gap:10px; padding:14px 18px 0; }
  .stat { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:10px 12px; }
  .stat b { display:block; font-size:22px; font-variant-numeric:tabular-nums; } .stat span { font-size:11px; color:var(--muted); }
  main { display:grid; grid-template-columns:repeat(auto-fit,minmax(330px,1fr)); gap:14px; padding:14px 18px 24px; }
  section { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:14px 16px; min-width:0; }
  h2 { font-size:12px; letter-spacing:.06em; text-transform:uppercase; color:var(--muted); margin:0 0 4px; }
  .sub { font-size:11px; color:var(--muted); margin:0 0 12px; }
  .tag { display:inline-block; font-size:10px; font-weight:600; border-radius:999px; padding:1px 8px; color:#fff; }
  .tag.langgraph { background:var(--graph); } .tag.langchain { background:var(--chain); }
  .flow { display:flex; flex-wrap:wrap; gap:6px; align-items:center; }
  .node { border:1px solid var(--line); border-radius:8px; padding:6px 9px; font-size:11.5px; background:var(--bg); transition:all .25s; }
  .node small { display:block; font-size:10px; color:var(--muted); }
  .node.done { border-color:var(--ok); } .node.done::before { content:"✓ "; color:var(--ok); }
  .node.running { border-color:var(--accent); background:#c4562c1a; box-shadow:0 0 0 3px #c4562c22; }
  .node.paused { border-color:var(--warn); background:#b0561e1a; } .node.paused::before { content:"⏸ "; color:var(--warn); }
  .arrow { color:var(--muted); font-size:11px; }
  .pause { margin-top:10px; font-size:12px; color:var(--warn); min-height:1.4em; }
  .arm { display:grid; grid-template-columns:34px 1fr 46px; align-items:center; gap:8px; margin:5px 0; font-size:11px; }
  .arm .track { height:14px; background:var(--bar); border-radius:7px; overflow:hidden; position:relative; }
  .arm .fill { height:100%; background:var(--accent); opacity:.55; width:0; transition:width .5s ease; }
  .arm.chosen .fill { opacity:1; } .arm.chosen b { color:var(--accent); }
  .arm .label { position:absolute; left:8px; top:0; line-height:14px; font-size:10px; color:var(--ink); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; right:6px; }
  .arm em { font-style:normal; text-align:right; font-variant-numeric:tabular-nums; color:var(--muted); }
  .decision { font-size:12px; margin-bottom:8px; min-height:1.4em; }
  svg { width:100%; height:70px; display:block; }
  .hits div { display:grid; grid-template-columns:1fr 52px; gap:8px; align-items:center; margin:4px 0; font-size:11.5px; }
  .hits .score { height:8px; background:var(--bar); border-radius:4px; overflow:hidden; } .hits .score i { display:block; height:100%; background:var(--graph); }
  .query { font-size:12px; margin-bottom:8px; } .query b { font-weight:600; }
  ol.log { list-style:none; margin:0; padding:0; max-height:320px; overflow:auto; font-size:11.5px; }
  ol.log li { display:grid; grid-template-columns:64px 74px 1fr; gap:8px; padding:4px 0; border-bottom:1px solid var(--line); }
  ol.log time { color:var(--muted); font-variant-numeric:tabular-nums; }
  .kind { font-size:10px; font-weight:600; color:var(--muted); text-transform:uppercase; }
  .empty { color:var(--muted); font-size:12px; }
  .tabs { display:flex; gap:4px; padding:10px 18px 0; border-bottom:1px solid var(--line); }
  .tabs button { font:inherit; font-weight:600; font-size:12px; border:0; background:none; color:var(--muted); padding:8px 12px; border-bottom:2px solid transparent; cursor:pointer; }
  .tabs button[aria-selected="true"] { color:var(--ink); border-bottom-color:var(--accent); }
  .how { max-width:860px; padding:18px 18px 40px; }
  .how h2 { font:600 18px/1.25 Georgia, serif; text-transform:none; letter-spacing:0; color:var(--ink); margin:30px 0 8px; }
  .how h2:first-child { margin-top:6px; }
  .how h3 { font-size:13px; margin:18px 0 6px; }
  .how p, .how li { font-size:13px; line-height:1.6; }
  .how pre { background:var(--card); border:1px solid var(--line); border-radius:8px; padding:10px 12px; overflow-x:auto; font:12px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace; }
  .how code { font:12px ui-monospace, SFMono-Regular, Menlo, monospace; background:var(--card); border:1px solid var(--line); border-radius:4px; padding:0 4px; }
  .how pre code { border:0; padding:0; background:none; }
  .how table { border-collapse:collapse; width:100%; font-size:12px; margin:8px 0; }
  .how th, .how td { text-align:left; vertical-align:top; padding:6px 8px; border-bottom:1px solid var(--line); }
  .how th { color:var(--muted); font-weight:600; }
  .how .callout { border-left:4px solid var(--accent); background:var(--card); padding:10px 14px; border-radius:0 8px 8px 0; margin:12px 0; }
  .how .flow-diagram { display:flex; flex-wrap:wrap; gap:6px; align-items:center; margin:10px 0; }
  .how .flow-diagram span.box { border:1px solid var(--line); background:var(--card); border-radius:8px; padding:6px 10px; font-size:12px; }
  .how .flow-diagram span.arrow { color:var(--muted); }
  .arm .meta { grid-column:2 / 4; font-size:10px; color:var(--muted); margin-top:-3px; }
  @media (max-width: 420px) { header { padding:12px 16px; } main, .stats { padding-left:16px; padding-right:16px; } }
</style></head>
<body>
<header>
  <h1>Triage · Learning monitor</h1>
  <span class="live"><span class="dot" id="dot"></span><span id="status">Connecting…</span></span>
  <span class="share" id="share"></span>
</header>
<nav class="tabs" role="tablist" aria-label="Monitor views">
  <button role="tab" id="tab-live-button" aria-selected="true" aria-controls="tab-live">Live</button>
  <button role="tab" id="tab-how-button" aria-selected="false" aria-controls="tab-how">How it works</button>
</nav>
<div id="tab-live" role="tabpanel" aria-labelledby="tab-live-button">
<div class="stats">
  <div class="stat"><b id="s-chain">0</b><span>LangChain runs</span></div>
  <div class="stat"><b id="s-graph">0</b><span>LangGraph node runs</span></div>
  <div class="stat"><b id="s-retrieval">0</b><span>Memory retrievals</span></div>
  <div class="stat"><b id="s-memory">0</b><span>Memories saved</span></div>
  <div class="stat"><b id="s-rated">0</b><span>Rated layouts</span></div>
  <div class="stat"><b id="s-avg">–</b><span>Average reward</span></div>
</div>
<main>
  <section>
    <h2><span class="tag langgraph">LangGraph</span> Task graph</h2>
    <p class="sub">refill_prescription · state saved after every node; pauses wait for the person</p>
    <div class="flow" id="graph"></div>
    <div class="pause" id="pause"></div>
  </section>
  <section>
    <h2><span class="tag langchain">LangChain</span> Simplifier pipeline</h2>
    <p class="sub">simplify_page · RunnableSequence of four traced steps</p>
    <div class="flow" id="pipeline"></div>
    <div class="pause" id="pipe-note"></div>
  </section>
  <section>
    <h2>Layout learning · Thompson sampling</h2>
    <p class="sub">Chance of choosing each layout for this kind of page. It shifts as ratings come in.</p>
    <div class="decision" id="decision"><span class="empty">No page simplified yet.</span></div>
    <div id="arms"></div>
  </section>
  <section>
    <h2>Reward history</h2>
    <p class="sub">Each rated page becomes a reward (0–1) that updates the layout model.</p>
    <svg id="spark" viewBox="0 0 300 70" preserveAspectRatio="none" role="img" aria-label="Reward history"></svg>
    <div class="decision" id="reward-note"><span class="empty">No ratings yet. Rate a simplified page in History.</span></div>
  </section>
  <section>
    <h2><span class="tag langchain">LangChain</span> Memory retrieval</h2>
    <p class="sub">VectorStoreRetriever over on-device memory · personal numbers are masked here</p>
    <div class="query" id="query"><span class="empty">No lookups yet.</span></div>
    <div class="hits" id="hits"></div>
  </section>
  <section>
    <h2>Live trace</h2>
    <p class="sub">Every step LangChain and LangGraph actually ran, newest first.</p>
    <ol class="log" id="log"></ol>
  </section>
</main>
</div>
<article class="how" id="tab-how" role="tabpanel" aria-labelledby="tab-how-button" hidden>
${HOW_IT_WORKS}
</article>
<script nonce="${nonce}">
(function () {
  var token = new URLSearchParams(location.search).get('t') || ''
  var $ = function (id) { return document.getElementById(id) }
  var GRAPH = ['recall','gather','open','fill','confirm','submit','remember']
  var GRAPH_LABEL = { recall:'Recall memory', gather:'Ask what\\u2019s missing', open:'Open page', fill:'Fill form', confirm:'Ask for yes', submit:'Send', remember:'Save for next time' }
  var PIPE = ['classify_page','choose_layout','rewrite_page','log_decision']
  var PIPE_LABEL = { classify_page:'Classify page', choose_layout:'Choose layout', rewrite_page:'Rewrite page', log_decision:'Log decision' }
  var counts = { chain:0, graph:0, retrieval:0, memory:0 }
  var rewards = []
  var runs = {}

  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e }
  function flow(id, steps, labels) {
    var box = $(id); box.textContent = ''
    steps.forEach(function (step, i) {
      if (i) box.appendChild(el('span', 'arrow', '→'))
      var n = el('div', 'node'); n.id = id + '-' + step; n.appendChild(document.createTextNode(labels[step]))
      var s = el('small', '', step); n.appendChild(s); box.appendChild(n)
    })
  }
  function mark(id, step, state, ms) {
    var n = $(id + '-' + step); if (!n) return
    n.className = 'node ' + state
    if (ms != null) n.querySelector('small').textContent = step + ' · ' + ms + ' ms'
  }
  function resetFlow(id, steps) { steps.forEach(function (s) { var n = $(id + '-' + s); if (n) { n.className = 'node'; n.querySelector('small').textContent = s } }) }
  flow('graph', GRAPH, GRAPH_LABEL); flow('pipeline', PIPE, PIPE_LABEL)

  function stat() {
    $('s-chain').textContent = counts.chain; $('s-graph').textContent = counts.graph
    $('s-retrieval').textContent = counts.retrieval; $('s-memory').textContent = counts.memory
  }
  function log(kind, text, at) {
    var li = el('li'); li.appendChild(el('time', '', new Date(at).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit', second:'2-digit' })))
    li.appendChild(el('span', 'kind', kind)); li.appendChild(el('span', '', text))
    var list = $('log'); list.insertBefore(li, list.firstChild)
    while (list.children.length > 200) list.removeChild(list.lastChild)
  }
  function spark() {
    var svg = $('spark'); svg.textContent = ''
    if (!rewards.length) return
    var ns = 'http://www.w3.org/2000/svg', w = 300, h = 70, n = rewards.length
    var x = function (i) { return n === 1 ? w / 2 : 6 + i * (w - 12) / (n - 1) }, y = function (v) { return h - 6 - v * (h - 12) }
    var base = document.createElementNS(ns, 'line'); base.setAttribute('x1', 0); base.setAttribute('x2', w); base.setAttribute('y1', y(0.5)); base.setAttribute('y2', y(0.5))
    base.setAttribute('stroke', 'currentColor'); base.setAttribute('stroke-opacity', '0.15'); base.setAttribute('stroke-dasharray', '3 3'); svg.appendChild(base)
    var path = document.createElementNS(ns, 'polyline')
    path.setAttribute('points', rewards.map(function (v, i) { return x(i) + ',' + y(v) }).join(' '))
    path.setAttribute('fill', 'none'); path.setAttribute('stroke', '#c4562c'); path.setAttribute('stroke-width', '2'); path.setAttribute('vector-effect', 'non-scaling-stroke')
    svg.appendChild(path)
    rewards.forEach(function (v, i) { var c = document.createElementNS(ns, 'circle'); c.setAttribute('cx', x(i)); c.setAttribute('cy', y(v)); c.setAttribute('r', 3); c.setAttribute('fill', '#c4562c'); svg.appendChild(c) })
  }

  function handle(e) {
    if (e.type === 'run') {
      if (e.phase === 'start') {
        runs[e.runId] = e
        if (e.system === 'langgraph') counts.graph++; else counts.chain++
        if (e.node && GRAPH.indexOf(e.node) >= 0) {
          if (e.node === 'recall') { resetFlow('graph', GRAPH); $('pause').textContent = '' }
          mark('graph', e.node, 'running')
        }
        if (PIPE.indexOf(e.name) >= 0) { if (e.name === 'classify_page') { resetFlow('pipeline', PIPE); $('pipe-note').textContent = '' } mark('pipeline', e.name, 'running') }
        if (e.name === 'refill_prescription' || e.name === 'simplify_page') log(e.system === 'langgraph' || e.name === 'refill_prescription' ? 'LangGraph' : 'LangChain', 'Started ' + e.name, e.at)
        else if (e.node || PIPE.indexOf(e.name) >= 0) log(e.node ? 'LangGraph' : 'LangChain', 'Running ' + (e.node || e.name), e.at)
      } else {
        var start = runs[e.runId]; delete runs[e.runId]
        var name = start ? (start.node || start.name) : e.name
        if (GRAPH.indexOf(name) >= 0 && start && start.node) {
          var node = $('graph-' + name)
          if (!(node && node.className.indexOf('paused') >= 0)) mark('graph', name, e.phase === 'error' ? 'paused' : 'done', e.durationMs)
        }
        if (PIPE.indexOf(name) >= 0) mark('pipeline', name, 'done', e.durationMs)
        if (name === 'simplify_page') $('pipe-note').textContent = 'Finished in ' + e.durationMs + ' ms'
        if (e.phase === 'error') log('error', name + ': ' + (e.error || 'failed'), e.at)
      }
      stat()
    } else if (e.type === 'interrupt') {
      var running = document.querySelector('#graph .node.running')
      if (running) running.className = 'node paused'
      $('pause').textContent = 'Paused, waiting for the person: \\u201c' + e.prompt + '\\u201d'
      log('LangGraph', 'Interrupt (' + e.kind + '): checkpoint saved, waiting for the person', e.at)
    } else if (e.type === 'retrieval') {
      counts.retrieval++; stat()
      var q = $('query'); q.textContent = ''; q.appendChild(el('span', '', 'Query: ')); q.appendChild(el('b', '', '\\u201c' + e.query + '\\u201d'))
      q.appendChild(el('span', '', ' · ' + e.hits.length + ' hits in ' + e.durationMs + ' ms'))
      var hits = $('hits'); hits.textContent = ''
      e.hits.forEach(function (h) {
        var row = el('div'); row.appendChild(el('span', '', h.text + '  (' + h.kind + ')'))
        var bar = el('span', 'score'); var fill = el('i'); fill.style.width = Math.max(0, Math.min(1, h.score || 0)) * 100 + '%'; bar.appendChild(fill)
        bar.title = 'similarity ' + (h.score != null ? h.score.toFixed(2) : 'n/a'); row.appendChild(bar); hits.appendChild(row)
      })
      log('retriever', 'Looked up \\u201c' + e.query + '\\u201d \\u2192 ' + e.hits.length + ' memories', e.at)
    } else if (e.type === 'memory') {
      if (e.action === 'saved') counts.memory++
      stat(); log('memory', (e.action === 'saved' ? 'Saved ' : 'Removed ') + (e.key ? '[' + e.key + '] ' : '') + e.text, e.at)
    } else if (e.type === 'bandit') {
      var d = $('decision'); d.textContent = ''
      d.appendChild(el('b', '', 'Chose ' + e.armId + ': ' + e.layout))
      d.appendChild(el('div', 'sub', 'Page type ' + e.pageType + ' · mode ' + e.mode + ' · p = ' + e.propensity.toFixed(2) + ' · written by ' + (e.source === 'llm' ? 'the model' : 'rules')))
      var arms = $('arms'); arms.textContent = ''
      Object.keys(e.shares).sort().forEach(function (id) {
        var row = el('div', 'arm' + (id === e.armId ? ' chosen' : ''))
        row.appendChild(el('b', '', id))
        var track = el('div', 'track'); var fill = el('div', 'fill'); track.appendChild(fill)
        row.appendChild(track); row.appendChild(el('em', '', Math.round(e.shares[id] * 100) + '%'))
        if (e.diagnostics && e.diagnostics[id]) {
          var dg = e.diagnostics[id]
          row.appendChild(el('span', 'meta', 'learned noise \u03c3\u00b2 \u2248 ' + dg.noiseVariance.toFixed(3) + ' \u00b7 ' + dg.evidence.toFixed(1) + ' recent ratings'))
        }
        arms.appendChild(row)
        requestAnimationFrame(function () { fill.style.width = Math.round(e.shares[id] * 100) + '%' })
      })
      log('bandit', 'Layout ' + e.armId + ' (' + e.mode + ', p=' + e.propensity.toFixed(2) + ') for a ' + e.pageType + ' page', e.at)
    } else if (e.type === 'reward') {
      rewards.push(e.reward); if (rewards.length > 40) rewards.shift(); spark()
      $('s-rated').textContent = e.rated; $('s-avg').textContent = e.averageReward == null ? '–' : Math.round(e.averageReward * 100) + '%'
      var r = $('reward-note'); r.textContent = 'Last reward ' + Math.round(e.reward * 100) + '% for ' + e.armId + ' (' + e.layout + ') · model updated'
      log('reward', Math.round(e.reward * 100) + '% for layout ' + e.armId + ' \\u2192 posterior updated', e.at)
    } else if (e.type === 'note') { log('note', e.text, e.at) }
  }

  fetch('/info?t=' + encodeURIComponent(token)).then(function (r) { return r.ok ? r.json() : null }).then(function (info) {
    if (info && info.lanUrl) $('share').textContent = 'Open on another device: ' + info.lanUrl
    else if (info) $('share').textContent = 'Only on this computer'
  }).catch(function () {})

  function selectTab(name) {
    ;['live', 'how'].forEach(function (tab) {
      var on = tab === name
      $('tab-' + tab).hidden = !on
      $('tab-' + tab + '-button').setAttribute('aria-selected', on ? 'true' : 'false')
    })
  }
  $('tab-live-button').addEventListener('click', function () { selectTab('live') })
  $('tab-how-button').addEventListener('click', function () { selectTab('how') })

  var source = new EventSource('/events?t=' + encodeURIComponent(token))
  source.onopen = function () { $('dot').className = 'dot on'; $('status').textContent = 'Live' }
  source.onerror = function () { $('dot').className = 'dot'; $('status').textContent = 'Reconnecting…' }
  source.onmessage = function (m) { try { handle(JSON.parse(m.data)) } catch (err) {} }
})()
</script>
</body></html>`
}
