const crypto = require('node:crypto');
const money = cents => `$${(Number(cents)/100).toFixed(2)}`;
const esc = value => String(value ?? '').replace(/[<>&"']/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;'}[c]));
const siteOrigin = () => (process.env.SITE_ORIGIN || 'https://www.dryerdudes.com').replace(/\/+$/,'');
function fail(message,code=409){const e=new Error(message);e.statusCode=code;throw e;}
async function db(path,{method='GET',body,headers={}}={}) {
  if(!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) fail('Billing is temporarily unavailable.',503);
  const key=process.env.SUPABASE_SERVICE_ROLE_KEY;
  const r=await fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`,{method,headers:{apikey:key,Authorization:`Bearer ${key}`,'Content-Type':'application/json',Prefer:'return=representation',...headers},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
  if(!r.ok) fail(`Billing database request failed (${r.status}).`,503);
  return r.status===204?[]:r.json();
}
async function one(table,filters){const q=new URLSearchParams({select:'*',limit:'1'});for(const [k,v]of Object.entries(filters))q.set(k,`eq.${v}`);return (await db(`${table}?${q}`))[0] || null;}
async function patch(table,id,body){return (await db(`${table}?id=eq.${encodeURIComponent(id)}`,{method:'PATCH',body}))[0];}
async function guestContext(request) {
  if(!request?.property_manager_id)return null;
  const guest=await one('pm_guest_requests',{request_id:request.id,property_manager_id:request.property_manager_id,status:'completed'});
  if(!guest)return null;
  const pm=await one('property_managers',{id:request.property_manager_id});
  if(!pm?.email)fail('The manager billing contact is missing.',503);
  return {guest,pm};
}
function tokenFor(bill){const text=`${bill.id}.${bill.revision}`;const secret=process.env.TOKEN_SIGNING_SECRET;if(!secret)fail('Billing link configuration is unavailable.',503);return `${text}.${crypto.createHmac('sha256',secret).update(`guest-bill:${text}`).digest('hex')}`;}
function verifyToken(token){
  if(typeof token!=='string'||!/^([a-f0-9-]{36})\.(\d{1,8})\.[a-f0-9]{64}$/.test(token))fail('This bill link is invalid.',400);
  const [id,revision,sig]=token.split('.');const expected=tokenFor({id,revision}).split('.')[2];
  if(!crypto.timingSafeEqual(Buffer.from(sig,'hex'),Buffer.from(expected,'hex')))fail('This bill link is invalid.',400);
  return {id,revision:Number(revision)};
}
async function acquire(bill){
  const lockId=crypto.randomUUID();const now=new Date().toISOString();
  const q=new URLSearchParams({id:`eq.${bill.id}`,or:`(lock_expires_at.is.null,lock_expires_at.lt.${now})`});
  const rows=await db(`pm_guest_bills?${q}`,{method:'PATCH',body:{lock_id:lockId,lock_expires_at:new Date(Date.now()+120000).toISOString()}});
  if(!rows.length)fail('This bill is being updated. Please try again shortly.');
  return {...rows[0],lock_id:lockId};
}
async function release(bill){if(!bill?.lock_id)return;await db(`pm_guest_bills?id=eq.${bill.id}&lock_id=eq.${bill.lock_id}`,{method:'PATCH',body:{lock_id:null,lock_expires_at:null}});}
async function settleSession(bill,session){
  if(session.payment_status!=='paid'||session.status!=='complete'||session.mode!=='payment'||session.currency!=='usd')fail('Payment has not been confirmed.',409);
  if(session.metadata?.kind!=='pm_guest_bill'||session.metadata?.guest_bill_id!==bill.id||Number(session.metadata?.guest_bill_revision)!==bill.revision||session.id!==bill.stripe_session_id||session.amount_total!==bill.amount_due_cents)fail('Payment does not match this bill.',409);
  const result=await db('rpc/record_pm_guest_bill_payment',{method:'POST',body:{p_bill_id:bill.id,p_revision:bill.revision,p_session_id:session.id,p_amount_cents:session.amount_total,p_payment_intent_id:typeof session.payment_intent==='string'?session.payment_intent:session.payment_intent?.id || null}});
  return result;
}
async function beginSubmission({booking,request,stripe,context}) {
  let bill=await one('pm_guest_bills',{booking_id:booking.id});
  if(!bill){try{[bill]=await db('pm_guest_bills',{method:'POST',body:{booking_id:booking.id,request_id:request.id,property_manager_id:context.pm.id}});}catch(e){bill=await one('pm_guest_bills',{booking_id:booking.id});if(!bill)throw e;}}
  bill=await acquire(bill);
  try{
    if(bill.status==='paid')fail('This guest bill has already been paid. Do not submit another charge for this job.');
    if(bill.stripe_session_id){
      const session=await stripe.checkout.sessions.retrieve(bill.stripe_session_id,{timeout:15000,maxNetworkRetries:1});
      if(session.status==='complete'){
        if(session.payment_status==='paid')await settleSession(bill,session);
        fail('Payment for this bill is processing or already received. Please refresh the job.');
      }
      if(session.status==='open')await stripe.checkout.sessions.expire(session.id,{}, {timeout:15000,maxNetworkRetries:1});
    }
    await patch('pm_guest_bills',bill.id,{status:'editing',stripe_session_id:null,stripe_url:null});
    return bill;
  }catch(e){await release(bill);throw e;}
}
async function email({to,subject,html,id}){
  if(!process.env.RESEND_API_KEY)fail('Email delivery is unavailable.',503);
  const r=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${process.env.RESEND_API_KEY}`,'Content-Type':'application/json','Idempotency-Key':id},body:JSON.stringify({from:'Dryer Dudes <scheduling@dryerdudes.com>',reply_to:'info@dryerdudes.com',to:[to],subject,html}),signal:AbortSignal.timeout(10000)});
  if(!r.ok)fail(`Billing email delivery failed (${r.status}).`,503);
}
async function publishSubmission({lease,booking,request,billing,context,partsOnOrder,parts}) {
  const due=Number(billing.remaining_due_cents);
  const snapshot={company_name:context.pm.company_name,contact_name:context.pm.contact_name,manager_email:context.pm.email,job_ref:booking.job_ref,address:request.address,summary:billing.tech_notes || '',base_fee_cents:Number(booking.base_fee_cents || 8000),full_service_cents:Number(billing.total_job_cents)-Number(booking.base_fee_cents || 8000)-Number(billing.parts_cost_cents),parts_cost_cents:Number(billing.parts_cost_cents),parts:Array.isArray(parts)?parts:[],total_cents:Number(billing.total_job_cents),collected_cents:Number(billing.amount_already_collected_cents),parts_on_order:partsOnOrder,approval_limit_cents:Number(request.total_job_approval_limit_cents || 15000)};
  const bill=await patch('pm_guest_bills',lease.id,{revision:lease.revision+1,snapshot,amount_due_cents:due,status:billing.pm_approval_required?'pending_approval':due>0?'ready':'paid',approved_at:null,denied_at:null,paid_at:due>0?null:new Date().toISOString(),expires_at:new Date(Date.now()+60*86400000).toISOString(),checkout_attempt:0,updated_at:new Date().toISOString()});
  const link=`${siteOrigin()}/pm-bill.html#bill=${tokenFor(bill)}`;
  await patch('booking_billing',billing.id,{payment_url:link,payment_status:due>0?'not_sent':'paid',status:billing.pm_approval_required?'pm_approval_needed':partsOnOrder?'parts_on_order':due>0?'sent_to_customer':'paid'});
  try{
    await email({to:context.pm.email,subject:billing.pm_approval_required?`Repair approval requested — ${booking.job_ref || 'Dryer Dudes'}`:`Dryer Dudes bill — ${booking.job_ref || 'repair'}`,id:`guest-bill/${bill.id}/${bill.revision}`,html:`<p>Hi ${esc(context.pm.contact_name || context.pm.company_name)},</p><p>Dryer repair at <strong>${esc(request.address)}</strong>.</p><p>${esc(snapshot.summary)}</p><ul><li>Diagnostic and labor: ${money(snapshot.base_fee_cents)}</li><li>Full Service: ${money(snapshot.full_service_cents)}</li><li>Parts: ${money(snapshot.parts_cost_cents)}</li><li>Total: ${money(snapshot.total_cents)}</li><li>Already paid: ${money(snapshot.collected_cents)}</li><li><strong>Amount due: ${money(due)}</strong></li></ul><p>${billing.pm_approval_required?`The proposed total exceeds your ${money(snapshot.approval_limit_cents)} approval limit. Review and approve or decline it before proceeding.`:'Review your bill and pay securely through Stripe. No login is needed.'}</p><p><a href="${esc(link)}">${billing.pm_approval_required?'Review repair approval':'View bill and payment options'}</a></p><p>Need help? <a href="mailto:info@dryerdudes.com">info@dryerdudes.com</a></p>`});
    return {ok:true,guest_bill_url:link};
  }catch(error){return {ok:false,guest_bill_url:link,error:error.message};}
}
async function loadBill(token){const claim=verifyToken(token);const bill=await one('pm_guest_bills',{id:claim.id});if(!bill||bill.revision!==claim.revision)fail('This bill link has been replaced. Please use the latest email from Dryer Dudes.',410);if(bill.expires_at && Date.parse(bill.expires_at)<=Date.now())fail('This bill link expired. Please email info@dryerdudes.com for help.',410);if(bill.status==='editing')fail('This bill is being updated. Please use the latest email or try again shortly.');const booking=await one('bookings',{id:bill.booking_id});if(!booking)fail('This job is unavailable.',404);return {bill,booking};}
async function getView(bill){return {ok:true,invoice:{...bill.snapshot,manager_email:undefined,status:bill.status,amount_due_cents:bill.status==='paid'?0:bill.amount_due_cents,approved_at:bill.approved_at,paid_at:bill.paid_at}};}
async function applyApproval(bill,booking,action){
  if(['cancelled','no_show'].includes(booking.status))fail('This job is no longer active. Please contact info@dryerdudes.com.');
  if(bill.status!=='pending_approval')fail('This approval request has already been handled. Please refresh the bill.');
  const approved=action==='approve';
  const updated=await db('rpc/decide_pm_guest_bill',{method:'POST',body:{p_bill_id:bill.id,p_revision:bill.revision,p_lock_id:bill.lock_id,p_approve:approved}});
  // The page itself confirms the recorded decision; notification failure cannot undo it.
  try{await email({to:process.env.ADMIN_ALERT_EMAIL || 'info@dryerdudes.com',subject:`Guest repair ${approved?'approved':'declined'} — ${bill.snapshot.job_ref || 'job'}`,id:`guest-bill-decision/${bill.id}/${bill.revision}`,html:`<p>${esc(bill.snapshot.company_name)} ${approved?'approved':'declined'} ${money(bill.snapshot.total_cents)} for ${esc(bill.snapshot.address)}. Job: ${esc(bill.snapshot.job_ref)}.</p>`});}catch(e){console.error('Guest approval owner notification failed',e.message);}
  return updated;
}
async function checkout(bill,booking,stripe,token){
  if(['cancelled','no_show'].includes(booking.status))fail('This job is no longer active. Please email info@dryerdudes.com.');
  if(!['ready','payment_pending'].includes(bill.status))fail('This bill must be approved before payment.');
  if(!Number.isSafeInteger(bill.amount_due_cents)||bill.amount_due_cents<=0)fail('This bill has no balance due.');
  if(bill.stripe_session_id){const session=await stripe.checkout.sessions.retrieve(bill.stripe_session_id,{timeout:15000,maxNetworkRetries:1});if(session.status==='complete'){await settleSession(bill,session);return {ok:true,paid:true};}if(session.status==='open')return {ok:true,checkout_url:session.url};}
  const attempt=bill.checkout_attempt+1;
  await patch('pm_guest_bills',bill.id,{checkout_attempt:attempt});
  const back=`${siteOrigin()}/pm-bill.html#bill=${token}`;
  const session=await stripe.checkout.sessions.create({mode:'payment',payment_method_types:['card'],customer_email:bill.snapshot.manager_email,client_reference_id:bill.booking_id,success_url:back,cancel_url:back,metadata:{kind:'pm_guest_bill',guest_bill_id:bill.id,guest_bill_revision:String(bill.revision),booking_id:bill.booking_id},payment_intent_data:{metadata:{kind:'pm_guest_bill',booking_id:bill.booking_id,job_ref:bill.snapshot.job_ref || ''}},line_items:[{quantity:1,price_data:{currency:'usd',unit_amount:bill.amount_due_cents,product_data:{name:`Dryer Dudes repair — ${bill.snapshot.job_ref || 'job'}`,description:`${bill.snapshot.address} • Diagnostic/labor ${money(bill.snapshot.base_fee_cents)}, Full Service ${money(bill.snapshot.full_service_cents)}, parts ${money(bill.snapshot.parts_cost_cents)}; already paid ${money(bill.snapshot.collected_cents)}`}}}]},{timeout:15000,maxNetworkRetries:1,idempotencyKey:`guest-bill/${bill.id}/${bill.revision}/${attempt}`});
  // Persist the session before returning its URL; only this session can settle this bill.
  await patch('pm_guest_bills',bill.id,{stripe_session_id:session.id,stripe_url:session.url,status:'payment_pending'});
  await db(`booking_billing?booking_id=eq.${bill.booking_id}`,{method:'PATCH',body:{stripe_checkout_session_id:session.id,payment_status:'checkout_sent',payment_method_action:'payment_link'}});
  return {ok:true,checkout_url:session.url};
}
async function handlePaymentSession(session){
  if(session.payment_status!=='paid')return {received:true,handled:false,reason:'payment_not_paid'};
  const bill=await one('pm_guest_bills',{id:session.metadata?.guest_bill_id});
  if(!bill)fail('Guest bill was not found.',503);
  const result=await settleSession(bill,session);
  {try{await email({to:bill.snapshot.manager_email,subject:`Payment received — ${bill.snapshot.job_ref || 'Dryer Dudes'}`,id:`guest-bill-paid/${session.id}`,html:`<p>Payment of <strong>${money(bill.amount_due_cents)}</strong> was received for ${esc(bill.snapshot.address)}.</p><p>Job: ${esc(bill.snapshot.job_ref)}. Total: ${money(bill.snapshot.total_cents)}. Balance due: $0.00.</p><p>${esc(bill.snapshot.summary)}</p><p>Need help? <a href="mailto:info@dryerdudes.com">info@dryerdudes.com</a></p>`});}catch(e){console.error('Guest bill receipt email failed',e.message);}}
  return {received:true,handled:true,...result};
}
module.exports={db,one,patch,guestContext,tokenFor,verifyToken,acquire,release,beginSubmission,publishSubmission,loadBill,getView,applyApproval,checkout,handlePaymentSession,settleSession,siteOrigin};
