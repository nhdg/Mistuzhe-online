const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const crypto = require("crypto");
const path = require("path");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, maxPayload: 16 * 1024 });
app.use(express.static(path.join(__dirname, "public")));
app.get("/health", (_, res) => res.json({ ok: true, name: "迷途者", version: "2.0.0" }));

const rooms = new Map();
const TERRAIN = [
  {name:"机关",emoji:"⚙",color:"violet"}, {name:"资源",emoji:"✦",color:"blue"},
  {name:"中央区",emoji:"✹",color:"gold"}, {name:"宝藏",emoji:"◆",color:"orange"},
  {name:"危桥",emoji:"⌁",color:"yellow"}, {name:"交易处",emoji:"⇄",color:"pink"},
  {name:"草地",emoji:"♣",color:"green"}, {name:"锻造台",emoji:"⚒",color:"red"}
];
const GOALS = [
  ["border","走遍边境","到达地图四个角落",3,"border"],["central","中央争夺","进入中央区 3 次",3,"central"],
  ["mechanisms","发现秘密","触发 3 个不同机关",3,"mechanisms"],["treasure","宝藏猎人","探索 3 个宝藏格",3,"treasure"],
  ["collector","收藏家","收集至少 9 种不同卡牌/资源",4,"collector"],["trade","富有商人","完成 4 次交易",3,"trade"],
  ["damage","猎手","累计造成 15 点伤害",4,"damage"],["battles","决斗者","参与 4 次战斗",3,"battles"],
  ["deceive","骗术大师","成功让对手猜错自己的目标",3,"deceive"],["kills","杀手","击败对手 3 次",5,"kills"],
  ["lowHp","绝境求生","生命值不高于 2 时完成另一个目标",4,"lowHp"],["loneWolf","独行者","不参与战斗完成一个目标",3,"loneWolf"],
  ["surveyor","测绘师","探索全部 8 种地形",4,"surveyor"],["shadow","暗影","完成 3 次秘密目标相关行动",3,"shadow"],
  ["ambush","完美陷阱","让对手触发一次埋伏",3,"ambush"],["water","节俭者","连续 5 个回合交水",3,"water"],
  ["centerBattle","寸步不让","在中央区战斗 2 次",3,"centerBattle"],["poker","扑克王","赢得 2 次德国扑克",3,"poker"],
  ["outsideDamage","围猎","对毒圈外的对手造成伤害",3,"outsideDamage"],["correctGuess","猜测王","正确猜中对手的目标",3,"correctGuess"],
  ["falseGuess","反逻辑","让对手猜错你的目标",3,"falseGuess"]
];
const RESOURCE_CARDS = ["水","木材","矿石","金币","药剂","查看","侦察镜","烟雾弹","磨刀石","护盾","闪光弹","偷窥","快走鞋","传送石","猎人标记","封路","捕兽夹","致命一击","背刺","埋伏","诱敌深入","扒窃","情报窃取","万能钥匙","空间石","迷雾之眼","多标记","神秘骰子","回忆碎片","震荡弹","破甲器","幸运硬币","命运骰","武器","扑克牌"];
const MECHANISMS = ["压力板","落穴","暗箭","随机传送","镜像","贪婪宝箱","黄金祭坛","诅咒金币","交换祭坛","干扰","终局开关"];
const TREASURES = ["万能钥匙","空间石","迷雾之眼","多标记","神秘骰子","回忆碎片","震荡弹","破甲器","幸运硬币","命运骰","扑克牌","传送石","护盾","武器"];
const TARGETED = new Set(["查看","侦察镜","封路","捕兽夹","埋伏","传送石","诱敌深入","猎人标记","空间石","多标记","迷雾之眼","万能钥匙","情报窃取","偷窥","震荡弹"]);
const rand = n => crypto.randomInt(n);
const shuffle = a => { const x=[...a]; for(let i=x.length-1;i>0;i--){const j=rand(i+1);[x[i],x[j]]=[x[j],x[i]];} return x; };
const pick = (a,n=1) => shuffle(a).slice(0,n);
const pos = i => ({r:Math.floor(i/8),c:i%8});
const dist = (a,b) => Math.abs(pos(a).r-pos(b).r)+Math.abs(pos(a).c-pos(b).c);
const safe = (room,i) => {const q=pos(i),s=room.safe;return q.r>=s&&q.r<8-s&&q.c>=s&&q.c<8-s;};
const log = (room,s) => {room.logs.push(s);room.logs=room.logs.slice(-70);};
const note = (p,s) => {p.notices.push(s);p.notices=p.notices.slice(-8);};
const draw = (p,n=1) => {for(let i=0;i<n;i++)p.hand.push(RESOURCE_CARDS[rand(RESOURCE_CARDS.length)]);};
const makeGoal = g => ({id:g[0],name:g[1],desc:g[2],points:g[3],kind:g[4],progress:0,done:false});
function makeRoom(name, ws) {
  const board=Array.from({length:64},(_,i)=>({i,t:rand(8),blocked:false,trap:null,seenBy:[]}));
  // Ensure a recognizable central zone and balanced starting corners.
  for(let r=2;r<=5;r++)for(let c=2;c<=5;c++)board[r*8+c].t=2;
  board[0].t=6;board[7].t=1;board[56].t=3;board[63].t=7;
  const room={code:crypto.randomBytes(3).toString("hex").toUpperCase(),board,players:[],round:1,safe:0,phase:"lobby",current:0,turns:0,logs:["房间已创建。把房间码分享给朋友即可联机。"],revealUntil:0,poker:null,createdAt:Date.now()};
  rooms.set(room.code,room);addPlayer(room,name,ws);return room;
}
function addPlayer(room,name,ws) {
  const id=crypto.randomUUID(), start=room.players.length===0?0:63;
  const p={id,token:crypto.randomBytes(18).toString("hex"),name:String(name||"旅人").trim().slice(0,18)||"旅人",ws,pos:start,start,hp:15,maxHp:15,water:3,wood:1,ore:1,gold:1,
    hand:pick(["药剂","查看","水","木材","矿石","金币","侦察镜","烟雾弹","护盾","快走鞋","扑克牌"],4),
    targets:pick(GOALS,3).map(makeGoal),points:0,actions:0,rolled:false,lastDice:0,damage:0,explored:[],corners:[],mechanisms:[],treasures:0,trades:0,waterStreak:0,combat:0,kills:0,transfer:true,ready:true,marks:[],notices:[],pokerWins:0,secretActions:0,turnsAlive:0,alive:true};
  room.players.push(p);return p;
}
function publicPlayer(p,room,viewerId) {
  const self=p.id===viewerId;
  return {id:p.id,name:p.name,pos:p.pos,start:p.start,hp:p.hp,maxHp:p.maxHp,water:p.water,wood:p.wood,ore:p.ore,gold:p.gold,points:p.points,
    actions:self?p.actions:undefined,rolled:self?p.rolled:undefined,lastDice:self?p.lastDice:undefined,hand:self?p.hand:undefined,targets:self?p.targets:undefined,
    transfer:self?p.transfer:undefined,explored:self?p.explored.length:undefined,active:room.players[room.current]?.id===p.id,alive:p.alive};
}
function stateFor(room,p) {
  return {type:"state",roomCode:room.code,phase:room.phase,round:room.round,safe:room.safe,currentPlayerId:room.players[room.current]?.id,
    board:room.board.map(c=>({i:c.i,t:room.phase==="reveal"||c.seenBy.includes(p.id)?c.t:null,blocked:c.blocked,trap:!!c.trap,safe:safe(room,c.i)})),
    players:room.players.map(x=>publicPlayer(x,room,p.id)),you:publicPlayer(p,room,p.id),logs:room.logs.slice(-35),
    revealRemaining:Math.max(0,room.revealUntil-Date.now()),winnerId:room.winnerId,poker:room.poker?{id:room.poker.id,starter:room.poker.starter,waiting:room.poker.waiting,results:room.poker.results}:null,
    notices:p.notices.splice(0),serverTime:Date.now()};
}
function send(ws,obj){if(ws&&ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify(obj));}
function broadcast(room){for(const p of room.players)send(p.ws,stateFor(room,p));}
function complete(room,p,g){
  if(g.done)return;g.done=true;p.points+=g.points;log(room,`${p.name} 完成目标「${g.name}」，获得 ${g.points} 点。`);
  if(p.hp<=2&&g.id!=="lowHp")p.targets.filter(x=>x.id==="lowHp"&&!x.done).forEach(x=>complete(room,p,x));
  if(p.combat===0&&g.id!=="loneWolf")p.targets.filter(x=>x.id==="loneWolf"&&!x.done).forEach(x=>complete(room,p,x));
  if(p.points>=12){room.phase="over";room.winnerId=p.id;log(room,`${p.name} 达到 12 目标点，赢得比赛！`);}
}
function checkGoals(room,p,event="") {
  for(const g of p.targets){if(g.done)continue;
    if(g.id==="surveyor"&&p.explored.length>=8)complete(room,p,g);
    if(g.id==="central"&&(p.centerVisits||0)>=3)complete(room,p,g);
    if(g.id==="ambush"&&(p.ambushCount||0)>=1)complete(room,p,g);
    if(g.id==="shadow"&&(p.secretActions||0)>=3)complete(room,p,g);
    if(g.id==="outsideDamage"&&p.outsideDamage)complete(room,p,g);
    if(g.id==="correctGuess"&&(p.correctGuesses||0)>=1)complete(room,p,g);
    if((g.id==="deceive"||g.id==="falseGuess")&&(p.falseGuesses||0)>=1)complete(room,p,g);
    if(g.id==="border"&&p.corners.length>=4)complete(room,p,g);
    if(g.id==="mechanisms"&&p.mechanisms.length>=3)complete(room,p,g);
    if(g.id==="treasure"&&p.treasures>=3)complete(room,p,g);
    if(g.id==="collector"&&new Set([...p.hand,"水","木材","矿石","金币"].filter(Boolean)).size>=9)complete(room,p,g);
    if(g.id==="trade"&&p.trades>=4)complete(room,p,g);
    if(g.id==="damage"&&p.damage>=15)complete(room,p,g);
    if(g.id==="battles"&&p.combat>=4)complete(room,p,g);
    if(g.id==="kills"&&p.kills>=3)complete(room,p,g);
    if(g.id==="water"&&p.waterStreak>=5)complete(room,p,g);
    if(g.id==="poker"&&p.pokerWins>=2)complete(room,p,g);
    if(g.id==="shadow"&&p.secretActions>=3)complete(room,p,g);
    if(g.id==="centerBattle"&&p.centerBattles>=2)complete(room,p,g);
    if(g.id==="lowHp"&&p.hp<=2&&event==="goal")complete(room,p,g);
  }
}
function respawn(room,p){
  p.hp=p.maxHp;p.pos=p.start;p.actions=0;p.rolled=false;p.water=Math.max(1,p.water);p.alive=true;
  log(room,`${p.name} 生命耗尽，返回起点并恢复生命。`);
}
function finishTurn(room,p){
  if(p.water>0){p.water--;p.waterStreak++;}else{p.hp--;p.waterStreak=0;log(room,`${p.name} 缺水，失去 1 点生命。`);}
  p.turnsAlive++;
  if(p.waterStreak>=5)checkGoals(room,p,"turn");
  if(!safe(room,p.pos)){p.hp-=2;log(room,`${p.name} 回合结束时仍在毒圈外，受到 2 点毒圈伤害。`);}
  if(p.hp<=0)respawn(room,p);
  room.turns++;
  if(room.turns%2===0){
    room.round++;
    if(room.round%3===0&&room.safe<3){room.safe++;log(room,`⚠ 毒圈收缩至第 ${room.safe+1} 圈！最外侧区域持续受到伤害。`);
      room.board.forEach(c=>{if(!safe(room,c.i))c.blocked=false;});
    }
  }
  room.current=1-room.current;const next=room.players[room.current];if(next){next.rolled=false;next.actions=0;next.lastDice=0;}
  if(room.phase!=="over")room.phase="play";
}
function useTrap(room,p,cell){
  const trap=cell.trap;if(!trap||trap.owner===p.id)return;
  cell.trap=null;
  if(trap.type==="捕兽夹"){p.hp-=2;p.actions=0;log(room,`${p.name} 触发捕兽夹，受到 2 点伤害并停止移动。`);}
  if(trap.type==="埋伏"){const owner=room.players.find(x=>x.id===trap.owner);p.hp-=3;if(owner){owner.damage+=3;owner.secretActions++;owner.ambushCount=(owner.ambushCount||0)+1;checkGoals(room,owner,"ambush");}log(room,`${p.name} 触发埋伏，受到 3 点伤害。`);}
  if(trap.type==="诱敌深入"){const owner=room.players.find(x=>x.id===trap.owner);if(owner){p.pos=owner.pos;p.hp-=1;}log(room,`${p.name} 触发诱敌深入，被拉至布陷者所在位置。`);}
  if(trap.type==="诱敌深入"){p.pos=trap.cell??p.pos;p.hp-=1;log(room,`${p.name} 落入诱敌陷阱。`);}
  if(p.hp<=0)respawn(room,p);
}
function explore(room,p,i){
  const c=room.board[i];if(!c.seenBy.includes(p.id))c.seenBy.push(p.id);
  if(!p.explored.includes(c.t))p.explored.push(c.t);
  const corners=[0,7,56,63];if(corners.includes(i)&&!p.corners.includes(i))p.corners.push(i);
  log(room,`${p.name} 探索第 ${i+1} 格：${TERRAIN[c.t].name}。`);
  if(!safe(room,i)){p.hp-=2;log(room,"毒圈伤害：-2 生命。");}
  if(c.t===0){
    if(!p.mechanisms.includes(i))p.mechanisms.push(i);
    const e=MECHANISMS[rand(MECHANISMS.length)];log(room,`机关「${e}」被触发。`);p.secretActions++;
    if(e==="压力板"){p.hp--;p.actions=0;}
    else if(e==="落穴"){p.pos=p.start;p.actions=0;}
    else if(e==="暗箭")p.hp--;
    else if(e==="随机传送"){p.pos=rand(64);p.actions=0;}
    else if(e==="镜像"){const o=room.players.find(x=>x.id!==p.id);if(o)[p.pos,o.pos]=[o.pos,p.pos];}
    else if(e==="贪婪宝箱"){const n=Math.min(2,p.hand.length);p.hand.splice(0,n);log(room,`贪婪宝箱夺走 ${n} 张手牌。`);}
    else if(e==="诅咒金币"){p.gold+=2;p.hp--;}
    else if(e==="黄金祭坛"){if(p.wood>0&&p.ore>0){p.wood--;p.ore--;p.gold+=4;}else draw(p,1);}
    else if(e==="交换祭坛"){const o=room.players.find(x=>x.id!==p.id);if(o)[p.gold,o.gold]=[o.gold,p.gold];}
    else if(e==="干扰"){const o=room.players.find(x=>x.id!==p.id);if(o)o.actions=0;}
    else if(e==="终局开关"){p.points++;room.safe=Math.min(3,room.safe+1);log(room,"终局开关触发，毒圈额外收缩。");}
  } else if(c.t===1){p.water++;p.wood++;p.ore++;p.gold++;draw(p,2);}
  else if(c.t===2){p.gold+=2;draw(p,1);p.centerVisits=(p.centerVisits||0)+1;}
  else if(c.t===3){draw(p,3);p.treasures++;}
  else if(c.t===4){const n=1+rand(6);log(room,`危桥检定掷出 ${n}。`);if(n>=4)p.actions+=1;else{p.hp-=2;p.actions=0;}}
  else if(c.t===5){if(p.gold>0){p.gold--;const r=["water","wood","ore"][rand(3)];p[r]++;p.trades++;log(room,`${p.name} 交易成功，获得${({water:"水",wood:"木材",ore:"矿石"})[r]}。`);}else note(p,"交易处需要至少 1 枚金币。");}
  else if(c.t===6){draw(p,2);p.hand.push("扑克牌");}
  else if(c.t===7){if(p.ore>0&&p.wood>0){p.ore--;p.wood--;p.hand.push("武器");log(room,"锻造成功：获得武器。");}else note(p,"锻造需要 1 木材与 1 矿石。");}
  checkGoals(room,p,"explore");
  if(p.hp<=0)respawn(room,p);
}
function card(room,p,msg){
  const i=Number(msg.cardIndex);if(!Number.isInteger(i)||i<0||i>=p.hand.length)return;
  const card=p.hand[i],cellIndex=Number(msg.cell),cell=Number.isInteger(cellIndex)&&cellIndex>=0&&cellIndex<64?room.board[cellIndex]:null;
  const opp=room.players.find(x=>x.id!==p.id);
  const consume=()=>p.hand.splice(i,1);
  const targetNeeded=TARGETED.has(card);
  if(targetNeeded&&!cell){note(p,`选择地图格子以使用「${card}」。`);return;}
  if(card==="药剂"){p.hp=Math.min(15,p.hp+4);consume();}
  else if(card==="水"){p.water+=2;consume();}
  else if(card==="木材"){p.wood++;consume();}
  else if(card==="矿石"){p.ore++;consume();}
  else if(card==="金币"){p.gold+=2;consume();}
  else if(card==="查看"||card==="侦察镜"||card==="迷雾之眼"||card==="多标记"){const n=card==="多标记"?3:card==="侦察镜"?2:1;for(let k=0;k<n;k++){const ci=card==="多标记"?cellIndex+k:card==="侦察镜"?Math.max(0,cellIndex-1)+k:cellIndex;if(ci<64&&!room.board[ci].seenBy.includes(p.id))room.board[ci].seenBy.push(p.id);}consume();}
  else if(card==="烟雾弹"){p.hp=Math.min(15,p.hp+1);p.smokeShield=(p.smokeShield||0)+2;consume();}
  else if(card==="磨刀石"){p.weaponBonus=(p.weaponBonus||0)+2;consume();}
  else if(card==="护盾"){p.shield=(p.shield||0)+3;consume();}
  else if(card==="闪光弹"){if(opp){opp.actions=0;opp.blinded=true;}consume();}
  else if(card==="偷窥"||card==="情报窃取"){if(opp&&opp.targets.length){note(p,`对手目标线索：${opp.targets[rand(opp.targets.length)].name}`);if(card==="情报窃取"&&opp.hand.length){p.hand.push(opp.hand.pop());}}consume();}
  else if(card==="快走鞋"){p.actions+=3;consume();}
  else if(card==="传送石"||card==="空间石"||card==="万能钥匙"){p.pos=cellIndex;p.actions=Math.max(0,p.actions-1);if(card==="万能钥匙"&&room.board[cellIndex].t!==3){note(p,"万能钥匙可落在任意格子，本次视为普通传送。");}consume();explore(room,p,p.pos);}
  else if(card==="猎人标记"){if(opp){opp.markedBy=p.id;note(p,`猎人标记：对手目前位于第 ${opp.pos+1} 格。`);}consume();}
  else if(card==="封路"){cell.blocked=true;consume();log(room,`第 ${cellIndex+1} 格被封路。`);}
  else if(["捕兽夹","埋伏","诱敌深入"].includes(card)){cell.trap={type:card,owner:p.id,cell:cellIndex};consume();log(room,`${p.name} 在第 ${cellIndex+1} 格布置了${card}。`);}
  else if(card==="致命一击"){p.weaponBonus=(p.weaponBonus||0)+4;consume();}
  else if(card==="背刺"){if(opp&&dist(p.pos,opp.pos)<=1){damage(room,p,opp,4,"背刺");consume();}else note(p,"背刺需要对手在相邻格。");}
  else if(card==="扒窃"){if(opp&&opp.hand.length){p.hand.push(opp.hand.pop());p.gold+=1;}consume();}
  else if(card==="诱敌深入"){if(opp){opp.pos=cellIndex;opp.hp--;consume();}}
  else if(card==="神秘骰子"||card==="命运骰"){p.actions+=rand(6)+1;consume();}
  else if(card==="回忆碎片"){p.explored=[];room.board.forEach(c=>{c.seenBy=c.seenBy.filter(id=>id!==p.id)});consume();note(p,"地图记忆已重置，但可重新探索获取目标进度。");}
  else if(card==="震荡弹"){if(opp&&dist(cellIndex,opp.pos)<=1){opp.hp-=3;opp.actions=0;}consume();}
  else if(card==="破甲器"){if(opp)opp.shield=0;p.weaponBonus=(p.weaponBonus||0)+1;consume();}
  else if(card==="幸运硬币"){p.actions+=1+rand(6);consume();}
  else if(card==="武器"){p.weaponBonus=(p.weaponBonus||0)+2;consume();}
  else if(card==="扑克牌"){if(!room.poker){consume();startPoker(room,p);}else note(p,"已有一场德国扑克正在进行。");return;}
  else {draw(p,1);consume();}
  p.secretActions++;checkGoals(room,p,"card");log(room,`${p.name} 使用了「${card}」。`);
}
function damage(room,attacker,target,amount,why="攻击"){
  if(target.shield>0){const blocked=Math.min(target.shield,amount);target.shield-=blocked;amount-=blocked;if(blocked)log(room,`${target.name} 的护盾抵消 ${blocked} 点伤害。`);}
  if(target.smokeShield>0&&amount>0){const blocked=Math.min(target.smokeShield,amount);target.smokeShield-=blocked;amount-=blocked;if(blocked)log(room,`${target.name} 的烟雾掩护抵消 ${blocked} 点伤害。`);}
  if(amount>0){target.hp-=amount;attacker.damage+=amount;attacker.combat++;target.combat++;if(pos(attacker.pos).r>=2&&pos(attacker.pos).r<=5&&pos(attacker.pos).c>=2&&pos(attacker.pos).c<=5)attacker.centerBattles=(attacker.centerBattles||0)+1;
    if(!safe(room,target.pos))attacker.outsideDamage=true;log(room,`${attacker.name} 对 ${target.name} 使用${why}，造成 ${amount} 点伤害。`);}
  checkGoals(room,attacker,"combat");if(target.hp<=0){attacker.kills++;attacker.points++;respawn(room,target);log(room,`${attacker.name} 击败对手，额外获得 1 点目标分。`);}checkGoals(room,attacker,"combat");
}
function pokerScore(cards){
  const ranks=cards.map(c=>c.r).sort((a,b)=>b-a), counts={};cards.forEach(c=>counts[c.r]=(counts[c.r]||0)+1);
  const groups=Object.entries(counts).map(([r,n])=>({r:+r,n})).sort((a,b)=>b.n-a.n||b.r-a.r);
  const flush=cards.every(c=>c.s===cards[0].s), uniq=[...new Set(ranks)].sort((a,b)=>b-a);
  const straight=uniq.length===5&&uniq[0]-uniq[4]===4;
  let rank=0,tie=ranks;
  if(straight&&flush){rank=8;tie=[uniq[0]];}else if(groups[0].n===4){rank=7;tie=[groups[0].r,...ranks.filter(r=>r!==groups[0].r)];}
  else if(groups[0].n===3&&groups[1]?.n===2){rank=6;tie=groups.map(g=>g.r);}
  else if(flush){rank=5;tie=ranks;}else if(straight){rank=4;tie=[uniq[0]];}
  else if(groups[0].n===3){rank=3;tie=groups.map(g=>g.r);}
  else if(groups[0].n===2&&groups[1]?.n===2){rank=2;tie=groups.map(g=>g.r);}
  else if(groups[0].n===2){rank=1;tie=groups.map(g=>g.r);}else{rank=0;tie=ranks;}
  return {rank,tie,label:["高牌","一对","两对","三条","顺子","同花","葫芦","四条","同花顺"][rank]};
}
function startPoker(room,p){
  const opp=room.players.find(x=>x.id!==p.id);if(!opp)return note(p,"需要另一名玩家参与德国扑克。");
  const suits=["橡果","叶子","红心","铃铛"],ranks=[7,8,9,10,11,12,13,14];
  const deck=shuffle(suits.flatMap(s=>ranks.map(r=>({s,r}))));
  const a=deck.slice(0,5),b=deck.slice(5,10),sa=pokerScore(a),sb=pokerScore(b);
  const cmp=sa.rank-sb.rank||(()=>{for(let i=0;i<Math.max(sa.tie.length,sb.tie.length);i++){const d=(sa.tie[i]||0)-(sb.tie[i]||0);if(d)return d;}return 0;})();
  const winner=cmp===0?null:cmp>0?p:opp;
  const pokerId=crypto.randomUUID();
  room.poker={id:pokerId,starter:p.id,waiting:false,results:{winnerId:winner?.id||null,a:{player:p.name,hand:sa.label,cards:a.map(c=>`${c.s}${c.r}`)},b:{player:opp.name,hand:sb.label,cards:b.map(c=>`${c.s}${c.r}`)}}};
  if(winner){winner.pokerWins++;winner.points++;log(room,`德国扑克：${winner.name} 获胜（${winner.id===p.id?sa.label:sb.label}），获得 1 点目标分。`);checkGoals(room,winner,"poker");}else log(room,"德国扑克平局。");
  p.secretActions++;setTimeout(()=>{if(room.poker?.id===pokerId){room.poker=null;broadcast(room);}},12000);
  note(p,`你的牌型：${sa.label}。对手牌型：${sb.label}。`);note(opp,`你的牌型：${sb.label}。对手牌型：${sa.label}。`);
}
function act(room,p,msg){
  if(!room.players.includes(p))return;
  const opponent=()=>room.players.find(x=>x.id!==p.id);
  if(msg.type==="start"&&room.phase==="lobby"&&room.players.length===2&&room.players[0]===p){
    room.phase="reveal";room.revealUntil=Date.now()+8000;log(room,"地图公开 8 秒：记忆地形后开始。");broadcast(room);
    setTimeout(()=>{if(room.phase==="reveal"){room.phase="play";room.current=rand(2);room.players.forEach(x=>{x.rolled=false;x.actions=0;});log(room,`记忆阶段结束，${room.players[room.current].name} 先行动。`);broadcast(room);}},8000);
  } else if(msg.type==="roll"&&room.phase==="play"&&room.players[room.current]===p&&!p.rolled){
    p.lastDice=1+rand(6);p.actions=p.blinded?Math.max(1,Math.ceil(p.lastDice/2)):p.lastDice;if(p.blinded)p.blinded=false;p.rolled=true;log(room,`${p.name} 掷出 ${p.lastDice}，获得 ${p.actions} 点行动力。`);
  } else if(msg.type==="move"&&room.phase==="play"&&room.players[room.current]===p&&p.rolled){
    const i=Number(msg.cell);if(!Number.isInteger(i)||i<0||i>63||room.board[i].blocked||i===p.pos)return;
    const d=dist(p.pos,i),a=pos(p.pos),b=pos(i);if(d>p.actions||!(a.r===b.r||a.c===b.c))return;
    let r=a.r,c=a.c,dr=Math.sign(b.r-a.r),dc=Math.sign(b.c-a.c);
    for(let k=1;k<=d;k++){r+=dr;c+=dc;if(room.board[r*8+c].blocked)return;}
    p.actions-=d;p.pos=i;explore(room,p,i);if(room.board[i].trap)useTrap(room,p,room.board[i]);
    if(opponent()?.pos===p.pos)log(room,"两名旅人相遇！可以发起攻击或挑战德国扑克。");
  } else if(msg.type==="useCard"&&room.phase==="play"&&room.players[room.current]===p&&p.rolled){card(room,p,msg);}
  else if(msg.type==="attack"&&room.phase==="play"&&room.players[room.current]===p&&p.rolled){
    const o=opponent();if(!o||o.pos!==p.pos||p.actions<1){note(p,"需要与对手处于同一格且至少有 1 点行动力。");}
    else{const dmg=1+(p.weaponBonus||0);p.weaponBonus=0;p.actions--;damage(room,p,o,dmg);checkGoals(room,p,"combat");}
  } else if(msg.type==="guess"&&room.phase==="play"&&room.players[room.current]===p){
    const o=opponent(),guess=String(msg.name||"").trim(),g=o?.targets.find(x=>x.name===guess);
    if(g&&g.name===guess){p.points++;p.secretActions++;p.correctGuesses=(p.correctGuesses||0)+1;log(room,`${p.name} 猜中对手目标「${g.name}」，获得 1 点。`);checkGoals(room,p,"guess");}
    else{log(room,`${p.name} 猜错目标。`);o.falseGuesses=(o.falseGuesses||0)+1;checkGoals(room,o,"deceive");checkGoals(room,p,"guess");}
  } else if(msg.type==="transfer"&&room.phase==="play"&&room.players[room.current]===p&&p.transfer){
    const i=Number(msg.targetIndex),g=p.targets[i];if(g&&!g.done){const options=GOALS.filter(x=>!p.targets.some(t=>t.id===x[0]));if(options.length){p.targets[i]=makeGoal(pick(options)[0]);p.transfer=false;log(room,`${p.name} 使用转移卡更换了目标。`);}}
  } else if(msg.type==="poker"&&room.phase==="play"&&room.players[room.current]===p&&p.rolled){if(room.board[p.pos].t!==6)note(p,"德国扑克桌设在草地格，请先移动到草地。");else if(p.actions<1)note(p,"挑战德国扑克需要 1 点行动力。");else{p.actions--;startPoker(room,p);}}
  else if(msg.type==="endTurn"&&room.phase==="play"&&room.players[room.current]===p&&p.rolled){finishTurn(room,p);if(room.phase!=="over")log(room,`${room.players[room.current].name} 的回合开始。`);return;}
  broadcast(room);
}
wss.on("connection",ws=>{
  let room=null,player=null;
  ws.on("message",raw=>{
    let msg;try{msg=JSON.parse(raw.toString())}catch{return;}
    if(!msg||typeof msg.type!=="string")return;
    if(msg.type==="join"){
      const name=String(msg.name||"旅人").trim().slice(0,18)||"旅人",code=String(msg.roomCode||"").trim().toUpperCase(),token=String(msg.token||"");
      if(code&&token){const existing=rooms.get(code)?.players.find(x=>x.token===token);if(existing){room=rooms.get(code);player=existing;player.ws=ws;send(ws,{type:"joined",roomCode:room.code,playerId:player.id,token:player.token});broadcast(room);return;}}
      if(code){room=rooms.get(code);if(!room){send(ws,{type:"error",message:"房间码不存在。"});return;}if(room.players.length>=2){send(ws,{type:"error",message:"房间已满。"});return;}if(room.phase!=="lobby"){send(ws,{type:"error",message:"游戏已开始，不能中途加入。"});return;}player=addPlayer(room,name,ws);}
      else{room=makeRoom(name,ws);player=room.players[0];}
      send(ws,{type:"joined",roomCode:room.code,playerId:player.id,token:player.token});log(room,`${player.name} 加入房间。`);broadcast(room);return;
    }
    if(room&&player)act(room,player,msg);
  });
  ws.on("close",()=>{if(room&&player){player.ws=null;log(room,`${player.name} 连接暂时中断，可用同一浏览器刷新重连。`);broadcast(room);}});
  ws.on("error",()=>{});
});
setInterval(()=>{const cutoff=Date.now()-1000*60*60*6;for(const [k,r] of rooms)if(r.createdAt<cutoff&&r.players.every(p=>!p.ws))rooms.delete(k);},60000).unref();
const port=process.env.PORT||3000;server.listen(port,()=>console.log(`迷途者 v2.0.0 listening on ${port}`));
