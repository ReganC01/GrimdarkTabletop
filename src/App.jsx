import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";

/* ═══ FONTS ═══════════════════════════════════════════════════ */
const GLOBAL_CSS = `
@import url('https://fonts.googleapis.com/css2?family=Cinzel:wght@400;700;900&family=Crimson+Text:ital,wght@0,400;0,600;1,400&family=Share+Tech+Mono&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --gold:#b8860b;--gold-l:#d4a820;--gold-d:#6a4e08;
  --blood:#8a0000;--blood-l:#c0281a;
  --iron:#22222e;--iron-l:#2e2e3e;--iron-d:#14141c;
  --bone:#d0c4a4;--bone-d:#7a6e54;
  --void:#06060a;--void2:#0c0c14;
  --fdisplay:'Cinzel',serif;--fbody:'Crimson Text',serif;--fmono:'Share Tech Mono',monospace;
}
body{background:var(--void);color:var(--bone);font-family:var(--fbody)}
::-webkit-scrollbar{width:3px}::-webkit-scrollbar-track{background:#0a0a12}::-webkit-scrollbar-thumb{background:var(--gold-d)}
@keyframes flicker{0%,100%{opacity:1}91%{opacity:1}92%{opacity:.6}94%{opacity:.9}96%{opacity:.7}98%{opacity:1}}
@keyframes dmg-up{0%{opacity:1;transform:translate(-50%,-10px) scale(1)}100%{opacity:0;transform:translate(-50%,-52px) scale(1.3)}}
@keyframes hit-burst{0%{opacity:1;transform:translate(-50%,-50%) scale(0.2)}70%{opacity:.8;transform:translate(-50%,-50%) scale(1.4)}100%{opacity:0;transform:translate(-50%,-50%) scale(1.8)}}
@keyframes muzzle-flash{0%{opacity:1;transform:translate(-50%,-50%) scale(0.3) rotate(0deg)}60%{opacity:.9;transform:translate(-50%,-50%) scale(1.1) rotate(15deg)}100%{opacity:0;transform:translate(-50%,-50%) scale(1.5) rotate(30deg)}}
@keyframes death-ring{0%{opacity:.9;transform:translate(-50%,-50%) scale(0);border-width:4px}100%{opacity:0;transform:translate(-50%,-50%) scale(2.5);border-width:1px}}
@keyframes slide-down{from{opacity:0;transform:translateY(-8px)}to{opacity:1;transform:translateY(0)}}
@keyframes charge-dash{0%,100%{opacity:1}50%{opacity:.4}}
@keyframes obj-glow{0%,100%{box-shadow:0 0 6px var(--gold-d)}50%{box-shadow:0 0 18px var(--gold),0 0 6px var(--gold-d)}}
@keyframes token-sel{0%,100%{box-shadow:0 0 8px currentColor}50%{box-shadow:0 0 18px currentColor,0 0 32px currentColor}}
@keyframes strat-use{0%{transform:scale(1)}50%{transform:scale(0.94)}100%{transform:scale(1)}}
@keyframes cp-tick{0%{transform:scale(1)}50%{transform:scale(1.3)}100%{transform:scale(1)}}
`;

/* ═══ RULES ENGINE ════════════════════════════════════════════ */
const BOARD_IN = 48; // board = 48 inches wide
// Board x coords are % of width, y coords are % of height.
// We need aspect-ratio-aware distance. We pass boardW/boardH in pixels.
const PCT_PER_IN = 100 / BOARD_IN; // % per inch along width axis

// distIn: compute distance in inches between two units given board pixel dimensions
// units store x/y as % of board width/height respectively
function distIn(a, b, boardW=800, boardH=600) {
  const dx = (a.x - b.x) / 100 * boardW; // pixels
  const dy = (a.y - b.y) / 100 * boardH; // pixels
  const pxPerInch = boardW / BOARD_IN;    // pixels per inch (width axis)
  return Math.sqrt(dx*dx + dy*dy) / pxPerInch;
}

const ENGAGE_IN = 2.0;   // engagement range in inches

const rollD6 = (n=1) => Array.from({length:n}, ()=>Math.floor(Math.random()*6)+1);
const roll2D6 = () => rollD6(1)[0] + rollD6(1)[0];

const woundTarget = (s,t) => s >= t*2 ? 2 : s > t ? 3 : s === t ? 4 : s*2 <= t ? 6 : 5;

function ptInPoly(px, py, pts) {
  let inside = false;
  for(let i=0,j=pts.length-1; i<pts.length; j=i++){
    const xi=pts[i][0],yi=pts[i][1],xj=pts[j][0],yj=pts[j][1];
    if(((yi>py)!==(yj>py))&&(px<(xj-xi)*(py-yi)/(yj-yi)+xi)) inside=!inside;
  }
  return inside;
}

function lineSegmentIntersect(ax,ay,bx,by,cx,cy,dx,dy){
  const d1x=bx-ax,d1y=by-ay,d2x=dx-cx,d2y=dy-cy;
  const cross=d1x*d2y-d1y*d2x;
  if(Math.abs(cross)<1e-10) return false;
  const t=((cx-ax)*d2y-(cy-ay)*d2x)/cross;
  const u=((cx-ax)*d1y-(cy-ay)*d1x)/cross;
  return t>0.01&&t<0.99&&u>0.01&&u<0.99;
}

function polyEdges(pts){
  const edges=[];
  for(let i=0;i<pts.length;i++) edges.push([pts[i],pts[(i+1)%pts.length]]);
  return edges;
}

function hasLOS(a, b, terrain) {
  for(const t of terrain){
    if(t.blocker && t.poly){
      const edges = polyEdges(t.poly);
      for(const [[x1,y1],[x2,y2]] of edges){
        if(lineSegmentIntersect(a.x,a.y,b.x,b.y,x1,y1,x2,y2)) return false;
      }
    }
  }
  return true;
}

function getCover(unit, terrain){
  let best = 0;
  for(const t of terrain){
    if(!t.cover) continue;
    const inside = t.poly ? ptInPoly(unit.x,unit.y,t.poly) : false;
    if(inside) best = Math.max(best, t.cover);
  }
  return best;
}

function resolveCombat(attacker, defender, terrain, isShooting){
  const numAttacks = attacker.count
    ? attacker.a * Math.min(attacker.count, attacker.currentCount||attacker.count)
    : attacker.a;

  const wsbs = isShooting ? attacker.bs : attacker.ws;
  const hitRolls = rollD6(numAttacks).map(r=>({v:r, hit:r>=wsbs, crit:r===6}));
  const hits = hitRolls.filter(h=>h.hit).length;

  if(!hits) return {dmg:0,hitRolls,woundRolls:[],saveRolls:[],failedSaves:0};

  const wt = woundTarget(attacker.s, defender.t);
  const woundRolls = rollD6(hits).map(r=>({v:r, wound:r>=wt, dev:r===6}));
  const wounds = woundRolls.filter(w=>w.wound).length;
  const devWounds = woundRolls.filter(w=>w.dev).length;

  if(!wounds) return {dmg:0,hitRolls,woundRolls,saveRolls:[],failedSaves:0};

  const ap = Math.abs(attacker.ap||0);
  const cover = isShooting ? getCover(defender,terrain) : 0;
  const effSv = Math.min(6, defender.sv + ap - cover);
  const activeSv = defender.inv ? Math.min(effSv, defender.inv) : effSv;
  const normalW = wounds - devWounds;
  const saveRolls = rollD6(Math.max(0,normalW)).map(r=>({v:r, saved:r>=activeSv}));
  const failedNormal = saveRolls.filter(s=>!s.saved).length;
  const failedSaves = failedNormal + devWounds;

  const dmgPer = attacker.d;
  const dmg = failedSaves * dmgPer;

  return {dmg,hitRolls,woundRolls,saveRolls,failedSaves,hits,wounds,devWounds,wt,wsbs,ap,cover,activeSv,dmgPer,numAttacks};
}

/* ═══ TERRAIN — Organic polygon shapes ═══════════════════════ */
// All coordinates are % of board width/height
// poly = array of [x,y] points

function buildTerrain(mapId){
  const maps = {
    sanctum: [
      // L-shaped ruin top-left
      {id:"r1",label:"RUINS",type:"ruin",cover:1,blocker:true,
       poly:[[6,4],[22,4],[22,10],[14,10],[14,18],[6,18]],
       fill:"#3a3a48",stroke:"#5a5a6a"},
      // Angled wall top-center
      {id:"w1",label:"WALL",type:"wall",cover:0,blocker:true,
       poly:[[38,3],[56,3],[56,7],[54,7],[54,5],[40,5],[40,7],[38,7]],
       fill:"#2a2a38",stroke:"#4a4a58"},
      // Irregular ruin top-right
      {id:"r2",label:"RUINS",type:"ruin",cover:1,blocker:true,
       poly:[[74,5],[86,5],[88,12],[82,16],[74,14]],
       fill:"#3a3a48",stroke:"#5a5a6a"},
      // Crescent bunker left-mid
      {id:"b1",label:"BUNKER",type:"bunker",cover:2,blocker:false,
       poly:[[3,40],[16,38],[20,46],[16,54],[3,52]],
       fill:"#1e1e38",stroke:"#3a3a5a"},
      // Central ruin complex
      {id:"r3",label:"RUINS",type:"ruin",cover:1,blocker:true,
       poly:[[34,36],[48,34],[56,40],[54,52],[42,54],[32,48]],
       fill:"#3a3a48",stroke:"#5a5a6a"},
      // Right bunker (diamond)
      {id:"b2",label:"BUNKER",type:"bunker",cover:2,blocker:false,
       poly:[[80,40],[90,46],[80,54],[70,48]],
       fill:"#1e1e38",stroke:"#3a3a5a"},
      // Crater bottom-left (circle approx)
      {id:"c1",label:"CRATER",type:"crater",cover:1,blocker:false,
       poly:buildCircle(16,74,8,10),fill:"#2e221a",stroke:"#4a3828"},
      // Crater bottom-right
      {id:"c2",label:"CRATER",type:"crater",cover:1,blocker:false,
       poly:buildCircle(80,74,7,10),fill:"#2e221a",stroke:"#4a3828"},
      // Angled wall bottom
      {id:"w2",label:"WALL",type:"wall",cover:0,blocker:true,
       poly:[[40,84],[60,84],[60,87],[58,87],[58,86],[42,86],[42,87],[40,87]],
       fill:"#2a2a38",stroke:"#4a4a58"},
      // Objectives
      {id:"obj1",label:"OBJ",type:"objective",cover:0,blocker:false,poly:buildCircle(50,48,3,8),fill:"#5a4a00",stroke:"#b8860b"},
      {id:"obj2",label:"OBJ",type:"objective",cover:0,blocker:false,poly:buildCircle(12,47,3,8),fill:"#5a4a00",stroke:"#b8860b"},
      {id:"obj3",label:"OBJ",type:"objective",cover:0,blocker:false,poly:buildCircle(88,47,3,8),fill:"#5a4a00",stroke:"#b8860b"},
      {id:"obj4",label:"OBJ",type:"objective",cover:0,blocker:false,poly:buildCircle(50,8,3,8),fill:"#5a4a00",stroke:"#b8860b"},
      {id:"obj5",label:"OBJ",type:"objective",cover:0,blocker:false,poly:buildCircle(50,90,3,8),fill:"#5a4a00",stroke:"#b8860b"},
    ],
    necropolis: [
      // Obelisk corridors - thin walls forming a maze-like centre
      {id:"w1",label:"WALL",type:"wall",cover:0,blocker:true,
       poly:[[20,10],[24,10],[24,28],[20,28]],fill:"#101c18",stroke:"#1a4030"},
      {id:"w2",label:"WALL",type:"wall",cover:0,blocker:true,
       poly:[[76,10],[80,10],[80,28],[76,28]],fill:"#101c18",stroke:"#1a4030"},
      // Stasis pools (water - irregular)
      {id:"wp1",label:"STASIS",type:"water",cover:0,blocker:false,
       poly:[[26,36],[36,32],[44,36],[44,46],[36,50],[26,46]],fill:"#081a28",stroke:"#0a3040"},
      {id:"wp2",label:"STASIS",type:"water",cover:0,blocker:false,
       poly:[[56,32],[66,36],[66,46],[58,50],[52,46],[52,36]],fill:"#081a28",stroke:"#0a3040"},
      // Tomb complexes (ruin, L-shape)
      {id:"r1",label:"TOMB",type:"ruin",cover:1,blocker:true,
       poly:[[3,24],[18,24],[18,32],[10,32],[10,44],[3,44]],fill:"#162414",stroke:"#1a4020"},
      {id:"r2",label:"TOMB",type:"ruin",cover:1,blocker:true,
       poly:[[82,24],[97,24],[97,44],[90,44],[90,32],[82,32]],fill:"#162414",stroke:"#1a4020"},
      // Central monolith (heavy cover)
      {id:"ml",label:"MONOLITH",type:"bunker",cover:2,blocker:true,
       poly:[[44,40],[50,36],[56,40],[56,52],[50,56],[44,52]],fill:"#0a1c14",stroke:"#1a4028"},
      // Bottom tombs
      {id:"r3",label:"TOMB",type:"ruin",cover:1,blocker:true,
       poly:[[3,62],[18,62],[18,72],[10,72],[10,80],[3,80]],fill:"#162414",stroke:"#1a4020"},
      {id:"r4",label:"TOMB",type:"ruin",cover:1,blocker:true,
       poly:[[82,62],[97,62],[97,80],[90,80],[90,72],[82,72]],fill:"#162414",stroke:"#1a4020"},
      // Objectives
      {id:"obj1",label:"OBJ",type:"objective",cover:0,blocker:false,poly:buildCircle(50,46,3,8),fill:"#2a4a10",stroke:"#4aff80"},
      {id:"obj2",label:"OBJ",type:"objective",cover:0,blocker:false,poly:buildCircle(8,47,3,8),fill:"#2a4a10",stroke:"#4aff80"},
      {id:"obj3",label:"OBJ",type:"objective",cover:0,blocker:false,poly:buildCircle(92,47,3,8),fill:"#2a4a10",stroke:"#4aff80"},
      {id:"obj4",label:"OBJ",type:"objective",cover:0,blocker:false,poly:buildCircle(50,6,3,8),fill:"#2a4a10",stroke:"#4aff80"},
      {id:"obj5",label:"OBJ",type:"objective",cover:0,blocker:false,poly:buildCircle(50,92,3,8),fill:"#2a4a10",stroke:"#4aff80"},
    ],
    warzone: [
      // Forest clusters (amoeba shapes)
      {id:"f1",label:"FOREST",type:"forest",cover:1,blocker:false,
       poly:[[2,2],[14,2],[18,8],[16,18],[8,22],[2,16]],fill:"#142010",stroke:"#1e3a18"},
      {id:"f2",label:"FOREST",type:"forest",cover:1,blocker:false,
       poly:[[82,2],[98,2],[98,14],[90,20],[82,16]],fill:"#142010",stroke:"#1e3a18"},
      // River — diagonal strip (water)
      {id:"rv",label:"RIVER",type:"water",cover:0,blocker:false,
       poly:[[0,52],[18,44],[32,48],[38,56],[28,62],[14,58]],fill:"#0c1c28",stroke:"#142030"},
      // Hills (irregular triangles)
      {id:"h1",label:"HILL",type:"hill",cover:1,blocker:false,
       poly:[[22,22],[38,20],[40,34],[28,38]],fill:"#3a2e14",stroke:"#5a4a22"},
      {id:"h2",label:"HILL",type:"hill",cover:1,blocker:false,
       poly:[[60,20],[76,22],[74,36],[60,36]],fill:"#3a2e14",stroke:"#5a4a22"},
      // More forest
      {id:"f3",label:"FOREST",type:"forest",cover:1,blocker:false,
       poly:[[44,30],[58,28],[60,42],[50,46],[42,40]],fill:"#142010",stroke:"#1e3a18"},
      {id:"f4",label:"FOREST",type:"forest",cover:1,blocker:false,
       poly:[[2,80],[16,76],[20,86],[10,96],[2,96]],fill:"#142010",stroke:"#1e3a18"},
      {id:"f5",label:"FOREST",type:"forest",cover:1,blocker:false,
       poly:[[80,78],[98,82],[98,96],[84,96],[78,88]],fill:"#142010",stroke:"#1e3a18"},
      // Craters
      {id:"cr1",label:"CRATER",type:"crater",cover:1,blocker:false,
       poly:buildCircle(70,58,7,12),fill:"#28200e",stroke:"#3a3018"},
      {id:"cr2",label:"CRATER",type:"crater",cover:1,blocker:false,
       poly:buildCircle(32,70,6,10),fill:"#28200e",stroke:"#3a3018"},
      // Objectives
      {id:"obj1",label:"OBJ",type:"objective",cover:0,blocker:false,poly:buildCircle(50,47,3,8),fill:"#4a3800",stroke:"#c0a020"},
      {id:"obj2",label:"OBJ",type:"objective",cover:0,blocker:false,poly:buildCircle(10,47,3,8),fill:"#4a3800",stroke:"#c0a020"},
      {id:"obj3",label:"OBJ",type:"objective",cover:0,blocker:false,poly:buildCircle(90,47,3,8),fill:"#4a3800",stroke:"#c0a020"},
      {id:"obj4",label:"OBJ",type:"objective",cover:0,blocker:false,poly:buildCircle(50,5,3,8),fill:"#4a3800",stroke:"#c0a020"},
      {id:"obj5",label:"OBJ",type:"objective",cover:0,blocker:false,poly:buildCircle(50,93,3,8),fill:"#4a3800",stroke:"#c0a020"},
    ],
  };
  return maps[mapId] || maps.sanctum;
}

function buildCircle(cx,cy,r,pts=12){
  return Array.from({length:pts},(_,i)=>{
    const a=(i/pts)*Math.PI*2;
    // Slightly randomize radius for organic feel
    const rr = r * (0.85 + Math.random()*0.3);
    return [cx+Math.cos(a)*rr, cy+Math.sin(a)*rr];
  });
}

/* ═══ FACTION SIGILS (unique SVG per faction) ════════════════ */
const FACTION_SIGILS = {
  space_marines: ({size=28,color="#4a90d9"}) => (
    <svg width={size} height={size} viewBox="0 0 32 32">
      {/* Aquila-style eagle */}
      <ellipse cx="16" cy="12" rx="5" ry="6" fill={color}/>
      <path d="M8,8 Q2,4 4,12 Q6,18 12,16 L16,18 L20,16 Q26,18 28,12 Q30,4 24,8 L20,10 L16,8 L12,10 Z" fill={color} opacity=".85"/>
      <polygon points="16,14 14,26 16,24 18,26" fill={color}/>
      <rect x="14" y="22" width="4" height="7" rx="1" fill={color} opacity=".8"/>
    </svg>
  ),
  orks: ({size=28,color="#3a7a1a"}) => (
    <svg width={size} height={size} viewBox="0 0 32 32">
      {/* Ork skull with tusks */}
      <ellipse cx="16" cy="13" rx="9" ry="10" fill={color}/>
      <rect x="10" y="20" width="5" height="9" rx="2" fill={color}/>
      <rect x="17" y="20" width="5" height="9" rx="2" fill={color}/>
      <ellipse cx="12" cy="11" rx="3" ry="4" fill={color} opacity=".5"/>
      <ellipse cx="20" cy="11" rx="3" ry="4" fill={color} opacity=".5"/>
      <rect x="12" y="8" width="2.5" height="4" rx="1" fill="#06060a"/>
      <rect x="17.5" y="8" width="2.5" height="4" rx="1" fill="#06060a"/>
      {/* Tusks */}
      <path d="M9,20 Q5,24 7,28" stroke={color} strokeWidth="2.5" fill="none" strokeLinecap="round"/>
      <path d="M23,20 Q27,24 25,28" stroke={color} strokeWidth="2.5" fill="none" strokeLinecap="round"/>
    </svg>
  ),
  necrons: ({size=28,color="#1a7a50"}) => (
    <svg width={size} height={size} viewBox="0 0 32 32">
      {/* Necron death mask */}
      <ellipse cx="16" cy="14" rx="10" ry="11" fill={color} opacity=".9"/>
      <path d="M10,10 L14,14 L10,18" fill="none" stroke="#06060a" strokeWidth="2"/>
      <path d="M22,10 L18,14 L22,18" fill="none" stroke="#06060a" strokeWidth="2"/>
      <rect x="12" y="20" width="8" height="2" fill="#06060a" rx="1"/>
      <line x1="6" y1="8" x2="10" y2="12" stroke={color} strokeWidth="1.5"/>
      <line x1="26" y1="8" x2="22" y2="12" stroke={color} strokeWidth="1.5"/>
      <circle cx="16" cy="14" r="2" fill={color} opacity=".4"/>
      <path d="M16,25 L12,31 L16,29 L20,31 Z" fill={color} opacity=".7"/>
    </svg>
  ),
  chaos: ({size=28,color="#6a0a0a"}) => (
    <svg width={size} height={size} viewBox="0 0 32 32">
      {/* Chaos star / eight-pointed */}
      {Array.from({length:8},(_,i)=>{
        const a=(i/8)*Math.PI*2, a2=a+Math.PI/8;
        const x1=16+Math.cos(a)*13, y1=16+Math.sin(a)*13;
        const x2=16+Math.cos(a2)*5, y2=16+Math.sin(a2)*5;
        return <polygon key={i} points={`16,16 ${x1},${y1} ${x2},${y2}`} fill={color} opacity={i%2===0?1:.7}/>;
      })}
      <circle cx="16" cy="16" r="4" fill={color}/>
      <circle cx="16" cy="16" r="2" fill="#06060a"/>
    </svg>
  ),
  eldar: ({size=28,color="#2a5080"}) => (
    <svg width={size} height={size} viewBox="0 0 32 32">
      {/* Eldar craftworld rune */}
      <ellipse cx="16" cy="16" rx="12" ry="12" fill="none" stroke={color} strokeWidth="1.5"/>
      <path d="M16,4 C22,8 24,24 16,28 C8,24 10,8 16,4 Z" fill={color} opacity=".7"/>
      <path d="M4,16 C8,10 24,8 28,16 C24,22 8,24 4,16 Z" fill={color} opacity=".7"/>
      <circle cx="16" cy="16" r="3" fill={color}/>
    </svg>
  ),
  tyranids: ({size=28,color="#5a1a6a"}) => (
    <svg width={size} height={size} viewBox="0 0 32 32">
      {/* Hive fleet bio-symbol */}
      <circle cx="16" cy="16" r="7" fill={color}/>
      {[0,72,144,216,288].map((deg,i)=>{
        const r=deg*Math.PI/180;
        const x=16+Math.cos(r)*13, y=16+Math.sin(r)*13;
        return <line key={i} x1="16" y1="16" x2={x} y2={y} stroke={color} strokeWidth="2.5" strokeLinecap="round"/>;
      })}
      {[0,72,144,216,288].map((deg,i)=>{
        const r=deg*Math.PI/180;
        const x=16+Math.cos(r)*13, y=16+Math.sin(r)*13;
        return <circle key={i} cx={x} cy={y} r="3" fill={color}/>;
      })}
      <circle cx="16" cy="16" r="3" fill="#06060a"/>
    </svg>
  ),
};

/* ═══ ARMIES ═════════════════════════════════════════════════ */
const ARMIES = {
  space_marines:{
    id:"space_marines",name:"Ultramarines",faction:"Adeptus Astartes",color:"#4a90d9",
    lore:"Sons of Guilliman. Clad in cerulean power armour, they are humanity's finest.",
    units:[
      {id:"cap",  name:"Chapter Master",pts:120,move:6,t:4,sv:2,inv:4,w:6,a:6,ws:2,bs:2,s:5,ap:3,d:3,ld:6,oc:1,count:1,range:24,shape:"Character"},
      {id:"lib",  name:"Librarian",     pts:90, move:6,t:4,sv:3,inv:4,w:5,a:4,ws:3,bs:3,s:5,ap:1,d:2,ld:6,oc:1,count:1,range:18,shape:"Character"},
      {id:"tac1", name:"Tactical Squad",pts:90, move:6,t:4,sv:3,inv:0,w:2,a:2,ws:3,bs:3,s:4,ap:0,d:1,ld:6,oc:2,count:5,range:24,shape:"Infantry"},
      {id:"tac2", name:"Tac Squad II",  pts:90, move:6,t:4,sv:3,inv:0,w:2,a:2,ws:3,bs:3,s:4,ap:0,d:1,ld:6,oc:2,count:5,range:24,shape:"Infantry"},
      {id:"term", name:"Terminators",   pts:200,move:5,t:5,sv:2,inv:4,w:3,a:3,ws:3,bs:3,s:8,ap:2,d:2,ld:6,oc:1,count:5,range:24,shape:"Elite"},
      {id:"aslt", name:"Assault Marines",pts:95,move:6,t:4,sv:3,inv:0,w:2,a:3,ws:3,bs:3,s:4,ap:1,d:1,ld:6,oc:2,count:5,range:0,shape:"Infantry"},
      {id:"dread",name:"Dreadnought",   pts:150,move:6,t:9,sv:3,inv:0,w:8,a:4,ws:3,bs:4,s:12,ap:2,d:3,ld:6,oc:3,count:1,range:24,shape:"Walker"},
      {id:"pred", name:"Predator Tank", pts:175,move:10,t:10,sv:3,inv:0,w:11,a:3,ws:5,bs:3,s:12,ap:2,d:3,ld:6,oc:3,count:1,range:36,shape:"Vehicle"},
    ],
    stratagems:[
      {id:"sm_s1",name:"Orbital Bombardment",cost:2,desc:"Before the game, mark one terrain piece. Units in that area suffer -1 to saves this battle.",effect:"debuff"},
      {id:"sm_s2",name:"Honour the Chapter",cost:1,desc:"One infantry unit may re-roll all failed hit rolls this phase.",effect:"reroll"},
      {id:"sm_s3",name:"Armour of Contempt",cost:1,desc:"One unit gains a 5+ invulnerable save until end of phase.",effect:"buff"},
      {id:"sm_s4",name:"Rapid Deployment",cost:1,desc:"One infantry unit may immediately move 3\" as a free action.",effect:"move"},
    ]
  },
  orks:{
    id:"orks",name:"Ork Waaagh!",faction:"Da Green Tide",color:"#3a7a1a",
    lore:"Greenskins beyond count. The WAAAGH grows stronger with every skull taken.",
    units:[
      {id:"wb",  name:"Warboss",      pts:100,move:5,t:5,sv:4,inv:5,w:7,a:5,ws:2,bs:5,s:7,ap:2,d:2,ld:7,oc:1,count:1,range:0,shape:"Character"},
      {id:"bk1", name:"Boyz Mob I",   pts:80, move:6,t:4,sv:5,inv:0,w:2,a:2,ws:3,bs:5,s:4,ap:0,d:1,ld:7,oc:2,count:10,range:12,shape:"Horde"},
      {id:"bk2", name:"Boyz Mob II",  pts:80, move:6,t:4,sv:5,inv:0,w:2,a:2,ws:3,bs:5,s:4,ap:0,d:1,ld:7,oc:2,count:10,range:12,shape:"Horde"},
      {id:"bk3", name:"Boyz Mob III", pts:80, move:6,t:4,sv:5,inv:0,w:2,a:2,ws:3,bs:5,s:4,ap:0,d:1,ld:7,oc:2,count:10,range:12,shape:"Horde"},
      {id:"nb",  name:"Nobz",         pts:120,move:6,t:5,sv:4,inv:0,w:3,a:3,ws:3,bs:5,s:6,ap:1,d:2,ld:7,oc:1,count:5,range:12,shape:"Elite"},
      {id:"mg",  name:"Meganobz",     pts:150,move:4,t:6,sv:2,inv:5,w:4,a:4,ws:3,bs:5,s:8,ap:2,d:2,ld:7,oc:1,count:3,range:0,shape:"Elite"},
      {id:"dd",  name:"Deff Dread",   pts:130,move:6,t:9,sv:4,inv:0,w:8,a:4,ws:3,bs:5,s:10,ap:2,d:3,ld:7,oc:3,count:1,range:12,shape:"Walker"},
      {id:"bb",  name:"Battlewagon",  pts:165,move:10,t:10,sv:4,inv:0,w:12,a:3,ws:4,bs:5,s:9,ap:1,d:3,ld:7,oc:3,count:1,range:24,shape:"Vehicle"},
    ],
    stratagems:[
      {id:"ok_s1",name:"WAAAGH!",cost:2,desc:"All Ork units can move and advance without penalty this Movement phase. Terrifying war-cry.",effect:"move"},
      {id:"ok_s2",name:"More Dakka",cost:1,desc:"One unit fires twice this Shooting phase. Utterly wasteful. Utterly effective.",effect:"reroll"},
      {id:"ok_s3",name:"Ere We Go",cost:1,desc:"One unit rerolls its charge distance dice. Good for getting stuck in.",effect:"reroll"},
      {id:"ok_s4",name:"Ramming Speed",cost:1,desc:"One vehicle unit adds +D6\" to its move and ignores terrain penalties this phase.",effect:"move"},
    ]
  },
  necrons:{
    id:"necrons",name:"Necron Dynasty",faction:"The Undying",color:"#1a7a50",
    lore:"Sleeping gods of living metal, risen to reclaim their empire from lesser beings.",
    units:[
      {id:"ov",  name:"Overlord",     pts:95, move:6,t:5,sv:3,inv:4,w:5,a:5,ws:2,bs:2,s:6,ap:3,d:2,ld:6,oc:1,count:1,range:24,shape:"Character"},
      {id:"cr",  name:"Cryptek",      pts:70, move:6,t:5,sv:4,inv:4,w:4,a:3,ws:3,bs:3,s:5,ap:2,d:1,ld:6,oc:1,count:1,range:24,shape:"Character"},
      {id:"w1",  name:"Warriors I",   pts:75, move:5,t:4,sv:4,inv:0,w:1,a:1,ws:4,bs:4,s:4,ap:1,d:1,ld:8,oc:2,count:10,range:24,shape:"Infantry"},
      {id:"w2",  name:"Warriors II",  pts:75, move:5,t:4,sv:4,inv:0,w:1,a:1,ws:4,bs:4,s:4,ap:1,d:1,ld:8,oc:2,count:10,range:24,shape:"Infantry"},
      {id:"im",  name:"Immortals",    pts:110,move:5,t:5,sv:3,inv:0,w:2,a:2,ws:3,bs:3,s:5,ap:2,d:1,ld:8,oc:1,count:5,range:24,shape:"Elite"},
      {id:"lh",  name:"Lychguard",    pts:140,move:5,t:5,sv:3,inv:4,w:3,a:3,ws:2,bs:4,s:7,ap:2,d:2,ld:8,oc:1,count:5,range:0,shape:"Elite"},
      {id:"wr",  name:"Wraiths",      pts:160,move:9,t:5,sv:4,inv:4,w:4,a:4,ws:2,bs:4,s:6,ap:2,d:2,ld:8,oc:2,count:3,range:0,shape:"Fast"},
      {id:"da",  name:"Doomsday Ark", pts:195,move:9,t:10,sv:3,inv:0,w:12,a:3,ws:4,bs:3,s:14,ap:5,d:4,ld:8,oc:3,count:1,range:48,shape:"Vehicle"},
    ],
    stratagems:[
      {id:"nc_s1",name:"Reanimation Protocols",cost:2,desc:"One unit with destroyed models restores up to 3 models at half wounds. The dead walk again.",effect:"heal"},
      {id:"nc_s2",name:"Dimensional Translocation",cost:2,desc:"Remove one infantry unit from the board and redeploy it anywhere >9\" from enemies.",effect:"move"},
      {id:"nc_s3",name:"Gauss Flux Arc",cost:1,desc:"One unit may reroll all wound rolls of 1 this phase.",effect:"reroll"},
      {id:"nc_s4",name:"The Undying Legion",cost:1,desc:"One unit ignores the effects of Battle-shock until end of round.",effect:"buff"},
    ]
  },
  chaos:{
    id:"chaos",name:"Chaos Space Marines",faction:"Heretic Astartes",color:"#8a1010",
    lore:"Traitors who sold their souls to the Ruinous Powers. Daemonic gifts warp them into killing machines.",
    units:[
      {id:"lord",name:"Chaos Lord",   pts:105,move:6,t:4,sv:3,inv:4,w:5,a:5,ws:2,bs:2,s:5,ap:2,d:2,ld:6,oc:1,count:1,range:12,shape:"Character"},
      {id:"sor", name:"Sorcerer",     pts:85, move:6,t:4,sv:3,inv:5,w:4,a:4,ws:3,bs:3,s:5,ap:1,d:2,ld:6,oc:1,count:1,range:18,shape:"Character"},
      {id:"csm1",name:"Chaos Marines",pts:85,move:6,t:4,sv:3,inv:0,w:2,a:2,ws:3,bs:3,s:4,ap:0,d:1,ld:6,oc:2,count:5,range:24,shape:"Infantry"},
      {id:"csm2",name:"Chaos Marines II",pts:85,move:6,t:4,sv:3,inv:0,w:2,a:2,ws:3,bs:3,s:4,ap:0,d:1,ld:6,oc:2,count:5,range:24,shape:"Infantry"},
      {id:"bz",  name:"Berzerkers",   pts:115,move:6,t:4,sv:3,inv:5,w:2,a:4,ws:2,bs:4,s:5,ap:1,d:1,ld:6,oc:2,count:8,range:0,shape:"Elite"},
      {id:"ob",  name:"Obliterators", pts:160,move:6,t:8,sv:3,inv:5,w:6,a:3,ws:3,bs:3,s:8,ap:2,d:3,ld:6,oc:2,count:2,range:24,shape:"Monster"},
      {id:"hb",  name:"Helbrute",     pts:140,move:6,t:9,sv:3,inv:0,w:8,a:4,ws:3,bs:4,s:12,ap:2,d:3,ld:6,oc:3,count:1,range:24,shape:"Walker"},
      {id:"fx",  name:"Forgefiend",   pts:175,move:8,t:10,sv:3,inv:0,w:11,a:3,ws:4,bs:3,s:8,ap:1,d:3,ld:6,oc:3,count:1,range:36,shape:"Monster"},
    ],
    stratagems:[
      {id:"cs_s1",name:"Dark Blessing",cost:2,desc:"One unit gains +1 to hit, wound, and save rolls until end of phase. The gods are pleased.",effect:"buff"},
      {id:"cs_s2",name:"Warp Surge",cost:1,desc:"One psyker unit deals D3 mortal wounds to the nearest enemy unit within 12\".",effect:"damage"},
      {id:"cs_s3",name:"Veterans of the Long War",cost:1,desc:"One unit rerolls failed wound rolls this phase. Hatred of the False Emperor.",effect:"reroll"},
      {id:"cs_s4",name:"Daemonic Possession",cost:1,desc:"One vehicle unit regains D3 lost wounds.",effect:"heal"},
    ]
  },
  eldar:{
    id:"eldar",name:"Craftworld Eldar",faction:"Aeldari",color:"#2a6090",
    lore:"Ancient beings of wisdom and grace, fighting to delay the extinction of their dying race.",
    units:[
      {id:"aut",name:"Autarch",       pts:90, move:7,t:3,sv:3,inv:4,w:5,a:5,ws:2,bs:2,s:3,ap:2,d:2,ld:6,oc:1,count:1,range:24,shape:"Character"},
      {id:"far",name:"Farseer",       pts:85, move:7,t:3,sv:6,inv:4,w:4,a:3,ws:3,bs:3,s:3,ap:1,d:2,ld:6,oc:1,count:1,range:24,shape:"Character"},
      {id:"gd1",name:"Guardians I",   pts:80, move:7,t:3,sv:4,inv:0,w:1,a:1,ws:4,bs:3,s:4,ap:0,d:1,ld:6,oc:2,count:10,range:18,shape:"Infantry"},
      {id:"gd2",name:"Guardians II",  pts:80, move:7,t:3,sv:4,inv:0,w:1,a:1,ws:4,bs:3,s:4,ap:0,d:1,ld:6,oc:2,count:10,range:18,shape:"Infantry"},
      {id:"av",  name:"Dire Avengers",pts:110,move:7,t:3,sv:3,inv:0,w:1,a:2,ws:3,bs:2,s:4,ap:2,d:1,ld:6,oc:2,count:5,range:18,shape:"Elite"},
      {id:"ws",  name:"Warp Spiders", pts:120,move:9,t:3,sv:4,inv:0,w:1,a:2,ws:3,bs:3,s:7,ap:1,d:1,ld:6,oc:1,count:5,range:12,shape:"Fast"},
      {id:"wl",  name:"Wraithlord",   pts:195,move:8,t:9,sv:2,inv:0,w:10,a:4,ws:2,bs:3,s:10,ap:3,d:4,ld:6,oc:4,count:1,range:36,shape:"Monster"},
      {id:"wk",  name:"War Walker",   pts:90, move:9,t:6,sv:3,inv:0,w:6,a:3,ws:4,bs:3,s:8,ap:2,d:2,ld:6,oc:2,count:1,range:30,shape:"Walker"},
    ],
    stratagems:[
      {id:"el_s1",name:"Doom",cost:2,desc:"Target an enemy unit. Until end of turn, all attacks against that unit reroll wound rolls of 1.",effect:"debuff"},
      {id:"el_s2",name:"Guide",cost:1,desc:"One unit may reroll all hit rolls this Shooting phase. The Farseer guides their aim.",effect:"reroll"},
      {id:"el_s3",name:"Ghostwalk",cost:1,desc:"One infantry unit ignores terrain movement penalties and cover bonuses until end of phase.",effect:"move"},
      {id:"el_s4",name:"Forewarned",cost:2,desc:"Interrupt after an enemy charges. One unit fires overwatch at BS2+ instead of BS6+.",effect:"reaction"},
    ]
  },
  tyranids:{
    id:"tyranids",name:"Hive Fleet Leviathan",faction:"Tyranids",color:"#6a1a7a",
    lore:"A devouring swarm from beyond the stars, consuming all biomass for the Hive Mind.",
    units:[
      {id:"hive",name:"Hive Tyrant", pts:160,move:8,t:9,sv:2,inv:4,w:10,a:5,ws:2,bs:3,s:8,ap:3,d:3,ld:7,oc:3,count:1,range:24,shape:"Monster"},
      {id:"war", name:"Warriors",    pts:105,move:7,t:5,sv:4,inv:0,w:3,a:3,ws:3,bs:4,s:5,ap:1,d:2,ld:7,oc:1,count:6,range:18,shape:"Elite"},
      {id:"t1",  name:"Termagants I",pts:60, move:6,t:3,sv:5,inv:0,w:1,a:1,ws:4,bs:4,s:3,ap:0,d:1,ld:8,oc:1,count:10,range:18,shape:"Horde"},
      {id:"t2",  name:"Termagants II",pts:60,move:6,t:3,sv:5,inv:0,w:1,a:1,ws:4,bs:4,s:3,ap:0,d:1,ld:8,oc:1,count:10,range:18,shape:"Horde"},
      {id:"hg1", name:"Hormagaunts I",pts:50,move:8,t:3,sv:5,inv:0,w:1,a:2,ws:3,bs:5,s:3,ap:0,d:1,ld:8,oc:1,count:10,range:0,shape:"Horde"},
      {id:"hg2", name:"Hormagaunts II",pts:50,move:8,t:3,sv:5,inv:0,w:1,a:2,ws:3,bs:5,s:3,ap:0,d:1,ld:8,oc:1,count:10,range:0,shape:"Horde"},
      {id:"gs",  name:"Genestealers", pts:130,move:8,t:4,sv:5,inv:5,w:2,a:4,ws:2,bs:5,s:5,ap:2,d:2,ld:7,oc:1,count:8,range:0,shape:"Fast"},
      {id:"car", name:"Carnifex",     pts:135,move:7,t:9,sv:3,inv:0,w:9,a:5,ws:3,bs:4,s:9,ap:2,d:3,ld:7,oc:3,count:1,range:12,shape:"Monster"},
    ],
    stratagems:[
      {id:"ty_s1",name:"Synaptic Imperative",cost:2,desc:"All units within 12\" of a synapse creature gain +1 attack until end of Fight phase.",effect:"buff"},
      {id:"ty_s2",name:"Digestion Pool",cost:1,desc:"One destroyed unit's models are partially recovered — restore 1 wound per 2 models lost.",effect:"heal"},
      {id:"ty_s3",name:"Biovore Barrage",cost:2,desc:"Target a point on the board. All units within 3\" suffer D3 mortal wounds (no saves).",effect:"damage"},
      {id:"ty_s4",name:"Hypnotic Gaze",cost:1,desc:"One unit freezes — target enemy unit cannot move or advance until start of their next turn.",effect:"debuff"},
    ]
  },
};

const PRESET_MAPS = [
  {id:"sanctum",  name:"Sanctum Imperialis", bg:"linear-gradient(155deg,#08080e 0%,#100e18 50%,#080810 100%)"},
  {id:"necropolis",name:"Necron Necropolis",  bg:"linear-gradient(155deg,#04080a 0%,#060e0c 50%,#040808 100%)"},
  {id:"warzone",  name:"Death World Warzone", bg:"linear-gradient(155deg,#0a0800 0%,#120e00 50%,#0e0a04 100%)"},
];

/* ═══ UNIT TOKEN SHAPES ══════════════════════════════════════ */
const SHAPE_SIZES = {Character:34,Infantry:29,Horde:36,Elite:32,Fast:30,Monster:42,Walker:38,Vehicle:44};

const UNIT_PATH = {
  Character:  "M16,2 L20,11 L30,11 L22,17 L25,27 L16,21 L7,27 L10,17 L2,11 L12,11 Z",
  Infantry:   "M16,3 L19,10 L19,22 L22,28 L10,28 L13,22 L13,10 Z",
  Elite:      "M16,2 L22,8 L22,22 L26,28 L6,28 L10,22 L10,8 Z",
  Horde:      "M8,4 L12,4 L12,16 L14,20 L10,20 L10,16 L8,16 Z M16,2 L20,2 L20,18 L22,22 L14,22 L14,18 L16,18 Z M24,4 L28,4 L28,16 L26,16 L26,20 L22,20 L24,16 Z",
  Fast:       "M16,2 L28,14 L22,14 L22,28 L10,28 L10,14 L4,14 Z",
  Monster:    "M16,2 L24,6 L26,16 L22,24 L10,24 L6,16 L8,6 Z",
  Walker:     "M12,2 L20,2 L20,10 L26,10 L26,20 L20,24 L20,28 L12,28 L12,24 L6,20 L6,10 L12,10 Z",
  Vehicle:    "M4,10 L10,4 L22,4 L28,10 L28,22 L22,28 L10,28 L4,22 Z",
};

const UnitToken = ({ unit, armyColor, selected, targeted, acted, onClick, dead }) => {
  const sz = SHAPE_SIZES[unit.shape] || 30;
  const hp = unit.currentWounds / unit.maxWounds;
  const hpColor = hp > .55 ? "#2a7a38" : hp > .28 ? "#7a5a00" : "#8a1a10";
  const Sigil = FACTION_SIGILS[unit.armyId];

  return (
    <div onClick={onClick} style={{
      position:"absolute", left:`${unit.x}%`, top:`${unit.y}%`,
      transform:"translate(-50%,-50%)", width:sz, height:sz,
      cursor:dead?"default":"pointer", zIndex:selected||targeted?25:10,
      opacity:dead?0:acted?0.6:1, transition:"opacity 0.3s",
    }}>
      {/* Outer ring */}
      <svg width={sz} height={sz} viewBox="0 0 32 32" style={{position:"absolute",inset:0,overflow:"visible"}}>
        <circle cx="16" cy="16" r="15" fill={`${armyColor}22`}
          stroke={selected?"#fff":targeted?"#c0281a":armyColor}
          strokeWidth={selected?2.5:targeted?2:1.5}
          style={{
            filter:selected?`drop-shadow(0 0 6px ${armyColor})`
                  :targeted?"drop-shadow(0 0 6px #c0281a)":undefined,
            animation:selected?"token-sel 1.5s infinite":undefined,
          }}/>
        {/* Unit shape */}
        <path d={UNIT_PATH[unit.shape]||UNIT_PATH.Infantry} fill={armyColor} opacity="0.85"/>
      </svg>
      {/* Model count */}
      {unit.count > 1 && (
        <div style={{
          position:"absolute",top:-5,right:-5,minWidth:14,height:14,
          background:(unit.currentCount||unit.count)<unit.count/2?"#5a0808":"#0c0c18",
          border:`1px solid ${armyColor}`,borderRadius:7,
          fontFamily:"var(--fmono)",fontSize:8,color:"var(--bone)",
          display:"flex",alignItems:"center",justifyContent:"center",padding:"0 2px",lineHeight:1,
        }}>{unit.currentCount||unit.count}</div>
      )}
      {/* HP bar */}
      <div style={{position:"absolute",bottom:-6,left:"5%",right:"5%",height:2.5,background:"#0a0a12",borderRadius:2}}>
        <div style={{height:"100%",background:hpColor,borderRadius:2,width:`${hp*100}%`,transition:"width 0.5s"}}/>
      </div>
      {/* Battle-shocked indicator */}
      {unit.battleShocked && (
        <div style={{position:"absolute",top:-12,left:"50%",transform:"translateX(-50%)",fontFamily:"var(--fmono)",fontSize:7,color:"#9a60d9",background:"#0a0a12",padding:"1px 4px",border:"1px solid #6a3a9a",letterSpacing:1,whiteSpace:"nowrap"}}>BSK</div>
      )}
    </div>
  );
};

/* ═══ VFX — Portal renders over entire viewport ══════════════ */
// Effects rendered in a fixed full-screen div so overflow:hidden doesn't clip them
const FX_DURATION = { muzzle:400, hit:600, damage:900, crit:1000, miss:700, death:900 };

const VFXPortal = ({ effects }) => (
  <div style={{position:"fixed",inset:0,pointerEvents:"none",zIndex:9999,overflow:"visible"}}>
    {effects.map(fx=>(
      <div key={fx.id} style={{position:"fixed",left:`${fx.px}px`, top:`${fx.py}px`}}>
        {fx.type==="muzzle"&&(
          <div style={{width:28,height:28,borderRadius:"50%",
            background:"radial-gradient(circle,#ffe880 0%,#ff8020 50%,transparent 80%)",
            transform:"translate(-50%,-50%)",animation:"muzzle-flash 0.35s ease-out forwards"}}/>
        )}
        {fx.type==="hit"&&(
          <div style={{width:32,height:32,borderRadius:"50%",
            border:"2px solid #ff5020",
            transform:"translate(-50%,-50%)",animation:"hit-burst 0.5s ease-out forwards"}}/>
        )}
        {fx.type==="damage"&&(
          <div style={{fontFamily:"var(--fdisplay)",fontSize:18,fontWeight:900,
            color:"#ff2020",textShadow:"0 0 10px #ff0000,0 1px 0 #000",
            transform:"translateX(-50%)",animation:"dmg-up 0.85s ease-out forwards",
            whiteSpace:"nowrap"}}>-{fx.val}</div>
        )}
        {fx.type==="crit"&&(
          <div style={{fontFamily:"var(--fdisplay)",fontSize:14,fontWeight:900,
            color:"#ff8000",textShadow:"0 0 14px #ff4000",
            transform:"translateX(-50%)",animation:"dmg-up 1s ease-out forwards",
            whiteSpace:"nowrap"}}>CRIT</div>
        )}
        {fx.type==="miss"&&(
          <div style={{fontFamily:"var(--fmono)",fontSize:11,
            color:"#4a4a6a",transform:"translateX(-50%)",
            animation:"dmg-up 0.6s ease-out forwards",whiteSpace:"nowrap"}}>SAVED</div>
        )}
        {fx.type==="death"&&(
          <div style={{width:48,height:48,borderRadius:"50%",
            border:"3px solid #c0281a",
            transform:"translate(-50%,-50%)",animation:"death-ring 0.9s ease-out forwards"}}/>
        )}
        {fx.type==="heal"&&(
          <div style={{fontFamily:"var(--fdisplay)",fontSize:16,fontWeight:900,
            color:"#20c060",textShadow:"0 0 10px #00ff80",
            transform:"translateX(-50%)",animation:"dmg-up 0.9s ease-out forwards",
            whiteSpace:"nowrap"}}>+{fx.val}W</div>
        )}
      </div>
    ))}
  </div>
);

/* ═══ DICE DISPLAY ═══════════════════════════════════════════ */
const DiceSet = ({rolls, label, target}) => (
  <div style={{marginBottom:10}}>
    <div style={{fontFamily:"var(--fmono)",fontSize:8,color:"var(--gold-d)",letterSpacing:2,marginBottom:5}}>
      {label} {target&&<span style={{color:"var(--bone-d)"}}>({target}+)</span>}
    </div>
    <div style={{display:"flex",gap:5,flexWrap:"wrap"}}>
      {rolls.map((r,i)=>{
        const suc = r.hit??r.wound??r.saved??false;
        const crit = r.crit||r.dev;
        return (
          <div key={i} style={{
            width:28,height:28,borderRadius:4,
            background:crit?"#3a0000":suc?"#0a2a0a":"#1a1a26",
            border:`1.5px solid ${crit?"#c0281a":suc?"#2a6a2a":"#3a3a50"}`,
            display:"flex",alignItems:"center",justifyContent:"center",
            fontFamily:"var(--fdisplay)",fontSize:14,fontWeight:700,
            color:crit?"#ff4040":suc?"#4aff6a":"#3a3a5a",
            boxShadow:crit?"0 0 8px #c0281a55":suc?"0 0 6px #2a6a2a44":"none",
            flexShrink:0,
          }}>{r.v}</div>
        );
      })}
    </div>
  </div>
);

/* ═══ WIN CONDITION TRACKER ══════════════════════════════════ */
const WIN_CONDITIONS = [
  {id:"annihilation", label:"Total Annihilation", desc:"Destroy every enemy unit."},
  {id:"objectives",   label:"Tactical Supremacy", desc:"Hold 3+ objectives at end of Round 5."},
  {id:"assassination",label:"Decapitation Strike", desc:"Destroy the enemy Warlord (Character) unit."},
  {id:"attrition",    label:"War of Attrition", desc:"Destroy 60% of enemy points value."},
];

/* ═══ SAVE / LOAD ════════════════════════════════════════════ */
const LS = {
  save:(k,v)=>{ try{localStorage.setItem("gdk40k_"+k,JSON.stringify(v))}catch(e){} },
  load:(k,d)=>{ try{const v=localStorage.getItem("gdk40k_"+k);return v?JSON.parse(v):d}catch(e){return d} },
};

/* ═══════════════════════════════════════════════════════════
   SCREENS
════════════════════════════════════════════════════════════ */

/* ─── BUTTON ──────────────────────────────────────────────── */
const GBtn = ({children,onClick,disabled,v="gold",sz="md",style:s={}})=>{
  const base={fontFamily:"var(--fdisplay)",cursor:disabled?"not-allowed":"pointer",letterSpacing:2,borderRadius:1,border:"none",transition:"all 0.12s",opacity:disabled?0.4:1,...s};
  const pads = sz==="sm"?"5px 11px":"9px 20px";
  const fss  = sz==="sm"?9:10;
  const vs={
    gold:{background:"linear-gradient(135deg,#3a2a06,#5a4010)",border:"1px solid var(--gold-d)",color:"var(--gold)",padding:pads,fontSize:fss},
    blood:{background:"linear-gradient(135deg,#4a0606,#7a1010)",border:"1px solid #a01818",color:"var(--bone)",padding:pads,fontSize:fss,boxShadow:"0 0 12px #7a101022"},
    ghost:{background:"transparent",border:"1px solid #242430",color:"var(--bone-d)",padding:pads,fontSize:fss},
    green:{background:"linear-gradient(135deg,#082008,#102a10)",border:"1px solid #2a5a2a",color:"#4a8a50",padding:pads,fontSize:fss},
    blue:{background:"linear-gradient(135deg,#060e1e,#0e1a30)",border:"1px solid #1e3a5a",color:"#4a7ab0",padding:pads,fontSize:fss},
  };
  return <button onClick={disabled?undefined:onClick} style={{...base,...vs[v]}}>{children}</button>;
};

/* ─── SPLASH ───────────────────────────────────────────────── */
function Splash({goto}){
  return (
    <div style={{minHeight:"100vh",background:"radial-gradient(ellipse at 50% 42%,#160808 0%,#0c0c18 50%,#050508 100%)",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",position:"relative",overflow:"hidden"}}>
      <div style={{position:"absolute",inset:0,backgroundImage:"url(\"data:image/svg+xml,%3Csvg width='80' height='80' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M0 80L80 0M-20 20L20-20M60 100L100 60' stroke='%23ffffff04' strokeWidth='1'/%3E%3C/svg%3E\")",pointerEvents:"none"}}/>
      <div style={{position:"relative",textAlign:"center",maxWidth:620,padding:"0 24px"}}>
        <div style={{marginBottom:14}}>
          <svg width="64" height="64" viewBox="0 0 64 64" style={{filter:"drop-shadow(0 0 18px #b8860b88)"}}>
            <polygon points="32,4 38,20 54,14 48,30 64,32 48,34 54,50 38,44 32,60 26,44 10,50 16,34 0,32 16,30 10,14 26,20" fill="none" stroke="#b8860b" strokeWidth="1.5"/>
            <polygon points="32,14 36,24 46,20 42,30 54,32 42,34 46,44 36,40 32,50 28,40 18,44 22,34 10,32 22,30 18,20 28,24" fill="#b8860b" opacity=".12"/>
            <circle cx="32" cy="32" r="8" fill="none" stroke="#b8860b" strokeWidth="1.5"/>
            <circle cx="32" cy="32" r="3" fill="#b8860b" opacity=".7"/>
          </svg>
        </div>
        <div style={{fontFamily:"var(--fdisplay)",color:"var(--gold-d)",fontSize:8,letterSpacing:7,marginBottom:10}}>IN THE GRIM DARKNESS OF THE FAR FUTURE</div>
        <h1 style={{fontFamily:"var(--fdisplay)",fontSize:"clamp(34px,7vw,70px)",color:"var(--bone)",margin:"0 0 4px",textShadow:"0 0 40px #b8860b33,0 2px 6px #000",letterSpacing:5,animation:"flicker 10s infinite"}}>WARHAMMER</h1>
        <h2 style={{fontFamily:"var(--fdisplay)",fontSize:"clamp(20px,4vw,44px)",color:"var(--gold)",margin:"0 0 4px",letterSpacing:7}}>40,000</h2>
        <div style={{fontFamily:"var(--fdisplay)",color:"#2e1e06",fontSize:9,letterSpacing:8,marginBottom:44}}>THERE IS ONLY WAR</div>
        <div style={{display:"flex",flexDirection:"column",gap:10,maxWidth:290,margin:"0 auto"}}>
          <GBtn onClick={()=>goto("army-select")} v="blood" s={{padding:"13px 28px",fontSize:11,letterSpacing:4}}>BEGIN CAMPAIGN</GBtn>
          <GBtn onClick={()=>goto("army-builder")} v="gold" s={{padding:"11px 28px",fontSize:10,letterSpacing:3}}>ARMY BUILDER</GBtn>
          <GBtn onClick={()=>goto("map-maker")} v="blue" s={{padding:"11px 28px",fontSize:10,letterSpacing:3}}>MAP MAKER</GBtn>
          <GBtn onClick={()=>goto("tutorial")} v="ghost" s={{padding:"10px 28px",fontSize:10,letterSpacing:3}}>LEARN TO PLAY</GBtn>
        </div>
        <p style={{fontFamily:"var(--fmono)",color:"#14141e",fontSize:8,marginTop:40,letterSpacing:1}}>UNOFFICIAL FAN TOOL · WH40K © GAMES WORKSHOP</p>
      </div>
    </div>
  );
}

/* ─── ARMY SELECT ──────────────────────────────────────────── */
function ArmySelect({goto,customArmies=[],onSelect}){
  const [sel,setSel]=useState(null);
  const all=[...Object.values(ARMIES),...customArmies];
  const S = FACTION_SIGILS;
  return(
    <div style={{minHeight:"100vh",background:"var(--void)",padding:"24px 18px"}}>
      <div style={{maxWidth:1000,margin:"0 auto"}}>
        <div style={{textAlign:"center",marginBottom:28}}>
          <div style={{fontFamily:"var(--fmono)",color:"var(--gold-d)",fontSize:8,letterSpacing:5,marginBottom:6}}>STEP I — CHOOSE YOUR ARMY</div>
          <h2 style={{fontFamily:"var(--fdisplay)",color:"var(--bone)",fontSize:22,letterSpacing:4}}>MUSTER YOUR FORCES</h2>
        </div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(270px,1fr))",gap:12,marginBottom:24}}>
          {all.map(a=>{
            const Sigil = FACTION_SIGILS[a.id];
            return (
              <div key={a.id} onClick={()=>setSel(a)} style={{background:sel?.id===a.id?`${a.color}12`:"rgba(255,255,255,0.015)",border:`1px solid ${sel?.id===a.id?a.color:"#1e1e28"}`,borderRadius:2,padding:"16px 14px",cursor:"pointer",boxShadow:sel?.id===a.id?`0 0 20px ${a.color}33`:"none",transition:"all 0.13s"}}>
                <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:10}}>
                  {Sigil?<Sigil size={28} color={a.color}/>:<div style={{width:28,height:28,borderRadius:"50%",background:a.color}}/>}
                  <div>
                    <div style={{fontFamily:"var(--fdisplay)",color:"var(--bone)",fontSize:13,letterSpacing:1}}>{a.name}</div>
                    <div style={{fontFamily:"var(--fmono)",color:a.color,fontSize:8,letterSpacing:2}}>{a.faction}</div>
                  </div>
                  {a.isCustom&&<span style={{marginLeft:"auto",fontFamily:"var(--fmono)",color:"var(--gold)",fontSize:7,padding:"1px 5px",border:"1px solid var(--gold-d)"}}>CUSTOM</span>}
                </div>
                <p style={{fontFamily:"var(--fbody)",color:"#4a4a60",fontSize:11,lineHeight:1.6,marginBottom:10,fontStyle:"italic"}}>{a.lore}</p>
                <div style={{borderTop:`1px solid ${a.color}22`,paddingTop:8}}>
                  {a.units.slice(0,5).map(u=>(
                    <div key={u.id} style={{display:"flex",justifyContent:"space-between",marginBottom:2}}>
                      <span style={{fontFamily:"var(--fmono)",color:"#4a4a5a",fontSize:8}}>{u.name}{u.count>1?` ×${u.count}`:""}</span>
                      <span style={{fontFamily:"var(--fmono)",color:a.color,fontSize:8}}>T{u.t}·{u.sv}+·{u.w}W</span>
                    </div>
                  ))}
                  {a.units.length>5&&<div style={{fontFamily:"var(--fmono)",color:"#2a2a3a",fontSize:8}}>+{a.units.length-5} more units</div>}
                </div>
              </div>
            );
          })}
        </div>
        <div style={{display:"flex",gap:10,justifyContent:"center"}}>
          <GBtn onClick={()=>goto("splash")} v="ghost">RETREAT</GBtn>
          <GBtn onClick={()=>sel&&onSelect(sel)} disabled={!sel} v="gold">CHOOSE BATTLEFIELD</GBtn>
        </div>
      </div>
    </div>
  );
}

/* ─── MAP SELECT ───────────────────────────────────────────── */
function MapSelect({goto,customMaps=[],onSelect}){
  const [sel,setSel]=useState(null);
  const all=[...PRESET_MAPS,...customMaps];
  return(
    <div style={{minHeight:"100vh",background:"var(--void)",padding:"24px 18px"}}>
      <div style={{maxWidth:860,margin:"0 auto"}}>
        <div style={{textAlign:"center",marginBottom:28}}>
          <div style={{fontFamily:"var(--fmono)",color:"var(--gold-d)",fontSize:8,letterSpacing:5,marginBottom:6}}>STEP II — CHOOSE BATTLEFIELD</div>
          <h2 style={{fontFamily:"var(--fdisplay)",color:"var(--bone)",fontSize:22,letterSpacing:4}}>SELECT WARZONE</h2>
        </div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(240px,1fr))",gap:14,marginBottom:24}}>
          {all.map(m=>{
            const terr=buildTerrain(m.id)||[];
            return (
              <div key={m.id} onClick={()=>setSel(m)} style={{border:`1px solid ${sel?.id===m.id?"var(--gold)":"#1e1e28"}`,borderRadius:2,overflow:"hidden",cursor:"pointer",background:sel?.id===m.id?"rgba(184,134,11,0.06)":"transparent",transition:"all 0.13s"}}>
                <div style={{height:120,background:m.bg,position:"relative",overflow:"hidden"}}>
                  <svg width="100%" height="100%" viewBox="0 0 100 75" preserveAspectRatio="xMidYMid slice" style={{position:"absolute",inset:0}}>
                    {terr.map(t=>(
                      <polygon key={t.id} points={t.poly.map(p=>`${p[0]*1},${p[1]*0.75}`).join(" ")} fill={t.fill} stroke={t.stroke} strokeWidth=".5" opacity=".8"/>
                    ))}
                  </svg>
                  {m.isCustom&&<span style={{position:"absolute",top:5,right:5,fontFamily:"var(--fmono)",color:"var(--gold)",fontSize:7,padding:"1px 5px",border:"1px solid var(--gold-d)",background:"#06060a"}}>CUSTOM</span>}
                </div>
                <div style={{padding:"10px 12px",background:"#080812"}}>
                  <div style={{fontFamily:"var(--fdisplay)",color:"var(--bone)",fontSize:13,marginBottom:3}}>{m.name}</div>
                  <div style={{fontFamily:"var(--fmono)",color:"var(--bone-d)",fontSize:8}}>{terr.filter(t=>t.type==="objective").length} objectives · {terr.filter(t=>t.type!=="objective").length} terrain</div>
                </div>
              </div>
            );
          })}
        </div>
        <div style={{display:"flex",gap:10,justifyContent:"center"}}>
          <GBtn onClick={()=>goto("army-select")} v="ghost">BACK</GBtn>
          <GBtn onClick={()=>sel&&onSelect(sel)} disabled={!sel} v="gold">DEPLOY FORCES</GBtn>
        </div>
      </div>
    </div>
  );
}

/* ─── DEPLOYMENT ───────────────────────────────────────────── */
function Deployment({playerArmy,cpuArmy,selectedMap,onStart}){
  const terrain=useMemo(()=>buildTerrain(selectedMap.id),[selectedMap.id]);
  const pUnits=useMemo(()=>playerArmy.units.map((u,i)=>({
    ...u,id:`p_${u.id}`,armyId:playerArmy.id,currentWounds:u.w*(u.count||1),maxWounds:u.w*(u.count||1),
    currentCount:u.count||1,isPlayer:true,hasActed:false,battleShocked:false,
    x:12+(i%4)*20,y:88,deployed:false,
  })),[playerArmy]);
  const [board,setBoard]=useState(pUnits);
  const [idx,setIdx]=useState(0);
  const boardRef=useRef();
  const allPlaced=board.filter(u=>u.isPlayer&&u.deployed).length>=pUnits.length;
  const handleClick=e=>{
    if(allPlaced) return;
    const rect=boardRef.current.getBoundingClientRect();
    const x=((e.clientX-rect.left)/rect.width)*100;
    const y=((e.clientY-rect.top)/rect.height)*100;
    if(y<62){alert("Deploy in your zone (bottom 38%)");return;}
    const u=pUnits[idx];
    setBoard(p=>[...p.filter(x=>x.id!==u.id),{...u,x,y,deployed:true}]);
    if(idx+1>=pUnits.length){
      const cpu=cpuArmy.units.map((u,i)=>({
        ...u,id:`c_${u.id}`,armyId:cpuArmy.id,currentWounds:u.w*(u.count||1),maxWounds:u.w*(u.count||1),
        currentCount:u.count||1,isPlayer:false,hasActed:false,battleShocked:false,
        x:12+(i%4)*20,y:4+(Math.floor(i/4)*14),deployed:true,
      }));
      setBoard(p=>[...p.filter(u=>u.isPlayer),...cpu]);
    }
    setIdx(i=>i+1);
  };
  return(
    <div style={{minHeight:"100vh",background:"var(--void)",display:"flex",flexDirection:"column",alignItems:"center",padding:20}}>
      <div style={{maxWidth:820,width:"100%"}}>
        <div style={{textAlign:"center",marginBottom:12}}>
          <div style={{fontFamily:"var(--fmono)",color:"var(--gold-d)",fontSize:8,letterSpacing:5,marginBottom:4}}>STEP III — DEPLOYMENT</div>
          <h2 style={{fontFamily:"var(--fdisplay)",color:"var(--bone)",fontSize:18,letterSpacing:4}}>TAKE YOUR POSITIONS</h2>
          {!allPlaced&&pUnits[idx]&&<p style={{fontFamily:"var(--fmono)",color:playerArmy.color,fontSize:9,marginTop:5}}>DEPLOYING: {pUnits[idx].name} — click in the blue zone</p>}
          {allPlaced&&<p style={{fontFamily:"var(--fmono)",color:"#2a6a3a",fontSize:10,marginTop:5}}>ALL FORCES DEPLOYED</p>}
        </div>
        <div ref={boardRef} onClick={handleClick} style={{width:"100%",paddingBottom:"65%",position:"relative",background:selectedMap.bg,borderRadius:2,border:"1px solid #1e1e2a",overflow:"hidden",cursor:allPlaced?"default":"crosshair",marginBottom:12}}>
          <svg width="100%" height="100%" viewBox="0 0 100 100" preserveAspectRatio="none" style={{position:"absolute",inset:0}}>
            {terrain.map(t=>(
              <polygon key={t.id} points={t.poly.map(p=>p.join(",")).join(" ")} fill={t.fill} stroke={t.stroke} strokeWidth=".4" opacity=".8"/>
            ))}
          </svg>
          <div style={{position:"absolute",left:0,right:0,top:0,height:"35%",background:"rgba(100,20,20,0.08)",borderBottom:"1px dashed rgba(100,20,20,0.25)",pointerEvents:"none"}}>
            <div style={{fontFamily:"var(--fmono)",color:"rgba(100,20,20,0.35)",fontSize:"min(7px,1.2vw)",padding:3,textAlign:"center",letterSpacing:2}}>ENEMY ZONE</div>
          </div>
          <div style={{position:"absolute",left:0,right:0,bottom:0,height:"38%",background:"rgba(20,40,100,0.08)",borderTop:"1px dashed rgba(20,40,100,0.25)",pointerEvents:"none"}}>
            <div style={{fontFamily:"var(--fmono)",color:"rgba(20,40,100,0.35)",fontSize:"min(7px,1.2vw)",padding:3,textAlign:"center",letterSpacing:2}}>YOUR ZONE</div>
          </div>
          <div style={{position:"absolute",inset:0}}>
            {board.filter(u=>u.deployed).map(u=>(
              <UnitToken key={u.id} unit={u} armyColor={u.isPlayer?playerArmy.color:cpuArmy.color}/>
            ))}
          </div>
        </div>
        <div style={{display:"flex",gap:5,flexWrap:"wrap",justifyContent:"center",marginBottom:14}}>
          {pUnits.map((u,i)=>{
            const placed=board.find(b=>b.id===u.id&&b.deployed);
            return(
              <div key={u.id} style={{padding:"3px 9px",background:placed?"rgba(30,60,30,0.3)":i===idx?"rgba(184,134,11,0.1)":"transparent",border:`1px solid ${placed?"#2a4a2a":i===idx?"var(--gold-d)":"#1e1e28"}`,borderRadius:1}}>
                <span style={{fontFamily:"var(--fmono)",color:placed?"#2a7a3a":i===idx?"var(--gold)":"#2a2a3a",fontSize:8}}>{u.name}{placed?" ✓":""}</span>
              </div>
            );
          })}
        </div>
        {allPlaced&&<div style={{textAlign:"center"}}><GBtn onClick={()=>onStart(board)} v="blood" s={{padding:"12px 36px",fontSize:11,letterSpacing:4}}>COMMENCE BATTLE</GBtn></div>}
      </div>
    </div>
  );
}

/* ─── MAIN GAME ────────────────────────────────────────────── */
const PHASES=["command","movement","shooting","charge","fight","morale"];
const PHASE_COLORS={command:"#7060c0",movement:"#3080c0",shooting:"#c08820",charge:"#c01818",fight:"#8a1010",morale:"#603090"};
const MAX_ROUNDS = 5;
const STRAT_CP_COST = {command:1,movement:1,shooting:1,charge:1,fight:1,morale:1};

function Game({playerArmy,cpuArmy,selectedMap,initUnits,goto}){
  const terrain=useMemo(()=>buildTerrain(selectedMap.id),[selectedMap.id]);
  const [units,setUnits]=useState(initUnits);
  const [phase,setPhase]=useState(0);
  const [round,setRound]=useState(1);
  const [log,setLog]=useState([{t:"turn",msg:"BATTLE ROUND 1 · COMMAND PHASE",id:0}]);
  const [sel,setSel]=useState(null);
  const [tgt,setTgt]=useState(null);
  const [ruleErr,setRuleErr]=useState(null);
  const [rolling,setRolling]=useState(false);
  const [combatLog,setCombatLog]=useState(null); // {title, steps}
  const [effects,setEffects]=useState([]);
  const [scores,setScores]=useState({p:0,c:0});
  const [chargeInfo,setChargeInfo]=useState(null);
  const [cpuBusy,setCpuBusy]=useState(false);
  const [cp,setCP]=useState({p:3,c:3}); // command points
  const [showStrats,setShowStrats]=useState(false);
  const [usedStrats,setUsedStrats]=useState([]);
  const [winCond,setWinCond]=useState(null); // {winner, reason}
  const [victory,setVictory]=useState(null);
  const [showWinModal,setShowWinModal]=useState(false);
  const [pendingStratEffect,setPendingStratEffect]=useState(null);
  const boardRef=useRef();
  const boardDims=useRef({w:800,h:500}); // live pixel dims of the board element
  const logRef=useRef();
  const fxCounter=useRef(0);

  // Keep boardDims in sync
  useEffect(()=>{
    const update=()=>{
      if(boardRef.current){
        const r=boardRef.current.getBoundingClientRect();
        boardDims.current={w:r.width,h:r.height};
      }
    };
    update();
    window.addEventListener("resize",update);
    return ()=>window.removeEventListener("resize",update);
  },[]);

  // Convenience wrappers that use live board dimensions
  const dIn=(a,b)=>distIn(a,b,boardDims.current.w,boardDims.current.h);
  const engagePct=()=>ENGAGE_IN/BOARD_IN*100; // % of board width for 2 inches
  const phaseName=PHASES[phase];
  const phaseColor=PHASE_COLORS[phaseName];

  useEffect(()=>{if(logRef.current)logRef.current.scrollTop=logRef.current.scrollHeight;},[log]);

  const alive=u=>u.currentWounds>0;
  const pAlive=useMemo(()=>units.filter(u=>u.isPlayer&&alive(u)),[units]);
  const cAlive=useMemo(()=>units.filter(u=>!u.isPlayer&&alive(u)),[units]);

  const addLog=(msg,t="info")=>setLog(p=>[...p.slice(-70),{msg,t,id:Date.now()+Math.random()}]);
  const showErr=(msg)=>{setRuleErr(msg);setTimeout(()=>setRuleErr(null),3500);};

  // Board pixel coords for VFX
  const getPixelPos=(pct_x, pct_y)=>{
    if(!boardRef.current) return {px:0,py:0};
    const r=boardRef.current.getBoundingClientRect();
    return {px: r.left+(pct_x/100)*r.width, py: r.top+(pct_y/100)*r.height};
  };

  const addFX=(type,x,y,val)=>{
    const id=fxCounter.current++;
    const {px,py}=getPixelPos(x,y);
    setEffects(p=>[...p,{id,type,px,py,val}]);
    setTimeout(()=>setEffects(p=>p.filter(e=>e.id!==id)),FX_DURATION[type]||800);
  };

  // Check win conditions
  const checkWin=useCallback((currentUnits)=>{
    const pA=currentUnits.filter(u=>u.isPlayer&&u.currentWounds>0);
    const cA=currentUnits.filter(u=>!u.isPlayer&&u.currentWounds>0);
    // Annihilation
    if(cA.length===0) return {winner:"player",reason:"Total Annihilation — all enemy forces destroyed!"};
    if(pA.length===0) return {winner:"cpu",reason:"Total Annihilation — your forces have been wiped out!"};
    // Assassination
    const pChar=pA.find(u=>u.shape==="Character");
    const cChar=cA.find(u=>u.shape==="Character");
    if(!cChar) return {winner:"player",reason:"Decapitation Strike — the enemy Warlord is slain!"};
    if(!pChar) return {winner:"cpu",reason:"Decapitation Strike — your Warlord has fallen!"};
    // Attrition — 60% enemy pts destroyed
    const totalPPts=playerArmy.units.reduce((s,u)=>s+u.pts,0);
    const totalCPts=cpuArmy.units.reduce((s,u)=>s+u.pts,0);
    const alivePPts=pA.reduce((s,u)=>s+u.pts,0);
    const aliveCPts=cA.reduce((s,u)=>s+u.pts,0);
    if(aliveCPts<totalCPts*0.4) return {winner:"player",reason:"War of Attrition — enemy forces have been broken!"};
    if(alivePPts<totalPPts*0.4) return {winner:"cpu",reason:"War of Attrition — your forces have been broken!"};
    return null;
  },[playerArmy,cpuArmy]);

  const scoreObjectives=useCallback((currentUnits)=>{
    const objs=terrain.filter(t=>t.type==="objective");
    let ps=0,cs=0,pHeld=0,cHeld=0;
    objs.forEach(obj=>{
      const cx=obj.poly.reduce((s,p)=>s+p[0],0)/obj.poly.length;
      const cy=obj.poly.reduce((s,p)=>s+p[1],0)/obj.poly.length;
      const r=5;
      const pA=currentUnits.filter(u=>u.isPlayer&&u.currentWounds>0&&!u.battleShocked);
      const cA=currentUnits.filter(u=>!u.isPlayer&&u.currentWounds>0&&!u.battleShocked);
      const pOC=pA.filter(u=>Math.hypot(u.x-cx,u.y-cy)<r).reduce((s,u)=>s+(u.oc||1),0);
      const cOC=cA.filter(u=>Math.hypot(u.x-cx,u.y-cy)<r).reduce((s,u)=>s+(u.oc||1),0);
      if(pOC>cOC){ps+=3;pHeld++;}
      else if(cOC>pOC){cs+=3;cHeld++;}
    });
    if(ps||cs){
      addLog(`OBJECTIVES: You hold ${pHeld} (+${ps}VP) / Enemy holds ${cHeld} (+${cs}VP)`,"score");
      setScores(s=>({p:s.p+ps,c:s.c+cs}));
    }
    // Tactical Supremacy win: 3+ objs at end of round 5
    if(round>=MAX_ROUNDS){
      if(pHeld>=3) return {winner:"player",reason:`Tactical Supremacy — you held ${pHeld} objectives at Round ${MAX_ROUNDS}!`};
      if(cHeld>=3) return {winner:"cpu",reason:`Tactical Supremacy — enemy held ${cHeld} objectives at Round ${MAX_ROUNDS}!`};
    }
    return null;
  },[terrain,round]);

  // Validate action
  const validate=(actor,target,action)=>{
    if(!alive(actor)) return "Unit is already destroyed.";
    if(action==="shoot"){
      if(phaseName!=="shooting") return "Shooting only in Shooting Phase.";
      if(!actor.range||actor.range===0) return `${actor.name} has no ranged weapon.`;
      if(actor.advanced) return "Cannot shoot after Advancing.";
      const engaged=cAlive.some(e=>dIn(actor,e)<=ENGAGE_IN);
      if(engaged) return "Cannot shoot while in Engagement Range of enemies.";
      if(!target) return "Select a target first.";
      const d=dIn(actor,target);
      if(d>actor.range) return `Out of range — ${d.toFixed(1)}" away, max ${actor.range}".`;
      if(!hasLOS(actor,target,terrain)) return "No Line of Sight — terrain blocks the shot.";
    }
    if(action==="charge"){
      if(phaseName!=="charge") return "Charges declared in Charge Phase.";
      if(!target) return "Select a charge target.";
    }
    if(action==="fight"){
      if(phaseName!=="fight") return "Fighting only in Fight Phase.";
      const enemies=actor.isPlayer?cAlive:pAlive;
      const inEngage=enemies.some(e=>dIn(actor,e)<=ENGAGE_IN+0.5);
      if(!inEngage) return `${actor.name} is not in Engagement Range of any enemy (need ≤${ENGAGE_IN}").`;
    }
    if(action==="move"){
      if(phaseName!=="movement") return "Movement only in Movement Phase.";
      if(actor.hasActed) return `${actor.name} has already moved.`;
    }
    return null;
  };

  const handleUnitClick=(e,uid)=>{
    e.stopPropagation();
    const u=units.find(x=>x.id===uid);
    if(!u||!alive(u)) return;
    if(u.isPlayer){
      if(sel?.id===uid){setSel(null);setTgt(null);return;}
      setSel(u);setTgt(null);setRuleErr(null);
    } else {
      if(!sel) return;
      setTgt(prev=>prev?.id===uid?null:u);
    }
  };

  const handleBoardClick=e=>{
    if(!sel||phaseName!=="movement") return;
    if(e.target!==boardRef.current&&!e.target.dataset.bg) return;
    const err=validate(sel,null,"move");
    if(err){showErr(err);return;}
    const rect=boardRef.current.getBoundingClientRect();
    const nx=((e.clientX-rect.left)/rect.width)*100;
    const ny=((e.clientY-rect.top)/rect.height)*100;
    const d=dIn(sel,{x:nx,y:ny});
    let maxM=sel.move;
    // Difficult terrain
    const onDiff=terrain.find(t=>(t.type==="water"||t.type==="crater")&&t.poly&&ptInPoly(nx,ny,t.poly));
    if(onDiff) maxM=maxM/2;
    if(d>maxM+0.8){showErr(`Too far! ${sel.name} move ${maxM.toFixed(1)}", distance ${d.toFixed(1)}".`);return;}
    // Can't end in enemy engagement range
    if(cAlive.some(e=>dIn({x:nx,y:ny},e)<=ENGAGE_IN)){showErr("Cannot end move in enemy Engagement Range.");return;}
    setUnits(p=>p.map(u=>u.id===sel.id?{...u,x:nx,y:ny,hasActed:true,moved:true}:u));
    addLog(`${sel.name} moves ${d.toFixed(1)}".`,"action");
    setSel(null);
  };

  const executeAttack=(isShooting)=>{
    if(!sel||!tgt||rolling) return;
    const err=validate(sel,tgt,isShooting?"shoot":"fight");
    if(err){showErr(err);return;}
    setRolling(true);

    const result=resolveCombat(sel,tgt,terrain,isShooting);

    // Build readable log
    const steps=[];
    steps.push({label:`HIT ROLLS (${result.wsbs}+, ${result.numAttacks} attacks)`,rolls:result.hitRolls.map(r=>({...r,hit:r.hit}))});
    if(result.woundRolls?.length) steps.push({label:`WOUND ROLLS (${result.wt}+, S${sel.s} vs T${tgt.t})`,rolls:result.woundRolls.map(r=>({...r,hit:r.wound,crit:r.dev}))});
    if(result.saveRolls?.length>0||result.devWounds>0){
      const saveLabel=`SAVE ROLLS (${result.activeSv}+${result.cover>0?` +${result.cover} cover`:""}${tgt.inv?` / ${tgt.inv}++ invuln`:""})`;
      const allSaves=[...result.saveRolls,...Array(result.devWounds||0).fill({v:"DEV",saved:false,dev:true})];
      steps.push({label:saveLabel,rolls:allSaves.map(r=>({...r,hit:!r.saved}))});
    }
    if(result.dmg>0) steps.push({label:`DAMAGE: ${result.failedSaves} × ${result.dmgPer} = ${result.dmg} damage`,rolls:[]});

    setCombatLog({
      title:`${sel.name} ${isShooting?"fires on":"fights"} ${tgt.name}`,
      steps,
      result,
      attId:sel.id, defId:tgt.id,
      isShooting,
    });
  };

  const confirmCombat=()=>{
    if(!combatLog) return;
    const {result,attId,defId,isShooting}=combatLog;
    const attacker=units.find(u=>u.id===attId);
    const defender=units.find(u=>u.id===defId);
    if(!attacker||!defender){setCombatLog(null);setRolling(false);return;}

    if(result.dmg>0){
      addFX("muzzle",attacker.x,attacker.y,0);
      addFX("hit",defender.x,defender.y,0);
      addFX("damage",defender.x,defender.y-4,result.dmg);
      if(result.devWounds>0) addFX("crit",defender.x+4,defender.y-8,0);
    } else {
      addFX("miss",defender.x,defender.y,0);
    }

    addLog(`${attacker.name} → ${defender.name}: ${result.dmg} damage (${result.failedSaves} failed saves)`,result.dmg>0?"damage":"miss");

    let newUnits=[...units];
    newUnits=newUnits.map(u=>{
      if(u.id===defId){
        const nw=Math.max(0,u.currentWounds-result.dmg);
        const nc=u.count?Math.max(0,Math.ceil(nw/u.w)):(nw>0?1:0);
        if(nw<=0){addLog(`${u.name} — DESTROYED.`,"death");addFX("death",u.x,u.y,0);}
        else if(nc<(u.currentCount||u.count)) addLog(`${u.name} loses ${(u.currentCount||u.count)-nc} model(s).`,"damage");
        return {...u,currentWounds:nw,currentCount:nc};
      }
      if(u.id===attId) return {...u,hasActed:true};
      return u;
    });

    setUnits(newUnits);
    const w=checkWin(newUnits);
    if(w){setVictory(w);setShowWinModal(true);}
    setCombatLog(null);setSel(null);setTgt(null);setRolling(false);
  };

  const doCharge=()=>{
    if(!sel||!tgt) return;
    const err=validate(sel,tgt,"charge");
    if(err){showErr(err);return;}
    const d=dIn(sel,tgt);
    const r1=rollD6(1)[0],r2=rollD6(1)[0],total=r1+r2;
    const need=Math.max(2,Math.ceil(d-0.5)); // 2D6 must reach target (with 0.5" slack)
    const success=total>=need;
    setChargeInfo({name:sel.name,tgtName:tgt.name,r1,r2,total,need,success,d:d.toFixed(1)});
    addLog(`CHARGE: ${sel.name}→${tgt.name} | ${r1}+${r2}=${total} (need ${need}) ${success?"SUCCESS":"FAIL"}`,success?"action":"miss");
    if(success){
      // Place charger 1.2" from target. Account for board aspect ratio so distance is correct.
      const {w:bw,h:bh}=boardDims.current;
      const pxPerIn=bw/BOARD_IN;
      const gapPx=1.2*pxPerIn; // 1.2 inches in pixels
      // angle in pixel space
      const dx=(tgt.x-sel.x)/100*bw;
      const dy=(tgt.y-sel.y)/100*bh;
      const ang=Math.atan2(dy,dx);
      // new position in pixels from target
      const nx=tgt.x-(Math.cos(ang)*gapPx/bw*100);
      const ny=tgt.y-(Math.sin(ang)*gapPx/bh*100);
      setUnits(p=>p.map(u=>u.id===sel.id?{...u,x:Math.max(1,Math.min(99,nx)),y:Math.max(1,Math.min(99,ny)),charged:true,hasActed:true}:u));
      addFX("hit",tgt.x,tgt.y,0);
    } else {
      setUnits(p=>p.map(u=>u.id===sel.id?{...u,hasActed:true}:u));
    }
    setSel(null);setTgt(null);
    setTimeout(()=>setChargeInfo(null),3000);
  };

  const moraleTests=useCallback((currentUnits)=>{
    return currentUnits.map(u=>{
      if(!alive(u)||!u.count||u.currentCount>=u.count) return u;
      const lost=u.count-u.currentCount,roll=roll2D6(),total=roll+lost;
      const shocked=total>u.ld;
      addLog(`MORALE ${u.name}: 2D6(${roll})+${lost}=${total} vs Ld${u.ld} — ${shocked?"BATTLE-SHOCKED":"holds"}`,shocked?"morale":"info");
      return shocked?{...u,battleShocked:true}:u;
    });
  },[]);

  const useStratagem=(strat)=>{
    if(cp.p<strat.cost){showErr(`Not enough Command Points (need ${strat.cost}, have ${cp.p})`);return;}
    if(usedStrats.includes(strat.id)){showErr("This stratagem has already been used this battle.");return;}
    setCP(c=>({...c,p:c.p-strat.cost}));
    setUsedStrats(p=>[...p,strat.id]);
    addLog(`STRATAGEM: ${strat.name} — ${strat.desc}`,"strat");
    // Apply effects
    if(strat.effect==="heal"&&sel){
      const healAmt=3;
      setUnits(p=>p.map(u=>{
        if(u.id!==sel.id) return u;
        const restored=Math.min(healAmt,u.maxWounds-u.currentWounds);
        if(restored>0){addFX("heal",u.x,u.y,restored);}
        return {...u,currentWounds:Math.min(u.maxWounds,u.currentWounds+healAmt),currentCount:Math.min(u.count||1,Math.ceil((u.currentWounds+healAmt)/u.w))};
      }));
    }
    if(strat.effect==="damage"&&tgt){
      const dmg=rollD6(1)[0];
      addLog(`Warp surge deals ${dmg} mortal wounds to ${tgt.name}!`,"damage");
      addFX("hit",tgt.x,tgt.y,0);addFX("damage",tgt.x,tgt.y-4,dmg);
      setUnits(p=>p.map(u=>{
        if(u.id!==tgt.id) return u;
        const nw=Math.max(0,u.currentWounds-dmg);
        const nc=u.count?Math.max(0,Math.ceil(nw/u.w)):(nw>0?1:0);
        if(nw<=0){addLog(`${u.name} DESTROYED!`,"death");addFX("death",u.x,u.y,0);}
        return {...u,currentWounds:nw,currentCount:nc};
      }));
    }
    setShowStrats(false);
  };

  const cpuTurn=useCallback(()=>{
    setCpuBusy(true);
    setTimeout(()=>{
      const alive_=u=>u.currentWounds>0;
      const cU=units.filter(u=>!u.isPlayer&&alive_(u));
      const pU=units.filter(u=>u.isPlayer&&alive_(u));
      if(!cU.length||!pU.length){setCpuBusy(false);return;}
      const patches={};
      const logs=[];
      const addP=(id,patch)=>patches[id]={...units.find(u=>u.id===id),...(patches[id]||{}),...patch};

      cU.forEach(att=>{
        const cur=(id)=>({...units.find(u=>u.id===id),...(patches[id]||{})});
        const pAlive_=pU.filter(u=>alive_(cur(u.id)));
        if(!pAlive_.length) return;
        const bw=boardDims.current.w, bh=boardDims.current.h;
        const di=(a,b)=>distIn(a,b,bw,bh);
        const melee=pAlive_.filter(t=>di(att,cur(t.id))<=ENGAGE_IN+0.5);
        const inRange=pAlive_.filter(t=>att.range&&di(att,cur(t.id))<=att.range&&hasLOS(att,cur(t.id),terrain));
        if(melee.length){
          const t=melee[0];const res=resolveCombat(att,cur(t.id),terrain,false);
          const cv=cur(t.id);const nw=Math.max(0,cv.currentWounds-res.dmg);
          const nc=t.count?Math.max(0,Math.ceil(nw/t.w)):(nw>0?1:0);
          addP(t.id,{currentWounds:nw,currentCount:nc});
          logs.push({msg:`${att.name} fights ${t.name} — ${res.dmg} dmg`,t:"cpu"});
          if(nw<=0) logs.push({msg:`${t.name} DESTROYED.`,t:"death"});
          setTimeout(()=>{addFX("hit",t.x,t.y,0);if(res.dmg>0)addFX("damage",t.x,t.y-4,res.dmg);},200);
        } else if(inRange.length){
          const t=inRange.sort((a,b)=>di(cur(a.id),cur(b.id))-di(cur(a.id),cur(b.id)))[0];
          const res=resolveCombat(att,cur(t.id),terrain,true);
          const cv=cur(t.id);const nw=Math.max(0,cv.currentWounds-res.dmg);
          const nc=t.count?Math.max(0,Math.ceil(nw/t.w)):(nw>0?1:0);
          addP(t.id,{currentWounds:nw,currentCount:nc});
          logs.push({msg:`${att.name} fires on ${t.name} — ${res.dmg} dmg`,t:"cpu"});
          if(nw<=0) logs.push({msg:`${t.name} DESTROYED.`,t:"death"});
          setTimeout(()=>{addFX("muzzle",att.x,att.y,0);addFX("hit",t.x,t.y,0);if(res.dmg>0)addFX("damage",t.x,t.y-4,res.dmg);},300);
        } else {
          const near=pAlive_.reduce((n,u)=>di(att,u)<di(att,n)?u:n,pAlive_[0]);
          // Move in pixel space toward nearest enemy, stop 1.5" away
          const pxPerIn=bw/BOARD_IN;
          const dx=(near.x-att.x)/100*bw;
          const dy=(near.y-att.y)/100*bh;
          const ang=Math.atan2(dy,dx);
          const movePx=Math.min(att.move*pxPerIn, Math.max(0, Math.sqrt(dx*dx+dy*dy)-1.5*pxPerIn));
          if(movePx>2){
            const nx=att.x+Math.cos(ang)*movePx/bw*100;
            const ny=att.y+Math.sin(ang)*movePx/bh*100;
            addP(att.id,{x:Math.max(1,Math.min(99,nx)),y:Math.max(1,Math.min(99,ny))});
          }
        }
      });

      if(Object.keys(patches).length){
        setUnits(p=>{
          const nu=p.map(u=>patches[u.id]?{...u,...patches[u.id]}:u);
          const w=checkWin(nu);
          if(w){setVictory(w);setShowWinModal(true);}
          return nu;
        });
      }
      logs.forEach(l=>addLog(l.msg,l.t));
      setCpuBusy(false);
    },1100);
  },[units,terrain,checkWin]);

  const advancePhase=()=>{
    if(rolling||cpuBusy) return;
    const next=(phase+1)%PHASES.length;
    let newUnits=units;
    if(phaseName==="morale"){
      newUnits=moraleTests(units);
      const objWin=scoreObjectives(newUnits);
      if(objWin){setVictory(objWin);setShowWinModal(true);return;}
    }
    if(next===0){
      setRound(r=>{
        const nr=r+1;
        if(nr>MAX_ROUNDS){
          // End of game — objectives decide
          const objs=terrain.filter(t=>t.type==="objective");
          let ph=0,ch=0;
          objs.forEach(obj=>{
            const cx=obj.poly.reduce((s,p)=>s+p[0],0)/obj.poly.length;
            const cy=obj.poly.reduce((s,p)=>s+p[1],0)/obj.poly.length;
            const r2=5;
            const pOC=pAlive.filter(u=>!u.battleShocked&&Math.hypot(u.x-cx,u.y-cy)<r2).reduce((s,u)=>s+(u.oc||1),0);
            const cOC=cAlive.filter(u=>!u.battleShocked&&Math.hypot(u.x-cx,u.y-cy)<r2).reduce((s,u)=>s+(u.oc||1),0);
            if(pOC>cOC) ph++; else if(cOC>pOC) ch++;
          });
          const w=scores.p>scores.c?{winner:"player",reason:`Game over! You win on VP: ${scores.p+ph*3} vs ${scores.c+ch*3}.`}
                 :scores.c>scores.p?{winner:"cpu",reason:`Game over! Enemy wins on VP: ${scores.c+ch*3} vs ${scores.p+ph*3}.`}
                 :{winner:"draw",reason:`Game over! Draw — equal Victory Points!`};
          setTimeout(()=>{setVictory(w);setShowWinModal(true);},200);
        }
        return nr;
      });
      addLog(`\n━━━ BATTLE ROUND ${round+1} ━━━`,"turn");
      // Restore CP
      setCP(c=>({p:Math.min(6,c.p+3),c:Math.min(6,c.c+3)}));
      setUnits(newUnits.map(u=>({...u,hasActed:false,moved:false,advanced:false,charged:false,battleShocked:false})));
      cpuTurn();
    } else {
      setUnits(newUnits.map(u=>({...u,hasActed:false})));
      addLog(`${PHASES[next].toUpperCase()} PHASE`,"phase");
    }
    setPhase(next);setSel(null);setTgt(null);
  };

  const selUnit=sel?units.find(u=>u.id===sel.id):null;
  const tgtUnit=tgt?units.find(u=>u.id===tgt.id):null;
  const canShoot=selUnit&&tgtUnit&&phaseName==="shooting"&&!selUnit.hasActed;
  const canCharge=selUnit&&tgtUnit&&phaseName==="charge"&&!selUnit.hasActed;
  const canFight=selUnit&&tgtUnit&&phaseName==="fight";
  const pStrats=playerArmy.stratagems||[];

  const PHASE_TIPS={
    command:"Restore Battle-shock. Use Stratagems (click CP button). End phase to continue.",
    movement:"Click a unit to select, click board to move. Blue ring = range. Can't end in enemy engagement.",
    shooting:"Select unit → select enemy → FIRE. Yellow ring = weapon range. Walls block LOS.",
    charge:"Select unit → select enemy → CHARGE. Roll 2D6 vs distance. Chargers fight first!",
    fight:"Select unit within 2\" of enemy → select enemy → FIGHT. Both sides trade blows.",
    morale:"Units below half models test Battle-shock. Ends automatically when you click END PHASE.",
  };

  return(
    <div style={{height:"100vh",background:"var(--void)",display:"flex",flexDirection:"column",overflow:"hidden"}}>
      <style>{GLOBAL_CSS}</style>
      <VFXPortal effects={effects}/>

      {/* COMBAT LOG MODAL */}
      {combatLog&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.8)",zIndex:400,display:"flex",alignItems:"center",justifyContent:"center"}}>
          <div style={{background:"linear-gradient(135deg,#0c0c18,#14101c)",border:"1px solid var(--gold-d)",borderRadius:2,padding:"20px 24px",maxWidth:380,width:"90%",boxShadow:"0 0 40px rgba(184,134,11,0.3)"}}>
            <div style={{fontFamily:"var(--fdisplay)",color:"var(--gold)",fontSize:12,letterSpacing:3,marginBottom:14,textAlign:"center"}}>{combatLog.title}</div>
            {combatLog.steps.map((step,i)=>(
              <div key={i} style={{marginBottom:10}}>
                <div style={{fontFamily:"var(--fmono)",fontSize:8,color:"var(--bone-d)",letterSpacing:2,marginBottom:5}}>{step.label}</div>
                {step.rolls.length>0&&(
                  <div style={{display:"flex",gap:5,flexWrap:"wrap"}}>
                    {step.rolls.map((r,j)=>{
                      const suc=r.hit??false;const crit=r.crit||r.dev;
                      if(r.v==="DEV") return <div key={j} style={{padding:"3px 7px",background:"#3a0000",border:"1px solid #c0281a",fontFamily:"var(--fmono)",fontSize:8,color:"#ff4040",borderRadius:2}}>DEV</div>;
                      return(
                        <div key={j} style={{width:28,height:28,background:crit?"#2a0000":suc?"#0a200a":"#14141e",border:`1.5px solid ${crit?"#c0281a":suc?"#2a5a2a":"#2a2a38"}`,borderRadius:3,display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"var(--fdisplay)",fontSize:13,fontWeight:700,color:crit?"#ff5050":suc?"#4aff5a":"#2a2a40",boxShadow:crit?"0 0 6px #c0281a55":suc?"0 0 4px #2a5a2a44":"none"}}>
                          {r.v}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            ))}
            <div style={{borderTop:"1px solid #1e1e2a",paddingTop:12,marginTop:4,textAlign:"center"}}>
              <div style={{fontFamily:"var(--fdisplay)",fontSize:16,color:combatLog.result.dmg>0?"#c0281a":"#2a5a2a",marginBottom:10}}>
                {combatLog.result.dmg>0?`${combatLog.result.dmg} DAMAGE DEALT`:"NO DAMAGE"}
              </div>
              <GBtn onClick={confirmCombat} v="blood" s={{padding:"8px 28px",fontSize:10,letterSpacing:3}}>CONFIRM</GBtn>
            </div>
          </div>
        </div>
      )}

      {/* VICTORY MODAL */}
      {showWinModal&&victory&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.93)",zIndex:500,display:"flex",alignItems:"center",justifyContent:"center"}}>
          <div style={{textAlign:"center",padding:"40px 56px",border:`1px solid ${victory.winner==="player"?"var(--gold)":"var(--blood-l)"}`,maxWidth:500}}>
            <div style={{fontFamily:"var(--fdisplay)",fontSize:9,letterSpacing:7,color:victory.winner==="player"?"var(--gold-d)":"#3a1010",marginBottom:14}}>
              {victory.winner==="player"?"THE EMPEROR PROTECTS":victory.winner==="cpu"?"HERESY DETECTED":"THE GODS ARE FICKLE"}
            </div>
            <h2 style={{fontFamily:"var(--fdisplay)",fontSize:32,color:victory.winner==="player"?"var(--gold)":victory.winner==="cpu"?"var(--blood-l)":"#8a8a60",letterSpacing:4,marginBottom:10}}>
              {victory.winner==="player"?"VICTORY":victory.winner==="cpu"?"DEFEAT":"DRAW"}
            </h2>
            <p style={{fontFamily:"var(--fbody)",color:"var(--bone-d)",fontSize:14,fontStyle:"italic",marginBottom:24}}>{victory.reason}</p>
            <div style={{display:"flex",gap:20,justifyContent:"center",marginBottom:28}}>
              <div><div style={{fontFamily:"var(--fdisplay)",fontSize:26,color:playerArmy.color}}>{scores.p}</div><div style={{fontFamily:"var(--fmono)",color:"#2a2a3a",fontSize:7,letterSpacing:2}}>YOUR VP</div></div>
              <div style={{fontFamily:"var(--fdisplay)",color:"#1e1e2a",fontSize:24,alignSelf:"center"}}>vs</div>
              <div><div style={{fontFamily:"var(--fdisplay)",fontSize:26,color:cpuArmy.color}}>{scores.c}</div><div style={{fontFamily:"var(--fmono)",color:"#2a2a3a",fontSize:7,letterSpacing:2}}>ENEMY VP</div></div>
            </div>
            <GBtn onClick={()=>goto("splash")} v={victory.winner==="player"?"gold":"blood"} s={{padding:"12px 32px",fontSize:10,letterSpacing:4}}>RETURN TO SANCTUM</GBtn>
          </div>
        </div>
      )}

      {/* STRATAGEMS PANEL */}
      {showStrats&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.75)",zIndex:300,display:"flex",alignItems:"center",justifyContent:"center"}} onClick={()=>setShowStrats(false)}>
          <div style={{background:"#0c0c18",border:"1px solid var(--gold-d)",borderRadius:2,padding:"20px 22px",maxWidth:400,width:"90%"}} onClick={e=>e.stopPropagation()}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
              <div style={{fontFamily:"var(--fdisplay)",color:"var(--gold)",fontSize:12,letterSpacing:3}}>STRATAGEMS</div>
              <div style={{fontFamily:"var(--fmono)",color:"var(--gold)",fontSize:10}}>CP: {cp.p}</div>
            </div>
            {pStrats.map(s=>{
              const used=usedStrats.includes(s.id);
              const canAfford=cp.p>=s.cost;
              return(
                <div key={s.id} style={{background:used?"transparent":"rgba(255,255,255,0.02)",border:`1px solid ${used?"#1a1a22":canAfford?"#3a2a06":"#1a1a28"}`,borderRadius:1,padding:"10px 12px",marginBottom:8,opacity:used?0.4:canAfford?1:0.6}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4}}>
                    <div style={{fontFamily:"var(--fdisplay)",color:used?"#3a3a4a":"var(--bone)",fontSize:11}}>{s.name}</div>
                    <div style={{fontFamily:"var(--fmono)",color:canAfford&&!used?"var(--gold)":"#3a2a06",fontSize:9,padding:"1px 6px",border:`1px solid ${canAfford&&!used?"var(--gold-d)":"#1a1a22"}`}}>{s.cost}CP</div>
                  </div>
                  <p style={{fontFamily:"var(--fbody)",color:"#4a4a60",fontSize:11,fontStyle:"italic",marginBottom:used?0:8}}>{s.desc}</p>
                  {!used&&<GBtn onClick={()=>useStratagem(s)} disabled={!canAfford} v="gold" sz="sm">USE</GBtn>}
                  {used&&<div style={{fontFamily:"var(--fmono)",color:"#2a2a3a",fontSize:8,letterSpacing:2}}>USED</div>}
                </div>
              );
            })}
            <div style={{textAlign:"center",marginTop:10}}><GBtn onClick={()=>setShowStrats(false)} v="ghost" sz="sm">CLOSE</GBtn></div>
          </div>
        </div>
      )}

      {/* ─── HEADER ─────────────────────────────────────────── */}
      <div style={{background:"#08080e",borderBottom:"1px solid #14141e",padding:"6px 12px",display:"flex",alignItems:"center",justifyContent:"space-between",gap:8,flexWrap:"wrap",flexShrink:0}}>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <span style={{fontFamily:"var(--fdisplay)",color:"var(--gold-d)",fontSize:10,letterSpacing:3}}>WH40K</span>
          <span style={{color:"#1a1a22"}}>|</span>
          <span style={{fontFamily:"var(--fmono)",color:"#3a3a4a",fontSize:8}}>RND {round}/{MAX_ROUNDS}</span>
          <div style={{padding:"2px 9px",background:`${phaseColor}18`,border:`1px solid ${phaseColor}44`,fontFamily:"var(--fdisplay)",fontSize:7,letterSpacing:2,color:phaseColor}}>{phaseName.toUpperCase()}</div>
          {cpuBusy&&<div style={{fontFamily:"var(--fmono)",color:"var(--blood-l)",fontSize:7,letterSpacing:2,animation:"flicker 0.8s infinite"}}>ENEMY ACTING</div>}
        </div>
        <div style={{display:"flex",gap:2}}>
          {PHASES.map((p,i)=>(
            <div key={p} style={{padding:"2px 6px",background:i===phase?phaseColor:`${PHASE_COLORS[p]}10`,fontFamily:"var(--fmono)",fontSize:6,letterSpacing:1,color:i===phase?"#06060a":i<phase?PHASE_COLORS[p]+"55":PHASE_COLORS[p]+"25",fontWeight:i===phase?"bold":"normal"}}>
              {p.slice(0,3).toUpperCase()}
            </div>
          ))}
        </div>
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          {/* Scores */}
          <div style={{display:"flex",gap:10}}>
            <div style={{textAlign:"center"}}><div style={{fontFamily:"var(--fdisplay)",color:playerArmy.color,fontSize:16,lineHeight:1}}>{scores.p}</div><div style={{fontFamily:"var(--fmono)",color:"#1e1e2a",fontSize:6}}>YOUR VP</div></div>
            <div style={{textAlign:"center"}}><div style={{fontFamily:"var(--fdisplay)",color:cpuArmy.color,fontSize:16,lineHeight:1}}>{scores.c}</div><div style={{fontFamily:"var(--fmono)",color:"#1e1e2a",fontSize:6}}>ENEMY VP</div></div>
          </div>
          {/* CP */}
          <button onClick={()=>setShowStrats(s=>!s)} style={{padding:"4px 10px",background:"rgba(184,134,11,0.1)",border:"1px solid var(--gold-d)",borderRadius:1,fontFamily:"var(--fdisplay)",fontSize:9,color:"var(--gold)",cursor:"pointer",letterSpacing:1}}>
            {cp.p}CP ⚡
          </button>
          <GBtn onClick={advancePhase} disabled={rolling||cpuBusy} v="blood" sz="sm" s={{letterSpacing:2}}>
            END {phaseName.slice(0,3).toUpperCase()} ›
          </GBtn>
        </div>
      </div>

      {/* ERROR BANNER */}
      {ruleErr&&(
        <div style={{background:"rgba(100,0,0,0.25)",borderBottom:"1px solid #6a0000",padding:"6px 14px",fontFamily:"var(--fmono)",color:"#ff5050",fontSize:9,letterSpacing:1,animation:"slide-down 0.15s ease",flexShrink:0}}>
          RULES VIOLATION — {ruleErr}
        </div>
      )}

      {/* CHARGE RESULT */}
      {chargeInfo&&(
        <div style={{background:chargeInfo.success?"rgba(10,50,14,0.3)":"rgba(80,8,8,0.3)",borderBottom:`1px solid ${chargeInfo.success?"#1a5a20":"#6a1010"}`,padding:"6px 14px",fontFamily:"var(--fmono)",fontSize:9,color:chargeInfo.success?"#3a7a40":"#7a3030",flexShrink:0}}>
          CHARGE: {chargeInfo.name} → {chargeInfo.tgtName} · {chargeInfo.d}" away · {chargeInfo.r1}+{chargeInfo.r2}={chargeInfo.total} vs {chargeInfo.need} needed · {chargeInfo.success?"CHARGE SUCCEEDS!":"CHARGE FAILS."}
        </div>
      )}

      <div style={{display:"flex",flex:1,overflow:"hidden",minHeight:0}}>

        {/* LEFT — player units */}
        <div style={{width:164,background:"#070710",borderRight:"1px solid #12121c",padding:8,overflowY:"auto",flexShrink:0}}>
          <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:8,borderBottom:`1px solid ${playerArmy.color}22`,paddingBottom:5}}>
            {FACTION_SIGILS[playerArmy.id]&&React.createElement(FACTION_SIGILS[playerArmy.id],{size:16,color:playerArmy.color})}
            <div style={{fontFamily:"var(--fdisplay)",color:playerArmy.color,fontSize:7,letterSpacing:2}}>{playerArmy.name.toUpperCase()}</div>
          </div>
          {units.filter(u=>u.isPlayer).map(u=>{
            const dead=!alive(u);
            const isSel=sel?.id===u.id;
            const hp=u.currentWounds/u.maxWounds;
            return(
              <div key={u.id} onClick={()=>!dead&&setSel(s=>s?.id===u.id?null:u)}
                style={{padding:"7px 8px",background:isSel?`${playerArmy.color}14`:dead?"transparent":"rgba(255,255,255,0.015)",border:`1px solid ${isSel?playerArmy.color:dead?"#0c0c14":"#12121c"}`,borderRadius:1,marginBottom:4,cursor:dead?"default":"pointer",opacity:dead?0.3:u.hasActed?0.55:1,transition:"all 0.12s"}}>
                <div style={{display:"flex",alignItems:"center",gap:5,marginBottom:dead?0:4}}>
                  <svg width="16" height="16" viewBox="0 0 32 32"><path d={UNIT_PATH[u.shape]||UNIT_PATH.Infantry} fill={dead?"#2a2a3a":playerArmy.color} opacity=".9"/></svg>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontFamily:"var(--fdisplay)",color:dead?"#1e1e2a":"var(--bone)",fontSize:8,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{u.name}</div>
                    <div style={{fontFamily:"var(--fmono)",color:"#2a2a3a",fontSize:6}}>{u.shape}{u.count>1?` ×${u.currentCount||u.count}`:""}</div>
                  </div>
                  {u.hasActed&&!dead&&<div style={{width:4,height:4,borderRadius:"50%",background:"#1a4a20",flexShrink:0}}/>}
                  {u.battleShocked&&<div style={{fontFamily:"var(--fmono)",color:"#6a3a9a",fontSize:6,flexShrink:0}}>BSK</div>}
                </div>
                {!dead&&<>
                  <div style={{height:2,background:"#12121c",borderRadius:1,marginBottom:1}}>
                    <div style={{height:"100%",background:hp>.55?"#1a4a20":hp>.28?"#5a4000":"#5a1010",borderRadius:1,width:`${hp*100}%`,transition:"width 0.4s"}}/>
                  </div>
                  <div style={{fontFamily:"var(--fmono)",color:"#1e1e2a",fontSize:6}}>{u.currentWounds}/{u.maxWounds}W{u.range?` · ${u.range}"`:""}</div>
                </>}
              </div>
            );
          })}
        </div>

        {/* CENTER — BATTLEFIELD */}
        <div style={{flex:1,display:"flex",flexDirection:"column",overflow:"hidden"}}>

          {/* Action bar */}
          {(selUnit||tgtUnit)&&(
            <div style={{background:"#0a0a16",borderBottom:"1px solid #161622",padding:"6px 12px",display:"flex",alignItems:"center",gap:8,flexWrap:"wrap",flexShrink:0}}>
              {selUnit&&(
                <div style={{display:"flex",alignItems:"center",gap:7}}>
                  <svg width="20" height="20" viewBox="0 0 32 32"><path d={UNIT_PATH[selUnit.shape]||UNIT_PATH.Infantry} fill={playerArmy.color}/></svg>
                  <div>
                    <div style={{fontFamily:"var(--fdisplay)",color:playerArmy.color,fontSize:10}}>{selUnit.name}</div>
                    <div style={{fontFamily:"var(--fmono)",color:"#2a2a3a",fontSize:7}}>S{selUnit.s} AP-{selUnit.ap} D{selUnit.d} {selUnit.range?`${selUnit.range}" range`:"melee"}</div>
                  </div>
                </div>
              )}
              {tgtUnit&&<>
                <div style={{fontFamily:"var(--fmono)",color:"#2a1a1a",fontSize:12}}>›</div>
                <div style={{display:"flex",alignItems:"center",gap:7}}>
                  <svg width="20" height="20" viewBox="0 0 32 32"><path d={UNIT_PATH[tgtUnit.shape]||UNIT_PATH.Infantry} fill={cpuArmy.color}/></svg>
                  <div>
                    <div style={{fontFamily:"var(--fdisplay)",color:cpuArmy.color,fontSize:10}}>{tgtUnit.name}</div>
                    <div style={{fontFamily:"var(--fmono)",color:"#2a2a3a",fontSize:7}}>T{tgtUnit.t} Sv{tgtUnit.sv}+{tgtUnit.inv?`/${tgtUnit.inv}++`:""} · {selUnit?dIn(selUnit,tgtUnit).toFixed(1):"-"}"</div>
                  </div>
                </div>
              </>}
              <div style={{marginLeft:"auto",display:"flex",gap:5}}>
                {canShoot&&<GBtn onClick={()=>executeAttack(true)} disabled={rolling} v="blood" sz="sm">{rolling?"...":"FIRE"}</GBtn>}
                {canCharge&&<GBtn onClick={doCharge} v="blood" sz="sm">CHARGE</GBtn>}
                {canFight&&<GBtn onClick={()=>executeAttack(false)} disabled={rolling} v="blood" sz="sm">{rolling?"...":"FIGHT"}</GBtn>}
                <GBtn onClick={()=>{setSel(null);setTgt(null);}} v="ghost" sz="sm">×</GBtn>
              </div>
            </div>
          )}

          {/* BOARD */}
          <div ref={boardRef} onClick={handleBoardClick} data-bg="1"
            style={{flex:1,position:"relative",background:selectedMap.bg,overflow:"hidden",cursor:phaseName==="movement"&&selUnit?"crosshair":"default"}}>

            {/* SVG terrain layer */}
            <svg width="100%" height="100%" viewBox="0 0 100 100" preserveAspectRatio="none"
              style={{position:"absolute",inset:0,overflow:"visible",pointerEvents:"none"}}>
              <defs>
                <filter id="glow-gold"><feGaussianBlur stdDeviation="1" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
              </defs>
              {/* Subtle grid */}
              {[10,20,30,40,50,60,70,80,90].map(v=>(
                <g key={v}>
                  <line x1={v} y1={0} x2={v} y2={100} stroke="rgba(255,255,255,0.012)" strokeWidth=".3"/>
                  <line x1={0} y1={v} x2={100} y2={v} stroke="rgba(255,255,255,0.012)" strokeWidth=".3"/>
                </g>
              ))}
              {terrain.map(t=>(
                <g key={t.id}>
                  <polygon points={t.poly.map(p=>p.join(",")).join(" ")} fill={t.fill} stroke={t.stroke} strokeWidth=".5" opacity=".9"
                    style={t.type==="objective"?{animation:"obj-glow 2.5s infinite",filter:"url(#glow-gold)"}:undefined}/>
                  {t.type==="objective"&&(
                    <text x={t.poly.reduce((s,p)=>s+p[0],0)/t.poly.length} y={t.poly.reduce((s,p)=>s+p[1],0)/t.poly.length+1.2}
                      textAnchor="middle" fontFamily="var(--fmono)" fontSize="2.8" fill={t.stroke} opacity=".8">OBJ</text>
                  )}
                </g>
              ))}
              {/* LOS line */}
              {selUnit&&tgtUnit&&(phaseName==="shooting"||phaseName==="fight")&&(()=>{
                const los=hasLOS(selUnit,tgtUnit,terrain);
                return <line x1={selUnit.x} y1={selUnit.y} x2={tgtUnit.x} y2={tgtUnit.y}
                  stroke={los?"rgba(184,134,11,0.3)":"rgba(180,20,20,0.4)"} strokeWidth=".6" strokeDasharray={los?"2,2":"1.5,1.5"}/>;
              })()}
              {/* Range ring — ellipse corrects for non-square board (preserveAspectRatio:none stretches SVG) */}
              {selUnit&&phaseName==="shooting"&&selUnit.range>0&&(()=>{
                const rx=selUnit.range*PCT_PER_IN;
                const ry=rx*(boardDims.current.w/Math.max(1,boardDims.current.h));
                return <ellipse cx={selUnit.x} cy={selUnit.y} rx={rx} ry={ry} fill="none" stroke="rgba(184,134,11,0.2)" strokeWidth=".7" strokeDasharray="2,2"/>;
              })()}
              {selUnit&&phaseName==="movement"&&(()=>{
                const rx=selUnit.move*PCT_PER_IN;
                const ry=rx*(boardDims.current.w/Math.max(1,boardDims.current.h));
                return <ellipse cx={selUnit.x} cy={selUnit.y} rx={rx} ry={ry} fill="none" stroke="rgba(30,80,180,0.22)" strokeWidth=".7" strokeDasharray="2,2"/>;
              })()}
            </svg>

            {/* Clickable bg overlay */}
            <div data-bg="1" style={{position:"absolute",inset:0,pointerEvents:"all"}}/>

            {/* Unit tokens */}
            {units.filter(alive).map(u=>(
              <UnitToken key={u.id} unit={u} armyColor={u.isPlayer?playerArmy.color:cpuArmy.color}
                selected={sel?.id===u.id} targeted={tgt?.id===u.id}
                acted={u.hasActed} dead={false}
                onClick={e=>handleUnitClick(e,u.id)}/>
            ))}
            {/* Dead units (faded) */}
            {units.filter(u=>!alive(u)).map(u=>(
              <div key={u.id} style={{position:"absolute",left:`${u.x}%`,top:`${u.y}%`,transform:"translate(-50%,-50%)",opacity:0.12,pointerEvents:"none"}}>
                <svg width={SHAPE_SIZES[u.shape]||30} height={SHAPE_SIZES[u.shape]||30} viewBox="0 0 32 32">
                  <path d={UNIT_PATH[u.shape]||UNIT_PATH.Infantry} fill="#3a3a4a"/>
                </svg>
              </div>
            ))}

            {/* Hint */}
            {!selUnit&&(
              <div style={{position:"absolute",bottom:8,left:"50%",transform:"translateX(-50%)",fontFamily:"var(--fmono)",fontSize:7,color:"rgba(184,134,11,0.2)",letterSpacing:2,pointerEvents:"none",whiteSpace:"nowrap"}}>
                {{movement:"SELECT UNIT TO MOVE",shooting:"SELECT UNIT TO FIRE",charge:"SELECT UNIT TO CHARGE",fight:"SELECT UNIT IN MELEE TO FIGHT",command:"COMMAND PHASE — USE STRATAGEMS OR END PHASE",morale:"MORALE PHASE — CLICK END PHASE TO RESOLVE"}[phaseName]||""}
              </div>
            )}
          </div>

          {/* Phase tip bar */}
          <div style={{background:"#06060e",borderTop:"1px solid #101018",padding:"4px 12px",flexShrink:0,display:"flex",alignItems:"center",gap:8}}>
            <div style={{fontFamily:"var(--fdisplay)",color:phaseColor,fontSize:7,letterSpacing:2,flexShrink:0}}>{phaseName.toUpperCase()}</div>
            <div style={{fontFamily:"var(--fmono)",color:"#1e1e2a",fontSize:7,lineHeight:1.4}}>{PHASE_TIPS[phaseName]}</div>
          </div>
        </div>

        {/* RIGHT — enemy + log */}
        <div style={{width:164,background:"#070710",borderLeft:"1px solid #12121c",display:"flex",flexDirection:"column",flexShrink:0}}>
          <div style={{padding:8,borderBottom:"1px solid #12121c",overflowY:"auto",maxHeight:"46%"}}>
            <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:8,borderBottom:`1px solid ${cpuArmy.color}22`,paddingBottom:5}}>
              {FACTION_SIGILS[cpuArmy.id]&&React.createElement(FACTION_SIGILS[cpuArmy.id],{size:16,color:cpuArmy.color})}
              <div style={{fontFamily:"var(--fdisplay)",color:cpuArmy.color,fontSize:7,letterSpacing:2}}>{cpuArmy.name.toUpperCase()}</div>
            </div>
            {units.filter(u=>!u.isPlayer).map(u=>{
              const dead=!alive(u);const isTgt=tgt?.id===u.id;
              return(
                <div key={u.id} onClick={()=>!dead&&sel&&setTgt(t=>t?.id===u.id?null:u)}
                  style={{padding:"6px 8px",background:isTgt?`${cpuArmy.color}14`:dead?"transparent":"rgba(255,255,255,0.015)",border:`1px solid ${isTgt?cpuArmy.color:dead?"#0c0c14":"#12121c"}`,borderRadius:1,marginBottom:3,cursor:!dead&&sel?"pointer":"default",opacity:dead?0.25:1}}>
                  <div style={{display:"flex",alignItems:"center",gap:5,marginBottom:dead?0:3}}>
                    <svg width="14" height="14" viewBox="0 0 32 32"><path d={UNIT_PATH[u.shape]||UNIT_PATH.Infantry} fill={dead?"#1e1e2a":cpuArmy.color} opacity=".9"/></svg>
                    <div style={{fontFamily:"var(--fdisplay)",color:dead?"#1e1e2a":"var(--bone-d)",fontSize:8,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis",flex:1}}>{u.name}</div>
                  </div>
                  {!dead&&<>
                    <div style={{height:2,background:"#12121c",borderRadius:1,marginBottom:1}}>
                      <div style={{height:"100%",background:u.currentWounds/u.maxWounds>.5?"#4a1010":"#7a1010",borderRadius:1,width:`${(u.currentWounds/u.maxWounds)*100}%`,transition:"width 0.4s"}}/>
                    </div>
                    <div style={{fontFamily:"var(--fmono)",color:"#1e1e2a",fontSize:6}}>{u.currentWounds}/{u.maxWounds}W</div>
                  </>}
                </div>
              );
            })}
          </div>
          {/* Log */}
          <div ref={logRef} style={{flex:1,padding:"7px 8px",overflowY:"auto",minHeight:0}}>
            <div style={{fontFamily:"var(--fmono)",color:"#12121c",fontSize:6,letterSpacing:3,marginBottom:6}}>BATTLE LOG</div>
            {log.map(e=>{
              const colors={death:"#8a1010",damage:"#c04020",miss:"#2a2a3a",turn:"#6050a0",phase:phaseColor,system:"#3a3a4a",action:"#28507a",morale:"#50287a",score:"#205820",cpu:"#601010",info:"#242430",strat:"#5a4000",heal:"#205a30"};
              return(
                <div key={e.id} style={{fontFamily:"var(--fmono)",fontSize:8,lineHeight:1.6,color:colors[e.t]||"#242430",borderBottom:"1px solid #0c0c14",paddingBottom:2,marginBottom:2}}>
                  {e.msg}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─── MAP MAKER ──────────────────────────────────────────── */
function MapMaker({goto,customMaps=[],setCustomMaps}){
  const [mapName,setMapName]=useState("New Warzone");
  const [bg,setBg]=useState("#0a0810");
  const [pieces,setPieces]=useState([]);
  const [tool,setTool]=useState("ruin");
  const [drag,setDrag]=useState(null);
  const [selPiece,setSelPiece]=useState(null);
  const boardRef=useRef();
  const BG_OPTS=[{l:"Deep Void",v:"#06060a"},{l:"Hive City",v:"linear-gradient(155deg,#08080e,#14101c)"},{l:"Desert",v:"linear-gradient(155deg,#0c0800,#1a1000)"},{l:"Jungle",v:"linear-gradient(155deg,#040a04,#081408)"},{l:"Ice World",v:"linear-gradient(155deg,#080c12,#0c1420)"},{l:"Lava",v:"linear-gradient(155deg,#120400,#200a00)"}];
  const xy=e=>{const r=boardRef.current.getBoundingClientRect();return[((e.clientX-r.left)/r.width)*100,((e.clientY-r.top)/r.height)*100];};
  const addPiece=e=>{
    if(drag) return;
    if(e.target!==boardRef.current&&!e.target.dataset.bg) return;
    const [x,y]=xy(e);
    const tt=TERRAIN_TYPES.find(t=>t.id===tool);
    const isObj=tool==="objective";
    const poly=isObj?buildCircle(x,y,3,10):tool==="crater"?buildCircle(x,y,5,12):[
      [x-7,y-5],[x+7,y-5],[x+7,y+5],[x-7,y+5]
    ];
    setPieces(p=>[...p,{id:"mp_"+Date.now(),type:tool,poly,label:tt.label,fill:tt.fill||"#3a3a48",stroke:tt.stroke||"#5a5a68",blocker:tt.blocker,cover:tt.cover}]);
    setSelPiece(null);
  };
  const startDrag=(e,id)=>{
    e.stopPropagation();
    const[px,py]=xy(e);
    const p=pieces.find(x=>x.id===id);
    const cx=p.poly.reduce((s,pt)=>s+pt[0],0)/p.poly.length;
    const cy=p.poly.reduce((s,pt)=>s+pt[1],0)/p.poly.length;
    setDrag({id,ox:px-cx,oy:py-cy});setSelPiece(id);
  };
  const mmove=e=>{
    if(!drag) return;
    const[px,py]=xy(e);
    const p=pieces.find(x=>x.id===drag.id);
    const cx=p.poly.reduce((s,pt)=>s+pt[0],0)/p.poly.length;
    const cy=p.poly.reduce((s,pt)=>s+pt[1],0)/p.poly.length;
    const dx=px-drag.ox-cx,dy=py-drag.oy-cy;
    setPieces(ps=>ps.map(x=>x.id===drag.id?{...x,poly:x.poly.map(([a,b])=>[a+dx,b+dy])}:x));
  };
  const mup=()=>setDrag(null);
  const del=(id)=>{setPieces(p=>p.filter(x=>x.id!==id));setSelPiece(null);};
  const save=()=>{
    const m={id:"cmap_"+Date.now(),name:mapName,bg,terrain:pieces,isCustom:true};
    const u=[...customMaps.filter(x=>x.name!==mapName),m];
    setCustomMaps(u);LS.save("maps",u);alert("Warzone saved.");
  };
  const TERRAIN_TYPES_LOCAL=[
    {id:"ruin",label:"Ruins",cover:1,blocker:true,fill:"#3a3a48",stroke:"#5a5a6a"},
    {id:"wall",label:"Wall",cover:0,blocker:true,fill:"#2a2a38",stroke:"#4a4a58"},
    {id:"forest",label:"Forest",cover:1,blocker:false,fill:"#142010",stroke:"#1e3818"},
    {id:"hill",label:"Hill",cover:1,blocker:false,fill:"#3a2e14",stroke:"#5a4a22"},
    {id:"water",label:"Bog",cover:0,blocker:false,fill:"#0c1c28",stroke:"#142030"},
    {id:"bunker",label:"Bunker",cover:2,blocker:false,fill:"#1e1e38",stroke:"#3a3a5a"},
    {id:"crater",label:"Crater",cover:1,blocker:false,fill:"#2e221a",stroke:"#4a3828"},
    {id:"objective",label:"Objective",cover:0,blocker:false,fill:"#5a4a00",stroke:"#b8860b"},
  ];
  return(
    <div style={{height:"100vh",background:"var(--void)",display:"flex",flexDirection:"column"}}>
      <div style={{background:"#08080e",borderBottom:"1px solid #12121c",padding:"7px 12px",display:"flex",alignItems:"center",gap:12,flexWrap:"wrap",flexShrink:0}}>
        <span style={{fontFamily:"var(--fdisplay)",color:"var(--gold)",fontSize:11,letterSpacing:3}}>MAP MAKER</span>
        <input value={mapName} onChange={e=>setMapName(e.target.value)} style={{background:"transparent",border:"none",borderBottom:"1px solid #2a2a3a",color:"var(--bone)",fontFamily:"var(--fmono)",fontSize:11,outline:"none",minWidth:150}}/>
        <div style={{marginLeft:"auto",display:"flex",gap:6}}>
          <GBtn onClick={()=>setPieces([])} v="ghost" sz="sm">CLEAR</GBtn>
          <GBtn onClick={save} v="green" sz="sm">SAVE</GBtn>
          <GBtn onClick={()=>goto("splash")} v="ghost" sz="sm">MENU</GBtn>
        </div>
      </div>
      <div style={{display:"flex",flex:1,overflow:"hidden",minHeight:0}}>
        <div style={{width:150,background:"#07070d",borderRight:"1px solid #12121c",padding:8,overflowY:"auto",flexShrink:0}}>
          <div style={{fontFamily:"var(--fmono)",color:"var(--gold-d)",fontSize:7,letterSpacing:3,marginBottom:8}}>TERRAIN TOOLS</div>
          {TERRAIN_TYPES_LOCAL.map(t=>(
            <button key={t.id} onClick={()=>setTool(t.id)} style={{width:"100%",padding:"6px 8px",background:tool===t.id?`${t.fill}44`:"rgba(255,255,255,0.02)",border:`1px solid ${tool===t.id?t.stroke:"#14141c"}`,borderRadius:1,color:tool===t.id?"var(--bone)":"#3a3a4a",textAlign:"left",cursor:"pointer",fontFamily:"var(--fdisplay)",fontSize:8,letterSpacing:1,marginBottom:3}}>{t.label}</button>
          ))}
          <div style={{fontFamily:"var(--fmono)",color:"var(--gold-d)",fontSize:7,letterSpacing:3,margin:"12px 0 7px"}}>BACKGROUND</div>
          {BG_OPTS.map(b=>(
            <button key={b.l} onClick={()=>setBg(b.v)} style={{width:"100%",padding:"4px 7px",background:b.v,border:`1px solid ${bg===b.v?"var(--gold-d)":"#14141c"}`,borderRadius:1,color:"rgba(255,255,255,0.45)",marginBottom:3,cursor:"pointer",fontFamily:"var(--fmono)",fontSize:7,textAlign:"left"}}>{b.l}</button>
          ))}
        </div>
        <div ref={boardRef} data-bg="1" onClick={addPiece} onMouseMove={mmove} onMouseUp={mup} onMouseLeave={mup}
          style={{flex:1,position:"relative",background:bg,cursor:"crosshair",userSelect:"none"}}>
          <svg width="100%" height="100%" viewBox="0 0 100 100" preserveAspectRatio="none"
            style={{position:"absolute",inset:0,pointerEvents:"none"}}>
            {[10,20,30,40,50,60,70,80,90].map(v=>(
              <g key={v}><line x1={v} y1={0} x2={v} y2={100} stroke="rgba(255,255,255,0.012)" strokeWidth=".3"/><line x1={0} y1={v} x2={100} y2={v} stroke="rgba(255,255,255,0.012)" strokeWidth=".3"/></g>
            ))}
            {pieces.map(p=>(
              <polygon key={p.id} points={p.poly.map(pt=>pt.join(",")).join(" ")} fill={p.fill} stroke={selPiece===p.id?"rgba(255,255,255,0.5)":p.stroke} strokeWidth={selPiece===p.id?".8":".4"} opacity=".85" style={{cursor:"grab",pointerEvents:"all"}} onMouseDown={e=>startDrag(e,p.id)}/>
            ))}
          </svg>
          {pieces.map(p=>{
            if(selPiece!==p.id) return null;
            const cx=p.poly.reduce((s,pt)=>s+pt[0],0)/p.poly.length;
            const cy=p.poly.reduce((s,pt)=>s+pt[1],0)/p.poly.length;
            return(
              <div key={p.id+"_del"} style={{position:"absolute",left:`${cx}%`,top:`${cy}%`,transform:"translate(-50%,-50%)",zIndex:20}}>
                <button onMouseDown={e=>{e.stopPropagation();del(p.id);}} style={{background:"#7a1010",border:"1px solid #c0281a",color:"#fff",borderRadius:1,width:14,height:14,fontSize:8,cursor:"pointer",lineHeight:1,fontFamily:"var(--fdisplay)"}}>×</button>
              </div>
            );
          })}
        </div>
        <div style={{width:150,background:"#07070d",borderLeft:"1px solid #12121c",padding:8,overflowY:"auto",flexShrink:0}}>
          <div style={{fontFamily:"var(--fmono)",color:"var(--gold-d)",fontSize:7,letterSpacing:3,marginBottom:8}}>RULES</div>
          {TERRAIN_TYPES_LOCAL.map(t=>(
            <div key={t.id} style={{marginBottom:10}}>
              <div style={{fontFamily:"var(--fdisplay)",color:t.stroke,fontSize:8,marginBottom:2}}>{t.label}</div>
              <div style={{fontFamily:"var(--fbody)",color:"#2a2a3a",fontSize:9,lineHeight:1.5}}>
                {{ruin:"Light Cover +1. Blocks LOS.",wall:"Blocks LOS.",forest:"Light Cover +1.",hill:"Elevated. Ignores light cover when shooting from.",water:"Difficult: halve movement.",bunker:"Heavy Cover +2.",crater:"Light Cover +1. Difficult.",objective:"Score 3VP/round. Hold with OC."}[t.id]}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ─── ARMY BUILDER (compact) ──────────────────────────────── */
function ArmyBuilder({goto,customArmies=[],setCustomArmies}){
  const [ed,setEd]=useState(null);
  const [edUnit,setEdUnit]=useState(null);
  const newA=()=>setEd({id:"ca_"+Date.now(),name:"New Warband",faction:"Unknown",color:"#8a6030",lore:"",units:[],stratagems:[],isCustom:true});
  const saveA=a=>{const u=customArmies.some(x=>x.id===a.id)?customArmies.map(x=>x.id===a.id?a:x):[...customArmies,a];setCustomArmies(u);LS.save("armies",u);setEd(null);};
  const delA=id=>{const u=customArmies.filter(a=>a.id!==id);setCustomArmies(u);LS.save("armies",u);};
  if(edUnit&&ed){
    const SF=({lbl,k,min=0,max=99})=>(
      <div><label style={{fontFamily:"var(--fmono)",color:"var(--gold-d)",fontSize:7,letterSpacing:1,display:"block",marginBottom:2}}>{lbl}</label>
        <input type="number" value={edUnit[k]||0} min={min} max={max} onChange={e=>setEdUnit(u=>({...u,[k]:Number(e.target.value)}))} style={{width:"100%",background:"#0c0c14",border:"1px solid #14141c",color:"var(--bone)",padding:"4px 6px",fontFamily:"var(--fmono)",fontSize:11,outline:"none",borderRadius:1}}/></div>
    );
    const SHAPES=["Infantry","Character","Elite","Horde","Fast","Monster","Walker","Vehicle"];
    return(
      <div style={{minHeight:"100vh",background:"var(--void)",padding:20,overflowY:"auto"}}>
        <div style={{maxWidth:640,margin:"0 auto"}}>
          <div style={{display:"flex",justifyContent:"space-between",marginBottom:18,flexWrap:"wrap",gap:8}}>
            <h2 style={{fontFamily:"var(--fdisplay)",color:"var(--bone)",fontSize:18,letterSpacing:3}}>UNIT DATASHEET</h2>
            <div style={{display:"flex",gap:6}}><GBtn onClick={()=>saveA({...ed,units:ed.units.some(x=>x.id===edUnit.id)?ed.units.map(x=>x.id===edUnit.id?edUnit:x):[...ed.units,edUnit]})} v="green">SAVE</GBtn><GBtn onClick={()=>setEdUnit(null)} v="ghost">CANCEL</GBtn></div>
          </div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:14}}>
            <div style={{gridColumn:"1/-1"}}><label style={{fontFamily:"var(--fmono)",color:"var(--gold-d)",fontSize:7,letterSpacing:1,display:"block",marginBottom:3}}>NAME</label><input value={edUnit.name} onChange={e=>setEdUnit(u=>({...u,name:e.target.value}))} style={{width:"100%",background:"#0c0c14",border:"1px solid #14141c",color:"var(--bone)",padding:"7px 9px",fontFamily:"var(--fdisplay)",fontSize:13,outline:"none",borderRadius:1}}/></div>
            <div><label style={{fontFamily:"var(--fmono)",color:"var(--gold-d)",fontSize:7,letterSpacing:1,display:"block",marginBottom:3}}>SHAPE</label><select value={edUnit.shape||"Infantry"} onChange={e=>setEdUnit(u=>({...u,shape:e.target.value}))} style={{width:"100%",background:"#0c0c14",border:"1px solid #14141c",color:"var(--bone)",padding:"6px 7px",fontFamily:"var(--fmono)",fontSize:10,outline:"none",borderRadius:1}}>{SHAPES.map(s=><option key={s}>{s}</option>)}</select></div>
            <SF lbl="POINTS" k="pts" min={0} max={9999}/>
            <SF lbl="COUNT" k="count" min={1} max={30}/>
          </div>
          <div style={{background:"rgba(184,134,11,0.04)",border:"1px solid rgba(184,134,11,0.12)",borderRadius:1,padding:12,marginBottom:12}}>
            <div style={{fontFamily:"var(--fmono)",color:"var(--gold-d)",fontSize:7,letterSpacing:2,marginBottom:10}}>CHARACTERISTICS</div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(80px,1fr))",gap:8}}>
              <SF lbl='MOVE(")' k="move" min={1} max={24}/><SF lbl="TOUGH" k="t" min={1} max={14}/><SF lbl="SAVE" k="sv" min={2} max={7}/><SF lbl="INVULN(0=none)" k="inv" min={0} max={6}/><SF lbl="WOUNDS" k="w" min={1} max={30}/><SF lbl="ATTACKS" k="a" min={1} max={20}/><SF lbl="WS" k="ws" min={2} max={7}/><SF lbl="BS" k="bs" min={2} max={7}/><SF lbl="STR" k="s" min={1} max={20}/><SF lbl="AP" k="ap" min={0} max={6}/><SF lbl="DAMAGE" k="d" min={1} max={12}/><SF lbl="LEAD" k="ld" min={4} max={10}/><SF lbl="OC" k="oc" min={0} max={10}/><SF lbl='RANGE(")' k="range" min={0} max={96}/>
            </div>
          </div>
          <div style={{background:"#0a0a12",padding:10,borderRadius:1,display:"flex",alignItems:"center",gap:10}}>
            <svg width="40" height="40" viewBox="0 0 32 32"><path d={UNIT_PATH[edUnit.shape]||UNIT_PATH.Infantry} fill={ed.color||"#b8860b"}/></svg>
            <div style={{fontFamily:"var(--fmono)",color:"#2a2a3a",fontSize:8,lineHeight:1.9}}>
              <div>M{edUnit.move}" T{edUnit.t} Sv{edUnit.sv}+{edUnit.inv?`/${edUnit.inv}++`:""} W{edUnit.w}</div>
              <div>A{edUnit.a} WS{edUnit.ws}+ BS{edUnit.bs}+ S{edUnit.s} AP-{edUnit.ap} D{edUnit.d}</div>
              <div>Ld{edUnit.ld} OC{edUnit.oc} {edUnit.range?`${edUnit.range}" range`:"Melee only"}</div>
            </div>
          </div>
        </div>
      </div>
    );
  }
  if(ed){
    return(
      <div style={{minHeight:"100vh",background:"var(--void)",padding:20,overflowY:"auto"}}>
        <div style={{maxWidth:860,margin:"0 auto"}}>
          <div style={{display:"flex",justifyContent:"space-between",marginBottom:20,flexWrap:"wrap",gap:8}}>
            <h2 style={{fontFamily:"var(--fdisplay)",color:"var(--bone)",fontSize:18,letterSpacing:3}}>{ed.name}</h2>
            <div style={{display:"flex",gap:6}}><GBtn onClick={()=>saveA(ed)} v="green">SAVE ARMY</GBtn><GBtn onClick={()=>setEd(null)} v="ghost">CANCEL</GBtn></div>
          </div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:16}}>
            {[["name","Name"],["faction","Faction"],["lore","Lore"]].map(([k,l])=>(
              <div key={k} style={{gridColumn:k==="lore"?"1/-1":"auto"}}>
                <label style={{fontFamily:"var(--fmono)",color:"var(--gold-d)",fontSize:7,letterSpacing:1,display:"block",marginBottom:3}}>{l.toUpperCase()}</label>
                <input value={ed[k]||""} onChange={e=>setEd(a=>({...a,[k]:e.target.value}))} style={{width:"100%",background:"#0c0c14",border:"1px solid #14141c",color:"var(--bone)",padding:"6px 8px",fontFamily:"var(--fmono)",fontSize:11,outline:"none",borderRadius:1}}/>
              </div>
            ))}
            <div>
              <label style={{fontFamily:"var(--fmono)",color:"var(--gold-d)",fontSize:7,letterSpacing:1,display:"block",marginBottom:3}}>COLOUR</label>
              <div style={{display:"flex",gap:8,alignItems:"center"}}>
                <input type="color" value={ed.color} onChange={e=>setEd(a=>({...a,color:e.target.value}))} style={{width:32,height:26,border:"1px solid #14141c",background:"none",cursor:"pointer"}}/>
                <span style={{fontFamily:"var(--fmono)",color:ed.color,fontSize:9}}>{ed.color}</span>
              </div>
            </div>
          </div>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
            <span style={{fontFamily:"var(--fmono)",color:"var(--bone-d)",fontSize:9}}>{ed.units.length} units · {ed.units.reduce((s,u)=>s+(u.pts||0),0)}pts</span>
            <GBtn onClick={()=>setEdUnit({id:"u_"+Date.now(),name:"New Unit",pts:80,move:6,t:4,sv:4,inv:0,w:2,a:2,ws:3,bs:4,s:4,ap:0,d:1,ld:7,oc:2,count:5,range:24,shape:"Infantry"})} v="gold" sz="sm">+ ADD UNIT</GBtn>
          </div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(220px,1fr))",gap:8}}>
            {ed.units.map(u=>(
              <div key={u.id} style={{background:"rgba(255,255,255,0.02)",border:"1px solid #14141c",borderRadius:1,padding:10}}>
                <div style={{display:"flex",justifyContent:"space-between",marginBottom:7}}>
                  <div style={{display:"flex",alignItems:"center",gap:6}}>
                    <svg width="16" height="16" viewBox="0 0 32 32"><path d={UNIT_PATH[u.shape]||UNIT_PATH.Infantry} fill={ed.color}/></svg>
                    <div><div style={{fontFamily:"var(--fdisplay)",color:"var(--bone)",fontSize:10}}>{u.name}</div><div style={{fontFamily:"var(--fmono)",color:ed.color,fontSize:7}}>{u.shape} · {u.pts}pts</div></div>
                  </div>
                  <div style={{display:"flex",gap:3}}><GBtn onClick={()=>setEdUnit(u)} v="ghost" sz="sm">EDIT</GBtn><GBtn onClick={()=>setEd(a=>({...a,units:a.units.filter(x=>x.id!==u.id)}))} v="blood" sz="sm">DEL</GBtn></div>
                </div>
                <div style={{display:"grid",gridTemplateColumns:"repeat(6,1fr)",gap:2}}>
                  {[["M",u.move+'"'],["T",u.t],["Sv",u.sv+"+"],["W",u.w],["A",u.a],["Ld",u.ld]].map(([l,v])=>(
                    <div key={l} style={{background:"#0c0c14",padding:"3px 2px",textAlign:"center",borderRadius:1}}>
                      <div style={{fontFamily:"var(--fmono)",color:"#1e1e2a",fontSize:6}}>{l}</div>
                      <div style={{fontFamily:"var(--fmono)",color:"var(--bone-d)",fontSize:9}}>{v}</div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }
  return(
    <div style={{minHeight:"100vh",background:"var(--void)",padding:20}}>
      <div style={{maxWidth:860,margin:"0 auto"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:24,flexWrap:"wrap",gap:8}}>
          <h2 style={{fontFamily:"var(--fdisplay)",color:"var(--bone)",fontSize:20,letterSpacing:3}}>ARMY BUILDER</h2>
          <div style={{display:"flex",gap:6}}><GBtn onClick={newA} v="gold">+ NEW ARMY</GBtn><GBtn onClick={()=>goto("splash")} v="ghost">BACK</GBtn></div>
        </div>
        <div style={{fontFamily:"var(--fmono)",color:"#1e1e2a",fontSize:7,letterSpacing:3,marginBottom:8}}>PRESET ARMIES (READ ONLY)</div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(200px,1fr))",gap:8,marginBottom:20,opacity:.5}}>
          {Object.values(ARMIES).map(a=>(
            <div key={a.id} style={{background:"rgba(255,255,255,0.015)",border:`1px solid ${a.color}22`,borderRadius:1,padding:10}}>
              <div style={{display:"flex",alignItems:"center",gap:7,marginBottom:5}}>
                {FACTION_SIGILS[a.id]&&React.createElement(FACTION_SIGILS[a.id],{size:16,color:a.color})}
                <span style={{fontFamily:"var(--fdisplay)",color:"var(--bone)",fontSize:11}}>{a.name}</span>
              </div>
              <div style={{fontFamily:"var(--fmono)",color:"#1e1e2a",fontSize:8}}>{a.units.length} units</div>
            </div>
          ))}
        </div>
        <div style={{fontFamily:"var(--fmono)",color:"var(--gold-d)",fontSize:7,letterSpacing:3,marginBottom:8}}>YOUR ARMIES</div>
        {!customArmies.length&&<div style={{border:"1px dashed #14141c",padding:20,textAlign:"center",fontFamily:"var(--fbody)",color:"#1e1e2a",fontStyle:"italic"}}>No custom armies yet.</div>}
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(200px,1fr))",gap:8}}>
          {customArmies.map(a=>(
            <div key={a.id} style={{background:"rgba(255,255,255,0.02)",border:`1px solid ${a.color}44`,borderRadius:1,padding:10}}>
              <div style={{display:"flex",justifyContent:"space-between",marginBottom:6}}>
                <div style={{display:"flex",alignItems:"center",gap:7}}>
                  <div style={{width:8,height:8,borderRadius:"50%",background:a.color}}/>
                  <span style={{fontFamily:"var(--fdisplay)",color:"var(--bone)",fontSize:11}}>{a.name}</span>
                </div>
                <div style={{display:"flex",gap:3}}><GBtn onClick={()=>setEd(a)} v="ghost" sz="sm">EDIT</GBtn><GBtn onClick={()=>delA(a.id)} v="blood" sz="sm">DEL</GBtn></div>
              </div>
              <div style={{fontFamily:"var(--fmono)",color:"#2a2a3a",fontSize:8}}>{a.units.length} units · {a.units.reduce((s,u)=>s+(u.pts||0),0)}pts</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ─── TUTORIAL ────────────────────────────────────────────── */
const TUT=[
  {t:"Welcome",b:"WH40K is a miniatures wargame set in the 41st Millennium. Two armies clash across ruined terrain, taking turns to move, shoot, charge, and fight. The last army standing — or the one dominating Objectives — wins. This implementation enforces all core rules."},
  {t:"Six Phases",b:"Each battle round has 6 phases: Command → Movement → Shooting → Charge → Fight → Morale. Both players complete all phases before the next round. Decisions cascade — a unit that moves cannot always shoot, charged units fight first, etc."},
  {t:"Movement",b:"Move units up to their Move value (in inches). Units cannot end within 2\" of enemies unless charging. Bogs and craters halve movement. Click a unit, then click the board to move — a blue ring shows range."},
  {t:"Shooting",b:"Select unit, select target. The target must be within weapon range AND visible (line of sight). Walls and ruins block LOS. Units engaged in melee cannot shoot. A yellow ring shows weapon range; a red dashed line means LOS blocked."},
  {t:"The Dice Chain",b:"Combat: Hit Rolls (≥ BS/WS), Wound Rolls (compare S vs T: S≥T×2=2+, S>T=3+, equal=4+, T>S=5+, T≥S×2=6+), Save Rolls (≥ Save minus AP, or Invulnerable save). Rolling 6 on wounds = Devastating Wound (bypasses saves)."},
  {t:"Charge & Fight",b:"Declare charge, roll 2D6 vs distance. Success places the charger in engagement range (2\"). Charging units fight FIRST. In the Fight phase, select any unit in engagement — both sides trade blows. Watch your flanks!"},
  {t:"Command Points",b:"You start with 3CP and gain 3 more each round (max 6). Click the CP button to spend them on Stratagems — powerful faction abilities like re-rolling dice, healing units, repositioning forces, or dealing mortal wounds."},
  {t:"Win Conditions",b:"Four ways to win: (1) Annihilation — destroy all enemies. (2) Decapitation — kill their Character/Warlord. (3) Attrition — destroy 60% of enemy points. (4) Tactical Supremacy — hold 3+ Objectives at end of Round 5. The game lasts 5 rounds."},
];

function Tutorial({goto}){
  const [s,setS]=useState(0);
  return(
    <div style={{minHeight:"100vh",background:"linear-gradient(135deg,#06060a,#0c0818)",display:"flex",alignItems:"center",justifyContent:"center",padding:20}}>
      <div style={{maxWidth:540,width:"100%"}}>
        <div style={{textAlign:"center",marginBottom:22}}>
          <div style={{fontFamily:"var(--fmono)",color:"var(--gold-d)",fontSize:7,letterSpacing:5,marginBottom:7}}>{s+1}/{TUT.length} — CODEX TUTORIALIS</div>
          <h2 style={{fontFamily:"var(--fdisplay)",color:"var(--bone)",fontSize:20,letterSpacing:3}}>{TUT[s].t}</h2>
        </div>
        <div style={{background:"#080810",borderRadius:1,height:2,marginBottom:20,overflow:"hidden"}}>
          <div style={{height:"100%",background:"linear-gradient(90deg,var(--gold-d),var(--gold-l))",width:`${((s+1)/TUT.length)*100}%`,transition:"width 0.3s"}}/>
        </div>
        <div style={{background:"rgba(184,134,11,0.04)",border:"1px solid rgba(184,134,11,0.15)",borderRadius:1,padding:"22px 24px",marginBottom:20}}>
          <p style={{fontFamily:"var(--fbody)",color:"var(--bone-d)",fontSize:15,lineHeight:1.85,fontStyle:"italic"}}>{TUT[s].b}</p>
        </div>
        <div style={{display:"flex",gap:8}}>
          {s>0&&<GBtn onClick={()=>setS(x=>x-1)} v="ghost" s={{flex:1}}>PREVIOUS</GBtn>}
          {s<TUT.length-1?<GBtn onClick={()=>setS(x=>x+1)} v="gold" s={{flex:2}}>NEXT</GBtn>:<GBtn onClick={()=>goto("army-select")} v="blood" s={{flex:2}}>BEGIN THE SLAUGHTER</GBtn>}
        </div>
        <div style={{textAlign:"center",marginTop:10}}>
          <button onClick={()=>goto("splash")} style={{background:"none",border:"none",fontFamily:"var(--fmono)",color:"#12121c",fontSize:7,cursor:"pointer",letterSpacing:2}}>RETURN TO SANCTUM</button>
        </div>
      </div>
    </div>
  );
}

/* ═══ ROOT ════════════════════════════════════════════════════ */
export default function Root(){
  const [screen,setScreen]=useState("splash");
  const [customArmies,setCustomArmies]=useState(()=>LS.load("armies",[]));
  const [customMaps,setCustomMaps]=useState(()=>LS.load("maps",[]));
  const [playerArmy,setPlayerArmy]=useState(null);
  const [cpuArmy,setCpuArmy]=useState(null);
  const [selectedMap,setSelectedMap]=useState(null);
  const [gameUnits,setGameUnits]=useState(null);
  const goto=setScreen;

  const onArmySelect=a=>{setPlayerArmy(a);goto("map-select");};
  const onMapSelect=m=>{
    setSelectedMap(m);
    const all=[...Object.values(ARMIES),...customArmies].filter(x=>x.id!==playerArmy.id);
    setCpuArmy(all[Math.floor(Math.random()*all.length)]);
    goto("deployment");
  };

  return(
    <>
      <style>{GLOBAL_CSS}</style>
      {screen==="splash"&&<Splash goto={goto}/>}
      {screen==="tutorial"&&<Tutorial goto={goto}/>}
      {screen==="army-builder"&&<ArmyBuilder goto={goto} customArmies={customArmies} setCustomArmies={setCustomArmies}/>}
      {screen==="map-maker"&&<MapMaker goto={goto} customMaps={customMaps} setCustomMaps={setCustomMaps}/>}
      {screen==="army-select"&&<ArmySelect goto={goto} customArmies={customArmies} onSelect={onArmySelect}/>}
      {screen==="map-select"&&<MapSelect goto={goto} customMaps={customMaps} onSelect={onMapSelect}/>}
      {screen==="deployment"&&playerArmy&&cpuArmy&&selectedMap&&(
        <Deployment playerArmy={playerArmy} cpuArmy={cpuArmy} selectedMap={selectedMap}
          onStart={u=>{setGameUnits(u);goto("game");}}/>
      )}
      {screen==="game"&&playerArmy&&cpuArmy&&selectedMap&&gameUnits&&(
        <Game playerArmy={playerArmy} cpuArmy={cpuArmy} selectedMap={selectedMap} initUnits={gameUnits} goto={goto}/>
      )}
    </>
  );
}
