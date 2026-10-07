import crypto from 'node:crypto';
import { validateGuest, db, sendEmail, hash, esc, origin, allowedOrigin } from '../lib/pm-guest.js';

export default async function handler(req,res) {
  res.setHeader('Cache-Control','no-store');
  if (req.method !== 'POST') { res.setHeader('Allow','POST'); return res.status(405).json({ok:false,error:'Method Not Allowed'}); }
  if (!allowedOrigin(req)) return res.status(403).json({ok:false,error:'Please submit this request on DryerDudes.com.'});
  let data;
  try {
    if (req.body?.website) return res.status(200).json({ok:true});
    data = validateGuest(req.body || {});
  } catch (error) { return res.status(400).json({ok:false,error:error.message}); }
  try {
    if (!process.env.RESEND_API_KEY) throw new Error('Email configuration unavailable');
    const ip = String(req.headers['x-vercel-forwarded-for'] || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
    const secret = process.env.TOKEN_SIGNING_SECRET;
    if (!secret) throw new Error('Token configuration unavailable');
    const ipHash = crypto.createHmac('sha256',secret).update(ip).digest('hex');
    const since = new Date(Date.now()-3600000).toISOString();
    const query = `created_at=gte.${encodeURIComponent(since)}&select=id&limit=10`;
    const [byIp,byEmail] = await Promise.all([
      db(`pm_guest_requests?ip_hash=eq.${ipHash}&${query}`),
      db(`pm_guest_requests?manager_email=eq.${encodeURIComponent(data.manager_email)}&${query}`),
    ]);
    if (byIp.length >= 10 || byEmail.length >= 3) return res.status(429).json({ok:false,error:'Too many requests. Please use the confirmation email already sent, or try again in an hour.'});
    const token = crypto.randomBytes(32).toString('hex');
    const [row] = await db('pm_guest_requests',{method:'POST',body:JSON.stringify({token_hash:hash(token),ip_hash:ipHash,manager_email:data.manager_email,payload:data,expires_at:new Date(Date.now()+86400000).toISOString()})});
    const link = `${origin()}/pm-request.html#verify=${token}`;
    try {
      await sendEmail({to:data.manager_email,subject:'Confirm your one-time Dryer Dudes request',id:`pm-guest-verification/${row.id}`,html:
        `<p>Hi ${esc(data.contact_name)},</p><p>Confirm the dryer repair request from <strong>${esc(data.company_name)}</strong> for <strong>${esc(data.service_address)}${data.unit ? ', Unit '+esc(data.unit) : ''}</strong>.</p>`+
        `<p>Dryer issue: ${esc(data.problem)}</p><p>$80 includes diagnostic and labor. Parts are extra.${data.full_service_requested ? ' You selected Full Service for an additional $20.' : ''} Your total repair approval limit is $${data.total_job_approval_limit_cents/100}. Your company is responsible for payment.</p>`+
        `<p><a href="${link}">Review and confirm this request</a></p><p>After you confirm, we will email and text ${esc(data.tenant_name)} a scheduling link. This link expires in 24 hours.</p><p>If you did not submit this request, you can ignore this email. No work is authorized until you confirm.</p>`});
    } catch (error) {
      await db(`pm_guest_requests?id=eq.${row.id}`,{method:'PATCH',body:JSON.stringify({status:'email_failed'})});
      throw error;
    }
    return res.status(200).json({ok:true,verification_required:true});
  } catch (error) {
    console.error('pm-guest-request failed',error.message);
    return res.status(503).json({ok:false,error:'We could not send the confirmation email. Please try again shortly.'});
  }
}
