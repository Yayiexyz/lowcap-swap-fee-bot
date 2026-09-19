(() => {
"use strict";

const BASE_HEX="0x2105";
const A={
 WETH:"0x4200000000000000000000000000000000000006",
 USDC:"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
 FACTORY:"0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
 NPM:"0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1",
 QUOTER:"0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
 ROUTER:"0x2626664c2603336E57B271c5C0b26F421741e481"
};
const ZERO="0x0000000000000000000000000000000000000000";
const MAX128=(1n<<128n)-1n;
const FEE=3000, SPACING=60, RANGE=3;

const ERC20=[
 "function balanceOf(address) view returns(uint256)",
 "function allowance(address,address) view returns(uint256)",
 "function approve(address,uint256) returns(bool)"
];
const WETH=[...ERC20,"function deposit() payable","function withdraw(uint256)"];
const FACTORY=["function getPool(address,address,uint24) view returns(address)"];
const POOL=[
 "function slot0() view returns(uint160 sqrtPriceX96,int24 tick,uint16,uint16,uint16,uint8,bool)",
 "function liquidity() view returns(uint128)"
];
const QUOTER=["function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns(uint256 amountOut,uint160,uint32,uint256)"];
const ROUTER=["function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns(uint256)"];
const NPM=[
 "event Transfer(address indexed from,address indexed to,uint256 indexed tokenId)",
 "function positions(uint256) view returns(uint96,address,address,address,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128)",
 "function mint((address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline) params) payable returns(uint256,uint128,uint256,uint256)",
 "function collect((uint256 tokenId,address recipient,uint128 amount0Max,uint128 amount1Max) params) payable returns(uint256,uint256)",
 "function decreaseLiquidity((uint256 tokenId,uint128 liquidity,uint256 amount0Min,uint256 amount1Min,uint256 deadline) params) payable returns(uint256,uint256)"
];

const $=id=>document.getElementById(id);
let eip=null,provider=null,signer=null,account=null,poolAddr=null;
const st={
 busy:false, timer:null, auto:localStorage.getItem("lowcap_auto_rebalance")!=="off",
 autoRunning:false, cooldown:0, ethPrice:0, preparedWeth:0n, preparedUsdc:0n,
 feeSamples:[]
};

function log(s){const t=new Date().toLocaleTimeString();$("log").textContent+=`[${t}] ${s}\n`; $("log").scrollTop=$("log").scrollHeight}
function short(a){return a&&a.length>12?`${a.slice(0,6)}…${a.slice(-4)}`:(a||"—")}
function money(x,d=2){x=Number(x);return Number.isFinite(x)?`$${x.toLocaleString(undefined,{minimumFractionDigits:d,maximumFractionDigits:d})}`:"—"}
function priceFromTick(t){return Math.pow(1.0001,Number(t))*1e12}
function ticks(t,pct=RANGE){return{lo:Math.floor((Number(t)+Math.log(1-pct/100)/Math.log(1.0001))/SPACING)*SPACING,hi:Math.ceil((Number(t)+Math.log(1+pct/100)/Math.log(1.0001))/SPACING)*SPACING}}
function runner(write=true){return write?signer:provider}
function C(write=true){const r=runner(write);return{
 weth:new ethers.Contract(A.WETH,WETH,r),usdc:new ethers.Contract(A.USDC,ERC20,r),
 factory:new ethers.Contract(A.FACTORY,FACTORY,r),quoter:new ethers.Contract(A.QUOTER,QUOTER,r),
 router:new ethers.Contract(A.ROUTER,ROUTER,r),npm:new ethers.Contract(A.NPM,NPM,r)
}}

function notifyUser(title,body){
 if(!st.alertsEnabled||!("Notification" in window)||Notification.permission!=="granted")return;
 try{new Notification(title,{body,tag:"lowcap-range-guardian"})}catch{}
}
async function toggleAlerts(){
 if(!("Notification" in window)){log("Browser notifications are not supported here.");return}
 if(!st.alertsEnabled){
  const p=await Notification.requestPermission();
  if(p!=="granted"){log("Notification permission was not granted.");return}
  st.alertsEnabled=true;localStorage.setItem("lowcap_alerts","on");$("notifyBtn").textContent="Disable Alerts";log("Range alerts enabled.")
 }else{
  st.alertsEnabled=false;localStorage.setItem("lowcap_alerts","off");$("notifyBtn").textContent="Enable Alerts";log("Range alerts disabled.")
 }
}
async function toggleWakeLock(){
 if(!("wakeLock" in navigator)){log("Screen Wake Lock is not supported by this browser.");return}
 if(st.wakeLock){try{await st.wakeLock.release()}catch{}st.wakeLock=null;$("wakeBtn").textContent="Keep Screen Awake";log("Screen wake lock released.");return}
 try{
  st.wakeLock=await navigator.wakeLock.request("screen");$("wakeBtn").textContent="Release Screen Awake";log("Screen wake lock enabled while this page remains visible.");
  st.wakeLock.addEventListener("release",()=>{st.wakeLock=null;if($("wakeBtn"))$("wakeBtn").textContent="Keep Screen Awake"})
 }catch(e){log("Wake lock unavailable: "+(e?.message||e))}
}
function gasGuardOkay(){
 const usd=Number(($("gasReserve")?.textContent||"").replace(/[^0-9.]/g,""));
 const ok=Number.isFinite(usd)&&usd>=2.5;
 if($("gasSafety")){$("gasSafety").textContent=ok?"OK":"LOW GAS";$("gasSafety").className=ok?"okText":"badText"}
 return ok
}
function setBusy(v){st.busy=v;document.querySelectorAll("button").forEach(b=>b.disabled=v)}
async function act(fn){if(st.busy)return;setBusy(true);try{await fn()}catch(e){const m=e?.shortMessage||e?.reason||e?.message||String(e);log("ERROR: "+m);alert(m)}finally{setBusy(false)}}

async function ensureBase(){
 const ch=await eip.request({method:"eth_chainId"});
 if(ch.toLowerCase()===BASE_HEX)return;
 try{await eip.request({method:"wallet_switchEthereumChain",params:[{chainId:BASE_HEX}]})}
 catch(e){if(e.code!==4902)throw e;await eip.request({method:"wallet_addEthereumChain",params:[{chainId:BASE_HEX,chainName:"Base",nativeCurrency:{name:"Ether",symbol:"ETH",decimals:18},rpcUrls:["https://mainnet.base.org"],blockExplorerUrls:["https://basescan.org"]}]})}
}

async function setup(ask){
 if(!window.ethers)throw new Error("ethers failed to load");
 eip=window.phantom?.ethereum||(window.ethereum?.isPhantom?window.ethereum:null);
 if(!eip)throw new Error("Phantom EVM provider not found");
 const accts=await eip.request({method:ask?"eth_requestAccounts":"eth_accounts"});
 if(!accts?.length)return false;
 await ensureBase();
 provider=new ethers.BrowserProvider(eip);signer=await provider.getSigner();account=await signer.getAddress();
 $("address").textContent=account;$("network").textContent="Base (8453)";
 $("liveBadge").innerHTML='<span class="dot"></span> PHANTOM CONNECTED';$("liveBadge").className="pill good";
 $("autoConnectStatus").textContent="CONNECTED";$("botStatus").textContent=st.auto?"Auto armed":"Monitoring";
 eip.on?.("accountsChanged",()=>location.reload());eip.on?.("chainChanged",()=>location.reload());
 await scanPool();await refreshAll();startMonitor();return true;
}
async function connect(){if(await setup(true))log(`Connected ${short(account)} on Base.`)}
async function autoConnect(){try{if(await setup(false))log(`Auto-reconnected ${short(account)} on Base.`);else log("Click Connect Phantom once to authorize this site.")}catch(e){log("Auto-connect unavailable: "+(e?.message||e))}}

async function scanPool(){
 const c=C(false);poolAddr=await c.factory.getPool(A.WETH,A.USDC,FEE);
 if(!poolAddr||poolAddr.toLowerCase()===ZERO)throw new Error("0.30% WETH/USDC pool unavailable");
 const p=new ethers.Contract(poolAddr,POOL,provider);const [s,l]=await Promise.all([p.slot0(),p.liquidity()]);
 st.ethPrice=priceFromTick(s.tick);$("ethPrice").textContent=money(st.ethPrice);
 $("poolRows").innerHTML=`<tr><td>0.30%</td><td class="mono">${short(poolAddr)}</td><td>${money(st.ethPrice)}</td><td class="mono">${String(l).slice(0,18)}…</td><td class="okText">Active</td></tr>`;
 log("Scanned Uniswap v3 WETH/USDC 0.30% pool.");
}
async function balances(){
 const c=C(false);const [e,w,u]=await Promise.all([provider.getBalance(account),c.weth.balanceOf(account),c.usdc.balanceOf(account)]);
 $("ethBal").textContent=`${Number(ethers.formatEther(e)).toFixed(6)} ETH`;
 $("wethBal").textContent=`${Number(ethers.formatEther(w)).toFixed(6)} WETH`;
 $("usdcBal").textContent=`${Number(ethers.formatUnits(u,6)).toFixed(2)} USDC`;
 const usd=Number(ethers.formatEther(e))*st.ethPrice;$("gasReserve").textContent=money(usd);$("gasReserve").className=usd<2.5?"badText":usd<5?"warnText":"okText";gasGuardOkay();
 return{eth:e,weth:w,usdc:u}
}
async function refreshAll(){if(!provider)return;await scanPool();await balances();if($("tokenId").value.trim())await loadPosition(true);$("lastUpdate").textContent=new Date().toLocaleTimeString()}

async function approve(token,spender,amt,label){
 if(await token.allowance(account,spender)>=amt)return;
 log("Phantom approval needed: "+label);const tx=await token.approve(spender,amt);log("Approval sent: "+tx.hash);await tx.wait();log(label+" approved.");
}
async function quote(tokenIn,tokenOut,amt){
 const r=await C(false).quoter.quoteExactInputSingle.staticCall({tokenIn,tokenOut,amountIn:amt,fee:FEE,sqrtPriceLimitX96:0});return r[0]
}
async function swap(tokenIn,tokenOut,amt){
 if(amt<=0n)return 0n;const c=C(true);const tok=tokenIn.toLowerCase()===A.WETH.toLowerCase()?c.weth:c.usdc;
 await approve(tok,A.ROUTER,amt,"Router");
 const q=await quote(tokenIn,tokenOut,amt);const slip=Math.max(.1,Number($("slippagePct").value||1));const min=q*BigInt(Math.floor((100-slip)*100))/10000n;
 const tx=await c.router.exactInputSingle({tokenIn,tokenOut,fee:FEE,recipient:account,amountIn:amt,amountOutMinimum:min,sqrtPriceLimitX96:0});
 log("Swap sent: "+tx.hash);await tx.wait();log("Swap confirmed.");return q
}

async function previewPlan(){
 const b=await balances(),reserve=Number($("reserveUsd").value||8),price=st.ethPrice,resWei=ethers.parseEther((reserve/price).toFixed(18)),cush=ethers.parseEther("0.00002");
 const dep=b.eth>resWei+cush?b.eth-resWei-cush:0n;
 const nativeUsd=Number(ethers.formatEther(dep))*price,wethUsd=Number(ethers.formatEther(b.weth))*price,usdcUsd=Number(ethers.formatUnits(b.usdc,6));
 const total=nativeUsd+wethUsd+usdcUsd,target=total/2;
 let msg="No balancing swap needed";
 if(usdcUsd<target)msg=`After wrapping deployable ETH, swap about ${money(target-usdcUsd)} of WETH to USDC`;
 else if(usdcUsd>target)msg=`Swap about ${money(usdcUsd-target)} USDC to WETH`;
 $("existingPlanSummary").textContent=`Deploy ~${money(total)} | keep ~${money(reserve)} native ETH | target ~${money(target)} each side | ${msg}`;
 return{b,reserve,dep,total,target}
}
async function prepareExisting(){
 const plan=await previewPlan(),c=C(true);
 if(plan.dep>0n){const tx=await c.weth.deposit({value:plan.dep});log("Wrap sent: "+tx.hash);await tx.wait();log("Deployable ETH wrapped.");}
 let w=await c.weth.balanceOf(account),u=await c.usdc.balanceOf(account);
 let wu=Number(ethers.formatEther(w))*st.ethPrice,uu=Number(ethers.formatUnits(u,6)),target=(wu+uu)/2;
 if(uu<target-.01){let a=ethers.parseEther(((target-uu)/st.ethPrice).toFixed(18));if(a>w)a=w;await swap(A.WETH,A.USDC,a)}
 else if(uu>target+.01){let a=ethers.parseUnits((uu-target).toFixed(6),6);if(a>u)a=u;await swap(A.USDC,A.WETH,a)}
 w=await c.weth.balanceOf(account);u=await c.usdc.balanceOf(account);st.preparedWeth=w;st.preparedUsdc=u;
 $("prepSummary").textContent=`${Number(ethers.formatEther(w)).toFixed(6)} WETH + ${Number(ethers.formatUnits(u,6)).toFixed(2)} USDC`;log("Existing Base balance prepared.");
 await balances();
}
async function useCurrent(){
 const b=await balances();if(b.weth<=0n||b.usdc<=0n)throw new Error("Wallet needs both WETH and USDC");
 st.preparedWeth=b.weth;st.preparedUsdc=b.usdc;$("prepSummary").textContent=`${Number(ethers.formatEther(b.weth)).toFixed(6)} WETH + ${Number(ethers.formatUnits(b.usdc,6)).toFixed(2)} USDC`;log("Prepared current WETH + USDC.");
}

async function mintPrepared(){
 if(st.preparedWeth<=0n||st.preparedUsdc<=0n)throw new Error("Prepare WETH + USDC first");
 const c=C(true),p=new ethers.Contract(poolAddr,POOL,provider),s=await p.slot0(),r=ticks(s.tick);
 const [wb,ub]=await Promise.all([c.weth.balanceOf(account),c.usdc.balanceOf(account)]);
 let w=st.preparedWeth<wb?st.preparedWeth:wb,u=st.preparedUsdc<ub?st.preparedUsdc:ub;
 await approve(c.weth,A.NPM,w,"WETH Position Manager");await approve(c.usdc,A.NPM,u,"USDC Position Manager");
 const dl=Math.floor(Date.now()/1000)+1800,base={token0:A.WETH,token1:A.USDC,fee:FEE,tickLower:r.lo,tickUpper:r.hi,amount0Desired:w,amount1Desired:u,amount0Min:0,amount1Min:0,recipient:account,deadline:dl};
 const pv=await c.npm.mint.staticCall(base),k=9700n,params={...base,amount0Min:pv[2]*k/10000n,amount1Min:pv[3]*k/10000n};
 const ge=await c.npm.mint.estimateGas(params),tx=await c.npm.mint(params,{gasLimit:ge*135n/100n});log("LP mint sent: "+tx.hash);const rc=await tx.wait();
 let id=null;for(const lg of rc.logs){if(lg.address.toLowerCase()!==A.NPM.toLowerCase())continue;try{const x=c.npm.interface.parseLog(lg);if(x?.name==="Transfer"&&x.args.from.toLowerCase()===ZERO){id=x.args.tokenId.toString();break}}catch{}}
 if(!id)throw new Error("Mint confirmed but NFT ID could not be parsed");
 $("tokenId").value=id;localStorage.setItem("lowcap_last_token_id",id);st.preparedWeth=0n;st.preparedUsdc=0n;$("prepSummary").textContent="None";log("Position NFT created successfully: #"+id);await loadPosition(false);
}

function feeSample(v){const t=Date.now();st.feeSamples.push({t,v});st.feeSamples=st.feeSamples.filter(x=>t-x.t<21600000).slice(-80);$("heroFees").textContent=money(v,4);const a=st.feeSamples[0],b=st.feeSamples.at(-1);if(b.t-a.t>120000&&b.v>=a.v)$("feePace").textContent=`Observed pace: ${money((b.v-a.v)/(b.t-a.t)*86400000,3)}/day`}
async function loadPosition(silent=false){
 const id=$("tokenId").value.trim();if(!id)throw new Error("Enter Position NFT ID");
 const c=C(false),x=await c.npm.positions(BigInt(id));const fee=Number(x[4]),lo=Number(x[5]),hi=Number(x[6]),liq=x[7];
 if(fee!==FEE)throw new Error("This v4 build expects the 0.30% position");
 const p=new ethers.Contract(poolAddr,POOL,provider),s=await p.slot0(),tick=Number(s.tick),price=priceFromTick(tick),lp=priceFromTick(lo),hp=priceFromTick(hi),inside=tick>=lo&&tick<hi;
 const edge=inside?Math.min((price-lp)/price*100,(hp-price)/price*100):0;
 $("posPrice").textContent=money(price);$("posRange").textContent=`${money(lp)} – ${money(hp)}`;$("posFee").textContent="0.30%";$("edgeDistance").textContent=inside?`${edge.toFixed(2)}%`:"0%";
 $("posStatus").textContent=inside?(edge<.35?"NEAR EDGE":"IN RANGE"):"OUT OF RANGE";$("posStatus").className=inside?(edge<.35?"warnText":"okText"):"badText";
 $("heroPosition").textContent=inside?"IN RANGE":"OUT OF RANGE";$("heroEdge").textContent=inside?`${edge.toFixed(2)}% to nearest edge`:"Auto-rebalance trigger active";
 $("rangeHint").textContent=inside?"Active liquidity is eligible to earn swap fees.":(st.auto?"Auto-rebalance will request Phantom approvals.":"Auto-rebalance is paused.");
 const posPct=Math.max(0,Math.min(100,(price-lp)/(hp-lp)*100));$("rangeFill").style.width=posPct+"%";$("rangeMarker").style.left=posPct+"%";$("rangeLowLabel").textContent=money(lp,0);$("rangeHighLabel").textContent=money(hp,0);
 try{const cw=C(true);const f=await cw.npm.collect.staticCall({tokenId:BigInt(id),recipient:account,amount0Max:MAX128,amount1Max:MAX128});const wf=Number(ethers.formatEther(f[0])),uf=Number(ethers.formatUnits(f[1],6)),usd=wf*price+uf;$("posFees").textContent=`${wf.toFixed(8)} WETH + ${uf.toFixed(4)} USDC ≈ ${money(usd,4)}`;feeSample(usd)}catch{$("posFees").textContent="Fee preview unavailable"}
 $("lastUpdate").textContent=new Date().toLocaleTimeString();if(!silent)log(`Loaded #${id}: ${inside?"IN RANGE":"OUT OF RANGE"}.`);
 return{id,liq,inside,price,lo,hi,edge}
}

async function collectTokens(){
 const p=await loadPosition(true),c=C(true),pv=await c.npm.collect.staticCall({tokenId:BigInt(p.id),recipient:account,amount0Max:MAX128,amount1Max:MAX128});
 if(pv[0]===0n&&pv[1]===0n)return log("No collectible fees.");
 const tx=await c.npm.collect({tokenId:BigInt(p.id),recipient:account,amount0Max:MAX128,amount1Max:MAX128});log("Collect sent: "+tx.hash);await tx.wait();$("collectSummary").textContent="Collected to Phantom as WETH + USDC.";await refreshAll()
}
async function collectEth(){
 const p=await loadPosition(true),c=C(true),bw=await c.weth.balanceOf(account),bu=await c.usdc.balanceOf(account);
 let tx=await c.npm.collect({tokenId:BigInt(p.id),recipient:account,amount0Max:MAX128,amount1Max:MAX128});log("Collect sent: "+tx.hash);await tx.wait();
 let w=await c.weth.balanceOf(account),u=await c.usdc.balanceOf(account),dw=w>bw?w-bw:0n,du=u>bu?u-bu:0n;
 let sw=0n;if(du>0n){const before=await c.weth.balanceOf(account);await swap(A.USDC,A.WETH,du);const after=await c.weth.balanceOf(account);sw=after>before?after-before:0n}
 const all=dw+sw;if(all>0n){tx=await c.weth.withdraw(all);log("Unwrap sent: "+tx.hash);await tx.wait()}
 $("collectSummary").textContent="Fee-derived balances converted to native ETH in Phantom.";await refreshAll()
}

async function rebalance(){
 const pos=await loadPosition(true);if(pos.inside)throw new Error("Recenter is allowed only when OUT OF RANGE in v4 auto mode");
 const c=C(true),before=await balances(),dl=Math.floor(Date.now()/1000)+1200;
 const pv=await c.npm.decreaseLiquidity.staticCall({tokenId:BigInt(pos.id),liquidity:pos.liq,amount0Min:0,amount1Min:0,deadline:dl}),k=9850n;
 let tx=await c.npm.decreaseLiquidity({tokenId:BigInt(pos.id),liquidity:pos.liq,amount0Min:pv[0]*k/10000n,amount1Min:pv[1]*k/10000n,deadline:dl});log("Decrease liquidity sent: "+tx.hash);await tx.wait();
 tx=await c.npm.collect({tokenId:BigInt(pos.id),recipient:account,amount0Max:MAX128,amount1Max:MAX128});log("Collect principal + fees sent: "+tx.hash);await tx.wait();
 let after=await balances(),dw=after.weth-before.weth,du=after.usdc-before.usdc;if(dw<=0n&&du<=0n)throw new Error("Could not detect withdrawn balances");
 const wu=Number(ethers.formatEther(dw>0n?dw:0n))*st.ethPrice,uu=Number(ethers.formatUnits(du>0n?du:0n,6)),target=(wu+uu)/2;
 if(wu>target*1.03)await swap(A.WETH,A.USDC,ethers.parseEther(((wu-target)/st.ethPrice).toFixed(18)));
 else if(uu>target*1.03)await swap(A.USDC,A.WETH,ethers.parseUnits((uu-target).toFixed(6),6));
 after=await balances();st.preparedWeth=after.weth-before.weth;st.preparedUsdc=after.usdc-before.usdc;
 if(st.preparedWeth<=0n||st.preparedUsdc<=0n)throw new Error("Rebalance token mix invalid");
 await mintPrepared();log("Rebalance complete with new ±3% position.");
}

async function monitor(){
 if(st.busy||st.autoRunning||!provider)return;const id=$("tokenId").value.trim();if(!id)return;
 try{const p=await loadPosition(true);if(!st.auto||p.inside||Date.now()<st.cooldown)return;st.autoRunning=true;$("autoRebalanceStatus").textContent="RECENTERING";log("AUTO-REBALANCE: OUT OF RANGE detected.");
 try{await rebalance();$("autoRebalanceStatus").textContent="ARMED"}catch(e){st.cooldown=Date.now()+600000;$("autoRebalanceStatus").textContent="10M COOLDOWN";log("AUTO-REBALANCE paused: "+(e?.shortMessage||e?.message||e))}finally{st.autoRunning=false}}
 catch(e){log("Monitor warning: "+(e?.message||e))}
}
function startMonitor(){clearInterval(st.timer);st.timer=setInterval(monitor,15000);$("browserStatus").textContent="Live monitor every 15 sec"}
function autoUI(){$("autoModeText").textContent=st.auto?"ON":"OFF";$("autoRebalanceStatus").textContent=st.auto?"ARMED":"PAUSED";$("toggleAutoRebalanceBtn").textContent=st.auto?"Pause Auto-Rebalance":"Enable Auto-Rebalance";if($("notifyBtn"))$("notifyBtn").textContent=st.alertsEnabled?"Disable Alerts":"Enable Alerts"}
function strategy(){const c=Number($("capitalUsd").value||0),r=Number($("reserveUsd").value||0);$("strategySummary").textContent=`Deploy target ~${money(Math.max(0,c-r))} • reserve ~${money(r)} • fixed 0.30% • fixed ±3%`}

$("connectBtn").onclick=()=>act(connect);$("refreshBtn").onclick=()=>act(refreshAll);$("scanBtn").onclick=()=>act(scanPool);
$("previewExistingBtn").onclick=()=>act(previewPlan);$("prepareExistingBtn").onclick=()=>act(prepareExisting);$("useWalletBtn").onclick=()=>act(useCurrent);$("mintBtn").onclick=()=>act(mintPrepared);
$("positionBtn").onclick=()=>act(()=>loadPosition(false));$("collectTokensBtn").onclick=()=>act(collectTokens);$("collectEthBtn").onclick=()=>act(collectEth);$("rebalanceBtn").onclick=()=>act(rebalance);
$("clearLogBtn").onclick=()=>$("log").textContent="";
$("notifyBtn").onclick=()=>act(toggleAlerts);$("wakeBtn").onclick=()=>act(toggleWakeLock);$("toggleAutoRebalanceBtn").onclick=()=>{st.auto=!st.auto;localStorage.setItem("lowcap_auto_rebalance",st.auto?"on":"off");autoUI();log("Auto-Rebalance "+(st.auto?"enabled":"paused"))};
["capitalUsd","reserveUsd","slippagePct"].forEach(id=>$(id).addEventListener("input",strategy));
document.addEventListener("visibilitychange",()=>{$("browserStatus").textContent=document.hidden?"Background tab — browser may throttle":"Live monitor every 15 sec"});

const saved=localStorage.getItem("lowcap_last_token_id");if(saved)$("tokenId").value=saved;
$("feeTier").value="3000";$("rangePct").value="3";strategy();autoUI();
log("v4.1 Hosted Pro ready: fixed 0.30% fee tier, fixed ±3% range, auto-reconnect and auto-rebalance armed.");
setTimeout(autoConnect,350);
})();