import { useState, useEffect, useRef } from "react";
import { createWalletClient, createPublicClient, custom, http, parseEther, formatEther } from "viem";
import { Icon, Logo } from "./Icon";

const avalancheFuji = {
  id: 43113,
  name: "Avalanche Fuji",
  network: "fuji",
  nativeCurrency: { name: "AVAX", symbol: "AVAX", decimals: 18 },
  rpcUrls: { default: { http: ["https://api.avax-test.network/ext/bc/C/rpc"] } },
};

const publicClient = createPublicClient({ chain: avalancheFuji, transport: http() });

// ── GDELT evidence fetching (runs in the browser, no manual paste) ─────────
const GDELT_MAX_RECORDS = 75;
const EVIDENCE_CHAR_BUDGET = 1800;
const MAX_EVIDENCE_ITEMS = 12;
const MAX_QUERY_TERMS = 6;
const STOPWORDS = new Set([
  "did", "do", "does", "the", "a", "an", "on", "in", "of", "to", "is", "was",
  "were", "will", "would", "by", "for", "with", "at", "as", "it", "be", "been",
  "that", "this", "these", "those", "and", "or", "answer", "yes", "no", "held",
  "than", "then", "from", "into", "over", "under", "above", "below", "any",
  "win", "won", "wins", "beat", "beats", "defeat", "defeats", "lose", "loses",
  "lost", "draw", "vs", "according", "recent", "news", "reporting", "indicates",
  "otherwise",
]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Strip emoji from dynamic status text so the UI stays icon-only (display only).
const stripEmoji = (s) =>
  String(s || "").replace(/[\p{Extended_Pictographic}️]/gu, "").replace(/\s+/g, " ").trim();

function cleanText(text) {
  return String(text || "").replace(/\s+/g, " ").replace(/[|]/g, "/").trim();
}

function buildGdeltQuery(question) {
  const terms = String(question || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !STOPWORDS.has(w) && w.length >= 3)
    .slice(0, MAX_QUERY_TERMS);
  return terms.join(" ");
}

async function fetchGoogleNewsEvidence(question) {
  const query = buildGdeltQuery(question);
  const url = `/googlenews/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
  const res = await fetch(url);
  const text = await res.text();
  
  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(text, "text/xml");
  const xmlItems = xmlDoc.getElementsByTagName("item");
  
  const articles = [];
  for (let i = 0; i < xmlItems.length; i++) {
    const item = xmlItems[i];
    const fullTitle = item.getElementsByTagName("title")[0]?.textContent || "";
    const parts = fullTitle.split(" - ");
    const sourceName = parts.pop() || "";
    const cleanTitle = parts.join(" - ") || fullTitle;
    
    const pubDateStr = item.getElementsByTagName("pubDate")[0]?.textContent || "";
    let seendate = "";
    try {
      const d = new Date(pubDateStr);
      seendate = d.toISOString().replace(/[-:]/g, "").split(".")[0];
    } catch {
      seendate = pubDateStr;
    }
    
    const sourceEl = item.getElementsByTagName("source")[0];
    const sourceUrl = sourceEl?.getAttribute("url") || "";
    let domain = sourceName;
    try {
      if (sourceUrl) {
        domain = new URL(sourceUrl).hostname.replace("www.", "");
      }
    } catch {
      // fallback
    }
    
    articles.push({
      title: cleanTitle || fullTitle,
      domain: domain || "news.google.com",
      seendate: seendate
    });
  }
  return articles;
}

async function fetchGdeltEvidence(question, onStatus = () => {}) {
  const query = `${buildGdeltQuery(question)} sourcelang:eng`;
  const url =
    "/gdelt/api/v2/doc/doc?" +
    new URLSearchParams({
      query,
      mode: "ArtList",
      format: "json",
      maxrecords: String(GDELT_MAX_RECORDS),
      sort: "DateDesc",
    }).toString();

  const MAX_ATTEMPTS = 3;
  let data;
  let errorMsg = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let body;
    try {
      const res = await fetch(url);
      body = await res.text();
    } catch (e) {
      errorMsg = e.message;
      break;
    }
    try {
      data = JSON.parse(body);
      break;
    } catch {
      if (attempt < MAX_ATTEMPTS) {
        const wait = 2000 + attempt * 1000;
        onStatus(`📰 GDELT rate-limited or sent non-JSON, retrying in ${Math.round(wait / 1000)}s (${attempt}/${MAX_ATTEMPTS - 1})...`);
        await sleep(wait);
        continue;
      }
      errorMsg = "GDELT rate-limited (returned non-JSON)";
    }
  }

  let articles = [];
  if (data && Array.isArray(data.articles)) {
    articles = data.articles;
  } else {
    onStatus("📰 GDELT rate-limited. Falling back to Google News RSS search...");
    try {
      articles = await fetchGoogleNewsEvidence(question);
    } catch (fallbackError) {
      throw new Error(
        `Both GDELT and Google News failed. GDELT: ${errorMsg}. Google News: ${fallbackError.message}`
      );
    }
  }

  if (articles.length === 0) throw new Error("No articles returned for this question from either GDELT or Google News.");

  const seen = new Set();
  const items = [];
  let used = 0;
  for (const a of articles) {
    const title = cleanText(a.title);
    if (!title) continue;
    const key = title.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 60);
    if (seen.has(key)) continue;
    seen.add(key);
    const line = `${title} — ${cleanText(a.domain)} — ${cleanText(a.seendate)}`;
    if (used + line.length + 3 > EVIDENCE_CHAR_BUDGET) break;
    items.push(line);
    used += line.length + 3;
    if (items.length >= MAX_EVIDENCE_ITEMS) break;
  }
  if (items.length === 0) throw new Error("No usable articles found.");
  return items.join(" | ");
}

export default function App() {
  const [config, setConfig] = useState(null);
  const [configError, setConfigError] = useState("");
  const [wallet, setWallet] = useState(null);
  const [markets, setMarkets] = useState([]);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("");
  const [btcPrice, setBtcPrice] = useState(null);
  const [resolvingId, setResolvingId] = useState(null);
  const resolvingRef = useRef(false);

  // Create-market form state
  const [newType, setNewType] = useState("text"); // "text" | "price"
  const [newQuestion, setNewQuestion] = useState(
    "Did Donald Trump win the U.S. presidential election held on November 5, 2024? Answer YES or NO."
  );
  const [newTarget, setNewTarget] = useState("100000");
  const [newExpiry, setNewExpiry] = useState("");
  const [newLiquidity, setNewLiquidity] = useState("0.01");
  const [betAmount, setBetAmount] = useState("0.01");

  function calcExpectedShares(yesReserve, noReserve, isYes, investment) {
    const y = Number(yesReserve);
    const n = Number(noReserve);
    const c = Number(investment);
    if (c === 0 || isNaN(c) || c <= 0) return 0;
    if (y === 0 || n === 0) {
      return c;
    }
    if (isYes) {
      const newYes = y + c;
      const newNo = (y * n) / newYes;
      return n - newNo + c;
    } else {
      const newNo = n + c;
      const newYes = (y * n) / newNo;
      return y - newYes + c;
    }
  }

  // Load config written by Resolver
  useEffect(() => {
    fetch("/fuji.json")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("fuji.json missing"))))
      .then((c) => {
        if (!c.address || !c.abi) throw new Error("fuji.json has no address/abi");
        setConfig({ address: c.address, abi: c.abi });
      })
      .catch((e) => setConfigError(e.message));
  }, []);

  async function connectWallet() {
    if (!window.ethereum) return alert("Install MetaMask first!");
    try {
      const client = createWalletClient({ chain: avalancheFuji, transport: custom(window.ethereum) });
      const [address] = await client.requestAddresses();
      setWallet({ client, address });
      setStatus("✅ Connected: " + address.slice(0, 6) + "..." + address.slice(-4));
    } catch (e) {
      setStatus("Error: " + e.message);
    }
  }

  async function fetchBTCPrice() {
    if (!config) return;
    try {
      const price = await publicClient.readContract({
        address: config.address, abi: config.abi, functionName: "getCurrentPrice"
      });
      setBtcPrice((Number(price) / 1e8).toFixed(2));
    } catch (e) {
      console.error(e);
    }
  }

  async function loadMarkets() {
    if (!config) return;
    try {
      const count = await publicClient.readContract({
        address: config.address, abi: config.abi, functionName: "marketCount"
      });
      const loaded = [];
      for (let i = 0; i < Number(count); i++) {
        const m = await publicClient.readContract({
          address: config.address, abi: config.abi, functionName: "getMarket", args: [BigInt(i)]
        });

        let userYesShares = 0n;
        let userNoShares = 0n;
        if (wallet && wallet.address) {
          try {
            userYesShares = await publicClient.readContract({
              address: config.address, abi: config.abi, functionName: "yesShares", args: [BigInt(i), wallet.address]
            });
            userNoShares = await publicClient.readContract({
              address: config.address, abi: config.abi, functionName: "noShares", args: [BigInt(i), wallet.address]
            });
          } catch (err) {
            console.error(`Error loading user shares for market ${i}:`, err);
          }
        }

        loaded.push({ id: i, ...m, userYesShares, userNoShares });
      }
      setMarkets(loaded);
    } catch (e) {
      console.error("Load markets error:", e);
    }
  }

  function send(functionName, args, value) {
    return wallet.client.writeContract({
      address: config.address, abi: config.abi, functionName, args,
      account: wallet.address, ...(value ? { value } : {})
    });
  }

  async function withTx(label, fn) {
    if (!wallet) return alert("Connect wallet first");
    setLoading(true);
    try {
      const hash = await fn();
      setStatus(`⏳ Confirming transaction: ${hash.slice(0, 10)}...`);
      await publicClient.waitForTransactionReceipt({ hash });
      setStatus(`${label} Tx: ${hash.slice(0, 10)}...`);
      await loadMarkets();
    } catch (e) {
      setStatus("❌ " + (e.shortMessage || e.message));
    }
    setLoading(false);
  }

  async function createMarket() {
    if (!wallet) return alert("Connect wallet first");
    if (!newQuestion || !newExpiry) return alert("Fill in the question and expiry");
    if (newType === "price" && !newTarget) return alert("Price markets need a target");
    if (!newLiquidity || isNaN(parseFloat(newLiquidity)) || parseFloat(newLiquidity) <= 0) {
      return alert("Please enter a valid initial liquidity");
    }
    const expiry = BigInt(Math.floor(new Date(newExpiry).getTime() / 1000));
    
    if (newType === "text") {
      await withTx("✅ Market created!", () =>
        send("createTextMarket", [newQuestion, expiry], parseEther(newLiquidity))
      );
    } else {
      await withTx("✅ Market created!", () =>
        send("createMarket", [newQuestion, BigInt(Math.floor(parseFloat(newTarget) * 1e8)), expiry], parseEther(newLiquidity))
      );
    }
  }

  const claimLPPayout = (id) =>
    withTx("🏦 LP Payout claimed!", () => send("claimLPPayout", [BigInt(id)]));

  const buyShares = (id, isYes) => {
    if (!betAmount || isNaN(parseFloat(betAmount)) || parseFloat(betAmount) <= 0) {
      return alert("Please enter a valid bet amount greater than 0");
    }
    return withTx(`✅ Bought ${isYes ? "YES" : "NO"} shares!`, () =>
      send("buyShares", [BigInt(id), isYes], parseEther(betAmount))
    );
  };

  // Write a tx and wait for it to be mined (so multi-step flows stay ordered).
  async function sendAndWait(functionName, args, value) {
    const hash = await send(functionName, args, value);
    await publicClient.waitForTransactionReceipt({ hash });
    return hash;
  }

  // Poll Cadabra until resolved
  async function settlePoll(id) {
    for (let i = 0; i < 60; i++) {
      try {
        await publicClient.simulateContract({
          account: wallet.address, address: config.address, abi: config.abi,
          functionName: "settle", args: [BigInt(id)],
        });
        setStatus("✅ Cadabra answered — settling...");
        await sendAndWait("settle", [BigInt(id)]);
        setStatus("✅ Market settled!");
        return;
      } catch (e) {
        const msg = String(e.shortMessage || e.message || "");
        if (msg.includes("Cadabra not ready")) {
          setStatus(`⏳ Waiting for Cadabra to answer... (${i + 1}/60)`);
          await sleep(10000);
          continue;
        }
        throw e;
      }
    }
    setStatus("⚠️ Cadabra hasn't answered yet — hit “Finish Settling” again in a bit.");
  }

  // One-click resolve
  async function resolveMarket(m) {
    if (!wallet) return alert("Connect wallet first");
    if (resolvingRef.current) return;
    resolvingRef.current = true;
    setResolvingId(m.id);
    setLoading(true);
    try {
      if (m.isTextMarket) {
        setStatus(`📰 [#${m.id}] Fetching news from GDELT...`);
        let evidence;
        try {
          evidence = await fetchGdeltEvidence(m.question, setStatus);
        } catch (err) {
          console.warn("GDELT fetch failed, offering manual override:", err);
          const manual = window.prompt(
            `GDELT news fetch failed:\n"${err.message}"\n\n` +
            `Please paste manual evidence/news articles to submit on-chain (max ${EVIDENCE_CHAR_BUDGET} chars):`
          );
          if (manual === null) {
            throw new Error("Resolution cancelled by user.");
          }
          if (!manual.trim()) {
            throw new Error("No evidence provided. Resolution aborted.");
          }
          evidence = manual.trim();
        }
        setStatus(`📰 [#${m.id}] Storing evidence on-chain...`);
        await sendAndWait("submitEvidence", [BigInt(m.id), evidence]);
        await sleep(2500);
        setStatus(`🤖 [#${m.id}] Asking Cadabra to resolve...`);
        await sendAndWait("requestTextResolution", [BigInt(m.id)]);
      } else {
        setStatus(`🤖 [#${m.id}] Reading Chainlink price + asking Cadabra to resolve...`);
        await sendAndWait("requestResolution", [BigInt(m.id)]);
      }
      await settlePoll(m.id);
    } catch (e) {
      setStatus("❌ " + (e.message || e.shortMessage));
    }
    resolvingRef.current = false;
    setResolvingId(null);
    setLoading(false);
    loadMarkets();
  }

  // Resume settling
  async function finishSettling(id) {
    if (!wallet) return alert("Connect wallet first");
    if (resolvingRef.current) return;
    resolvingRef.current = true;
    setLoading(true);
    try {
      await settlePoll(id);
    } catch (e) {
      setStatus("❌ " + (e.shortMessage || e.message));
    }
    resolvingRef.current = false;
    setLoading(false);
    loadMarkets();
  }

  const claimPayout = (id) => withTx("💰 Payout claimed!", () => send("claimPayout", [BigInt(id)]));

  useEffect(() => {
    if (!config) return;
    loadMarkets();
  }, [wallet, config]);

  useEffect(() => {
    fetchBTCPrice();
    const interval = setInterval(fetchBTCPrice, 30000);
    return () => clearInterval(interval);
  }, [config]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div style={{ maxWidth: 840, margin: "0 auto", padding: "32px 20px", fontFamily: "'Inter', system-ui, sans-serif", color: "#f1f5f9", minHeight: "100vh" }}>
      
      {/* CSS Injected Styles */}
      <style>{`
        body {
          background-color: #090d16 !important;
          background-image: radial-gradient(circle at 50% 0%, #1a1e35 0%, #090d16 100%) !important;
        }
        .custom-btn {
          transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
        }
        .custom-btn:hover:not(:disabled) {
          transform: translateY(-2px);
          filter: brightness(1.15);
          box-shadow: 0 4px 20px rgba(138, 43, 226, 0.3);
        }
        .custom-btn:active:not(:disabled) {
          transform: translateY(0);
        }
        .custom-btn:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
        .custom-input {
          transition: border-color 0.2s, box-shadow 0.2s;
        }
        .custom-input:focus {
          border-color: #8a2be2 !important;
          box-shadow: 0 0 0 3px rgba(138, 43, 226, 0.25) !important;
        }
        .market-card {
          transition: border-color 0.3s, transform 0.3s;
        }
        .market-card:hover {
          border-color: rgba(138, 43, 226, 0.3) !important;
          transform: translateY(-2px);
        }
        .gradient-text {
          background: linear-gradient(135deg, #a855f7 0%, #06b6d4 100%);
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
          background-clip: text;
        }
        .glow-bar {
          box-shadow: 0 0 12px rgba(16, 185, 129, 0.4);
        }
      `}</style>

      {/* Header */}
      <div style={{ background: "linear-gradient(135deg, rgba(26, 32, 53, 0.8), rgba(15, 23, 42, 0.8))", border: "1px solid rgba(255,255,255,0.08)", backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)", borderRadius: 20, padding: "28px 32px", marginBottom: 28, boxShadow: "0 10px 40px rgba(0,0,0,0.3)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 16 }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 28, fontWeight: 800, letterSpacing: "-0.025em", display: "flex", alignItems: "center", gap: 12 }}><Logo size={36} /><span className="gradient-text">Cadabra Prediction</span></h1>
            <p style={{ margin: "6px 0 0", color: "#94a3b8", fontSize: 14, fontWeight: 500 }}>
              AI resolution via Cadabra LLM — Chainlink price markets <strong>and</strong> GDELT news/text markets on Avalanche Fuji
            </p>
          </div>
          {btcPrice && (
            <div style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 12, padding: "10px 16px", fontSize: 14, fontWeight: 600, color: "#38bdf8", boxShadow: "0 4px 12px rgba(0,0,0,0.15)", display: "inline-flex", alignItems: "center", gap: 8 }}>
              <Icon name="trendUp" size={16} /> BTC (Chainlink): <strong style={{ color: "#f8fafc" }}>${Number(btcPrice).toLocaleString()}</strong>
            </div>
          )}
        </div>
      </div>

      {/* Config missing banner */}
      {!config && (
        <div style={{ ...cardStyle, background: "#fff7ed", border: "1px solid #fdba74", color: "#9a3412", marginBottom: 20 }}>
          <strong>No deployed contract found.</strong> Run <code>npm run setup</code> in the <code>resolver/</code> folder
          (it deploys the contract and writes <code>web/public/fuji.json</code>), then refresh this page.
          {configError && <div style={{ fontSize: 12, marginTop: 6, opacity: 0.7 }}>({configError})</div>}
        </div>
      )}

      {/* Status */}
      {status && (
        <div style={{ background: "rgba(16, 185, 129, 0.1)", border: "1px solid rgba(16, 185, 129, 0.3)", borderRadius: 12, padding: "14px 20px", marginBottom: 20, fontSize: 14, color: "#34d399", fontWeight: 500, display: "flex", alignItems: "center", gap: 8, wordBreak: "break-word" }}>
          <Icon name="spark" size={16} /> <span>{stripEmoji(status)}</span>
        </div>
      )}

      {/* Connect wallet */}
      {!wallet ? (
        <div style={{ display: "flex", justifyContent: "center", marginBottom: 28 }}>
          <button onClick={connectWallet} className="custom-btn" style={btnStyle("linear-gradient(135deg, #8a2be2 0%, #4a00e0 100%)")}>
            <Icon name="wallet" size={18} /> Connect MetaMask Wallet
          </button>
        </div>
      ) : (
        <div style={{ background: "rgba(16, 185, 129, 0.05)", border: "1px solid rgba(16, 185, 129, 0.2)", borderRadius: 12, padding: "12px 18px", marginBottom: 24, fontSize: 14, fontWeight: 600, color: "#34d399", display: "inline-flex", alignItems: "center", gap: 8 }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#10b981", display: "inline-block" }}></span>
          <span>{wallet.address.slice(0, 6)}...{wallet.address.slice(-4)} connected on Fuji</span>
        </div>
      )}

      {/* Create market */}
      <div style={cardStyle} className="market-card">
        <h2 style={{ margin: "0 0 16px", fontSize: 18, fontWeight: 700, display: "flex", alignItems: "center", gap: 8, color: "#f8fafc" }}>
          <Icon name="plus" size={18} /> Create New Market
        </h2>
        <div style={{ display: "flex", gap: 10, marginBottom: 16 }}>
          <button 
            onClick={() => {
              setNewType("text");
              if (newQuestion === "Will BTC close above $100,000?") {
                setNewQuestion("Did Donald Trump win the U.S. presidential election held on November 5, 2024? Answer YES or NO.");
              }
            }} 
            className="custom-btn" 
            style={pillStyle(newType === "text", "#0ea5e9")}
          >
            <Icon name="news" size={15} /> News / Text
          </button>
          <button 
            onClick={() => {
              setNewType("price");
              if (newQuestion === "Did Donald Trump win the U.S. presidential election held on November 5, 2024? Answer YES or NO.") {
                setNewQuestion("Will BTC close above $100,000?");
              }
            }} 
            className="custom-btn" 
            style={pillStyle(newType === "price", "#16a34a")}
          >
            <Icon name="trendUp" size={15} /> Price (Chainlink)
          </button>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <label style={{ fontSize: 12, fontWeight: 600, color: "#94a3b8", marginBottom: 4 }}>Market Question</label>
          <input value={newQuestion} onChange={e => setNewQuestion(e.target.value)} placeholder="Will BTC close above $100,000?" style={inputStyle} className="custom-input" />
        </div>
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
          {newType === "price" && (
            <div style={{ flex: 2, minWidth: 150 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: "#94a3b8", marginBottom: 4 }}>Target Price (USD)</label>
              <input value={newTarget} onChange={e => setNewTarget(e.target.value)} placeholder="100000" style={inputStyle} className="custom-input" type="number" />
            </div>
          )}
          <div style={{ flex: 2, minWidth: 150 }}>
            <label style={{ fontSize: 12, fontWeight: 600, color: "#94a3b8", marginBottom: 4 }}>Expiration Date</label>
            <input value={newExpiry} onChange={e => setNewExpiry(e.target.value)} style={inputStyle} className="custom-input" type="datetime-local" />
          </div>
          <div style={{ flex: 1, minWidth: 100 }}>
            <label style={{ fontSize: 12, fontWeight: 600, color: "#94a3b8", marginBottom: 4 }}>Liquidity (AVAX)</label>
            <input value={newLiquidity} onChange={e => setNewLiquidity(e.target.value)} placeholder="0.05" style={inputStyle} className="custom-input" type="number" step="0.01" min="0.01" />
          </div>
        </div>
        <button onClick={createMarket} disabled={loading || !config} className="custom-btn" style={{ ...btnStyle("linear-gradient(135deg, #10b981 0%, #059669 100%)"), width: "100%", marginTop: 8 }}>
          {loading ? "Creating..." : `Create ${newType === "text" ? "Text" : "Price"} Market`}
        </button>
      </div>

      {/* Markets Section */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: "32px 0 16px" }}>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, display: "flex", alignItems: "center", gap: 8 }}>
          <Icon name="bars" size={20} /> Active & Past Markets
        </h2>
        <button onClick={loadMarkets} className="custom-btn" style={btnStyle("rgba(255,255,255,0.06)", true)}><Icon name="refresh" size={15} /> Refresh</button>
      </div>

      {markets.length === 0 && (
        <div style={{ ...cardStyle, textAlign: "center", color: "#94a3b8", padding: "40px 20px" }}>
          No markets found. Be the first to create one above!
        </div>
      )}

      {markets.map((m) => {
        const expired = Date.now() / 1000 >= Number(m.expiryDate);
        const yesPool = Number(formatEther(m.yesPool || 0n));
        const noPool = Number(formatEther(m.noPool || 0n));
        const total = yesPool + noPool;
        const yesReserve = Number(formatEther(m.yesReserve || 0n));
        const noReserve = Number(formatEther(m.noReserve || 0n));
        const totalReserves = yesReserve + noReserve;
        const isText = m.isTextMarket;

        // Spot Price and Probability calculations
        const yesSpot = totalReserves > 0 ? (yesReserve / totalReserves) : 0.50;
        const noSpot = totalReserves > 0 ? (noReserve / totalReserves) : 0.50;

        // Always sum to 1.00 AVAX in UI
        const yesPriceFormatted = yesSpot.toFixed(2);
        const noPriceFormatted = (1.00 - parseFloat(yesPriceFormatted)).toFixed(2);

        const yesPct = Math.round(yesSpot * 100);
        const noPct = 100 - yesPct;
        const targetUSD = Number(m.targetPrice) / 1e8;

        // Buying calculations based on inputted betAmount
        const parsedBetAmount = parseFloat(betAmount);
        const isValidBet = !isNaN(parsedBetAmount) && parsedBetAmount > 0;
        const yesSharesEst = isValidBet ? calcExpectedShares(yesReserve, noReserve, true, parsedBetAmount) : 0;
        const noSharesEst = isValidBet ? calcExpectedShares(yesReserve, noReserve, false, parsedBetAmount) : 0;
        const yesAvgPrice = yesSharesEst > 0 ? (parsedBetAmount / yesSharesEst) : 0;
        const noAvgPrice = noSharesEst > 0 ? (parsedBetAmount / noSharesEst) : 0;

        return (
          <div key={m.id} style={cardStyle} className="market-card">
            
            {/* Header info */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
              <h3 style={{ margin: 0, fontSize: 17, fontWeight: 700, flex: 1, lineHeight: 1.4, color: "#f8fafc" }}>
                <span style={{ fontSize: 11, color: "#fff", background: isText ? "#0ea5e9" : "#16a34a", borderRadius: 6, padding: "2px 8px", marginRight: 8, verticalAlign: "middle", fontWeight: 700, display: "inline-flex", alignItems: "center", gap: 4 }}>
                  <Icon name={isText ? "news" : "trendUp"} size={11} /> {isText ? "TEXT" : "PRICE"}
                </span>
                #{m.id} {m.question}
              </h3>
              <span style={{
                padding: "4px 12px", borderRadius: 20, fontSize: 12, fontWeight: 600, marginLeft: 12,
                whiteSpace: "nowrap", display: "inline-flex", alignItems: "center", gap: 5,
                background: m.resolved ? "rgba(16, 185, 129, 0.15)" : expired ? "rgba(234, 179, 8, 0.15)" : "rgba(59, 130, 246, 0.15)",
                color: m.resolved ? "#34d399" : expired ? "#facc15" : "#60a5fa",
                border: m.resolved ? "1px solid rgba(16, 185, 129, 0.3)" : expired ? "1px solid rgba(234, 179, 8, 0.3)" : "1px solid rgba(59, 130, 246, 0.3)"
              }}>
                {m.resolved ? (<><Icon name="trophy" size={12} /> {m.yesWon ? "YES Won" : "NO Won"}</>) : expired ? (<><Icon name="clock" size={12} /> Expired</>) : (<><Icon name="dot" size={10} /> Active</>)}
              </span>
            </div>

            {/* Subtitle details */}
            <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 16px", fontSize: 13, color: "#94a3b8", marginBottom: 16, borderBottom: "1px solid rgba(255,255,255,0.06)", paddingBottom: 12 }}>
              {!isText && <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><Icon name="target" size={14} /> Target Price: <strong style={{ color: "#f1f5f9" }}>${targetUSD.toLocaleString()}</strong></span>}
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><Icon name="clock" size={14} /> Expires: <strong style={{ color: "#f1f5f9" }}>{new Date(Number(m.expiryDate) * 1000).toLocaleString()}</strong></span>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><Icon name="droplet" size={14} /> Pool: <strong style={{ color: "#f1f5f9" }}>{total.toFixed(4)} AVAX</strong></span>
            </div>

            {/* Probability bar */}
            <div style={{ marginBottom: 20 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 6, fontWeight: 600 }}>
                <span style={{ color: "#34d399", display: "inline-flex", alignItems: "center", gap: 5 }}><Icon name="checkCircle" size={13} /> YES {yesPct}% <span style={{ color: "#64748b", fontWeight: 500 }}>({yesPriceFormatted} AVAX)</span></span>
                <span style={{ color: "#f87171", display: "inline-flex", alignItems: "center", gap: 5 }}><span style={{ color: "#64748b", fontWeight: 500 }}>({noPriceFormatted} AVAX)</span> NO {noPct}% <Icon name="xCircle" size={13} /></span>
              </div>
              <div style={{ display: "flex", height: 14, borderRadius: 999, overflow: "hidden", background: "rgba(0,0,0,0.3)", border: "1px solid rgba(255,255,255,0.06)" }}>
                <div className="glow-bar" style={{ background: "linear-gradient(90deg, #059669, #34d399)", width: yesPct + "%", height: "100%", transition: "width .4s ease" }} />
                <div style={{ background: "linear-gradient(90deg, #ef4444, #f87171)", width: noPct + "%", height: "100%", transition: "width .4s ease" }} />
              </div>
            </div>

            {/* User Position display */}
            {wallet && (Number(m.userYesShares || 0n) > 0 || Number(m.userNoShares || 0n) > 0) && (
              <div style={{ 
                marginBottom: 20, 
                background: "rgba(138, 43, 226, 0.1)", 
                border: "1px solid rgba(138, 43, 226, 0.25)", 
                borderRadius: 10, 
                padding: "10px 14px", 
                fontSize: 13,
                color: "#e2e8f0",
                display: "flex",
                alignItems: "center",
                gap: 8
              }}>
                <Icon name="briefcase" size={16} />
                <span>
                  <strong>Your Positions:</strong> &nbsp;
                  {Number(m.userYesShares || 0n) > 0 && (
                    <span style={{ color: "#34d399", marginRight: 16, fontWeight: 600 }}>
                      {Number(formatEther(m.userYesShares)).toFixed(3)} YES shares
                    </span>
                  )}
                  {Number(m.userNoShares || 0n) > 0 && (
                    <span style={{ color: "#f87171", fontWeight: 600 }}>
                      {Number(formatEther(m.userNoShares)).toFixed(3)} NO shares
                    </span>
                  )}
                </span>
              </div>
            )}

            {/* Trading Actions */}
            <div style={{ display: "flex", gap: 12, flexDirection: "column" }}>
              {!m.resolved && !expired && (
                <>
                  {/* Bet Amount Input inside card */}
                  <div style={{ display: "flex", alignItems: "center", gap: 12, background: "rgba(0,0,0,0.25)", padding: "12px 16px", borderRadius: 12, border: "1px solid rgba(255,255,255,0.06)", flexWrap: "wrap" }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: "#94a3b8", display: "inline-flex", alignItems: "center", gap: 6 }}><Icon name="coin" size={15} /> Bet Amount:</span>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <input 
                        type="number" 
                        step="0.01" 
                        min="0.001" 
                        value={betAmount} 
                        onChange={e => setBetAmount(e.target.value)} 
                        style={{ 
                          background: "rgba(0, 0, 0, 0.4)", 
                          border: "1px solid rgba(255, 255, 255, 0.1)", 
                          borderRadius: 8, 
                          padding: "6px 12px", 
                          color: "white", 
                          fontSize: 14, 
                          width: 80,
                          outline: "none"
                        }}
                        className="custom-input"
                      />
                      <span style={{ fontSize: 13, fontWeight: 600, color: "#cbd5e1" }}>AVAX</span>
                    </div>
                    {isValidBet && (
                      <span style={{ fontSize: 12, color: "#94a3b8", marginLeft: "auto" }}>
                        Slip estimates shown on buttons
                      </span>
                    )}
                  </div>

                  {/* Buy YES / NO buttons */}
                  <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                    <button 
                      onClick={() => buyShares(m.id, true)} 
                      disabled={loading || !isValidBet} 
                      className="custom-btn" 
                      style={{ 
                        ...btnStyle("linear-gradient(135deg, #059669 0%, #10b981 100%)", true), 
                        flex: 1, 
                        minWidth: 220 
                      }}
                    >
                      <Icon name="checkCircle" size={16} /> Buy YES ({yesSharesEst.toFixed(3)} shares @ {yesAvgPrice.toFixed(2)} AVAX/share)
                    </button>
                    <button 
                      onClick={() => buyShares(m.id, false)} 
                      disabled={loading || !isValidBet} 
                      className="custom-btn" 
                      style={{ 
                        ...btnStyle("linear-gradient(135deg, #dc2626 0%, #ef4444 100%)", true), 
                        flex: 1, 
                        minWidth: 220 
                      }}
                    >
                      <Icon name="xCircle" size={16} /> Buy NO ({noSharesEst.toFixed(3)} shares @ {noAvgPrice.toFixed(2)} AVAX/share)
                    </button>
                  </div>
                </>
              )}

              {/* Resolution and Settling actions */}
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                {expired && !m.resolutionRequested && !m.resolved && (
                  <button 
                    onClick={() => resolveMarket(m)} 
                    disabled={loading} 
                    className="custom-btn" 
                    style={{ ...btnStyle("linear-gradient(135deg, #7c3aed 0%, #6366f1 100%)", true), width: "100%" }}
                  >
                    <Icon name={resolvingId === m.id ? "hourglass" : "cpu"} size={16} /> {resolvingId === m.id ? "Resolving..." : loading ? "Busy — wait..." : "Resolve Market"}
                  </button>
                )}
                {m.resolutionRequested && !m.resolved && (
                  <button 
                    onClick={() => finishSettling(m.id)} 
                    disabled={loading} 
                    className="custom-btn" 
                    style={{ ...btnStyle("linear-gradient(135deg, #0284c7 0%, #0369a1 100%)", true), width: "100%" }}
                  >
                    <Icon name="hourglass" size={16} /> Finish Settling
                  </button>
                )}
                {m.resolved && (
                  <button 
                    onClick={() => claimPayout(m.id)} 
                    disabled={loading} 
                    className="custom-btn" 
                    style={{ ...btnStyle("linear-gradient(135deg, #10b981 0%, #059669 100%)", true), width: "100%" }}
                  >
                    <Icon name="coin" size={16} /> Claim Winning Payout
                  </button>
                )}
                {m.resolved && !isText && wallet && wallet.address && wallet.address.toLowerCase() === m.creator.toLowerCase() && !m.lpClaimed && (
                  <button 
                    onClick={() => claimLPPayout(m.id)} 
                    disabled={loading} 
                    className="custom-btn" 
                    style={{ ...btnStyle("linear-gradient(135deg, #f97316 0%, #ea580c 100%)", true), width: "100%" }}
                  >
                    <Icon name="bank" size={16} /> Claim LP Payouts (Creator)
                  </button>
                )}
              </div>
            </div>

            {/* Stored evidence / prompt */}
            {isText && m.evidence && (
              <div style={{ marginTop: 14, fontSize: 12, color: "#94a3b8", background: "rgba(0, 0, 0, 0.25)", padding: "12px 16px", borderRadius: 8, border: "1px solid rgba(255,255,255,0.04)", wordBreak: "break-all" }}>
                <strong>On-chain news evidence:</strong> {m.evidence.slice(0, 240)}{m.evidence.length > 240 ? "…" : ""}
              </div>
            )}
            {m.resolutionData && (
              <div style={{ marginTop: 8, fontSize: 12, color: "#94a3b8", background: "rgba(0, 0, 0, 0.25)", padding: "12px 16px", borderRadius: 8, border: "1px solid rgba(255,255,255,0.04)" }}>
                <strong>Prompt sent to Oracle:</strong> {m.resolutionData.slice(0, 250)}...
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

const cardStyle = { 
  background: "rgba(20, 25, 35, 0.65)", 
  backdropFilter: "blur(16px)",
  WebkitBackdropFilter: "blur(16px)",
  border: "1px solid rgba(255, 255, 255, 0.08)", 
  borderRadius: 16, 
  padding: 24, 
  marginBottom: 20, 
  boxShadow: "0 8px 32px 0 rgba(0, 0, 0, 0.37)" 
};

const inputStyle = { 
  width: "100%", 
  padding: "12px 14px", 
  marginBottom: 12, 
  background: "rgba(0, 0, 0, 0.3)", 
  border: "1px solid rgba(255, 255, 255, 0.12)", 
  borderRadius: 10, 
  fontSize: 14, 
  color: "#f8fafc",
  boxSizing: "border-box", 
  display: "block",
  outline: "none"
};

const btnStyle = (bg, small = false) => ({ 
  background: bg, 
  color: "white", 
  border: "none", 
  borderRadius: 10, 
  padding: small ? "10px 16px" : "12px 20px", 
  fontSize: small ? 13 : 14, 
  cursor: "pointer", 
  fontWeight: 600,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 8
});

const pillStyle = (active, bg) => ({ 
  background: active ? bg : "rgba(255, 255, 255, 0.05)", 
  color: active ? "white" : "#94a3b8", 
  border: active ? "none" : "1px solid rgba(255, 255, 255, 0.1)", 
  borderRadius: 20, 
  padding: "6px 16px", 
  fontSize: 13, 
  cursor: "pointer", 
  fontWeight: 600,
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  transition: "all 0.2s ease"
});
