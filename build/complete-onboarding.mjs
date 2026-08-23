import { spawn } from 'node:child_process';
const dataDir = process.argv[2], pkg = process.argv[3];
const c = spawn(process.execPath, [`${pkg}/plugin/runtime/server.mjs`], { env: { ...process.env, BILL_COACH_DATA_DIR: dataDir }, stdio: ['pipe','pipe','pipe'] });
let buf='', id=1; const pend=new Map();
c.stdout.on('data',d=>{buf+=d;let i;while((i=buf.indexOf('\n'))>=0){const l=buf.slice(0,i).trim();buf=buf.slice(i+1);if(!l)continue;try{const m=JSON.parse(l);if(pend.has(m.id)){pend.get(m.id)(m);pend.delete(m.id);}}catch{}}});
const rpc=(m,p)=>new Promise(r=>{const n=id++;pend.set(n,r);c.stdin.write(JSON.stringify({jsonrpc:'2.0',id:n,method:m,params:p})+'\n');});
const call=async(n,a)=>{const r=await rpc('tools/call',{name:n,arguments:a});const t=r?.result?.content?.[0]?.text??'';try{return JSON.parse(t)}catch{return t}};
await rpc('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'seed',version:'1'}});
const s=await call('start_coach',{user_message:'setup',now:new Date().toISOString()});
const r=await call('save_coaching_state',{session_id:s.session_id,expected_session_version:s.session_version,
  onboarding:{status:'complete',confirmed_picture:'Simulation baseline: Bill is moving into a first-commercial-hire role at a funded seed-stage startup.'},
  session:{status:'active',evidence_ids:[],open_questions:[]}});
await call('end_coach',{session_id:s.session_id,expected_session_version:r.session_version??2,judgment:'baseline',next_move:'work'});
console.log('onboarding marked complete');
c.kill();
