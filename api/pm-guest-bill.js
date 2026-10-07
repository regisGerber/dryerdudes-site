const Stripe = require('stripe');
const billing = require('../lib/pm-guest-billing.cjs');
module.exports = async function handler(req,res){
  res.setHeader('Cache-Control','no-store');
  if(req.method!=='POST'){res.setHeader('Allow','POST');return res.status(405).json({ok:false,error:'Method Not Allowed'});}
  const origin=req.headers?.origin;
  if(origin && ![billing.siteOrigin(),'https://dryerdudes.com','https://www.dryerdudes.com'].includes(origin))return res.status(403).json({ok:false,error:'Please open your bill on DryerDudes.com.'});
  let lock;
  try{
    let {bill,booking}=await billing.loadBill(req.body?.token);
    const action=req.body?.action || 'review';
    if(action==='review'){
      // A redirect alone never counts as payment. Stripe must confirm a paid session.
      if(bill.stripe_session_id && bill.status==='payment_pending'){
        const stripe=new Stripe(process.env.STRIPE_SECRET_KEY,{apiVersion:'2024-06-20',timeout:15000,maxNetworkRetries:1});
        const session=await stripe.checkout.sessions.retrieve(bill.stripe_session_id);
        if(session.status==='complete' && session.payment_status==='paid'){await billing.handlePaymentSession(session);bill=await billing.one('pm_guest_bills',{id:bill.id});}
      }
      return res.status(200).json(await billing.getView(bill));
    }
    if(!['approve','decline','pay'].includes(action))return res.status(400).json({ok:false,error:'Invalid bill action.'});
    if(['approve','decline'].includes(action) && req.body.confirm!==true)return res.status(400).json({ok:false,error:'Please confirm your repair decision.'});
    lock=await billing.acquire(bill);
    // Re-read the claim after acquiring the lock in case a technician revised the bill.
    const current=await billing.loadBill(req.body.token);bill=current.bill;booking=current.booking;
    if(action==='pay'){
      if(bill.status==='paid')return res.status(200).json({ok:true,paid:true});
      const stripe=new Stripe(process.env.STRIPE_SECRET_KEY,{apiVersion:'2024-06-20',timeout:15000,maxNetworkRetries:1});
      return res.status(200).json(await billing.checkout(bill,booking,stripe,req.body.token));
    }
    bill=await billing.applyApproval(bill,booking,action);
    return res.status(200).json(await billing.getView(bill));
  }catch(error){console.error('Guest bill request failed',error.message);return res.status(error.statusCode || 503).json({ok:false,error:error.statusCode?error.message:'The bill is temporarily unavailable. Please email info@dryerdudes.com for help.'});}
  finally{if(lock)await billing.release(lock).catch(error=>console.error('Guest bill lock release failed',error.message));}
};
