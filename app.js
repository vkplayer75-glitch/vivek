/* ============ CONSTANTS ============ */
const ZN=[["Left shoulder","shL"],["Right shoulder","shR"],["Sacrum","sacrum"],["Left heel","heelL"],["Right heel","heelR"]];
const N=5, CAP_P=32, RISK_MIN=90;      // capillary closing pressure (mmHg); minutes of sustained load = 100% risk
import {FIREBASE_CONFIG,DEVICE_ID} from "./config.js";
const $=s=>document.querySelector(s);
const T=Object.assign({turnMin:120,edgeCm:25,fsMm:80},JSON.parse(localStorage.getItem("dg_set")||"{}"));
/* ============ STATE ============ */
const S={mode:"offline",last:null,prevT:null,rx:0,absent:0,load:new Array(N).fill(0),turnSimMin:0,
  series:[],sampleOn:false,alerts:[],cmds:[],cool:{},fb:null};
try{S.alerts=JSON.parse(localStorage.getItem("dg_alerts")||"[]")}catch{}
const resetState=()=>{S.load.fill(0);S.turnSimMin=0;S.prevT=null;S.absent=0;S.rx=0;S.last=null};

/* ============ ANALYTICS ============ */
const avg=a=>a.reduce((x,y)=>x+y,0)/(a.length||1);
function norm(v){const g=k=>+(v.p&&v.p[k])||0;
  return {pct:ZN.map(z=>g(z[1])),p:ZN.map(z=>g(z[1])/100*T.fsMm),l:+(v.edge&&v.edge.l)||400,r:+(v.edge&&v.edge.r)||400,pb:!!(v.pir&&v.pir.bed),pr:!!(v.pir&&v.pir.room),rssi:v.rssi,up:v.up}}
function analyze(d){
  const [a,b,c,e,f]=d.p, L=a+e, R=b+f, H=a+b, F=e+f;
  const m=Math.min(d.l,d.r);
  return {present:Math.max(...d.pct)>=8,gx:(R-L)/(R+L||1),gy:(F-H)/(F+H||1),m,edge:Math.max(0,Math.min(1,1-m/60)),peak:Math.max(...d.p)};
}
function status(d,a){
  if(!a.present){
    if(d.pr)return{k:"warn",t:"Out of bed",n:"Moving in room"};
    if(S.absent>=60)return{k:"bad",t:"Out of bed · no motion",n:"Possible fall: check the room"};
    return{k:"warn",t:"Out of bed",n:"Tracking room"};
  }
  if(a.m<T.edgeCm)return{k:"bad",t:"At bed edge",n:"Exit imminent · "+a.m+" cm"};
  if(a.m<T.edgeCm*1.6)return{k:"warn",t:"Restless",n:"Moving toward edge"};
  return{k:"ok",t:"Resting",n:"In bed · centred"};
}

/* ============ INGEST ============ */
const push=(arr,v)=>{arr.push(v);if(arr.length>90)arr.shift()};
const SPAN=2*3600000;
function record(d,a,now){
  if(S.sampleOn){S.series=S.series.filter(p=>!p.s);S.sampleOn=false}
  const pt={t:now,peak:+a.peak.toFixed(1),edge:+(a.present?a.edge:0).toFixed(2),z:d.p.map(v=>+v.toFixed(1))},L=S.series[S.series.length-1];
  if(L&&now-L.t<10000)Object.assign(L,pt,{t:L.t});else S.series.push(pt);
  while(S.series.length&&S.series[0].t<now-SPAN)S.series.shift();
}
function mergeSeries(pts){
  if(!pts.length)return;
  S.series=S.series.filter(p=>!p.s);S.sampleOn=false;
  const all=S.series.concat(pts).sort((a,b)=>a.t-b.t),out=[];
  all.forEach(p=>{const L=out[out.length-1];if(!L||p.t-L.t>5000)out.push(p)});
  S.series=out.filter(p=>p.t>Date.now()-SPAN);
}
function loadSample(){
  const now=Date.now(),fs=T.fsMm,base=[22,22,34,18,18],pts=[];
  for(let m=0;m<=120;m++){
    const turned=m>62,since=turned?m-62:m,pct=base.map((b,i)=>{
      let v=b*(1+.08*Math.sin(m/7+i));
      if(i===2)v=30+Math.min(45,since*.62);
      if(i===0||i===3)v*=(turned?.8:1.15);if(i===1||i===4)v*=(turned?1.15:.9);
      return Math.max(0,Math.min(100,v))});
    const z=pct.map(v=>+(v/100*fs).toFixed(1)),e=m>=95&&m<=103?.35+.5*Math.sin((m-95)/8*Math.PI):.08+.05*Math.sin(m/5);
    pts.push({t:now-(120-m)*60000,peak:Math.max(...z),edge:+Math.max(0,e).toFixed(2),z,s:1});
  }
  S.series=S.series.filter(p=>!p.s&&p.t<pts[0].t).concat(pts);S.sampleOn=true;
}
function ingest(raw){
  const d=norm(raw), now=Date.now(); S.rx=now;
  const a=analyze(d), dtReal=S.prevT?Math.min(30,(now-S.prevT)/1000):1; S.prevT=now;
  const dtMin=dtReal*1/60;
  d.p.forEach((p,i)=>{if(a.present&&p>CAP_P)S.load[i]+=dtMin*(p/CAP_P);else S.load[i]=Math.max(0,S.load[i]-dtMin*.6)});
  S.turnSimMin+=dtMin; S.absent=(!a.present&&!d.pr)?S.absent+dtReal:0;
  S.last={d,a,st:status(d,a)};
  record(d,a,now);
  raise(d,a); render();
}
const riskPct=m=>Math.min(100,m/RISK_MIN*100);
const saveAlerts=()=>{try{localStorage.setItem("dg_alerts",JSON.stringify(S.alerts))}catch{}};
function raise(d,a){
  const now=Date.now();
  const fire=(key,level,title,msg,cd=60000)=>{
    if(S.cool[key]&&now-S.cool[key]<cd)return; S.cool[key]=now;
    const al={id:now+key,ts:now,level,title,msg,ack:false};
    S.alerts.unshift(al);S.alerts=S.alerts.slice(0,100);saveAlerts();
    fbWrite("alerts/"+String(al.id).replace(/\W/g,"_"),al);
    try{if(Notification.permission==="granted")new Notification("DecuGuard · "+title,{body:msg})}catch{}
  };
  S.load.forEach((m,i)=>{if(riskPct(m)>=70)fire("pr"+i,"bad","Sustained pressure · "+ZN[i][0],"Tissue load at "+Math.round(riskPct(m))+"%. Offload this region.")});
  if(S.turnSimMin>=T.turnMin)fire("turn","warn","Repositioning due","More than "+fmtT(T.turnMin)+" since last turn.",300000);
  if(a.present&&a.m<T.edgeCm)fire("edge","warn","Bed-edge proximity","Patient is "+a.m+" cm from the bed edge. Exit likely.",45000);
  if(!a.present)fire("exit","warn","Bed exit detected","Patient has left the bed.",60000);
  if(S.absent>=60)fire("lost","bad","Out of bed with no motion","No bed pressure and no room motion for 60 s. Check for a fall.",60000);
}

/* ============ COLOURS & FORMAT ============ */
function heatColor(p){
  const t=Math.max(0,Math.min(1,p/70)),stops=[[191,238,227],[251,233,168],[246,167,178]];
  const [i,f]=t<.5?[0,t*2]:[1,(t-.5)*2];
  return `rgb(${stops[i].map((c,k)=>Math.round(c+(stops[i+1][k]-c)*f)).join(",")})`;
}
const fmtT=m=>{m=Math.max(0,m);const h=Math.floor(m/60),mm=Math.floor(m%60);return `${h}h ${String(mm).padStart(2,"0")}m`};
const ago=ts=>{const s=Math.round((Date.now()-ts)/1000);return s<60?s+"s ago":s<3600?Math.round(s/60)+"m ago":new Date(ts).toLocaleTimeString()};
function heatHTML(p){
  const c=(i,sp)=>`<div class="cell" style="height:46px;${sp?"grid-column:span 2;":""}background:${heatColor(p[i])}">${p[i].toFixed(0)} mmHg</div>`;
  return `<div class="heat" style="grid-template-columns:90px 1fr 1fr"><div></div><div class="colhead">Left</div><div class="colhead">Right</div>
  <div class="lab">Shoulders</div>${c(0)}${c(1)}<div class="lab">Sacrum</div>${c(2,1)}<div class="lab">Heels</div>${c(3)}${c(4)}</div>`;
}

/* ============ RENDER ============ */
function hero(d,a,st){
  d.p.forEach((p,i)=>{const r=11+9*Math.min(1,p/70),c=heatColor(p);
    $("#zb"+i).setAttribute("fill",c);["#zb","#zh"].forEach(q=>$(q+i).setAttribute("r",r))});
  $("#sL").setAttribute("fill",a.present&&d.l<T.edgeCm?"#ef7f8e":"#3fb8a8");
  $("#sR").setAttribute("fill",a.present&&d.r<T.edgeCm?"#ef7f8e":"#3fb8a8");
  const t=$("#heroTitle");t.textContent=st.t;t.style.color=st.k==="bad"?"var(--bad)":st.k==="warn"?"#c28a2e":"var(--ok)";
  $("#heroSub").textContent=st.n;
  $("#heroChips").innerHTML=[["Bed",a.present?"Occupied":"Vacated",a.present?"ok":"warn"],["Peak pressure",a.peak.toFixed(0)+" mmHg",a.peak>CAP_P?"warn":"ok"],
    ["Nearest edge",a.present?a.m+" cm":"–",a.present&&a.m<T.edgeCm?"bad":"ok"],["Room motion",d.pr?"Detected":"None",d.pr&&!a.present?"warn":"ok"]]
    .map(([l,v,k])=>`<span class="chipx"><small>${l}</small><span class="pill ${k}">${v}</span></span>`).join("");
}

function render(){
  const cm=S.cmds.length?S.cmds.map(c=>`<div class="ev ok"><div class="bar"></div><div><b>${c.a}${c.v!=null?" · "+c.v:""}</b><div class="t">${ago(c.ts)}</div></div></div>`).join(""):'<div class="empty">No commands sent yet.</div>';
  $("#acLog").innerHTML=cm;
  const open=S.alerts.filter(x=>!x.ack).length; $("#alertCount").textContent=open;
  $("#alertLog").innerHTML=S.alerts.length?S.alerts.map(al=>`<div class="ev ${al.level}"><div class="bar"></div><div><b>${al.title}</b><div>${al.msg}</div><div class="t">${ago(al.ts)}</div></div>${al.ack?'<span class="pill ok" style="margin-left:auto">Acknowledged</span>':`<button data-ack="${al.id}"><svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>Acknowledge</button>`}</div>`).join(""):'<div class="empty">No alerts. All clear.</div>';
  if(!S.last){const w='<div class="empty">Waiting for data from the ESP-12E…</div>';$("#heatOverview").innerHTML=w;$("#heatPressure").innerHTML=w;drawCharts();return}
  const {d,a,st}=S.last;
  $("#kStatus").textContent=st.t;$("#kStatusN").textContent=st.n;
  $("#kStatus").style.color=st.k==="bad"?"var(--bad)":st.k==="warn"?"#c28a2e":"var(--ok)";
  $("#kPeak").textContent=a.peak.toFixed(0);
  $("#kPeakN").textContent=a.peak>CAP_P?"Above capillary closing pressure":"Below capillary closing pressure (32)";
  const remain=T.turnMin-S.turnSimMin;
  $("#kTurn").textContent=remain>0?fmtT(remain):"Overdue";$("#kTurn").style.color=remain>0?"":"var(--bad)";
  $("#kTurnN").textContent="Turn interval "+fmtT(T.turnMin);
  $("#kRssi").textContent=d.rssi??"—";
  $("#kUp").textContent=d.up!=null?"Uptime "+fmtT(d.up/60):"Uptime —";
  const maxRisk=riskPct(Math.max(...S.load)),rp=$("#riskPill");
  rp.textContent=maxRisk>=70?"High risk":maxRisk>=35?"Moderate risk":"Low risk";rp.className="pill "+(maxRisk>=70?"bad":maxRisk>=35?"warn":"ok");
  const hm=heatHTML(d.p);$("#heatOverview").innerHTML=hm;$("#heatPressure").innerHTML=hm;
  $("#turnBig").textContent=fmtT(S.turnSimMin)+" ";
  $("#turnBar").style.width=Math.min(100,S.turnSimMin/T.turnMin*100)+"%";
  $("#turnBar").style.background=S.turnSimMin>=T.turnMin?"var(--bad)":"";
  $("#turnNote").textContent=S.turnSimMin>=T.turnMin?"Repositioning overdue. Please turn the patient.":"Elapsed since last repositioning.";
  $("#riskBars").innerHTML=ZN.map((z,i)=>{const p=riskPct(S.load[i]),col=p>=70?"var(--bad)":p>=35?"var(--amber)":"var(--teal)";
    return `<div class="row" style="margin:7px 0"><div style="width:110px;font-size:12.5px;color:var(--muted)">${z[0]}</div><div class="progress" style="flex:1;margin:0"><div style="width:${p}%;background:${col}"></div></div><div style="width:44px;text-align:right;font-size:12px">${Math.round(p)}%</div></div>`}).join("");
  const pill=$("#egPill");pill.textContent=st.t;pill.className="pill "+st.k;
  let x=215,y=185;
  if(a.present){x=215+a.gx*60;y=185+a.gy*50}else if(d.pr){x=400;y=200}
  $("#pt").setAttribute("cx",x);$("#pt").setAttribute("cy",y);
  $("#pt").setAttribute("fill",st.k==="bad"?"#ef7f8e":st.k==="warn"?"#f2b95c":"#8f8cf2");
  $("#ptLabel").textContent=a.present?`On bed · nearest edge ${a.m} cm`:(d.pr?"Out of bed · motion in room":"Out of bed · no motion");
  const eo=cmv=>a.present?Math.max(0,Math.min(1,1-cmv/(T.edgeCm*2))):0;
  $("#edgeL").setAttribute("opacity",eo(d.l));$("#edgeR").setAttribute("opacity",eo(d.r));
  const mk=(l,v,k)=>`<div class="row" style="justify-content:space-between"><span class="note">${l}</span><span class="pill ${k}">${v}</span></div>`;
  const cl=v=>v>=400?"No echo":v+" cm";
  $("#egMetrics").innerHTML=mk("Bed occupancy",a.present?"Occupied":"Vacated",a.present?"ok":"warn")+
    mk("Left edge clearance",cl(d.l),a.present&&d.l<T.edgeCm?"bad":"ok")+mk("Right edge clearance",cl(d.r),a.present&&d.r<T.edgeCm?"bad":"ok")+
    mk("Bedside motion (PIR 1)",d.pb?"Motion":"Still","ok")+mk("Room motion (PIR 2)",d.pr?"Motion":"Still",d.pr&&!a.present?"warn":"ok");
  hero(d,a,st);
  drawCharts();
}

/* ============ CHARTS ============ */
function cv(id){const c=$(id),r=devicePixelRatio||1,w=c.clientWidth,h=+c.getAttribute("height");c.width=w*r;c.height=h*r;const g=c.getContext("2d");g.scale(r,r);g.clearRect(0,0,w,h);return {g,w,h}}
let RANGE=60;
function tline(id,defs,min,max){
  const {g,w,h}=cv(id);if(!w)return;
  const t1=Date.now(),t0=t1-RANGE*60000,X=t=>30+(w-34)*(t-t0)/(t1-t0),Y=v=>8+(h-24)*(1-(v-min)/(max-min));
  g.strokeStyle="#e9ecf8";g.lineWidth=1;g.font="10px sans-serif";g.fillStyle="#9aa1c9";
  for(let i=0;i<=4;i++){const y=8+(h-24)*i/4;g.beginPath();g.moveTo(30,y);g.lineTo(w,y);g.stroke();g.textAlign="left";g.fillText((max-(max-min)*i/4).toFixed(max<=1?1:0),0,y+3)}
  for(let i=0;i<=4;i++){g.textAlign=i===0?"left":i===4?"right":"center";g.fillText(new Date(t0+(t1-t0)*i/4).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"}),30+(w-34)*i/4+(i===0?-4:0),h-3)}
  g.textAlign="left";
  const P=S.series.filter(p=>p.t>=t0-60000),gap=Math.max(150000,RANGE*2000);
  if(P.length<2){g.fillText("No data in this range yet",44,h/2);return}
  const segs=[];P.forEach(p=>{const sg=segs[segs.length-1];if(sg&&p.t-sg[sg.length-1].t<=gap)sg.push(p);else segs.push([p])});
  defs.forEach(s=>segs.forEach(sg=>{
    if(sg.length<2)return;
    g.beginPath();g.lineWidth=2.2;g.strokeStyle=s.c;g.lineJoin="round";
    sg.forEach((p,i)=>{const x=Math.max(30,X(p.t)),y=Y(s.f(p));i?g.lineTo(x,y):g.moveTo(x,y)});g.stroke();
    if(s.fill){g.lineTo(X(sg[sg.length-1].t),h-16);g.lineTo(Math.max(30,X(sg[0].t)),h-16);g.fillStyle=s.fill;g.fill()}}));
}
const ZC=["#8f8cf2","#6fb1f2","#f08fa0","#3fb8a8","#f2b95c"];
function drawCharts(){
  $("#sampleTag").style.display=S.sampleOn?"":"none";
  tline("#cTrend",[{f:p=>p.peak/80,c:"#8f8cf2"},{f:p=>p.edge,c:"#f08fa0"}],0,1);
  tline("#cZones",ZC.map((c,i)=>({f:p=>p.z[i],c})),0,T.fsMm);
  tline("#cEdge",[{f:p=>p.edge,c:"#f08fa0",fill:"rgba(240,143,160,.15)"}],0,1);
}

/* ============ FIREBASE ============ */
const setConn=(cls,txt)=>{$("#cdot").className="dot "+cls;$("#ctext").textContent=txt};
function parseCfg(t){
  t=t.trim();const m=t.match(/\{[\s\S]*\}/);if(!m)throw new Error("No config object found");
  try{return JSON.parse(m[0])}catch{return JSON.parse(m[0].replace(/'/g,'"').replace(/([{,]\s*)([A-Za-z_]\w*)\s*:/g,'$1"$2":').replace(/,\s*}/g,"}"))}
}
async function connectFirebase(cfg,devId,auth){
  setConn("","Connecting…");
  const base="https://www.gstatic.com/firebasejs/10.14.1/";
  const [{initializeApp},db,au]=await Promise.all([import(base+"firebase-app.js"),import(base+"firebase-database.js"),import(base+"firebase-auth.js")]);
  const app=initializeApp(cfg,"dg-"+Date.now());
  if(auth==="anon")await au.signInAnonymously(au.getAuth(app));
  const database=db.getDatabase(app),root=`devices/${devId}`;
  S.mode="firebase";resetState();S.fb={database,db,devId};
  db.onValue(db.ref(database,root+"/lastTurn"),s=>{const v=s.val();if(v)S.turnSimMin=(Date.now()-v)/60000});
  db.onValue(db.ref(database,root+"/latest"),snap=>{const v=snap.val();if(!v||!v.p)return;setConn("live","Live · ESP-12E");$("#devchip").textContent="Device · "+devId+" · "+(v.rssi??"?")+" dBm";ingest(v)},err=>setConn("err","Error: "+err.code));
  db.onValue(db.ref(database,root+"/alerts"),s=>{const o=s.val();if(!o)return;const ids=new Set(S.alerts.map(x=>x.id));Object.values(o).forEach(x=>{if(!ids.has(x.id))S.alerts.push(x)});S.alerts.sort((p,q)=>q.ts-p.ts);S.alerts=S.alerts.slice(0,100);saveAlerts();render()});
  fbWrite("settings",{edgeCm:T.edgeCm,turnMin:T.turnMin,fsMm:T.fsMm});
  try{const o=(await db.get(db.ref(database,root+"/history"))).val();
    if(o)mergeSeries(Object.values(o).filter(r=>r&&typeof r.ts==="number"&&r.p).map(r=>{const d=norm(r),a=analyze(d);return{t:r.ts,peak:+a.peak.toFixed(1),edge:+(a.present?a.edge:0).toFixed(2),z:d.p.map(v=>+v.toFixed(1))}}));
  }catch(e){console.warn("history",e)}
  $("#devchip").textContent="Device · "+devId;
  setLinked(true);setConn("live","Connected · waiting for ESP-12E");
}
async function fbWrite(path,val){if(!S.fb)return;try{await S.fb.db.set(S.fb.db.ref(S.fb.database,`devices/${S.fb.devId}/${path}`),val)}catch(e){console.warn(e)}}
setInterval(()=>{if(S.mode==="firebase"&&S.rx&&Date.now()-S.rx>15000)setConn("err","Device offline · last data "+ago(S.rx))},2000);

/* ============ ACOUSTIC COMMANDS ============ */
function sendCmd(a,v){
  S.cmds.unshift({ts:Date.now(),a,v});S.cmds.length=Math.min(S.cmds.length,20);
  fbWrite("cmd",{action:a,value:v==null?0:v,id:Math.floor(Math.random()*2e9),ts:Date.now()});
  render();
}

const setLinked=on=>document.querySelectorAll("[data-cmd],#vol").forEach(b=>b.disabled=!on);

/* ============ UI ============ */
$("#tabs").addEventListener("click",e=>{const b=e.target.closest("button");if(!b)return;
  document.querySelectorAll("#tabs button").forEach(x=>x.classList.toggle("on",x===b));
  document.querySelectorAll(".tab").forEach(s=>s.classList.toggle("hide",s.id!=="t-"+b.dataset.t));render()});
$("#btnTurn").onclick=()=>{S.turnSimMin=0;S.load=S.load.map(v=>v*.25);fbWrite("lastTurn",Date.now());render()};
document.addEventListener("click",e=>{
  const a=e.target.closest("[data-ack]");if(a){const x=S.alerts.find(z=>String(z.id)===a.dataset.ack);if(x){x.ack=true;saveAlerts();fbWrite("acks/"+String(x.id).replace(/\W/g,"_"),Date.now());render()}}
  const c=e.target.closest("[data-cmd]");if(c)sendCmd(c.dataset.cmd);
});
$("#vol").onchange=e=>sendCmd("volume",+e.target.value);
document.addEventListener("click",e=>{const r=e.target.closest("[data-range]");if(!r)return;
  RANGE=+r.dataset.range;document.querySelectorAll("[data-range]").forEach(b=>b.classList.toggle("on",b===r));drawCharts()});
$("#btnSample").onclick=()=>{loadSample();render();drawCharts()};
const saveSeries=()=>{try{localStorage.setItem("dg_series",JSON.stringify(S.series.filter(p=>!p.s)))}catch{}};
setInterval(saveSeries,30000);addEventListener("beforeunload",saveSeries);
setInterval(drawCharts,10000);
$("#btnClear").onclick=()=>{S.alerts=[];saveAlerts();render()};
const readT=()=>{T.turnMin=+$("#tTurn").value||120;T.edgeCm=+$("#tEdge").value||25;T.fsMm=+$("#tFs").value||80;localStorage.setItem("dg_set",JSON.stringify(T))};
$("#btnSettings").onclick=()=>{
  const c=localStorage.getItem("dg_cfg");if(c)$("#cfg").value=c;
  $("#devId").value=localStorage.getItem("dg_dev")||"bed-01";$("#authMode").value=localStorage.getItem("dg_auth")||"anon";
  $("#tTurn").value=T.turnMin;$("#tEdge").value=T.edgeCm;$("#tFs").value=T.fsMm;
  try{if(Notification.permission==="default")Notification.requestPermission()}catch{}
  $("#dlg").showModal()};
$("#btnCancel").onclick=()=>$("#dlg").close();
$("#btnDisconnect").onclick=()=>{["dg_auto","dg_cfg"].forEach(k=>localStorage.removeItem(k));location.reload()};
$("#btnConnect").onclick=async()=>{
  const msg=$("#cfgMsg");msg.textContent="Connecting…";
  try{
    readT();const cfg=parseCfg($("#cfg").value);if(!cfg.databaseURL)throw new Error("databaseURL is required (Realtime Database)");
    const dev=$("#devId").value.trim()||"bed-01",auth=$("#authMode").value;
    await connectFirebase(cfg,dev,auth);
    localStorage.setItem("dg_cfg",$("#cfg").value);localStorage.setItem("dg_dev",dev);localStorage.setItem("dg_auth",auth);localStorage.setItem("dg_auto","1");
    $("#dlg").close();
  }catch(e){msg.textContent="Could not connect: "+(e.message||e);setConn("err","Connection failed")}
};
window.addEventListener("resize",()=>render());

/* ============ BOOT ============ */
(async()=>{
  try{S.series=JSON.parse(localStorage.getItem("dg_series")||"[]").filter(p=>p.t>Date.now()-SPAN)}catch{}
  if(!S.series.length)loadSample();
  setLinked(false);setConn("","Not connected");render();
  let cfg=FIREBASE_CONFIG;try{if(!cfg&&localStorage.getItem("dg_cfg"))cfg=parseCfg(localStorage.getItem("dg_cfg"))}catch{}
  if(!cfg){$("#btnSettings").click();return}
  try{await connectFirebase(cfg,localStorage.getItem("dg_dev")||DEVICE_ID,localStorage.getItem("dg_auth")||"anon")}
  catch(e){console.warn(e);setConn("err","Connection failed · check Cloud settings");$("#btnSettings").click()}
})();
