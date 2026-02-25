import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

const supabaseUrl = window.__SUPABASE_URL__;
const supabaseAnonKey = window.__SUPABASE_ANON_KEY__;

if (!supabaseUrl || !supabaseAnonKey) {
  alert("Missing Supabase config.");
  throw new Error("Missing Supabase config");
}

const supabase = createClient(supabaseUrl, supabaseAnonKey);

const ALLOWED_TYPES = ["all_day", "am", "pm", "slot"];

// ---------- UI ----------
const whoami = document.getElementById("whoami");
const logoutBtn = document.getElementById("logoutBtn");
const focusTech = document.getElementById("focusTech");
const overlayAllBtn = document.getElementById("overlayAllBtn");
const clearOverlayBtn = document.getElementById("clearOverlayBtn");
const dayBtn = document.getElementById("dayBtn");
const weekBtn = document.getElementById("weekBtn");
const monthBtn = document.getElementById("monthBtn");
const prevBtn = document.getElementById("prevBtn");
const nextBtn = document.getElementById("nextBtn");
const todayBtn = document.getElementById("todayBtn");
const rangeLabel = document.getElementById("rangeLabel");
const calWrap = document.getElementById("calWrap");
const topError = document.getElementById("topError");

const offDate = document.getElementById("offDate");
const offBlock = document.getElementById("offBlock");
const offSlot = document.getElementById("offSlot");
const offReason = document.getElementById("offReason");
const addOffBtn = document.getElementById("addOffBtn");
const offList = document.getElementById("offList");

const detailHint = document.getElementById("detailHint");
const detailBox = document.getElementById("detailBox");
const markOffFromDetailBtn = document.getElementById("markOffFromDetailBtn");
const deleteOffFromDetailBtn = document.getElementById("deleteOffFromDetailBtn");

function show(el, on = true){ if(el) el.style.display = on ? "" : "none"; }
function setText(el, t){ if(el) el.textContent = t ?? ""; }
function toISODate(d){ return d.toISOString().slice(0,10); }
function fmtDay(d){ return d.toLocaleDateString([], { weekday:"short", month:"short", day:"numeric" }); }
function fmtTimeLabel(h1,m1,h2,m2){ const pad=n=>String(n).padStart(2,"0"); return `${h1}:${pad(m1)}–${h2}:${pad(m2)}`; }
function statusLabel(s){ return String(s||"").toLowerCase() || "scheduled"; }

// ---------- slots ----------
function buildDaySlots(dateObj){
  const base = new Date(dateObj.getFullYear(), dateObj.getMonth(), dateObj.getDate());
  function mk(h1,m1,h2,m2,label,idx){
    return { slot_index:idx,label,start_h:h1,start_m:m1,end_h:h2,end_m:m2 };
  }
  return [
    mk(8,0,10,0,"A",1),
    mk(8,30,10,30,"B",2),
    mk(9,30,11,30,"C",3),
    mk(10,0,12,0,"D",4),
    mk(13,0,15,0,"E",5),
    mk(13,30,15,30,"F",6),
    mk(14,30,16,30,"G",7),
    mk(15,0,17,0,"H",8),
  ];
}

// ---------- auth ----------
async function requireAdmin(){
  const { data:{session} } = await supabase.auth.getSession();
  if(!session){ window.location.href="/login.html"; return null; }

  const { data:profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("user_id", session.user.id)
    .single();

  if(profile?.role !== "admin"){ window.location.href="/tech.html"; return null; }
  setText(whoami, session.user.email);
  return session;
}

logoutBtn?.addEventListener("click", async ()=>{
  await supabase.auth.signOut();
  window.location.href="/login.html";
});

// ---------- state ----------
let viewMode="week";
let overlayAll=true;
let focusTechId="all";
let anchorDate=new Date();
let techRows=[];
let selectedCell=null;
let selectedSlotEl=null;

// ---------- techs ----------
async function loadTechs(){
  const { data } = await supabase
    .from("techs")
    .select("id,name,active")
    .eq("active", true)
    .order("created_at");

  techRows=data||[];
  focusTech.innerHTML="";

  const optAll=document.createElement("option");
  optAll.value="all";
  optAll.textContent="All techs";
  focusTech.appendChild(optAll);

  for(const t of techRows){
    const o=document.createElement("option");
    o.value=t.id;
    o.textContent=t.name;
    focusTech.appendChild(o);
  }
}

// ---------- time off load (SLOT BASED ONLY) ----------
async function loadTimeOff(start,end){
  const startDate=toISODate(start);
  const endDate=toISODate(end);

  const { data,error } = await supabase
    .from("tech_time_off")
    .select("id,tech_id,service_date,slot_index,reason")
    .gte("service_date", startDate)
    .lte("service_date", endDate);

  if(error) throw error;
  return data||[];
}

// ---------- bookings ----------
async function loadBookings(start,end){
  const { data,error } = await supabase
    .from("bookings")
    .select("id,window_start,window_end,status,job_ref,booking_requests:request_id(name,address)")
    .gte("window_start", start.toISOString())
    .lt("window_start", end.toISOString());

  if(error) throw error;
  return data||[];
}

// ---------- insert OFF ----------
async function insertSlotOff(tech_id,dateISO,slot_index,reason){
  const { error } = await supabase.from("tech_time_off").insert({
    tech_id,
    service_date: dateISO,
    slot_index,
    type:"slot",
    reason
  });
  if(error) throw error;
}

addOffBtn?.addEventListener("click", async ()=>{
  try{
    show(topError,false);

    if(focusTechId==="all"){
      setText(topError,"Pick a tech first.");
      show(topError,true);
      return;
    }

    const dateISO=offDate.value;
    const block=offBlock.value;
    const slotIndex=Number(offSlot.value||1);
    const reason=offReason.value||null;

    if(!dateISO) throw new Error("Select date");

    if(block==="all_day"){
      for(let i=1;i<=8;i++) await insertSlotOff(focusTechId,dateISO,i,reason);
    }
    else if(block==="am"){
      for(let i=1;i<=4;i++) await insertSlotOff(focusTechId,dateISO,i,reason);
    }
    else if(block==="pm"){
      for(let i=5;i<=8;i++) await insertSlotOff(focusTechId,dateISO,i,reason);
    }
    else{
      await insertSlotOff(focusTechId,dateISO,slotIndex,reason);
    }

    await render();
  }
  catch(e){
    setText(topError,e.message);
    show(topError,true);
  }
});

// ---------- delete OFF ----------
deleteOffFromDetailBtn?.addEventListener("click", async ()=>{
  if(!selectedCell?.offRows?.length) return;

  const row=selectedCell.offRows[0];
  await supabase.from("tech_time_off").delete().eq("id",row.id);

  await render();
});

// ---------- calendar ----------
function slotDiv({kind,title,meta,badgeText}){
  const d=document.createElement("div");
  d.className=`slot ${kind}`;
  d.innerHTML=`<div><span class="badge">${badgeText||""}</span></div>
               <div class="slot-title">${title||""}</div>
               <div class="slot-meta">${meta||""}</div>`;
  return d;
}

function renderWeekGrid(monDate,bookings,timeOffRows){
  const days=[];
  for(let i=0;i<5;i++){
    const d=new Date(monDate);
    d.setDate(d.getDate()+i);
    days.push(d);
  }

  const table=document.createElement("table");
  const tbody=document.createElement("tbody");
  const slots=buildDaySlots(monDate);

  for(const slot of slots){
    const tr=document.createElement("tr");
    const tdTime=document.createElement("td");
    tdTime.textContent=`${slot.label} • ${fmtTimeLabel(slot.start_h,slot.start_m,slot.end_h,slot.end_m)}`;
    tr.appendChild(tdTime);

    for(const d of days){
      const td=document.createElement("td");
      const iso=toISODate(d);

      const cellOff=timeOffRows.filter(o =>
        o.service_date===iso &&
        o.slot_index===slot.slot_index &&
        (overlayAll || o.tech_id===focusTechId)
      );

      const cellBookings=bookings.filter(b=>{
        const bDate=toISODate(new Date(b.window_start));
        const hour=new Date(b.window_start).getHours();
        return bDate===iso && slot.start_h===hour;
      });

      let div;
      if(cellOff.length){
        div=slotDiv({kind:"off",badgeText:"OFF",title:"Time off"});
      }
      else if(cellBookings.length){
        const b=cellBookings[0];
        div=slotDiv({
          kind:"booked",
          badgeText:statusLabel(b.status),
          title:b.booking_requests?.name||"Customer",
          meta:b.booking_requests?.address||""
        });
      }
      else{
        div=slotDiv({kind:"open",badgeText:"Open",title:"Not booked"});
      }

      td.appendChild(div);
      tr.appendChild(td);
    }

    tbody.appendChild(tr);
  }

  table.appendChild(tbody);
  calWrap.innerHTML="";
  calWrap.appendChild(table);
}

// ---------- render ----------
async function render(){
  const start=new Date(anchorDate);
  const end=new Date(anchorDate);
  end.setDate(end.getDate()+7);

  const [bookings,timeOffRows]=await Promise.all([
    loadBookings(start,end),
    loadTimeOff(start,end)
  ]);

  renderWeekGrid(start,bookings,timeOffRows);

  if(!timeOffRows.length){
    offList.textContent="No time off in range.";
  } else {
    offList.textContent=timeOffRows
      .map(o=>`• ${o.service_date} slot ${o.slot_index}`)
      .join("\n");
  }
}

// ---------- init ----------
async function main(){
  const session=await requireAdmin();
  if(!session) return;
  await loadTechs();
  await render();
}

main();

