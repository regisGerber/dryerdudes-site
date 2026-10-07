import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import start from '../api/pm-guest-request.js';
import confirm from '../api/pm-guest-confirm.js';
import pmHandler from '../api/pm-request-times.js';
import {validateGuest,hash} from '../lib/pm-guest.js';
const fixture={company_name:'Test PM',contact_name:'Manager',manager_email:'manager@example.com',manager_phone:'5415550100',billing_address_line_1:'123 Main St',billing_city:'Medford',billing_state:'OR',billing_zip:'97501',tenant_name:'Tenant',tenant_phone:'5415550101',tenant_email:'tenant@example.com',service_address:'456 Main St, Medford, OR 97501',address_line1:'456 Main St',address_city:'Medford',address_state:'OR',address_zip:'97501',dryer_type:'electric',problem:'No heat',stacked:false,full_service_requested:true,billing_agreed:true,tenant_contact_agreed:true,total_job_approval_limit_cents:15000};
const token='a'.repeat(64);
const response=value=>({ok:true,status:200,text:async()=>JSON.stringify(value),json:async()=>value});
async function run(handler,body,fetcher,{method='POST',headers={}}={}){
 const oldFetch=global.fetch;const previous={};for(const [name,value] of Object.entries({SUPABASE_URL:'https://test.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'test-secret',RESEND_API_KEY:'test-email-key',TOKEN_SIGNING_SECRET:'test-token-secret',SITE_ORIGIN:'https://www.dryerdudes.com'})){previous[name]=process.env[name];process.env[name]=value;}
 const result={headers:{}}; const res={setHeader(k,v){result.headers[k]=v;},status(n){result.status=n;return this;},json(x){result.data=x;return this;}};
 global.fetch=fetcher || (()=>{throw Error('Unexpected network call');});
 try {await handler({method,body,headers},res);return result;}finally{global.fetch=oldFetch;for(const [k,v] of Object.entries(previous)){if(v===undefined)delete process.env[k];else process.env[k]=v;}}
}
test('validates billing responsibility, tenant permission, stacked units, phone and approval limit',()=>{
 assert.equal(validateGuest(fixture).tenant_phone,'+15415550101');
 for(const patch of [{billing_agreed:false},{tenant_contact_agreed:false},{stacked:true},{tenant_phone:'1'},{manager_email:'bad'},{total_job_approval_limit_cents:80}]) assert.throws(()=>validateGuest({...fixture,...patch}));
});
test('guest submission stores a hashed token and sends only the manager verification email',async()=>{
 let saved,email;const r=await run(start,fixture,async(url,opts)=>{
  if(url.includes('pm_guest_requests?'))return response([]);
  if(url.endsWith('/pm_guest_requests')){saved=JSON.parse(opts.body);return response([{...saved,id:'guest-id'}]);}
  if(url==='https://api.resend.com/emails'){email=JSON.parse(opts.body);return response({id:'email-id'});}
  throw Error('Unexpected call '+url);
 });
 assert.equal(r.status,200);assert.equal(saved.status,undefined);assert.equal(saved.payload.manager_email,fixture.manager_email);assert.deepEqual(email.to,[fixture.manager_email]);
 const raw=email.html.match(/#verify=([a-f0-9]{64})/)[1];assert.equal(saved.token_hash,hash(raw));assert(!JSON.stringify(saved).includes(raw));assert(!JSON.stringify(r.data).includes(raw));
});
test('rate limit does not create a record or send email',async()=>{let calls=0;const r=await run(start,fixture,async()=>{calls++;return response(Array.from({length:10},()=>({id:'x'})));});assert.equal(r.status,429);assert.equal(calls,2);});
test('review requires token, is read-only, and returns no contact secrets or tenant phone',async()=>{
 const row={id:'g',status:'pending',payload:validateGuest(fixture),expires_at:new Date(Date.now()+86400000).toISOString()};let calls=0;
 const r=await run(confirm,{token,action:'review'},async(_url,opts)=>{assert.equal(opts.method,undefined);calls++;return response([row]);});
 assert.equal(r.status,200);assert.equal(calls,1);assert.equal(r.data.review.company_name,'Test PM');assert.equal(r.data.review.tenant_phone,undefined);
});
test('expired verification cannot create a job',async()=>{const r=await run(confirm,{token,confirm:true},async()=>response([{id:'g',status:'pending',expires_at:'2020-01-01'}]));assert.equal(r.status,410);});
test('completed verification returns same saved result without another job or message',async()=>{let calls=0;const result={ok:true,request_id:'r',email_sent:true,sms_sent:true,booking_page_url:'https://www.dryerdudes.com/pm-schedule.html?token=test'};const r=await run(confirm,{token,confirm:true},async()=>{calls++;return response([{status:'completed',result}]);});assert.equal(calls,1);assert.equal(r.data.request_id,'r');assert.equal(r.data.already_confirmed,true);});
test('concurrent confirmation losing claim cannot schedule or send',async()=>{let calls=0;const r=await run(confirm,{token,confirm:true},async(_url,opts)=>{calls++;return response(opts.method==='PATCH'?[]:[{id:'g',status:'pending',expires_at:new Date(Date.now()+86400000).toISOString(),payload:validateGuest(fixture)}]);});assert.equal(r.status,409);assert.equal(calls,2);});
test('full guest confirmation reuses tenant scheduling, links bill to manager, and returns delivery state',async()=>{
 const id=crypto.randomUUID(),requestId=crypto.randomUUID();const patches=[];const emails=[];let scheduleBody,pm;
 const row={id,status:'pending',payload:validateGuest(fixture),expires_at:new Date(Date.now()+86400000).toISOString()};
 const r=await run(confirm,{token,confirm:true},async(url,opts={})=>{
  if(url.includes('/pm_guest_requests?')){if(opts.method==='PATCH'){patches.push(JSON.parse(opts.body));return response([row]);}return response([row]);}
  if(url.endsWith('/property_managers')){pm=JSON.parse(opts.body);return response([pm]);}
  if(url.endsWith('/api/request-times')){scheduleBody=JSON.parse(opts.body);return response({ok:true,request_id:requestId,token:'request-token',primary:[{offer_token:'offer',service_date:'2026-10-15',start_time:'08:00',end_time:'10:00'}],more:{options:[]}});}
  if(url.includes('/booking_requests?')){patches.push(JSON.parse(opts.body));return response([{}]);}
  if(url==='https://api.resend.com/emails'){emails.push(JSON.parse(opts.body));return response({id:'e'});}
  return {ok:false,status:503,text:async()=>JSON.stringify({error:'SMS unavailable'})};
 });
 assert.equal(r.status,200);assert.equal(pm.user_id,null);assert.equal(pm.email,fixture.manager_email);assert.equal(scheduleBody.email,fixture.tenant_email);assert.equal(scheduleBody.suppress_delivery,true);
 assert(patches.some(x=>x.property_manager_id===pm.id&&x.request_source==='property_manager'&&x.addon_preapproved));assert(patches.some(x=>x.status==='completed'&&x.request_id===requestId));assert(patches.some(x=>x.notes?.includes('Problem: No heat')));
 assert.equal(r.data.email_sent,true);assert.equal(r.data.sms_sent,false);assert.equal(emails.length,2);assert.deepEqual(emails[0].to,[fixture.tenant_email]);assert.deepEqual(emails[1].to,[fixture.manager_email]);assert.equal(r.data.delivery,undefined);
});
test('original PM endpoint still requires authentication even if client supplies verifiedGuest',async()=>{const r=await run(pmHandler,{...fixture,verifiedGuest:{pm:{id:'x'}}});assert.equal(r.status,401);});
test('guest endpoints reject cross-origin requests and GET without sending messages',async()=>{for(const h of [start,confirm]){assert.equal((await run(h,{},undefined,{headers:{origin:'https://evil.example'}})).status,403);assert.equal((await run(h,{},undefined,{method:'GET'})).status,405);}});
