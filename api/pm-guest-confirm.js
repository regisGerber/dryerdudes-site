import crypto from 'node:crypto';
import { handlePmRequest } from './pm-request-times.js';
import { db, hash, clean, esc, sendEmail, allowedOrigin } from '../lib/pm-guest.js';

export default async function handler(req,res) {
  res.setHeader('Cache-Control','no-store');
  if (req.method !== 'POST') { res.setHeader('Allow','POST'); return res.status(405).json({ok:false,error:'Method Not Allowed'}); }
  if (!allowedOrigin(req)) return res.status(403).json({ok:false,error:'Please confirm on DryerDudes.com.'});
  const token = clean(req.body?.token,100);
  if (!/^[a-f0-9]{64}$/.test(token)) return res.status(400).json({ok:false,error:'This confirmation link is invalid.'});
  let row;
  try {
    [row] = await db(`pm_guest_requests?token_hash=eq.${hash(token)}&select=*&limit=1`);
    if (!row) return res.status(404).json({ok:false,error:'This confirmation link is invalid.'});
    if (row.status === 'completed') return res.status(200).json({...row.result,already_confirmed:true});
    if (Date.parse(row.expires_at) <= Date.now()) return res.status(410).json({ok:false,error:'This confirmation link expired. Please submit a new request.'});
    if (row.status !== 'pending') return res.status(409).json({ok:false,error:row.status === 'processing' ? 'Your request is being processed. Please check this page again shortly.' : 'This request needs assistance. Please contact Dryer Dudes before submitting another request.'});
    const data = row.payload;
    if (req.body?.action === 'review') return res.status(200).json({ok:true,review:{company_name:data.company_name,contact_name:data.contact_name,manager_email:data.manager_email,tenant_name:data.tenant_name,service_address:data.service_address,unit:data.unit,problem:data.problem,full_service_requested:data.full_service_requested,total_job_approval_limit_cents:data.total_job_approval_limit_cents}});
    if (req.body?.confirm !== true) return res.status(400).json({ok:false,error:'Review and confirm the request first.'});
    // Atomic compare-and-set: only one caller may schedule this request.
    const claimed = await db(`pm_guest_requests?id=eq.${row.id}&status=eq.pending`,{method:'PATCH',body:JSON.stringify({status:'processing',verified_at:new Date().toISOString()})});
    if (!claimed.length) return res.status(409).json({ok:false,error:'This request is already being processed. Please reload shortly.'});
    // Immutable billing contact for this guest job. Never overwrite an existing portal account.
    const pmId = crypto.randomUUID();
    const [pm] = await db('property_managers',{method:'POST',body:JSON.stringify({id:pmId,user_id:null,company_name:data.company_name,contact_name:data.contact_name,email:data.manager_email,phone:data.manager_phone || null,default_job_approval_limit_cents:data.total_job_approval_limit_cents,billing_address_line_1:data.billing_address_line_1,billing_address_line_2:data.billing_address_line_2 || null,billing_city:data.billing_city,billing_state:data.billing_state.toUpperCase(),billing_zip:data.billing_zip})});
    await db(`pm_guest_requests?id=eq.${row.id}`,{method:'PATCH',body:JSON.stringify({property_manager_id:pm.id})});
    const notes = [`ONE-TIME PROPERTY MANAGEMENT REQUEST`, `Email verified: ${new Date().toISOString()}`, `Dryer: ${data.dryer_type}; free-standing`, `Problem: ${data.problem}`,data.unit ? `Unit: ${data.unit}` : '',data.access_notes].filter(Boolean).join('\n');
    let result, status;
    const capture = {setHeader(){},status(code){status=code;return this;},json(value){result=value;return this;}};
    await handlePmRequest({...req,method:'POST',body:{...data,access_notes:notes,stacked:false}},capture,{pm,user:{email:data.manager_email}});
    if (!result?.ok || status !== 200) {
      await db(`pm_guest_requests?id=eq.${row.id}`,{method:'PATCH',body:JSON.stringify({status:'failed',request_id:result?.request_id || null,result:{ok:false,error:result?.message || result?.error || 'Request could not be scheduled.'}})});
      return res.status(status || 502).json({ok:false,error:result?.message || result?.error || 'Could not create appointment options. Please contact Dryer Dudes before trying again.'});
    }
    const publicResult = {ok:true,request_id:result.request_id,booking_page_url:result.booking_page_url,email_sent:result.email_sent,sms_sent:result.sms_sent};
    await db(`pm_guest_requests?id=eq.${row.id}`,{method:'PATCH',body:JSON.stringify({status:'completed',request_id:result.request_id,result:publicResult})});
    try {
      await sendEmail({to:data.manager_email,subject:'Your Dryer Dudes request is confirmed',id:`pm-guest-receipt/${row.id}`,html:`<p>Hi ${esc(data.contact_name)},</p><p>Your repair request for ${esc(data.service_address)} is confirmed. ${result.email_sent || result.sms_sent ? 'The tenant received a scheduling link.' : 'The tenant email and text did not send. Please forward the scheduling link below to your tenant.'}</p><p><a href="${esc(result.booking_page_url)}">Tenant scheduling link</a></p><p>Your company is responsible for the $80 diagnostic and labor, parts, and ${data.full_service_requested ? 'the selected $20 Full Service.' : 'any approved add-ons.'} Your repair approval limit is $${data.total_job_approval_limit_cents/100}. Billing updates will go to this email address.</p><p>Reply to this email if you need help. Request reference: ${esc(result.request_id)}</p>`});
    } catch(error) { console.error('Guest receipt delivery failed',error.message); }
    return res.status(200).json(publicResult);
  } catch (error) {
    console.error('pm-guest-confirm failed',error.message);
    // Never retry scheduling automatically after an ambiguous upstream failure.
    return res.status(503).json({ok:false,error:'We could not finish confirming the request. Please contact Dryer Dudes before submitting another request.'});
  }
}
