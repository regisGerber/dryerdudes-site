const $ = s => document.querySelector(s);

let cachedRequestId=null;
let cachedMoreOffers=[];
let moreEmailSent=false;

function wireMobileUI(){

const aboutToggle=$("#aboutToggle");
const howToggle=$("#howToggle");
const howGrid=$("#howGrid");

if(aboutToggle){

aboutToggle.onclick=()=>{

document.querySelectorAll("#aboutGrid .mobile-only-collapsible")
.forEach(el=>{
el.classList.toggle("dd-hidden-mobile");
});

aboutToggle.textContent=
aboutToggle.textContent.includes("See more")
? "Show less"
: "See more about Dryer Dudes";

};

}

if(howToggle){

howToggle.onclick=()=>{

howGrid.classList.toggle("mobile-open");

howToggle.textContent=
howGrid.classList.contains("mobile-open")
? "Hide information"
: "Click here for more information";

};

}

}

function updateSMSConsent(){

const method=document.querySelector('input[name="contact_method"]:checked')?.value;

const wrap=$("#smsConsentWrap");

if(!wrap)return;

wrap.classList.toggle("dd-hidden",!(method==="text"||method==="both"));

}

function wireContactRadios(){

document.querySelectorAll('input[name="contact_method"]').forEach(r=>{
r.addEventListener("change",updateSMSConsent);
});

updateSMSConsent();

}

async function maybeSendMoreOptionsEmail(){

if(moreEmailSent)return;
if(!cachedRequestId)return;

const email=document.querySelector('input[name="email"]')?.value?.trim();

if(!email)return;

moreEmailSent=true;

try{

await fetch("/api/send-more-options-email",{

method:"POST",

headers:{
"Content-Type":"application/json"
},

body:JSON.stringify({
request_id:cachedRequestId,
email
})

});

}catch(e){

console.warn("More options email failed",e);

}

}

function revealMoreOptions(){

const moreWrap=$("#moreWrap");
const moreList=$("#moreList");

if(!moreWrap||!cachedMoreOffers.length)return;

moreList.innerHTML="";

cachedMoreOffers.forEach(o=>{

const el=document.createElement("div");

el.className="dd-option";

el.textContent=o.label;

moreList.appendChild(el);

});

moreWrap.classList.remove("dd-hidden");

maybeSendMoreOptionsEmail();

}

document.addEventListener("DOMContentLoaded",()=>{

wireMobileUI();
wireContactRadios();

const viewMore=$("#viewMoreBtn");

if(viewMore){
viewMore.addEventListener("click",revealMoreOptions);
}

});
