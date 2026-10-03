import { COLORS, nodeOrder, linkText, UNKNOWN, finite, fixed, compact, duration, tokenRate, gib, escapeHtml as esc, clockTime, eventTime, localDay, monthLabel, dayLabel, monthOptions, chartPath, validateMonth, fabricLayout, labelWidth, nextTheme, topologyKey, staleAfterMs, livePoint, mergeLivePoint, timeoutSignal, onMediaChange } from './view-data.js';
const $ = selector => document.querySelector(selector);
let latest = null, metas = [], lastTopology = null, range = 60, collecting = false, monthSequence = 0, monthLoadedAt = 0, monthController = null;
// The full history is fetched every 30 s and when the range changes; polls in between add their own sample to it.
const HISTORY_REFRESH_MS = 30_000;
let history = [], historyAt = 0, historyRange = null;
// The token ledger counts days in the server's time zone (usage.timeZone); until the first response, the viewer's own.
let ledgerTimeZone = null;
const ledgerToday = () => localDay(Date.now(), ledgerTimeZone);
// Model servers (topology.json "servers"): the one the output, engine and ledger panels follow, from ?server= or the
// last pick in this browser. The server answers with its first server for an id it does not know.
let selectedServer=new URLSearchParams(location.search).get('server');try{selectedServer??=localStorage.getItem('spark-scope-server')}catch{}
const serverQuery=()=>selectedServer?`&server=${encodeURIComponent(selectedServer)}`:'';
// Node id -> its server summary, rebuilt from every state.
let serverOf={};
// Until the server names its ledger time zone, the month is a guess; it follows the server's month unless picked by hand.
let selectedMonth = ledgerToday().slice(0,7), earliestMonth = null, monthPicked = false;
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
// Unchanged text is left alone, so live regions only speak when something actually changes.
function text(selector, value) { const el = $(selector); if (el.textContent !== value) el.textContent = value; el.classList.toggle('unknown-value', value === UNKNOWN || value === 'stopped'); }
// Theme: follows the system until picked; the button cycles through the other look, the system's look and back to system.
const themeToggle=$('#theme-toggle'),darkQuery=matchMedia('(prefers-color-scheme: dark)');
let themeChoice=null;try{const saved=localStorage.getItem('spark-scope-theme');if(saved==='light'||saved==='dark')themeChoice=saved}catch{}
function applyTheme() {
  const system=darkQuery.matches?'dark':'light',next=nextTheme(themeChoice,system);
  document.documentElement.dataset.theme=themeChoice??system;themeToggle.dataset.choice=themeChoice??'system';
  themeToggle.title=`Theme: ${themeChoice??`system (${system})`}. Switch to ${next??'system'}`;themeToggle.setAttribute('aria-label',themeToggle.title);
}
themeToggle.addEventListener('click',()=>{themeChoice=nextTheme(themeChoice,darkQuery.matches?'dark':'light');try{themeChoice?localStorage.setItem('spark-scope-theme',themeChoice):localStorage.removeItem('spark-scope-theme')}catch{}applyTheme()});
onMediaChange(darkQuery,applyTheme);applyTheme();

const ROLE_NAMES={HEAD:'Head',WORKER:'Worker',NODE:'Node',SOLO:'Solo'};
// Badge colours follow the node's state, the same way the rack panel colours its bays.
const BADGE_LEVELS={serving:'good',idle:'idle','no GPU data':'warn','no response':'crit','not collected':'idle'};
// One card per node in topology order; rebuilt when anything in topology.json changes on the server.
let nodesKey=null;
function syncNodes(next) {
  const key=topologyKey(next);if(nodesKey===key)return;
  nodesKey=key;metas=next;$('#nodes').dataset.count=metas.length<=6?String(metas.length):'many';
  $('#brand-count').textContent=metas.length>1?`× ${metas.length}`:'';buildNodes();
}
// Sensors and the TP rank are shown only when a node reports them; ACPI zones keep their firmware names.
const EXTRA_FIELDS=[['Free disk','disk'],['Process memory','process-memory'],['CPU load','cpu',true],['NVMe','nvme',true],['NIC','nic',true],['System','system'],['TP rank','rank',true]];
function buildNodes() {
  $('#nodes').innerHTML=metas.map(meta=>`<article class="node" data-node-id="${esc(meta.id)}"><header><h2 data-node="title">${esc(meta.name)}</h2><span class="badge" data-node="state">checking</span></header><div class="role"><span data-node="role"></span><span data-node="connection"></span></div><div class="instrument"><div class="gauge"><svg viewBox="0 0 114 72" aria-hidden="true"><path class="track" d="M10 62 A47 47 0 0 1 104 62"/><path class="needle" pathLength="100" stroke-dasharray="0 100" d="M10 62 A47 47 0 0 1 104 62"/></svg><strong data-node="gpu">${UNKNOWN}</strong><span>GPU load</span></div><div class="readings">${[['GPU temperature','temp','°C'],['GPU power','power','W'],['Free memory','memory','GiB'],['Clock','clock','MHz']].map(([label,field,unit])=>`<div class="reading"><small>${label}</small><b><span data-node="${field}">${UNKNOWN}</span><em>${unit}</em></b></div>`).join('')}</div></div><div class="mem"><div class="memline"><span>Unified memory usage</span><span data-node="memory-used">${UNKNOWN}</span></div><div class="meter"><i style="width:0"></i></div></div><details><summary data-node="kernel-summary">Checking kernel diagnostics</summary><div class="extra">${EXTRA_FIELDS.map(([label,field,optional])=>`<span${optional?' data-optional hidden':''}>${label} <b data-node="${field}">${UNKNOWN}</b></span>`).join('')}<span class="wide" data-optional hidden>ACPI <b data-node="zones">${UNKNOWN}</b></span><span class="wide" data-optional hidden>Container <b data-node="container">${UNKNOWN}</b></span><span class="wide" data-node="kernel-last"></span><span class="wide" data-node="last-update"></span></div></details></article>`).join('');
}
function renderNode(meta,node) {
  const el=$('#nodes').querySelector(`[data-node-id="${CSS.escape(meta.id)}"]`);if(!el)return;
  const set=(name,value)=>{const field=el.querySelector(`[data-node="${name}"]`);field.textContent=value;field.classList.toggle('unknown-value',value===UNKNOWN);if(field.parentElement.hasAttribute('data-optional'))field.parentElement.hidden=value===UNKNOWN};
  const pending=meta.collect===false||node?.collected===false,ok=Boolean(node?.ok);el.classList.toggle('is-unknown',!ok);
  const home=serverOf[meta.id];el.classList.toggle('other-server',Boolean(latest?.server&&home?.id!==latest.server));
  const target=meta.local?'local':meta.host??'no host';
  set('title',meta.name);set('role',[home?.name!==meta.name?home?.name:null,ROLE_NAMES[meta.role]??meta.role,meta.hardware].filter(Boolean).join(' | '));
  const state=pending?'not collected':!ok?'no response':node.gpu?.available===false?'no GPU data':node.inferenceProcessReady?'serving':'idle';
  set('state',state);el.querySelector('.badge').dataset.level=BADGE_LEVELS[state]??'idle';
  set('connection',pending?`${target} | not collected`:ok?`${target} | ${fixed(node.latencyMs,0)} ms`:`${target} | status unknown`);
  const gpu=ok?node.gpu:{};set('gpu',finite(gpu?.utilization)?fixed(gpu.utilization,0)+'%':UNKNOWN);el.querySelector('[data-node="gpu"]').classList.toggle('full',finite(gpu?.utilization)&&gpu.utilization>=99.5);
  set('temp',fixed(gpu?.temperature,0));
  // The card warms with the GPU: no tint below 55 °C, full red glow from 90 °C.
  el.style.setProperty('--heat',finite(gpu?.temperature)?String(Math.max(0,Math.min(1,(gpu.temperature-55)/35)).toFixed(2)):'0');el.classList.toggle('hot',finite(gpu?.temperature)&&gpu.temperature>=85);set('power',fixed(gpu?.powerWatts));set('memory',gib(ok?node.memory?.availableBytes:null));set('clock',fixed(gpu?.clockMHz,0));
  const total=ok?node.memory?.totalBytes:null,used=ok?node.memory?.usedBytes:null;
  set('memory-used',finite(total)&&finite(used)?`${gib(used)} / ${gib(total,0)} GiB`:UNKNOWN);
  el.querySelector('.needle').setAttribute('stroke-dasharray',`${finite(gpu?.utilization)?Math.max(0,Math.min(100,gpu.utilization)):0} 100`);
  el.querySelector('.meter i').style.width=finite(total)&&total>0&&finite(used)?`${Math.min(100,used/total*100)}%`:'0%';
  set('disk',ok&&finite(node.disk?.availableBytes)?gib(node.disk.availableBytes,0)+' GiB':UNKNOWN);set('process-memory',ok&&finite(node.processMemoryBytes)?gib(node.processMemoryBytes)+' GiB':UNKNOWN);
  const cpu=ok?node.cpu:null;set('cpu',finite(cpu?.load1)?`${fixed(cpu.load1,2)}${finite(cpu.cores)?` / ${cpu.cores} cores`:''}`:UNKNOWN);
  set('nvme',ok?fixed(node.nvmeCelsius,1,' °C'):UNKNOWN);set('nic',ok?fixed(node.nicCelsius,1,' °C'):UNKNOWN);
  const zones=ok?Object.entries(node.thermals?.zones??{}).filter(([,value])=>finite(value)):[];set('zones',zones.length?zones.map(([name,value])=>`${name} ${fixed(value,1)}`).join(' | ')+' °C':UNKNOWN);
  set('system',ok&&node.systemState?`${node.systemState} (failed ${node.failedUnits})`:UNKNOWN);set('rank',ok&&finite(node.rank)?String(node.rank):UNKNOWN);
  // The container line appears only when the node can see its inference container (Docker access).
  set('container',ok&&node.container?.detected?`${node.container.name} ${node.container.running?'running':'stopped'} (restarts ${node.container.restarts})`:UNKNOWN);
  const kernel=ok?node.kernelEvents:null;
  set('kernel-summary',kernel?.available?`24 h: Xid ${kernel.capped?'≥':''}${kernel.xid}, NO MEMORY ${kernel.capped?'≥':''}${kernel.noMemory} | details`:'Kernel diagnostics unavailable | details');
  set('kernel-last',kernel?.available?(kernel.total?`${eventTime(kernel.lastAt)} ${kernel.lastMessage||'kernel error'}`:'No matching kernel errors in the last 24 h'):'Kernel journal summary unavailable');
  set('last-update',pending?'not collected':`Last poll ${clockTime(node?.updatedAt)}`);
}
const LINK_STROKE={up:['var(--link)',''],slow:['var(--orange)',''],partial:['var(--orange)',''],pending:['var(--orange)','6 5'],down:['var(--red)','6 5'],unknown:['var(--line)','3 4']};
// The interconnect: one line per cable. With one node or no links configured the panel is hidden.
function renderLinks(state) {
  const topology=state?.topology??lastTopology,links=topology?.links??[],layout=fabricLayout(topology);
  $('#fabric-panel').hidden=!layout;$('#body-grid').classList.toggle('no-fabric',!layout);
  if(!layout)return;
  $('#link-rows').innerHTML=links.map(link=>{const live=state?.ringLinks?.[link.id],st=live?.state??'unknown',planes=link.planes??['a','b'],color=st==='up'&&!live.slow?'green':st==='down'?'red':st==='unknown'?'muted':'orange';const rate=plane=>planes.includes(plane)?fixed(live?.[plane]?.rateGbps,2):'—';return `<tr><td>${esc(link.label.replace('–',' ↔ '))}</td><td>${rate('a')}</td><td>${rate('b')}</td><td style="color:var(--${color})">${esc(linkText(live))}</td></tr>`}).join('');
  $('#fabric-links').innerHTML=layout.links.map(line=>{const live=state?.ringLinks?.[line.id],[stroke,dash]=LINK_STROKE[live?.state==='up'&&live.slow?'slow':live?.state??'unknown']??LINK_STROKE.unknown;return `<line x1="${line.x1.toFixed(1)}" y1="${line.y1.toFixed(1)}" x2="${line.x2.toFixed(1)}" y2="${line.y2.toFixed(1)}" style="stroke:${stroke}${dash?`;stroke-dasharray:${dash}`:''}"><title>${esc(links.find(link=>link.id===line.id)?.label??line.id)}: ${esc(linkText(live))}</title></line>`}).join('');
  // Short ids sit in a circle; longer ones in a pill sized to the label, with the full id and name on hover.
  $('#fabric-nodes').innerHTML=layout.nodes.map(node=>{const width=labelWidth(node.label),meta=topology.nodes.find(item=>item.id===node.id),x=node.x.toFixed(1),y=node.y.toFixed(1);const shape=width===38?`<circle cx="${x}" cy="${y}" r="19" style="stroke:${node.color}"/>`:`<rect x="${(node.x-width/2).toFixed(1)}" y="${(node.y-16).toFixed(1)}" width="${width}" height="32" rx="16" style="stroke:${node.color}"/>`;return `<g><title>${esc(node.id)}${meta?.name&&meta.name!==node.id?` | ${esc(meta.name)}`:''}</title>${shape}<text class="label" x="${x}" y="${(node.y+4).toFixed(1)}" text-anchor="middle">${esc(node.label)}</text></g>`}).join('');
  const paths=links.reduce((sum,link)=>sum+(link.planes??['a','b']).length,0),count=$('#fabric-count');
  count.setAttribute('x',layout.caption.x);count.setAttribute('y',layout.caption.y);count.textContent=`${plural(links.length,'cable')} | ${plural(paths,'logical path')}`;
}
function renderCharts(state) {
  const history=state.history||[],end=Date.now(),start=end-range*60_000;
  const rates=history.map(p=>p.outputTokensPerSecond).filter(finite),avg=state.historyStats?.activeOutputTokensPerSecond;
  const max=niceCeil(Math.max(1,...rates,finite(avg)?avg:0)*1.1);
  const d=chartPath(history,'outputTokensPerSecond',{start,end,min:0,max,top:4,bottom:22});$('#output-line').setAttribute('d',d);$('#output-fill').setAttribute('d','');
  $('#avg-line').setAttribute('d',finite(avg)?chartPath([{at:start,value:avg},{at:end,value:avg}],'value',{start,end,min:0,max,top:4,bottom:22}):'');
  const queueMax=Math.max(1,...history.map(p=>p.queue).filter(finite));$('#queue-line').setAttribute('d',chartPath(history,'queue',{start,end,min:0,max:queueMax,top:120,bottom:4}));
  // Output axis: the plot is 140 px tall with 4 px above and 22 px below the data, drawn 25 px above the plot's bottom edge.
  setAxis($('#output-axis'),[max,max/2,0].map(value=>({label:`${fixed(value,value>0&&value<10?1:0)} tok/s`,style:`bottom:${(25+22+(value/max)*(140-4-22)).toFixed(1)}px`,edge:'bottom'})));
  chartContext.output={history,start,end};
  const label=value=>clockTime(value,{seconds:false});
  text('#range-start',label(start));text('#range-mid',label((start+end)/2));text('#range-end',label(end));
  $('#plot-note').hidden=rates.length>0;$('#plot-note').textContent=state.inferenceState==='stopped'?'The inference process is stopped.':'No output measurements yet.';
  for(const kind of ['temp','mem']) {
    // Values are picked per node id from each sample, so an id never collides with the sample's own fields (such as "at").
    const field=kind==='temp'?'temperature':'memoryAvailableBytes',scale=kind==='mem'?2**30:1,ids=metas.map(meta=>meta.id);
    const pick=id=>point=>{const v=point.nodes?.[id]?.[field];return finite(v)?v/scale:null};
    const values=history.flatMap(point=>ids.map(id=>pick(id)(point))).filter(finite),low=kind==='temp'&&values.length?Math.min(...values)-2:0,high=values.length?Math.max(...values)+(kind==='temp'?2:5):1;
    $('#'+kind+'-chart').innerHTML=ids.map((id,index)=>`<path d="${chartPath(history,pick(id),{start,end,width:320,height:80,min:low,max:high})}" fill="none" stroke="${COLORS[index%COLORS.length]}" stroke-width="2" vector-effect="non-scaling-stroke"/>`).join('');
    const box=document.querySelector(`.chart-box[data-chart="${kind}"]`),unit=kind==='temp'?' °C':' GiB';
    setAxis(box.querySelector('.y-axis'),values.length?[{label:fixed(high,0)+unit,style:'top:0',edge:'top'},{label:fixed(low,0)+unit,style:'bottom:0',edge:'bottom'}]:[]);
    chartContext[kind]={history,start,end,pick,ids,state};
    $('#'+kind+'-legend').innerHTML=metas.map((meta,index)=>{const node=state.nodes?.[meta.id];const value=!node?.ok?UNKNOWN:kind==='temp'?fixed(node.gpu?.temperature,0):gib(node.memory?.availableBytes);return `<span style="color:${COLORS[index%COLORS.length]}">${esc(meta.name)} <b class="num">${value}</b></span>`}).join('');
  }
}
// Y-axis labels sit over the chart in HTML: the SVGs stretch to their box, which would distort SVG text.
// A round top for the output scale (10, 20, 25, 50, 100 ...), so its axis labels read cleanly.
const niceCeil=value=>{const step=10**Math.floor(Math.log10(value));return [1,2,2.5,5,10].map(m=>m*step).find(n=>n>=value)};
function setAxis(axis,ticks) {
  const html=ticks.map(tick=>`<span class="${tick.edge}" style="${tick.style}"><em>${esc(tick.label)}</em></span>`).join('');
  if(axis.innerHTML!==html)axis.innerHTML=html;
}
// Hover: a hairline snaps to the nearest sample under the pointer and a readout lists every series at that time,
// so a value never has to be caught live.
const chartContext={};
function nearestPoint(context,fraction) {
  const at=context.start+fraction*(context.end-context.start);let best=null;
  for(const point of context.history)if(finite(point.at)&&(!best||Math.abs(point.at-at)<Math.abs(best.at-at)))best=point;
  // Nothing within 3% of the range (a gap in the data): show nothing rather than a far-off sample.
  return best&&Math.abs(best.at-at)<=(context.end-context.start)*0.03?best:null;
}
function tipRows(kind,point,context) {
  if(kind==='output')return [['var(--blue)','Output',finite(point.outputTokensPerSecond)?`${fixed(point.outputTokensPerSecond,1)} tok/s`:UNKNOWN],['var(--orange)','Queue',finite(point.queue)?fixed(point.queue,0):UNKNOWN],[null,'Running',finite(point.runningRequests)?fixed(point.runningRequests,0):UNKNOWN]];
  return context.ids.map((id,index)=>{const value=context.pick(id)(point);return [COLORS[index%COLORS.length],metas.find(meta=>meta.id===id)?.name??id,finite(value)?(kind==='temp'?`${fixed(value,0)} °C`:`${fixed(value,1)} GiB`):UNKNOWN]});
}
function showTip(box,clientX) {
  const kind=box.dataset.chart,context=chartContext[kind],svg=box.querySelector('svg'),line=box.querySelector('.hover-line'),tip=box.querySelector('.chart-tip');
  const rect=svg.getBoundingClientRect(),fraction=(clientX-rect.left)/rect.width;
  const point=context&&fraction>=0&&fraction<=1?nearestPoint(context,fraction):null;
  if(!point){line.hidden=true;tip.hidden=true;return}
  const boxRect=box.getBoundingClientRect(),x=rect.left-boxRect.left+(point.at-context.start)/(context.end-context.start)*rect.width;
  line.hidden=false;line.style.left=`${x.toFixed(1)}px`;
  // Built with textContent: node names come from topology.json.
  tip.replaceChildren();const time=document.createElement('div');time.className='tip-time';time.textContent=clockTime(point.at);tip.append(time);
  for(const [color,label,value] of tipRows(kind,point,context)){const row=document.createElement('div'),key=document.createElement('i'),strong=document.createElement('b'),name=document.createElement('span');if(color)key.style.background=color;else key.className='blank';strong.textContent=value;name.textContent=label;row.append(key,strong,name);tip.append(row)}
  tip.hidden=false;const left=x+12+tip.offsetWidth>box.clientWidth?x-12-tip.offsetWidth:x+12;tip.style.left=`${Math.max(0,left).toFixed(1)}px`;
}
const hoverAt=new Map();
document.querySelectorAll('[data-chart]').forEach(box=>{
  box.addEventListener('pointermove',event=>{hoverAt.set(box,event.clientX);showTip(box,event.clientX)});
  box.addEventListener('pointerleave',()=>{hoverAt.delete(box);box.querySelector('.hover-line').hidden=true;box.querySelector('.chart-tip').hidden=true});
});
function refreshTips() { for(const [box,clientX] of hoverAt)showTip(box,clientX); }
function renderToday(usage) {
  for(const selector of ['[data-usage]','[data-today]'])document.querySelectorAll(selector).forEach(el=>{const key=el.dataset.usage||el.dataset.today;const value=usage?.error||usage?.reported?.[key]===false?null:usage?.today?.[key];el.textContent=key==='requests'?fixed(value,0):compact(value);el.title=finite(value)?value.toLocaleString('en-US'):''});
  document.querySelectorAll('[data-ledger-zone]').forEach(el=>{el.textContent=ledgerTimeZone?`Days in ${ledgerTimeZone}`:''});
}
function renderState(state) {
  const age=Date.now()-Date.parse(state.updatedAt);if(!Number.isFinite(age)||age>staleAfterMs(state))throw new Error('stale data');
  latest=state;lastTopology=state.topology??lastTopology;
  if(state.usage?.timeZone&&state.usage.timeZone!==ledgerTimeZone){ledgerTimeZone=state.usage.timeZone;if(!monthPicked&&selectedMonth!==ledgerToday().slice(0,7)){selectedMonth=ledgerToday().slice(0,7);monthLoadedAt=0;rebuildMonths();if(!$('#tokens').hidden)void refreshMonth(true)}}
  syncNodes(nodeOrder(state));$('#shell').classList.remove('stale');
  serverOf=Object.fromEntries((state.servers??[]).flatMap(server=>server.nodes.map(id=>[id,server])));renderServers(state);
  const v=state.inference,stopped=state.inferenceState==='stopped',nodes=state.nodes||{};
  const scope=state.server?metas.filter(m=>serverOf[m.id]?.id===state.server):metas;
  const online=metas.filter(m=>nodes[m.id]?.ok).length,serving=scope.filter(m=>nodes[m.id]?.ok&&nodes[m.id]?.inferenceProcessReady).length,count=metas.length,processes=metas.filter(m=>nodes[m.id]?.ok&&nodes[m.id]?.inferenceProcessReady).length;
  $('.status').className='status '+(state.status==='healthy'?'':stopped?'stopped':'error');text('#status-title',state.message||'Checking status');
  const watts=metas.map(m=>nodes[m.id]).filter(n=>n?.ok&&finite(n.gpu?.powerWatts)).map(n=>n.gpu.powerWatts);
  $('#status-desc').innerHTML=`<span>Nodes ${online}/${count}</span><span>Inference processes ${processes}/${count}</span><span>API ${v?.ok?'up':'no response'}</span>${watts.length?`<span>GPU power ${fixed(watts.reduce((sum,w)=>sum+w,0),1)} W${watts.length<count?` (${watts.length}/${count} nodes)`:''}</span>`:''}`;
  text('#updated-at',clockTime(state.updatedAt));text('#model-title',v?.modelName||(stopped?'Inference stopped':'Model unknown'));text('#model-meta',serving?`${state.serving?.engine??'Inference'} running on ${plural(serving,'node')}`:`Live monitor | ${plural(scope.length,'node')}`);
  document.title=v?.modelName?`${v.modelName} | Spark Scope`:'Spark Scope';
  const empty=stopped?'stopped':UNKNOWN,value=(number,formatter=fixed)=>v?.ok?formatter(number):empty;
  text('#speed',value(v?.outputTokensPerSecond));text('#legend-speed',value(v?.outputTokensPerSecond));text('#avg',fixed(state.historyStats?.activeOutputTokensPerSecond));text('#queue',value(v?.waitingRequests,n=>fixed(n,0)));
  document.querySelectorAll('[data-field]').forEach(el=>{const key=el.dataset.field;let result=empty;if(v?.ok){if(key==='requests')result=`${fixed(v.runningRequests,0)} / ${fixed(v.waitingRequests,0)}`;else if(key.endsWith('Seconds'))result=duration(v[key]);else if(key.endsWith('Percent'))result=fixed(v[key],1,'%');else result=tokenRate(v[key])}el.textContent=result});
  metas.forEach(meta=>renderNode(meta,nodes[meta.id]));renderLinks(state);renderCharts(state);refreshTips();renderToday(state.usage);
}
// One button per model server: its model, output rate and boxes. The picked one drives the panels below.
const SERVER_LEVELS={healthy:'good',degraded:'warn',offline:'crit',starting:'idle'};
function renderServers(state) {
  const list=state.servers??[],nav=$('#servers');nav.hidden=!list.length;if(!list.length)return;
  // An id the server does not know (renamed in topology.json) falls back to the server's pick.
  if(state.server&&!list.some(server=>server.id===selectedServer))selectedServer=state.server;
  const html=list.map(server=>{const idle=server.inferenceState==='stopped',level=idle?'idle':!server.ok?'crit':SERVER_LEVELS[server.status]??'idle';
    const model=server.modelName??(idle?'Idle, no model loaded':'No response');const boxes=server.nodes.map(id=>metas.find(m=>m.id===id)?.name??id).join(' | ');
    const rate=server.ok?`<b class="num">${tokenRate(server.outputTokensPerSecond)}</b>`:'';const queue=server.ok&&finite(server.runningRequests)?`<small>${fixed(server.runningRequests,0)} running | ${fixed(server.waitingRequests??0,0)} waiting</small>`:'';
    return `<button data-server="${esc(server.id)}" aria-pressed="${server.id===state.server}"><span class="server-head"><i data-level="${level}"></i><strong>${esc(server.name)}</strong><span>${esc(boxes)}</span></span><span class="server-model">${esc(model)}</span><span class="server-rate">${rate}${queue}</span></button>`}).join('');
  if(nav.innerHTML!==html)nav.innerHTML=html;
}
$('#servers').addEventListener('click',event=>{const button=event.target.closest('[data-server]');if(!button||button.dataset.server===selectedServer)return;
  selectedServer=button.dataset.server;try{localStorage.setItem('spark-scope-server',selectedServer)}catch{}
  // The output chart and ledger belong to the server: fetch its full history and month instead of merging into the last one's.
  historyRange=null;history=[];monthLoadedAt=0;$('#servers').querySelectorAll('[data-server]').forEach(b=>b.setAttribute('aria-pressed',String(b===button)));
  void refresh();if(!$('#tokens').hidden)void refreshMonth(true)});
function failedState() {
  latest=null;
  $('#shell').classList.add('stale');$('.status').className='status error';text('#status-title','Spark Scope server not responding');text('#status-desc','Live values read as unknown until the connection returns.');
  metas.forEach(meta=>renderNode(meta,null));renderLinks(null);renderToday(null);for(const id of ['speed','legend-speed','avg','queue'])text('#'+id,UNKNOWN);document.querySelectorAll('[data-field]').forEach(el=>el.textContent=UNKNOWN);$('#plot-note').hidden=false;$('#plot-note').textContent='Lost the connection to the server. Reconnecting…';
}
async function refresh() {
  if(collecting)return;collecting=true;const requestedRange=range,requestedServer=selectedServer,full=historyRange!==requestedRange||Date.now()-historyAt>=HISTORY_REFRESH_MS;
  let data=null;const timeout=timeoutSignal(8000);
  try{const res=await fetch(`/api/state?minutes=${requestedRange}${full?'':'&history=0'}${serverQuery()}`,{cache:'no-store',signal:timeout.signal});if(!res.ok)throw new Error('HTTP '+res.status);data=await res.json()}
  catch{if(requestedRange===range)failedState()}
  finally{timeout.done()}
  try{
    if(data&&requestedRange===range&&requestedServer===selectedServer){
      if(full){history=data.history??[];historyAt=Date.now();historyRange=requestedRange}else history=mergeLivePoint(history,livePoint(data),requestedRange*60_000);
      renderState({...data,history});
    }
  }catch(error){
    // A drawing problem is not a lost connection: keep the last good view and say what broke.
    if(error?.message==='stale data')failedState();else console.error('Spark Scope could not draw the latest state:',error);
  }finally{collecting=false;if(requestedRange!==range||requestedServer!==selectedServer)void refresh()}
}

function rebuildMonths() {
  const current=ledgerToday().slice(0,7),choices=monthOptions(earliestMonth,current);
  if(!choices.includes(selectedMonth))choices.push(selectedMonth);
  $('#token-month').innerHTML=choices.sort().reverse().map(month=>`<option value="${month}"${month===selectedMonth?' selected':''}>${monthLabel(month)}</option>`).join('');
}
// A counter the engine does not export (usage.reported[key] === false) reads as unknown, not as 0.
let unreported={};
function metricCell(key,value,tag='td') { if(unreported[key]&&!value)return `<${tag} data-metric="${key}" class="unknown-value">${UNKNOWN}</${tag}>`; return `<${tag} data-metric="${key}" data-count="${value}" title="${value.toLocaleString('en-US')}">${key==='requests'?fixed(value,0):compact(value)}</${tag}>`; }
function renderMonth(usage) {
  if(usage.timeZone)ledgerTimeZone=usage.timeZone;
  unreported=Object.fromEntries(Object.entries(usage.reported??{}).filter(([,seen])=>seen===false).map(([key])=>[key,true]));
  earliestMonth=usage.firstMonth;rebuildMonths();const current=selectedMonth===usage.day.slice(0,7),name=monthLabel(selectedMonth).split(' ')[0];
  text('#month-title',current?`${name} to date`:`${name} total`);text('#month-period',current?`${dayLabel(selectedMonth+'-01')} – ${dayLabel(usage.day)}`:monthLabel(selectedMonth));
  $('#month-period').classList.remove('month-load-error');$('#today-tokens').hidden=!current;
  const metrics=[['Total tokens','total'],['Cache read','cache'],['New input','compute'],['Output','output'],['Logical input','input'],['Requests','requests']];
  const metricsHtml=metrics.map(([label,key])=>`<div class="${key==='total'?'total-tokens':''}"><small>${label}</small>${metricCell(key,usage.totals[key],'b')}</div>`).join('');
  if($('#month-metrics').innerHTML!==metricsHtml)$('#month-metrics').innerHTML=metricsHtml;
  const days=[...usage.days].sort((a,b)=>b.day.localeCompare(a.day));const fields=['cache','compute','output','input','requests'];
  $('#token-days').innerHTML=days.length?days.map(day=>`<tr><th scope="row">${esc(dayLabel(day.day))}</th>${fields.map(k=>metricCell(k,day[k])).join('')}</tr>`).join(''):'<tr><td colspan="6">No token usage recorded this month.</td></tr>';
  $('#token-month-total').innerHTML=`<tr><th scope="row">Month total</th>${fields.map(k=>metricCell(k,usage.totals[k])).join('')}</tr>`;
  const number=Number(selectedMonth.slice(5)),lastDay=current?Number(usage.day.slice(8)):new Date(Date.UTC(Number(selectedMonth.slice(0,4)),number,0)).getUTCDate();const recent=[];for(let d=Math.max(1,lastDay-6);d<=lastDay;d++){const date=selectedMonth+'-'+String(d).padStart(2,'0');recent.push({day:date,value:usage.days.find(row=>row.day===date)?.output??null})}
  const max=Math.max(1,...recent.map(p=>p.value).filter(finite));$('#token-chart').innerHTML=recent.map(row=>`<div class="day-bar" style="--h:${finite(row.value)?row.value/max*85:0}%" title="${dayLabel(row.day)}: ${finite(row.value)?'Output '+fixed(row.value,0):'no record'}"><i></i><span>${dayLabel(row.day)}</span></div>`).join('');
  renderToday(latest?.usage);
}
function clearMonth(message,isError=false) {
  text('#month-title',`${monthLabel(selectedMonth).split(' ')[0]} total`);text('#month-period',message);$('#month-period').classList.toggle('month-load-error',isError);
  $('#month-metrics').innerHTML='';$('#token-days').innerHTML=`<tr><td colspan="6">${esc(message)}</td></tr>`;$('#token-month-total').innerHTML='';$('#token-chart').innerHTML='';$('#today-tokens').hidden=true;
}
async function refreshMonth(force=false) {
  if(!force&&(monthController||Date.now()-monthLoadedAt<10000))return;
  const sequence=++monthSequence,month=selectedMonth;monthController?.abort();const controller=new AbortController();monthController=controller;const timer=setTimeout(()=>controller.abort(),8000);
  try{const res=await fetch('/api/usage?month='+encodeURIComponent(month)+serverQuery(),{cache:'no-store',signal:controller.signal});if(!res.ok)throw new Error('HTTP '+res.status);const payload=validateMonth(await res.json(),month);if(sequence===monthSequence){renderMonth(payload);monthLoadedAt=Date.now()}}catch{if(sequence===monthSequence)clearMonth('Could not load the monthly ledger. Retrying…',true)}finally{clearTimeout(timer);if(sequence===monthSequence)monthController=null}
}
function selectTab(btn,updateHash=true) {
  document.querySelectorAll('[role=tab]').forEach(b=>{b.setAttribute('aria-selected',String(b===btn));b.tabIndex=b===btn?0:-1;$('#'+b.getAttribute('aria-controls')).hidden=b!==btn});
  const tokens=btn.id==='tab-tokens';if(updateHash)location.hash=tokens?'tokens':'scope';if(tokens)void refreshMonth();
}
document.querySelectorAll('[role=tab]').forEach(btn=>{btn.addEventListener('click',()=>selectTab(btn));btn.addEventListener('keydown',e=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(e.key)){e.preventDefault();const next=e.key==='Home'?$('#tab-scope'):e.key==='End'?$('#tab-tokens'):btn.id==='tab-scope'?$('#tab-tokens'):$('#tab-scope');selectTab(next);next.focus()}})});
window.addEventListener('hashchange',()=>selectTab($(location.hash==='#tokens'?'#tab-tokens':'#tab-scope'),false));
document.querySelectorAll('[data-range]').forEach(btn=>btn.addEventListener('click',()=>{range=Number(btn.dataset.range);document.querySelectorAll('[data-range]').forEach(b=>b.setAttribute('aria-pressed',String(b===btn)));void refresh()}));
$('#token-month').addEventListener('change',()=>{monthPicked=true;selectedMonth=$('#token-month').value;monthLoadedAt=0;clearMonth('Loading the monthly ledger…');void refreshMonth(true)});
buildNodes();rebuildMonths();clearMonth('Loading the monthly ledger…');selectTab($(location.hash==='#tokens'?'#tab-tokens':'#tab-scope'),false);void refresh();
setInterval(()=>{void refresh();if(!$('#tokens').hidden)void refreshMonth()},2000);
