process.env.TZ='UTC';
const express=require('express'),{Pool}=require('pg'),bcrypt=require('bcryptjs'),jwt=require('jsonwebtoken'),cp=require('cookie-parser'),multer=require('multer'),XLSX=require('xlsx'),proj4=require('proj4'),helmet=require('helmet'),crypto=require('crypto'),fs=require('fs'),path=require('path'),E=require('./engine');
const{DATABASE_URL,JWT_SECRET,ANTHROPIC_API_KEY,GOOGLE_MAPS_BROWSER_KEY,GOOGLE_GEOCODING_KEY,UPLOAD_DIR='./uploads',PORT=3000,APP_URL='http://localhost:3000'}=process.env;
if(!JWT_SECRET||JWT_SECRET.length<32)throw new Error('Set JWT_SECRET (32+ characters) in .env');
const db=new Pool({connectionString:DATABASE_URL,ssl:process.env.PGSSL==='1'?{rejectUnauthorized:false}:undefined}),q=(s,a)=>db.query(s,a).then(r=>r.rows);
proj4.defs('SRC',process.env.SOURCE_CRS_PROJ4||'+proj=tmerc +lat_0=0 +lon_0=19 +k=1 +x_0=0 +y_0=0 +ellps=WGS84 +units=m +no_defs');
fs.mkdirSync(UPLOAD_DIR,{recursive:true});
const app=express();app.set('trust proxy',1);app.use(helmet({contentSecurityPolicy:false}));app.use(express.json({limit:'1mb'}));app.use(cp());
const ck=()=>({httpOnly:true,secure:process.env.NODE_ENV==='production',sameSite:'lax',maxAge:7*864e5});
const auth=roles=>async(req,res,next)=>{try{const p=jwt.verify(req.cookies.sid,JWT_SECRET),[u]=await q('select id,email,role,active from users where id=$1',[p.id]);if(!u||!u.active)throw 0;req.user=u}catch(e){return res.status(401).json({error:'Not signed in'})}
 if(roles&&!roles.includes(req.user.role))return res.status(403).json({error:'Not permitted for your role'});next()};
const A=auth(),ADM=auth(['admin']),h=f=>(req,res)=>f(req,res).catch(e=>{console.error(e);res.status(e.status||500).json({error:e.status?e.message:'Server error'})});
const okPw=p=>typeof p==='string'&&p.length>=10;
// ---- auth
const tries=new Map();
app.post('/api/login',h(async(req,res)=>{const{email='',password=''}=req.body,k=req.ip+email.toLowerCase(),t=tries.get(k)||{n:0,at:0};
 if(t.n>=5&&Date.now()-t.at<9e5)return res.status(429).json({error:'Too many attempts. Try again in 15 minutes.'});
 const[u]=await q('select * from users where lower(email)=lower($1)',[email]);
 if(!u||!u.active||!await bcrypt.compare(password,u.hash)){tries.set(k,{n:t.n+1,at:Date.now()});return res.status(401).json({error:'Incorrect email or password.'})}
 tries.delete(k);res.cookie('sid',jwt.sign({id:u.id},JWT_SECRET,{expiresIn:'7d'}),ck());res.json({email:u.email,role:u.role})}));
app.post('/api/logout',(req,res)=>{res.clearCookie('sid');res.json({ok:true})});
app.get('/api/me',A,(req,res)=>res.json({email:req.user.email,role:req.user.role}));
app.post('/api/password',A,h(async(req,res)=>{const{current,next}=req.body;if(!okPw(next))return res.status(400).json({error:'New password must be at least 10 characters.'});
 const[u]=await q('select hash from users where id=$1',[req.user.id]);if(!await bcrypt.compare(current||'',u.hash))return res.status(400).json({error:'Current password is incorrect.'});
 await q('update users set hash=$1 where id=$2',[await bcrypt.hash(next,12),req.user.id]);res.json({ok:true})}));
app.post('/api/forgot',h(async(req,res)=>{const[u]=await q('select id,email from users where lower(email)=lower($1) and active',[req.body.email||'']);
 if(u){const tok=crypto.randomBytes(32).toString('hex');await q('insert into resets values($1,$2,now()+interval \'1 hour\')',[crypto.createHash('sha256').update(tok).digest('hex'),u.id]);
  const link=`${APP_URL}/login.html?reset=${tok}`;if(process.env.SMTP_URL)await require('nodemailer').createTransport(process.env.SMTP_URL).sendMail({from:process.env.SMTP_FROM,to:u.email,subject:'Reset your password',text:`Reset link (valid 1 hour): ${link}`});else console.log('PASSWORD RESET LINK for',u.email,link)}
 res.json({ok:true})}));
app.post('/api/reset',h(async(req,res)=>{const{token,password}=req.body;if(!okPw(password))return res.status(400).json({error:'Password must be at least 10 characters.'});
 const th=crypto.createHash('sha256').update(token||'').digest('hex'),[r]=await q('delete from resets where token_hash=$1 and expires>now() returning user_id',[th]);
 if(!r)return res.status(400).json({error:'This reset link is invalid or has expired.'});await q('update users set hash=$1 where id=$2',[await bcrypt.hash(password,12),r.user_id]);res.json({ok:true})}));
// ---- users (admin)
app.get('/api/users',ADM,h(async(req,res)=>res.json({users:await q('select id,email,role,active from users order by id')})));
app.post('/api/users',ADM,h(async(req,res)=>{const{email,password,role}=req.body;if(!/^\S+@\S+\.\S+$/.test(email||''))return res.status(400).json({error:'Enter a valid email.'});if(!okPw(password))return res.status(400).json({error:'Password must be at least 10 characters.'});
 if(!['admin','user'].includes(role))return res.status(400).json({error:'Invalid role.'});
 try{await q('insert into users(email,hash,role) values($1,$2,$3)',[email,await bcrypt.hash(password,12),role])}catch(e){return res.status(409).json({error:'That email already exists.'})}res.json({ok:true})}));
app.patch('/api/users/:id',ADM,h(async(req,res)=>{if(+req.params.id===req.user.id)return res.status(400).json({error:'You cannot change your own access.'});await q('update users set active=$1 where id=$2',[!!req.body.active,req.params.id]);res.json({ok:true})}));
// ---- ingest
function ingest(fp){const buf=fs.readFileSync(fp),m0=XLSX.read(buf,{bookSheets:true}),nm=m0.SheetNames,hid=(m0.Workbook?.Sheets||[]).map(s=>s.Hidden),want=nm.filter((n,i)=>!hid[i]);if(nm.includes('MASTER DATA'))want.push('MASTER DATA');
 const wb=XLSX.read(buf,{cellDates:true,sheets:want}),S={};let best=null;
 for(const n of want){const ws=wb.Sheets[n];if(!ws)continue;S[n]=XLSX.utils.sheet_to_json(ws,{header:1,raw:true,defval:''});if(n==='MASTER DATA')continue;const x=E.findHeader(S[n]);if(x.sc&&E.REQ.every(k=>x.m[k]!=null)&&(!best||x.sc>best.sc))best={...x,sheet:n}}
 if(!best)throw Object.assign(new Error('No sheet contains a notification table (needs notification no., date, status and complaint code columns).'),{status:422});
 const P=E.parseRows(S[best.sheet],best.hr,best.m);if(!P.rows.length)throw Object.assign(new Error('The table was found but has no valid notification rows.'),{status:422});
 const ds=P.rows.map(r=>r.dk).filter(Boolean).sort(),mc={};ds.forEach(d=>mc[d.slice(0,7)]=(mc[d.slice(0,7)]||0)+1);
 return{period:Object.entries(mc).sort((a,b)=>b[1]-a[1])[0][0],from:ds[0],to:ds[ds.length-1],n:P.rows.length,payload:{rows:P.rows,T:E.targets(S['MASTER DATA']),P:{dups:P.dups,skipped:P.skipped},meta:{from:ds[0],to:ds[ds.length-1],map:best.m,conf:best.conf,hdr:S[best.sheet][best.hr],sheet:best.sheet}}}}
const up=multer({storage:multer.diskStorage({destination:UPLOAD_DIR,filename:(r,f,cb)=>cb(null,crypto.randomUUID()+path.extname(f.originalname).toLowerCase())}),limits:{fileSize:50e6},fileFilter:(r,f,cb)=>cb(/\.(xlsx|xlsm|xls)$/i.test(f.originalname)?null:Object.assign(new Error('Only Excel files (.xlsx, .xlsm, .xls) are accepted.'),{status:400}),true)});
app.post('/api/datasets',ADM,up.single('file'),h(async(req,res)=>{if(!req.file)return res.status(400).json({error:'No file received.'});
 let r;try{r=ingest(req.file.path)}catch(e){fs.unlinkSync(req.file.path);throw e.status?e:Object.assign(new Error('Could not read this file. It may be corrupt, password-protected or not an Excel file.'),{status:422})}
 const sha=crypto.createHash('sha256').update(fs.readFileSync(req.file.path)).digest('hex'),[v]=await q('select coalesce(max(version),0)+1 v from datasets where period=$1',[r.period]);r.payload.meta.name=req.file.originalname;
 const[d]=await q('insert into datasets(period,version,name,original_name,stored_path,sha256,date_from,date_to,n,payload,uploaded_by) values($1,$2,$3,$3,$4,$5,$6,$7,$8,$9,$10) returning id',[r.period,v.v,req.file.originalname,req.file.path,sha,r.from,r.to,r.n,r.payload,req.user.id]);
 res.json({id:d.id,period:r.period,version:v.v,note:v.v>1?`A dataset for ${r.period} already existed; this is stored as version ${v.v} and the earlier version is kept.`:null})}));
app.get('/api/datasets',A,h(async(req,res)=>{const arch=req.query.archived==='1'&&req.user.role==='admin';res.json({datasets:await q(`select id,period,version,name,to_char(date_from,'YYYY-MM-DD') date_from,to_char(date_to,'YYYY-MM-DD') date_to,n,status,created_at from datasets where status=$1 order by period desc,version desc`,[arch?'archived':'active'])})}));
app.get('/api/datasets/:id',A,h(async(req,res)=>{const[d]=await q('select id,period,version,payload from datasets where id=$1 and status=\'active\'',[req.params.id]);if(!d)return res.status(404).json({error:'Dataset not found.'});d.payload.meta.id=String(d.id);res.json(d)}));
app.get('/api/datasets/:id/original',ADM,h(async(req,res)=>{const[d]=await q('select stored_path,original_name from datasets where id=$1',[req.params.id]);if(!d)return res.status(404).json({error:'Not found'});res.download(path.resolve(d.stored_path),d.original_name)}));
for(const[act,st]of[['archive','archived'],['restore','active']])app.post(`/api/datasets/:id/${act}`,ADM,h(async(req,res)=>{await q('update datasets set status=$1 where id=$2',[st,req.params.id]);res.json({ok:true})}));
// ---- AI (server-side key, compact structured facts only)
const pc=v=>v==null?null:+(v*100).toFixed(1);
function facts(p){const M=E.compute(p.rows,p.T);return{period:[p.meta.from,p.meta.to],totals:{n:M.n,open:M.op,closed:M.cl,pctClosed:pc(M.pct)},avgAgeDays:M.avg&&+M.avg.toFixed(2),openPastTarget:M.late,codes:M.codes.slice(0,8).map(c=>({code:c.c,n:c.n,open:c.open,avgAge:+c.avg.toFixed(1),targetDays:c.t,overdueOpen:c.late})),completenessPct:Object.fromEntries(Object.entries(M.comp).map(([k,v])=>[k,pc(v.v)])),assessmentsPct:pc(M.assess.v),workCentres:M.wcs.slice(0,6),topSuburbs:M.sub.slice(0,8),withCoordinates:p.rows.filter(r=>r.x&&r.y).length,findings:E.findings(M,p.T,p.rows).map(f=>f[1])}}
function delta(a,b,f){const g=(R)=>{const m={};R.forEach(r=>{const k=f(r);if(k)m[k]=(m[k]||0)+1});return m},x=g(a.rows),y=g(b.rows);return[...new Set([...Object.keys(x),...Object.keys(y)])].map(k=>({name:k,previous:x[k]||0,current:y[k]||0,change:(y[k]||0)-(x[k]||0),pct:x[k]?+(((y[k]||0)-x[k])/x[k]*100).toFixed(1):null})).sort((p,q)=>Math.abs(q.change)-Math.abs(p.change)).slice(0,8)}
app.post('/api/ai',A,h(async(req,res)=>{if(!ANTHROPIC_API_KEY)return res.status(503).json({error:'AI is not configured: set ANTHROPIC_API_KEY on the server.'});
 const ids=(req.body.ids||[]).slice(0,2),P=[];for(const id of ids){const[d]=await q('select payload from datasets where id=$1 and status=\'active\'',[id]);if(!d)return res.status(404).json({error:'Dataset not found.'});P.push(d.payload)}
 if(!P.length)return res.status(400).json({error:'No dataset selected.'});let data,task;
 if(P.length===1){data=facts(P[0]);task='Summarise this single reporting period.'}else{const[a,b]=P,sa=new Set(a.rows.map(r=>r.id)),com=b.rows.filter(r=>sa.has(r.id)).length;data={previous:facts(a),current:facts(b),matching:{common:com,new:b.rows.length-com,removed:a.rows.length-com},suburbChanges:delta(a,b,r=>(r.city||'').toUpperCase()),streetChanges:delta(a,b,r=>(r.street||'').toUpperCase()),codeChanges:delta(a,b,r=>r.code)};task='Explain what changed between the previous and current reporting periods.'}
 const prompt=`You assist an administrator of a roads-infrastructure depot. ${task} Use ONLY the JSON below. Never invent or recalculate figures; quote them exactly. Make no causal claims. Write under 300 words with these headings: "Verified findings" (facts straight from the JSON), "AI interpretation" (patterns worth investigating, hedged), "Recommendations" (practical next steps), "Indicators to monitor". Say so where something is unclear (e.g. the meaning of status codes ORAS/OSNO is not defined). Where matching.common is 0, state that individual records could not be matched.\n\n${JSON.stringify(data)}`;
 const r=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'x-api-key':ANTHROPIC_API_KEY,'anthropic-version':'2023-06-01','content-type':'application/json'},body:JSON.stringify({model:process.env.ANTHROPIC_MODEL||'claude-sonnet-5-5',max_tokens:1000,messages:[{role:'user',content:prompt}]}),signal:AbortSignal.timeout(60000)}),j=await r.json();
 if(!r.ok)return res.status(502).json({error:'AI service error: '+(j.error?.message||r.status)});res.json({text:j.content.filter(b=>b.type==='text').map(b=>b.text).join('')})}));
// ---- map: config, points (coordinate conversion + cached geocoding), admin corrections
app.get('/api/config',A,(req,res)=>res.json({mapsKey:GOOGLE_MAPS_BROWSER_KEY||null}));
async function geo(qs,budget){const[c]=await q('select * from geocache where q=$1',[qs]);if(c)return c;if(!GOOGLE_GEOCODING_KEY||budget.n<=0)return null;budget.n--;
 const r=await fetch(`https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(qs)}&region=za&key=${GOOGLE_GEOCODING_KEY}`),j=await r.json(),g=j.results?.[0],row={q:qs,lat:g?.geometry.location.lat??null,lng:g?.geometry.location.lng??null,loc_type:g?.geometry.location_type||'NONE'};
 if(j.status==='OK'||j.status==='ZERO_RESULTS')await q('insert into geocache values($1,$2,$3,$4) on conflict do nothing',[qs,row.lat,row.lng,row.loc_type]);return row}
app.get('/api/datasets/:id/points',A,h(async(req,res)=>{const[d]=await q('select payload from datasets where id=$1 and status=\'active\'',[req.params.id]);if(!d)return res.status(404).json({error:'Dataset not found.'});
 const ov=Object.fromEntries((await q('select nid,lat,lng from overrides where dataset_id=$1',[req.params.id])).map(o=>[o.nid,o])),budget={n:40},pts=[],insufficient=[];
 for(const r of d.payload.rows){const base={id:r.id,code:r.code,street:r.street,city:r.city,closed:r.closed,age:r.age};
  if(ov[r.id]){pts.push({...base,lat:ov[r.id].lat,lng:ov[r.id].lng,precision:'corrected'});continue}
  if(r.x&&r.y){try{const[lng,lat]=proj4('SRC','WGS84',[r.y,r.x]);if(Math.abs(lat)<=90&&Math.abs(lng)<=180){pts.push({...base,lat,lng,precision:'coordinates'});continue}}catch(e){}}
  const a=r.street&&r.city?await geo(`${r.street}, ${r.city}, Cape Town, South Africa`,budget):null;
  if(a&&a.lat!=null&&['ROOFTOP','RANGE_INTERPOLATED'].includes(a.loc_type)){pts.push({...base,lat:a.lat,lng:a.lng,precision:'geocoded-street'});continue}
  const s=r.city?await geo(`${r.city}, Cape Town, South Africa`,budget):null;
  if(s&&s.lat!=null)pts.push({...base,lat:s.lat,lng:s.lng,precision:'suburb'});else insufficient.push(r.id)}
 res.json({points:pts,insufficient,geocodingPending:budget.n<=0,crs:'Source X/Y interpreted as projected metres (first column = northing, second = easting) in a WGS84 Transverse Mercator, central meridian 19°E. Confirm with your GIS team.'})}));
app.put('/api/datasets/:id/location/:nid',ADM,h(async(req,res)=>{const{lat,lng}=req.body;if(!(Math.abs(lat)<=90&&Math.abs(lng)<=180))return res.status(400).json({error:'Invalid coordinates.'});
 await q('insert into overrides values($1,$2,$3,$4,$5) on conflict(dataset_id,nid) do update set lat=$3,lng=$4,by_user=$5',[req.params.id,req.params.nid,lat,lng,req.user.id]);res.json({ok:true})}));
// ---- pages
app.use(express.static(path.join(__dirname,'public'),{index:false}));
app.get('/',(req,res)=>{try{jwt.verify(req.cookies.sid,JWT_SECRET);res.sendFile(path.join(__dirname,'views/index.html'))}catch(e){res.redirect('/login.html')}});
(async()=>{await q(fs.readFileSync(path.join(__dirname,'schema.sql'),'utf8'));
 if(!(await q('select 1 from users limit 1')).length&&process.env.ADMIN_EMAIL&&okPw(process.env.ADMIN_PASSWORD)){await q('insert into users(email,hash,role) values($1,$2,\'admin\')',[process.env.ADMIN_EMAIL,await bcrypt.hash(process.env.ADMIN_PASSWORD,12)]);console.log('Created first administrator:',process.env.ADMIN_EMAIL)}
 app.listen(PORT,()=>console.log('Listening on',PORT))})().catch(e=>{console.error(e);process.exit(1)});
