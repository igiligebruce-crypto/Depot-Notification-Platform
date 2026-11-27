
const N=s=>String(s??'').toLowerCase().replace(/[^a-z0-9]/g,'');
const SYN={id:['notifctn','notification','notificationno','notifno'],date:['date','reportdate','datereported'],age:['ageingana','ageing','age'],done:['completion','completiondate','completed'],order:['order','worksorder'],street:['street'],city:['city','suburb'],status:['userstatus','status'],code:['codingcodetext','faultcode','complaintcode','codetext'],wc:['mainworkcentertext','workcentre','workcenter'],wcc:['mnwkctr','mainworkcenter'],asm:['assembly','assemblycode'],floc:['funcloc','functionallocation'],src:['originatordescription','originator','source'],ward:['wardsubcd','ward'],x:['xycoordinate','xcoordinate'],y:['xycoordinate','ycoordinate']};
const REQ=['id','date','status','code'];
function mapCols(h){const m={},used=new Set(),conf={},hn=h.map(N);
 for(const k in SYN){for(const s of SYN[k]){const i=hn.findIndex((x,j)=>x===s&&!used.has(j));if(i>=0){m[k]=i;used.add(i);conf[k]='exact';break}}}
 for(const k in SYN)if(m[k]==null)for(const s of SYN[k]){if(s.length<5)continue;const i=hn.findIndex((x,j)=>x&&x.includes(s)&&!used.has(j));if(i>=0){m[k]=i;used.add(i);conf[k]='fuzzy';break}}
 return{m,conf}}
function findHeader(a){let best={sc:0};for(let i=0;i<Math.min(40,a.length);i++){const r=mapCols(a[i]||[]);const sc=Object.keys(r.m).length+REQ.filter(k=>r.m[k]!=null).length;if(sc>best.sc)best={sc,hr:i,...r}}return best}
const iso=d=>d.toISOString().slice(0,10);
function pd(v){if(v instanceof Date)return isNaN(v)?null:new Date(Date.UTC(v.getFullYear(),v.getMonth(),v.getDate()));
 if(typeof v==='number'&&v>20000)return new Date(Date.UTC(1899,11,30)+Math.floor(v)*864e5);
 const s=String(v??'').trim();let m=/^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})/.exec(s);if(m)return new Date(Date.UTC(+m[3],m[2]-1,+m[1]));
 m=/^(\d{4})-?(\d{2})-?(\d{2})/.exec(s);return m?new Date(Date.UTC(+m[1],m[2]-1,+m[2+1])):null}
function parseRows(a,hr,m){const g=(r,k)=>m[k]==null?'':(r[m[k]]??''),t=(r,k)=>String(g(r,k)).trim(),out=[],seen=new Set(),dups=[],skipped=[];
 for(let i=hr+1;i<a.length;i++){const r=a[i];if(!r||r.every(x=>x===''))continue;const id=t(r,'id');
  if(!/^\d{5,}$/.test(id)){if(id!==''||r.some(x=>x!==''))skipped.push(i+1);continue}
  const st=t(r,'status').toUpperCase(),d=pd(g(r,'date')),dn=pd(g(r,'done'));
  const o={id,dk:d?iso(d):'',age:+g(r,'age')||0,dd:dn?iso(dn):'',wo:t(r,'order')!=='',st,base:/NOCO/.test(st)?'NOCO':/ORAS/.test(st)?'ORAS':/OSNO/.test(st)?'OSNO':(st.split(' ')[0]||'?'),closed:/NOCO/.test(st),emer:/EMER/.test(st),asd:/SS/.test(st),code:t(r,'code')||'(none)',street:t(r,'street'),city:t(r,'city'),wc:t(r,'wc')||'(none)',wcc:t(r,'wcc'),asm:t(r,'asm'),floc:t(r,'floc'),x:+g(r,'x')||0,y:+g(r,'y')||0,src:t(r,'src')||'(unknown)'};
  if(seen.has(id))dups.push(id);seen.add(id);out.push(o)}
 return{rows:out,dups,skipped}}
function targets(a){const T={days:{},assess:.8,wcMax:15,comp:{wo:.95,wc:.95,fl:.95,as:.95,fc:.95},src:'defaults (no MASTER DATA sheet found)'};if(!a)return T;T.src='MASTER DATA sheet';
 for(const r of a){if(typeof r[8]==='string'&&r[8]&&typeof r[9]==='number')T.days[r[8].trim()]=r[9];
  if(typeof r[11]==='string'&&typeof r[12]==='number'){const l=r[11].toLowerCase(),v=r[12];
   if(l.includes('assessments completed'))T.assess=v;else if(l.includes('maximum number'))T.wcMax=v;else if(l.includes('works order'))T.comp.wo=v;else if(l.includes('work centre'))T.comp.wc=v;else if(l.includes('functional location'))T.comp.fl=v;else if(l.includes('assembly code'))T.comp.as=v;else if(l.includes('fault code'))T.comp.fc=v}}
 return T}
const sm=(a,f)=>a.reduce((s,x)=>s+f(x),0),grp=(a,f)=>{const m={};a.forEach(x=>(m[f(x)]??=[]).push(x));return m};
function compute(R,T){const n=R.length,cl=R.filter(r=>r.closed).length,op=n-cl;
 const bs={};R.forEach(r=>{const k=r.base==='NOCO'?(r.wo?'NOCO (with WO)':'NOCO (no WO)'):r.base;bs[k]=(bs[k]||0)+1});
 const codes=Object.entries(grp(R,r=>r.code)).map(([c,a])=>{const t=T.days[c],cw=a.filter(r=>r.closed&&r.wo);return{c,n:a.length,open:a.filter(r=>!r.closed).length,avg:sm(a,r=>r.age)/a.length,t,cw:cw.length,ok:t==null?null:cw.filter(r=>r.age<=t).length,late:t==null?0:a.filter(r=>!r.closed&&r.age>t).length,maxOpen:Math.max(0,...a.filter(r=>!r.closed).map(r=>r.age))}}).sort((a,b)=>b.n-a.n);
 const cp=f=>{const have=R.filter(f).length,ex=R.filter(r=>r.closed&&!r.wo&&!f(r)).length;return{v:n-ex?have/(n-ex):null,have,den:n-ex}};
 const comp={wo:cp(r=>r.wo),wc:cp(r=>r.wcc),fl:cp(r=>r.floc),as:cp(r=>r.asm),fc:cp(r=>r.code!=='(none)')};
 const asd=R.filter(r=>r.asd).length,exA=R.filter(r=>r.closed&&!r.wo&&!r.asd).length,assess={v:n-exA?asd/(n-exA):null,have:asd,den:n-exA};
 const days=[...new Set([...R.map(r=>r.dk),...R.map(r=>r.dd)].filter(Boolean))].sort();
 const trend={days,created:days.map(d=>R.filter(r=>r.dk===d).length),closed:days.map(d=>R.filter(r=>r.dd===d).length)};
 const wcs=Object.entries(grp(R,r=>r.wc)).map(([w,a])=>({w,n:a.length,open:a.filter(r=>!r.closed).length,closed:a.filter(r=>r.closed).length})).sort((a,b)=>b.n-a.n);
 const top=(f,k=10)=>Object.entries(grp(R.filter(r=>f(r)),f)).map(([k,a])=>({k,n:a.length,open:a.filter(r=>!r.closed).length})).sort((a,b)=>b.n-a.n).slice(0,k);
 const bk=[['0–2 days',0,2],['3–4 days',3,4],['5–6 days',5,6],['7+ days',7,1e9]].map(([l,lo,hi])=>({l,open:R.filter(r=>!r.closed&&r.age>=lo&&r.age<=hi).length,closed:R.filter(r=>r.closed&&r.age>=lo&&r.age<=hi).length}));
 const up=s=>(s||'').toUpperCase();
 return{n,cl,op,pct:n?cl/n:null,avg:n?sm(R,r=>r.age)/n:null,emer:R.filter(r=>r.emer).length,late:sm(codes,c=>c.late),bs,codes,comp,assess,trend,wcs,sub:top(r=>up(r.city)||'UNSPECIFIED'),st:top(r=>up(r.street)||'',10).filter(x=>x.k),src:top(r=>r.src),bk,
  ck:(()=>{const w=codes.filter(c=>c.ok!=null&&c.cw);const d=sm(w,c=>c.cw);return{ok:sm(w,c=>c.ok),den:d,v:d?sm(w,c=>c.ok)/d:null}})()}}
function quality(R,P){const raw=new Set(R.map(r=>r.city).filter(Boolean)),up=new Set([...raw].map(s=>s.toUpperCase()));
 return[['Duplicate notification numbers',P.dups.length,'er'],['Rows skipped (no valid notification number)',P.skipped.length,'wa'],['Rows with no street',R.filter(r=>!r.street).length,'wa'],['Rows with no suburb/city',R.filter(r=>!r.city).length,'wa'],['Suburb names differing only by letter case',raw.size-up.size,'wa'],['Placeholder suburb (“GENERIC TOWN …”)',R.filter(r=>/^generic/i.test(r.city)).length,'wa'],['Work centre missing or NOT ASSIGNED',R.filter(r=>r.wc==='(none)'||/NOT ASSIGNED/i.test(r.wc)).length,'wa'],['Coded “Duplicate notification” by staff',R.filter(r=>/^duplicate/i.test(r.code)).length,'in'],['Closed without a date',R.filter(r=>r.closed&&!r.dd).length,'er'],['Not closed but has a completion date',R.filter(r=>!r.closed&&r.dd).length,'er'],['Rows with no created date',R.filter(r=>!r.dk).length,'er']]}
function findings(M,T,R){const o=[],P=v=>(v*100).toFixed(1)+'%';
 if(!M.n)return o;o.push(['in',`${M.op} of ${M.n} notifications (${P(M.op/M.n)}) are still open; ${M.cl} (${P(M.pct)}) are closed.`]);
 M.codes.filter(c=>c.late).forEach(c=>o.push(['er',`${c.late} open “${c.c}” notification(s) are older than the ${c.t}-day target (oldest open: ${c.maxOpen} days).`]));
 M.codes.filter(c=>c.ok!=null&&c.cw&&c.ok<c.cw).forEach(c=>o.push(['wa',`“${c.c}”: only ${c.ok} of ${c.cw} closed notifications (with a works order) were closed within ${c.t} days (${P(c.ok/c.cw)}).`]));
 if(M.assess.v!=null&&M.assess.v<T.assess)o.push(['er',`Assessments completed: ${P(M.assess.v)} (${M.assess.have} of ${M.assess.den}) against a target of ${P(T.assess)}.`]);
 const L={wo:'Notifications with works order',wc:'Notifications with work centre',fl:'Notifications with functional location',as:'Notifications with assembly code',fc:'Notifications with fault code'};
 for(const k in L)if(M.comp[k].v!=null&&M.comp[k].v<T.comp[k])o.push(['wa',`${L[k]}: ${P(M.comp[k].v)} against a target of ${P(T.comp[k])} (${M.comp[k].have} of ${M.comp[k].den}).`]);
 M.wcs.filter(w=>w.open>T.wcMax).forEach(w=>o.push(['er',`Work centre “${w.w}” holds ${w.open} open notifications; the workbook’s maximum per work centre is ${T.wcMax}.`]));
 const pk=M.trend.days.map((d,i)=>[d,M.trend.created[i]]).sort((a,b)=>b[1]-a[1])[0];if(pk)o.push(['in',`Busiest day for new notifications: ${pk[0].split('-').reverse().join('/')} with ${pk[1]}.`]);
 if(M.emer)o.push(['wa',`${M.emer} notification(s) carry an EMER (emergency) status flag.`]);return o}

module.exports={findHeader,parseRows,targets,compute,quality,findings,REQ,SYN};
