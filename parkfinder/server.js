"use strict";
/* 停車雷達 後端 ｜ TDX 全台路外停車場即時車位代理
   - 持有 TDX 金鑰、換 Access Token（快取一天）
   - 依座標就近查詢縣市，回傳統一格式（WGS84 經緯度）
   - 沒設定金鑰時不會壞掉：回傳空陣列，前端自動退回只顯示停車場位置 */

const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const CID = process.env.TDX_CLIENT_ID || "";
const CSECRET = process.env.TDX_CLIENT_SECRET || "";

const AUTH_URL = "https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token";
const API = "https://tdx.transportdata.tw/api/basic/v1/Parking/OffStreet";

/* ---- 全台縣市中心點（TDX 城市代碼 → 概略質心），用來就近選縣市 ---- */
const CITIES = {
  Taipei:[25.0375,121.5637], NewTaipei:[25.0169,121.4628], Keelung:[25.1276,121.7392],
  Taoyuan:[24.9936,121.3010], HsinchuCity:[24.8138,120.9675], HsinchuCounty:[24.8387,121.0177],
  MiaoliCounty:[24.5602,120.8214], Taichung:[24.1477,120.6736], ChanghuaCounty:[24.0518,120.5161],
  NantouCounty:[23.9609,120.9719], YunlinCounty:[23.7092,120.4313], ChiayiCity:[23.4801,120.4491],
  ChiayiCounty:[23.4518,120.2555], Tainan:[22.9999,120.2270], Kaohsiung:[22.6273,120.3014],
  PingtungCounty:[22.5519,120.5487], YilanCounty:[24.7021,121.7378], HualienCounty:[23.9871,121.6015],
  TaitungCounty:[22.7583,121.1444], PenghuCounty:[23.5712,119.5793], KinmenCounty:[24.4490,118.3768],
  LienchiangCounty:[26.1608,119.9499]
};

function haversine(a,b,c,d){ const R=6371000,r=Math.PI/180;
  const u=(c-a)*r,v=(d-b)*r,s=Math.sin(u/2)**2+Math.cos(a*r)*Math.cos(c*r)*Math.sin(v/2)**2;
  return 2*R*Math.asin(Math.sqrt(s)); }

function nearestCities(lat,lng,n=2){
  return Object.entries(CITIES)
    .map(([c,p])=>({c,d:haversine(lat,lng,p[0],p[1])}))
    .sort((a,b)=>a.d-b.d).slice(0,n).map(x=>x.c);
}

/* ---- TDX Token（快取，到期前 60 秒換新） ---- */
let tok = { value:null, exp:0 };
async function getToken(){
  if(!CID || !CSECRET) throw new Error("NO_TDX_CREDENTIALS");
  if(tok.value && Date.now() < tok.exp - 60000) return tok.value;
  const body = new URLSearchParams({ grant_type:"client_credentials", client_id:CID, client_secret:CSECRET });
  const r = await fetch(AUTH_URL,{ method:"POST",
    headers:{ "content-type":"application/x-www-form-urlencoded" }, body });
  if(!r.ok) throw new Error("AUTH_FAIL_"+r.status);
  const j = await r.json();
  tok = { value:j.access_token, exp: Date.now() + (j.expires_in||86400)*1000 };
  return tok.value;
}
async function tdxGet(url){
  const t = await getToken();
  const r = await fetch(url,{ headers:{ authorization:"Bearer "+t } });
  if(r.status===401){ tok={value:null,exp:0}; }
  if(!r.ok) throw new Error("TDX_"+r.status);
  return r.json();
}

/* ---- 取單一縣市並正規化（含 30 秒快取與同城去重請求） ---- */
const cache = new Map();      // city -> { t, data }
const inflight = new Map();   // city -> Promise
const TTL = 30000;

function pickAvail(list){
  // 依 CarParkID 整理汽車剩餘車位；欄位名稱在不同縣市略有差異，做容錯
  const m = {};
  list.forEach(a=>{
    const id = a.CarParkID; if(id==null) return;
    const sp = a.AvailableSpaces ?? a.AvailableCar ?? a.NumberOfAvailable ?? a.availablecar;
    const tot = a.TotalSpaces ?? a.NumberOfSpaces ?? a.totalcar;
    const isCar = a.SpaceType===undefined || a.SpaceType===1 || a.SpaceType==="1";
    const v = (sp==null||sp==="")?null:Number(sp);
    if(m[id]===undefined || isCar){
      m[id] = { avail:(isNaN(v)?null:v), total:(tot!=null&&tot!==""?Number(tot):null) };
    }
  });
  return m;
}

async function fetchCity(city){
  const hit = cache.get(city);
  if(hit && Date.now()-hit.t < TTL) return hit.data;
  if(inflight.has(city)) return inflight.get(city);

  const p = (async ()=>{
    const [cpRaw, avRaw] = await Promise.all([
      tdxGet(`${API}/CarPark/City/${city}?%24format=JSON`),
      tdxGet(`${API}/ParkingAvailability/City/${city}?%24format=JSON`).catch(()=>null)
    ]);
    const lots = Array.isArray(cpRaw)?cpRaw:(cpRaw.CarParks||cpRaw.ParkingLots||[]);
    const avList = avRaw==null ? [] :
      (Array.isArray(avRaw)?avRaw:(avRaw.ParkingAvailabilities||avRaw.CarParks||[]));
    const updateTime = (avRaw && !Array.isArray(avRaw) && avRaw.UpdateTime) || "";
    const am = pickAvail(avList);
    const out = lots.map(l=>{
      const pos = l.CarParkPosition || {};
      const lat = pos.PositionLat ?? l.PositionLat;
      const lng = pos.PositionLon ?? l.PositionLon;
      if(lat==null||lng==null) return null;
      const id = l.CarParkID;
      const a = am[id] || {};
      const name = (l.CarParkName && (l.CarParkName.Zh_tw||l.CarParkName)) || id;
      const total = a.total ?? (l.TotalSpaces!=null?Number(l.TotalSpaces):null);
      return { id, name:String(name), lat:+lat, lng:+lng,
        total: (total!=null&&!isNaN(total))?total:null,
        available: a.avail ?? null,
        fare: (l.FareDescription||"").trim(), address:(l.Address||"").trim(), city };
    }).filter(Boolean);
    const data = { updateTime, lots:out };
    cache.set(city,{ t:Date.now(), data });
    return data;
  })().finally(()=>inflight.delete(city));

  inflight.set(city,p);
  return p;
}

/* ---- API ---- */
app.get("/api/health",(req,res)=>res.json({ ok:true, tdx: !!(CID&&CSECRET) }));

app.get("/api/parking/near", async (req,res)=>{
  const lat=+req.query.lat, lng=+req.query.lng, radius=Math.min(+req.query.radius||1500,8000);
  if(isNaN(lat)||isNaN(lng)) return res.status(400).json({ error:"bad_coords" });
  if(!CID||!CSECRET) return res.json({ note:"no_tdx", updateTime:"", lots:[] });
  try{
    const cities = nearestCities(lat,lng,2);
    const sets = await Promise.allSettled(cities.map(fetchCity));
    let lots=[], updateTime="";
    sets.forEach(s=>{ if(s.status==="fulfilled"){ lots=lots.concat(s.value.lots); updateTime=updateTime||s.value.updateTime; }});
    const near = lots.map(l=>({ ...l, dist:haversine(lat,lng,l.lat,l.lng) }))
      .filter(l=>l.dist<=radius).sort((a,b)=>a.dist-b.dist).slice(0,120);
    res.json({ updateTime, cities, lots:near });
  }catch(e){
    res.status(502).json({ error:String(e.message||e), lots:[] });
  }
});

app.get("/api/parking/city", async (req,res)=>{
  const city=req.query.city;
  if(!CITIES[city]) return res.status(400).json({ error:"unknown_city", cities:Object.keys(CITIES) });
  if(!CID||!CSECRET) return res.json({ note:"no_tdx", lots:[] });
  try{ res.json(await fetchCity(city)); }
  catch(e){ res.status(502).json({ error:String(e.message||e) }); }
});

/* 驗證用：回傳 TDX 原始回應的第一筆，方便比對欄位 */
app.get("/api/debug", async (req,res)=>{
  const city=req.query.city||"Taipei";
  if(!CID||!CSECRET) return res.json({ note:"no_tdx" });
  try{
    const [cp,av]=await Promise.all([
      tdxGet(`${API}/CarPark/City/${city}?%24format=JSON&%24top=1`),
      tdxGet(`${API}/ParkingAvailability/City/${city}?%24format=JSON&%24top=1`)
    ]);
    res.json({ city, carparkSample:cp, availabilitySample:av });
  }catch(e){ res.status(502).json({ error:String(e.message||e) }); }
});

app.use(express.static(path.join(__dirname,"public")));
app.get("*",(req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));

app.listen(PORT,()=>{
  console.log(`停車雷達 running on :${PORT}  TDX金鑰:${CID&&CSECRET?"已設定":"未設定（只顯示位置）"}`);
});
