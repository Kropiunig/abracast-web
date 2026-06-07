import { useState, useEffect, useRef } from "react";
import { createWalletClient, createPublicClient, custom, http, parseEther, formatEther } from "viem";

const avalancheFuji = {
  id: 43113,
  name: "Avalanche Fuji",
  network: "fuji",
  nativeCurrency: { name: "AVAX", symbol: "AVAX", decimals: 18 },
  rpcUrls: { default: { http: ["https://api.avax-test.network/ext/bc/C/rpc"] } },
};

const publicClient = createPublicClient({ chain: avalancheFuji, transport: http() });

const GDELT_MAX_RECORDS = 75;
const EVIDENCE_CHAR_BUDGET = 1800;
const MAX_EVIDENCE_ITEMS = 12;
const MAX_QUERY_TERMS = 6;
const STOPWORDS = new Set([
  "did","do","does","the","a","an","on","in","of","to","is","was","were","will","would",
  "by","for","with","at","as","it","be","been","that","this","these","those","and","or",
  "answer","yes","no","held","than","then","from","into","over","under","above","below",
  "any","win","won","wins","beat","beats","defeat","defeats","lose","loses","lost","draw",
  "vs","according","recent","news","reporting","indicates","otherwise",
]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cleanText(t) { return String(t||"").replace(/\s+/g," ").replace(/[|]/g,"/").trim(); }

function buildGdeltQuery(question) {
  return String(question||"").toLowerCase().replace(/[^a-z0-9\s]/g," ").split(/\s+/)
    .filter(w=>w&&!STOPWORDS.has(w)&&w.length>=3).slice(0,MAX_QUERY_TERMS).join(" ");
}

async function fetchGoogleNewsEvidence(question) {
  const query = buildGdeltQuery(question);
  const url = `/googlenews/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
  const res = await fetch(url);
  const text = await res.text();
  const xmlDoc = new DOMParser().parseFromString(text,"text/xml");
  const items = xmlDoc.getElementsByTagName("item");
  const articles = [];
  for(let i=0;i<items.length;i++){
    const item=items[i];
    const fullTitle=item.getElementsByTagName("title")[0]?.textContent||"";
    const parts=fullTitle.split(" - ");
    const sourceName=parts.pop()||"";
    const cleanTitle=parts.join(" - ")||fullTitle;
    const pubDateStr=item.getElementsByTagName("pubDate")[0]?.textContent||"";
    let seendate="";
    try{ const d=new Date(pubDateStr); seendate=d.toISOString().replace(/[-:]/g,"").split(".")[0]; }catch{ seendate=pubDateStr; }
    const sourceEl=item.getElementsByTagName("source")[0];
    const sourceUrl=sourceEl?.getAttribute("url")||"";
    let domain=sourceName;
    try{ if(sourceUrl) domain=new URL(sourceUrl).hostname.replace("www.",""); }catch{}
    articles.push({title:cleanTitle||fullTitle,domain:domain||"news.google.com",seendate});
  }
  return articles;
}

async function fetchGdeltEvidence(question, onStatus=()=>{}) {
  const query=`${buildGdeltQuery(question)} sourcelang:eng`;
  const url="/gdelt/api/v2/doc/doc?"+new URLSearchParams({query,mode:"ArtList",format:"json",maxrecords:String(GDELT_MAX_RECORDS),sort:"DateDesc"}).toString();
  const MAX_ATTEMPTS=3; let data; let errorMsg="";
  for(let attempt=1;attempt<=MAX_ATTEMPTS;attempt++){
    let body;
    try{ const res=await fetch(url); body=await res.text(); }catch(e){ errorMsg=e.message; break; }
    try{ data=JSON.parse(body); break; }
    catch{
      if(attempt<MAX_ATTEMPTS){ const wait=2000+attempt*1000; onStatus(`Retrying news fetch in ${Math.round(wait/1000)}s...`); await sleep(wait); continue; }
      errorMsg="GDELT rate-limited";
    }
  }
  let articles=[];
  if(data&&Array.isArray(data.articles)){ articles=data.articles; }
  else{
    onStatus("Trying Google News fallback...");
    try{ articles=await fetchGoogleNewsEvidence(question); }
    catch(e){ throw new Error(`Both sources failed. GDELT: ${errorMsg}. Google News: ${e.message}`); }
  }
  if(articles.length===0) throw new Error("No articles found for this question.");
  const seen=new Set(); const items=[]; let used=0;
  for(const a of articles){
    const title=cleanText(a.title); if(!title) continue;
    const key=title.toLowerCase().replace(/[^a-z0-9]/g,"").slice(0,60);
    if(seen.has(key)) continue; seen.add(key);
    const line=`${title} — ${cleanText(a.domain)} — ${cleanText(a.seendate)}`;
    if(used+line.length+3>EVIDENCE_CHAR_BUDGET) break;
    items.push(line); used+=line.length+3;
    if(items.length>=MAX_EVIDENCE_ITEMS) break;
  }
  if(items.length===0) throw new Error("No usable articles found.");
  return items.join(" | ");
}

export default function App() {
  const [config, setConfig] = useState(null);
  const [configError, setConfigError] = useState("");
  const [wallet, setWallet] = useState(null);
  const [markets, setMarkets] = useState([]);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("");
  const [avaxPrice, setAvaxPrice] = useState(null);
  const [resolvingId, setResolvingId] = useState(null);
  const resolvingRef = useRef(false);
  const [newType, setNewType] = useState("text");
  const [newQuestion, setNewQuestion] = useState("Did Donald Trump win the U.S. presidential election held on November 5, 2024? Answer YES or NO.");
  const [newTarget, setNewTarget] = useState("100000");
  const [newExpiry, setNewExpiry] = useState("");
  const [newLiquidity, setNewLiquidity] = useState("0.01");
  const [betAmount, setBetAmount] = useState("0.01");
  const [showCreate, setShowCreate] = useState(false);
  const [filterType, setFilterType] = useState("all");
  const [hiddenIds, setHiddenIds] = useState(() => {
    try { return new Set(JSON.parse(localStorage.getItem("hiddenMarkets") || "[]")); }
    catch { return new Set(); }
  });

  function hideMarket(id) {
    setHiddenIds(prev => {
      const next = new Set(prev);
      next.add(id);
      localStorage.setItem("hiddenMarkets", JSON.stringify([...next]));
      return next;
    });
  }

  function calcExpectedShares(yr,nr,isYes,inv){
    const y=Number(yr),n=Number(nr),c=Number(inv);
    if(c===0||isNaN(c)||c<=0) return 0;
    if(y===0||n===0) return c;
    if(isYes){ const ny=y+c; const nn=(y*n)/ny; return n-nn+c; }
    else{ const nn=n+c; const ny=(y*n)/nn; return y-ny+c; }
  }

  useEffect(()=>{
    fetch("/fuji.json").then(r=>r.ok?r.json():Promise.reject(new Error("fuji.json missing")))
      .then(c=>{ if(!c.address||!c.abi) throw new Error("fuji.json has no address/abi"); setConfig({address:c.address,abi:c.abi}); })
      .catch(e=>setConfigError(e.message));
  },[]);

  async function connectWallet(){
    if(!window.ethereum) return alert("Install MetaMask first!");
    try{
      const client=createWalletClient({chain:avalancheFuji,transport:custom(window.ethereum)});
      const [address]=await client.requestAddresses();
      setWallet({client,address});
      setStatus("Connected: "+address.slice(0,6)+"..."+address.slice(-4));
    }catch(e){ setStatus("Error: "+e.message); }
  }

  async function fetchAvaxPrice(){
    if(!config) return;
    try{
      const price=await publicClient.readContract({address:config.address,abi:config.abi,functionName:"getCurrentPrice"});
      setAvaxPrice((Number(price)/1e8).toFixed(2));
    }catch(e){ console.error(e); }
  }

  async function loadMarkets(){
    if(!config) return;
    try{
      const count=await publicClient.readContract({address:config.address,abi:config.abi,functionName:"marketCount"});
      const loaded=[];
      for(let i=0;i<Number(count);i++){
        const m=await publicClient.readContract({address:config.address,abi:config.abi,functionName:"getMarket",args:[BigInt(i)]});
        let userYesShares=0n,userNoShares=0n;
        if(wallet?.address){
          try{
            userYesShares=await publicClient.readContract({address:config.address,abi:config.abi,functionName:"yesShares",args:[BigInt(i),wallet.address]});
            userNoShares=await publicClient.readContract({address:config.address,abi:config.abi,functionName:"noShares",args:[BigInt(i),wallet.address]});
          }catch(err){ console.error(`Error loading user shares for market ${i}:`,err); }
        }
        loaded.push({id:i,...m,userYesShares,userNoShares});
      }
      setMarkets(loaded);
    }catch(e){ console.error("Load markets error:",e); }
  }

  function send(functionName,args,value){
    return wallet.client.writeContract({address:config.address,abi:config.abi,functionName,args,account:wallet.address,...(value?{value}:{})});
  }

  async function withTx(label,fn){
    if(!wallet) return alert("Connect wallet first");
    setLoading(true);
    try{
      const hash=await fn();
      setStatus(`Confirming... ${hash.slice(0,10)}`);
      await publicClient.waitForTransactionReceipt({hash});
      setStatus(`${label} Tx: ${hash.slice(0,10)}...`);
      await loadMarkets();
    }catch(e){ setStatus("Error: "+(e.shortMessage||e.message)); }
    setLoading(false);
  }

  async function createMarket(){
    if(!wallet) return alert("Connect wallet first");
    if(!newQuestion||!newExpiry) return alert("Fill in the question and expiry");
    if(newType==="price"&&!newTarget) return alert("Price markets need a target");
    if(!newLiquidity||isNaN(parseFloat(newLiquidity))||parseFloat(newLiquidity)<=0) return alert("Enter valid liquidity");
    const expiry=BigInt(Math.floor(new Date(newExpiry).getTime()/1000));
    if(newType==="text"){
      await withTx("Market created!",()=>send("createTextMarket",[newQuestion,expiry],parseEther(newLiquidity)));
    }else{
      await withTx("Market created!",()=>send("createMarket",[newQuestion,BigInt(Math.floor(parseFloat(newTarget)*1e8)),expiry],parseEther(newLiquidity)));
    }
  }

  const claimLPPayout=(id)=>withTx("LP Payout claimed!",()=>send("claimLPPayout",[BigInt(id)]));
  const buyShares=(id,isYes)=>{
    if(!betAmount||isNaN(parseFloat(betAmount))||parseFloat(betAmount)<=0) return alert("Enter a valid bet amount");
    return withTx(`Bought ${isYes?"YES":"NO"} shares!`,()=>send("buyShares",[BigInt(id),isYes],parseEther(betAmount)));
  };

  async function sendAndWait(functionName,args,value){
    const hash=await send(functionName,args,value);
    await publicClient.waitForTransactionReceipt({hash});
    return hash;
  }

  async function settlePoll(id){
    for(let i=0;i<60;i++){
      try{
        await publicClient.simulateContract({account:wallet.address,address:config.address,abi:config.abi,functionName:"settle",args:[BigInt(id)]});
        setStatus("Oracle answered — settling...");
        await sendAndWait("settle",[BigInt(id)]);
        setStatus("Market settled!");
        return;
      }catch(e){
        const msg=String(e.shortMessage||e.message||"");
        if(msg.includes("Cadabra not ready")){ setStatus(`Waiting for oracle... (${i+1}/60)`); await sleep(10000); continue; }
        throw e;
      }
    }
    setStatus("Oracle hasn't answered yet — click Finish Settling again shortly.");
  }

  async function resolveMarket(m){
    if(!wallet) return alert("Connect wallet first");
    if(resolvingRef.current) return;
    resolvingRef.current=true; setResolvingId(m.id); setLoading(true);
    try{
      if(m.isTextMarket){
        setStatus(`Fetching news for market #${m.id}...`);
        let evidence;
        try{ evidence=await fetchGdeltEvidence(m.question,setStatus); }
        catch(err){
          const manual=window.prompt(`News fetch failed:\n"${err.message}"\n\nPaste evidence manually (max ${EVIDENCE_CHAR_BUDGET} chars):`);
          if(manual===null) throw new Error("Resolution cancelled.");
          if(!manual.trim()) throw new Error("No evidence provided.");
          evidence=manual.trim();
        }
        setStatus("Storing evidence on-chain...");
        await sendAndWait("submitEvidence",[BigInt(m.id),evidence]);
        await sleep(2500);
        setStatus("Asking oracle to resolve...");
        await sendAndWait("requestTextResolution",[BigInt(m.id)]);
      }else{
        setStatus("Reading Chainlink price + asking oracle...");
        await sendAndWait("requestResolution",[BigInt(m.id)]);
      }
      await settlePoll(m.id);
    }catch(e){ setStatus("Error: "+(e.message||e.shortMessage)); }
    resolvingRef.current=false; setResolvingId(null); setLoading(false); loadMarkets();
  }

  async function finishSettling(id){
    if(!wallet) return alert("Connect wallet first");
    if(resolvingRef.current) return;
    resolvingRef.current=true; setLoading(true);
    try{ await settlePoll(id); }catch(e){ setStatus("Error: "+(e.shortMessage||e.message)); }
    resolvingRef.current=false; setLoading(false); loadMarkets();
  }

  const claimPayout=(id)=>withTx("Payout claimed!",()=>send("claimPayout",[BigInt(id)]));

  useEffect(()=>{ if(!config) return; loadMarkets(); },[wallet,config]);
  useEffect(()=>{ fetchAvaxPrice(); const t=setInterval(fetchAvaxPrice,30000); return()=>clearInterval(t); },[config]);

  const filteredMarkets = markets.filter(m => {
    if(hiddenIds.has(m.id)) return false;
    if(filterType==="text") return m.isTextMarket;
    if(filterType==="price") return !m.isTextMarket;
    if(filterType==="active") return !m.resolved && Date.now()/1000 < Number(m.expiryDate);
    if(filterType==="resolved") return m.resolved;
    return true;
  });

  return (
    <div style={{minHeight:"100vh",background:"#FFFFFF",color:"#111827",fontFamily:"'Inter',system-ui,sans-serif"}}>
      <style>{`
        *{box-sizing:border-box;} body{margin:0;background:#FFFFFF;}

        .pm-btn-primary{
          background:#1652F0;color:#fff;border:none;border-radius:8px;
          padding:9px 20px;font-size:14px;font-weight:600;cursor:pointer;
          transition:background 0.15s;font-family:inherit;
          display:inline-flex;align-items:center;justify-content:center;gap:6px;
        }
        .pm-btn-primary:hover:not(:disabled){background:#1240C0;}
        .pm-btn-primary:disabled{opacity:0.5;cursor:not-allowed;}

        .pm-btn-ghost{
          background:transparent;color:#374151;border:1px solid #E5E7EB;border-radius:8px;
          padding:8px 16px;font-size:14px;font-weight:500;cursor:pointer;
          transition:all 0.15s;font-family:inherit;
          display:inline-flex;align-items:center;gap:6px;
        }
        .pm-btn-ghost:hover{background:#F9FAFB;border-color:#D1D5DB;}

        .pm-btn-yes{
          background:#EFF6FF;color:#1652F0;border:1.5px solid #BFDBFE;
          border-radius:8px;padding:10px 16px;font-size:14px;font-weight:600;
          cursor:pointer;transition:all 0.15s;font-family:inherit;flex:1;
          display:flex;align-items:center;justify-content:center;gap:6px;
        }
        .pm-btn-yes:hover:not(:disabled){background:#DBEAFE;border-color:#93C5FD;}
        .pm-btn-yes:disabled{opacity:0.45;cursor:not-allowed;}

        .pm-btn-no{
          background:#FFF1F2;color:#E11D48;border:1.5px solid #FECDD3;
          border-radius:8px;padding:10px 16px;font-size:14px;font-weight:600;
          cursor:pointer;transition:all 0.15s;font-family:inherit;flex:1;
          display:flex;align-items:center;justify-content:center;gap:6px;
        }
        .pm-btn-no:hover:not(:disabled){background:#FFE4E6;border-color:#FDA4AF;}
        .pm-btn-no:disabled{opacity:0.45;cursor:not-allowed;}

        .pm-btn-resolve{
          width:100%;background:#F5F3FF;color:#7C3AED;border:1.5px solid #DDD6FE;
          border-radius:8px;padding:10px 16px;font-size:14px;font-weight:600;
          cursor:pointer;transition:all 0.15s;font-family:inherit;
        }
        .pm-btn-resolve:hover:not(:disabled){background:#EDE9FE;}
        .pm-btn-resolve:disabled{opacity:0.45;cursor:not-allowed;}

        .pm-btn-claim{
          width:100%;background:#F0FDF4;color:#16A34A;border:1.5px solid #BBF7D0;
          border-radius:8px;padding:10px 16px;font-size:14px;font-weight:600;
          cursor:pointer;transition:all 0.15s;font-family:inherit;
        }
        .pm-btn-claim:hover:not(:disabled){background:#DCFCE7;}
        .pm-btn-claim:disabled{opacity:0.45;cursor:not-allowed;}

        .pm-btn-settle{
          width:100%;background:#EFF6FF;color:#1D4ED8;border:1.5px solid #BFDBFE;
          border-radius:8px;padding:10px 16px;font-size:14px;font-weight:600;
          cursor:pointer;transition:all 0.15s;font-family:inherit;
        }

        .market-card{
          background:#fff;border:1px solid #E5E7EB;border-radius:12px;padding:20px;
          transition:box-shadow 0.2s,border-color 0.2s;cursor:default;
        }
        .market-card:hover{box-shadow:0 4px 20px rgba(0,0,0,0.08);border-color:#D1D5DB;}

        .filter-pill{
          background:transparent;color:#6B7280;border:1px solid #E5E7EB;
          border-radius:20px;padding:6px 16px;font-size:13px;font-weight:500;
          cursor:pointer;transition:all 0.15s;font-family:inherit;white-space:nowrap;
        }
        .filter-pill:hover{background:#F9FAFB;color:#111827;}
        .filter-pill.active{background:#111827;color:#fff;border-color:#111827;}

        .pm-input{
          width:100%;background:#fff;border:1.5px solid #E5E7EB;border-radius:8px;
          padding:10px 14px;color:#111827;font-size:14px;font-family:inherit;
          outline:none;transition:border-color 0.15s;box-sizing:border-box;
        }
        .pm-input:focus{border-color:#1652F0;}
        .pm-input::placeholder{color:#9CA3AF;}

        .tab-bar-btn{
          background:transparent;color:#6B7280;border:none;border-bottom:2px solid transparent;
          padding:12px 4px;font-size:14px;font-weight:500;cursor:pointer;font-family:inherit;
          transition:all 0.15s;white-space:nowrap;
        }
        .tab-bar-btn:hover{color:#111827;}
        .tab-bar-btn.active{color:#111827;border-bottom-color:#111827;font-weight:700;}

        @keyframes slideUp{from{opacity:0;transform:translateY(8px);}to{opacity:1;transform:translateY(0);}}
        .toast{animation:slideUp 0.25s ease forwards;}

        @media(max-width:700px){
          .markets-grid{grid-template-columns:1fr!important;}
          .create-grid{grid-template-columns:1fr!important;}
        }
      `}</style>

      <header style={{
        position:"sticky",top:0,zIndex:100,
        background:"rgba(255,255,255,0.95)",backdropFilter:"blur(12px)",WebkitBackdropFilter:"blur(12px)",
        borderBottom:"1px solid #E5E7EB",height:60,
        display:"flex",alignItems:"center",padding:"0 24px",justifyContent:"space-between",
      }}>
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
            <rect width="28" height="28" rx="7" fill="#1652F0"/>
            <path d="M14 6L20 10V18L14 22L8 18V10L14 6Z" fill="white" fillOpacity="0.9"/>
            <circle cx="14" cy="14" r="3" fill="#1652F0"/>
          </svg>
          <div style={{display:"flex",flexDirection:"column",lineHeight:1.1}}>
            <span style={{fontWeight:800,fontSize:17,color:"#0F172A",letterSpacing:"-0.03em"}}>Abracast</span>
            <span style={{fontWeight:500,fontSize:11,color:"#9CA3AF",letterSpacing:"0.05em",textTransform:"uppercase"}}>markets</span>
          </div>
        </div>

        <div style={{display:"flex",alignItems:"center",gap:10}}>
          {avaxPrice && (
            <div style={{fontSize:13,fontWeight:600,color:"#6B7280"}}>
              AVAX <span style={{color:"#111827"}}>${Number(avaxPrice).toLocaleString()}</span>
            </div>
          )}
          {!wallet ? (
            <button onClick={connectWallet} className="pm-btn-primary" style={{padding:"8px 18px"}}>
              Connect Wallet
            </button>
          ) : (
            <div style={{
              background:"#F0FDF4",border:"1px solid #BBF7D0",borderRadius:8,
              padding:"7px 14px",fontSize:13,fontWeight:600,color:"#16A34A",
              display:"flex",alignItems:"center",gap:7
            }}>
              <div style={{width:7,height:7,borderRadius:"50%",background:"#16A34A"}}/>
              {wallet.address.slice(0,6)}...{wallet.address.slice(-4)}
            </div>
          )}
          <button onClick={()=>setShowCreate(v=>!v)} className="pm-btn-ghost" style={{padding:"8px 16px"}}>
            {showCreate ? "Cancel" : "+ Create"}
          </button>
        </div>
      </header>

      {status && (
        <div className="toast" style={{
          position:"fixed",bottom:24,right:24,zIndex:200,
          background:"#111827",borderRadius:10,padding:"12px 18px",maxWidth:380,
          fontSize:13,color:status.startsWith("Error")?"#FCA5A5":"#D1FAE5",
          fontWeight:500,boxShadow:"0 10px 40px rgba(0,0,0,0.2)",lineHeight:1.5
        }}>
          {status}
        </div>
      )}

      {showCreate && (
        <div style={{background:"#F9FAFB",borderBottom:"1px solid #E5E7EB",padding:"28px 24px"}}>
          <div>
            <h2 style={{margin:"0 0 20px",fontSize:18,fontWeight:700,color:"#111827"}}>Create a Market</h2>

            <div style={{display:"flex",gap:4,marginBottom:20,background:"#F3F4F6",padding:3,borderRadius:8,width:"fit-content"}}>
              {[["text","News / Text"],["price","Price (Chainlink)"]].map(([val,label])=>(
                <button key={val} onClick={()=>{
                  setNewType(val);
                  if(val==="price"&&newQuestion==="Did Donald Trump win the U.S. presidential election held on November 5, 2024? Answer YES or NO.") setNewQuestion("Will BTC close above $100,000?");
                  if(val==="text"&&newQuestion==="Will BTC close above $100,000?") setNewQuestion("Did Donald Trump win the U.S. presidential election held on November 5, 2024? Answer YES or NO.");
                }} style={{
                  background:newType===val?"#fff":"transparent",
                  color:newType===val?"#111827":"#6B7280",
                  border:"none",borderRadius:6,padding:"7px 16px",
                  fontSize:13,fontWeight:newType===val?600:500,cursor:"pointer",
                  fontFamily:"inherit",boxShadow:newType===val?"0 1px 3px rgba(0,0,0,0.1)":"none",
                  transition:"all 0.15s"
                }}>
                  {label}
                </button>
              ))}
            </div>

            <div style={{display:"flex",flexDirection:"column",gap:14}}>
              <div>
                <label style={{display:"block",fontSize:12,fontWeight:600,color:"#374151",marginBottom:6}}>Market Question</label>
                <textarea value={newQuestion} onChange={e=>setNewQuestion(e.target.value)} className="pm-input" rows={2} style={{resize:"vertical"}} placeholder="What do you want to predict?"/>
              </div>
              <div className="create-grid" style={{display:"grid",gridTemplateColumns:newType==="price"?"1fr 1fr 1fr":"1fr 1fr",gap:14}}>
                {newType==="price" && (
                  <div>
                    <label style={{display:"block",fontSize:12,fontWeight:600,color:"#374151",marginBottom:6}}>Target Price (USD)</label>
                    <input value={newTarget} onChange={e=>setNewTarget(e.target.value)} className="pm-input" type="number" placeholder="100000"/>
                  </div>
                )}
                <div>
                  <label style={{display:"block",fontSize:12,fontWeight:600,color:"#374151",marginBottom:6}}>Expiration</label>
                  <input value={newExpiry} onChange={e=>setNewExpiry(e.target.value)} className="pm-input" type="datetime-local"/>
                </div>
                <div>
                  <label style={{display:"block",fontSize:12,fontWeight:600,color:"#374151",marginBottom:6}}>Initial Liquidity (AVAX)</label>
                  <input value={newLiquidity} onChange={e=>setNewLiquidity(e.target.value)} className="pm-input" type="number" step="0.01" min="0.01" placeholder="0.01"/>
                </div>
              </div>
              <div>
                <button onClick={createMarket} disabled={loading||!config} className="pm-btn-primary" style={{padding:"10px 28px"}}>
                  {loading?"Creating...":newType==="text"?"Create Text Market":"Create Price Market"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {!config && (
        <div style={{marginBottom:16}}>
          <div style={{background:"#FFFBEB",border:"1px solid #FDE68A",borderRadius:10,padding:"14px 18px",fontSize:14,color:"#92400E"}}>
            No deployed contract found. Run <code style={{background:"rgba(0,0,0,0.06)",padding:"2px 6px",borderRadius:4}}>npm run setup</code> in the <code style={{background:"rgba(0,0,0,0.06)",padding:"2px 6px",borderRadius:4}}>resolver/</code> folder, then refresh.
            {configError&&<span style={{color:"#DC2626",marginLeft:8}}>({configError})</span>}
          </div>
        </div>
      )}

      <main style={{padding:"28px 32px"}}>

        <div style={{display:"flex",gap:8,marginBottom:24,overflowX:"auto",paddingBottom:4}}>
          {[["all","All"],["active","Active"],["resolved","Resolved"],["text","News"],["price","Price"]].map(([val,label])=>(
            <button key={val} onClick={()=>setFilterType(val)} className={`filter-pill${filterType===val?" active":""}`}>
              {label}
            </button>
          ))}
          <div style={{marginLeft:"auto",flexShrink:0,display:"flex",gap:8}}>
            {hiddenIds.size>0&&(
              <button onClick={()=>{ setHiddenIds(new Set()); localStorage.removeItem("hiddenMarkets"); }} className="pm-btn-ghost" style={{padding:"6px 14px",fontSize:13,color:"#6B7280"}}>
                Show hidden ({hiddenIds.size})
              </button>
            )}
            <button onClick={loadMarkets} className="pm-btn-ghost" style={{padding:"6px 14px",fontSize:13}}>Refresh</button>
          </div>
        </div>

        {filteredMarkets.length===0 && (
          <div style={{background:"#F9FAFB",border:"1px solid #E5E7EB",borderRadius:12,padding:"64px 24px",textAlign:"center",color:"#9CA3AF",fontSize:15}}>
            {markets.length===0?"No markets yet — create the first one.":"No markets match this filter."}
          </div>
        )}

        <div className="markets-grid" style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(300px,1fr))",gap:14}}>
          {filteredMarkets.map((m)=>{
            const expired=Date.now()/1000>=Number(m.expiryDate);
            const yesPool=Number(formatEther(m.yesPool||0n));
            const noPool=Number(formatEther(m.noPool||0n));
            const total=yesPool+noPool;
            const yesReserve=Number(formatEther(m.yesReserve||0n));
            const noReserve=Number(formatEther(m.noReserve||0n));
            const totalReserves=yesReserve+noReserve;
            const isText=m.isTextMarket;
            const yesSpot=totalReserves>0?yesReserve/totalReserves:0.5;
            const yesPct=Math.round(yesSpot*100);
            const noPct=100-yesPct;
            const targetUSD=Number(m.targetPrice)/1e8;
            const parsedBetAmount=parseFloat(betAmount);
            const isValidBet=!isNaN(parsedBetAmount)&&parsedBetAmount>0;
            const yesSharesEst=isValidBet?calcExpectedShares(yesReserve,noReserve,true,parsedBetAmount):0;
            const noSharesEst=isValidBet?calcExpectedShares(yesReserve,noReserve,false,parsedBetAmount):0;

            const [statusLabel,statusColor,statusBg,statusBorder]=m.resolved
              ?[m.yesWon?"YES Won":"NO Won","#16A34A","#F0FDF4","#BBF7D0"]
              :expired?["Expired","#D97706","#FFFBEB","#FDE68A"]
              :["Active","#1652F0","#EFF6FF","#BFDBFE"];

            return (
              <div key={m.id} className="market-card">

                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
                  <div style={{display:"flex",gap:6,alignItems:"center"}}>
                    <span style={{
                      fontSize:11,fontWeight:700,letterSpacing:"0.05em",textTransform:"uppercase",
                      background:isText?"#EFF6FF":"#F0FDF4",
                      color:isText?"#1652F0":"#16A34A",
                      border:isText?"1px solid #BFDBFE":"1px solid #BBF7D0",
                      borderRadius:5,padding:"2px 7px"
                    }}>
                      {isText?"News":"Price"}
                    </span>
                    <span style={{fontSize:12,color:"#9CA3AF",fontWeight:500}}>#{m.id}</span>
                  </div>
                  <div style={{display:"flex",alignItems:"center",gap:8}}>
                    <span style={{
                      fontSize:11,fontWeight:700,letterSpacing:"0.04em",textTransform:"uppercase",
                      background:statusBg,color:statusColor,border:`1px solid ${statusBorder}`,
                      borderRadius:5,padding:"2px 7px",whiteSpace:"nowrap"
                    }}>
                      {statusLabel}
                    </span>
                    <button
                      onClick={()=>hideMarket(m.id)}
                      title="Hide this market"
                      style={{
                        background:"none",border:"none",cursor:"pointer",
                        color:"#D1D5DB",fontSize:16,lineHeight:1,padding:"2px 4px",
                        borderRadius:4,transition:"color 0.15s",display:"flex",alignItems:"center"
                      }}
                      onMouseEnter={e=>e.currentTarget.style.color="#6B7280"}
                      onMouseLeave={e=>e.currentTarget.style.color="#D1D5DB"}
                    >✕</button>
                  </div>
                </div>

                <p style={{margin:"0 0 16px",fontSize:15,fontWeight:700,color:"#0F172A",lineHeight:1.55,letterSpacing:"-0.01em"}}>
                  {m.question.replace(/^#\d+\s+/,"")}
                </p>

                <div style={{marginBottom:16}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
                    <div style={{display:"flex",alignItems:"center",gap:8}}>
                      <div style={{width:9,height:9,borderRadius:"50%",background:"#1652F0",flexShrink:0}}/>
                      <span style={{fontSize:13,fontWeight:600,color:"#374151",letterSpacing:"0.01em"}}>YES</span>
                    </div>
                    <span style={{fontSize:20,fontWeight:800,color:"#1652F0",letterSpacing:"-0.03em"}}>{yesPct}%</span>
                  </div>
                  <div style={{height:3,background:"#F3F4F6",borderRadius:999,marginBottom:10,overflow:"hidden"}}>
                    <div style={{height:"100%",width:`${yesPct}%`,background:"#1652F0",borderRadius:999,transition:"width 0.4s ease"}}/>
                  </div>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                    <div style={{display:"flex",alignItems:"center",gap:8}}>
                      <div style={{width:9,height:9,borderRadius:"50%",background:"#E5E7EB",flexShrink:0}}/>
                      <span style={{fontSize:13,fontWeight:600,color:"#9CA3AF",letterSpacing:"0.01em"}}>NO</span>
                    </div>
                    <span style={{fontSize:20,fontWeight:800,color:"#9CA3AF",letterSpacing:"-0.03em"}}>{noPct}%</span>
                  </div>
                </div>

                <div style={{display:"flex",flexWrap:"wrap",gap:"2px 14px",fontSize:12,color:"#9CA3AF",marginBottom:16,paddingBottom:16,borderBottom:"1px solid #F3F4F6"}}>
                  {!isText&&<span>Target: <span style={{color:"#6B7280",fontWeight:600}}>${targetUSD.toLocaleString()}</span></span>}
                  <span>{total.toFixed(4)} AVAX vol.</span>
                  <span>Ends {new Date(Number(m.expiryDate)*1000).toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"})}</span>
                </div>

                {wallet&&(Number(m.userYesShares||0n)>0||Number(m.userNoShares||0n)>0)&&(
                  <div style={{marginBottom:14,background:"#F5F3FF",border:"1px solid #DDD6FE",borderRadius:8,padding:"8px 12px",fontSize:13,display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
                    <span style={{fontSize:11,fontWeight:700,color:"#7C3AED",textTransform:"uppercase",letterSpacing:"0.05em"}}>Your position</span>
                    {Number(m.userYesShares||0n)>0&&<span style={{color:"#1652F0",fontWeight:600}}>{Number(formatEther(m.userYesShares)).toFixed(3)} YES</span>}
                    {Number(m.userYesShares||0n)>0&&Number(m.userNoShares||0n)>0&&<span style={{color:"#D1D5DB"}}>·</span>}
                    {Number(m.userNoShares||0n)>0&&<span style={{color:"#E11D48",fontWeight:600}}>{Number(formatEther(m.userNoShares)).toFixed(3)} NO</span>}
                  </div>
                )}

                <div style={{display:"flex",flexDirection:"column",gap:10}}>
                  {!m.resolved&&!expired&&(
                    <>
                      <div style={{display:"flex",alignItems:"center",gap:8}}>
                        <span style={{fontSize:12,fontWeight:500,color:"#6B7280",whiteSpace:"nowrap"}}>Bet amount</span>
                        <input type="number" step="0.01" min="0.001" value={betAmount} onChange={e=>setBetAmount(e.target.value)} className="pm-input" style={{width:90}}/>
                        <span style={{fontSize:12,color:"#9CA3AF"}}>AVAX</span>
                      </div>
                      <div style={{display:"flex",gap:8}}>
                        <button onClick={()=>buyShares(m.id,true)} disabled={loading||!isValidBet} className="pm-btn-yes">
                          Buy YES
                          {isValidBet&&<span style={{fontSize:11,opacity:0.75}}>{yesSharesEst.toFixed(2)} shares</span>}
                        </button>
                        <button onClick={()=>buyShares(m.id,false)} disabled={loading||!isValidBet} className="pm-btn-no">
                          Buy NO
                          {isValidBet&&<span style={{fontSize:11,opacity:0.75}}>{noSharesEst.toFixed(2)} shares</span>}
                        </button>
                      </div>
                    </>
                  )}
                  {expired&&!m.resolutionRequested&&!m.resolved&&(
                    <button onClick={()=>resolveMarket(m)} disabled={loading} className="pm-btn-resolve">
                      {resolvingId===m.id?"Resolving...":loading?"Busy...":"Resolve Market"}
                    </button>
                  )}
                  {m.resolutionRequested&&!m.resolved&&(
                    <button onClick={()=>finishSettling(m.id)} disabled={loading} className="pm-btn-settle">Finish Settling</button>
                  )}
                  {m.resolved&&(
                    <button onClick={()=>claimPayout(m.id)} disabled={loading} className="pm-btn-claim">Claim Payout</button>
                  )}
                  {m.resolved&&!isText&&wallet?.address&&wallet.address.toLowerCase()===m.creator.toLowerCase()&&!m.lpClaimed&&(
                    <button onClick={()=>claimLPPayout(m.id)} disabled={loading} className="pm-btn-ghost" style={{width:"100%",justifyContent:"center"}}>
                      Claim LP Payout (Creator)
                    </button>
                  )}
                </div>

                {isText&&m.evidence&&(
                  <div style={{marginTop:14,padding:"10px 12px",background:"#F9FAFB",borderRadius:8,border:"1px solid #F3F4F6"}}>
                    <p style={{margin:"0 0 3px",fontSize:10,fontWeight:700,color:"#9CA3AF",textTransform:"uppercase",letterSpacing:"0.06em"}}>On-chain evidence</p>
                    <p style={{margin:0,fontSize:12,color:"#6B7280",lineHeight:1.5,wordBreak:"break-word"}}>
                      {m.evidence.slice(0,240)}{m.evidence.length>240?"…":""}
                    </p>
                  </div>
                )}
                {m.resolutionData&&(
                  <div style={{marginTop:8,padding:"10px 12px",background:"#F9FAFB",borderRadius:8,border:"1px solid #F3F4F6"}}>
                    <p style={{margin:"0 0 3px",fontSize:10,fontWeight:700,color:"#9CA3AF",textTransform:"uppercase",letterSpacing:"0.06em"}}>Oracle prompt</p>
                    <p style={{margin:0,fontSize:12,color:"#6B7280",lineHeight:1.5}}>{m.resolutionData.slice(0,200)}…</p>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div style={{textAlign:"center",marginTop:48,paddingTop:20,borderTop:"1px solid #F3F4F6",fontSize:12,color:"#D1D5DB"}}>
          Abracast · AI-resolved prediction markets on Avalanche Fuji
        </div>
      </main>
    </div>
  );
}
