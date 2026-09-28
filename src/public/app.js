import {createGame,candidates,applyMove,rotations,VERSION} from './engine.js';
const $=id=>document.getElementById(id);
const colors={I:'#81d4d6',O:'#e5c877',T:'#b6a0d5',S:'#a4ca9a',Z:'#df8977',J:'#89acd4',L:'#eba36c'};
const configIds=['provider','endpoint','model','api-key','timeout'];
const reducedMotion=matchMedia('(prefers-reduced-motion: reduce)');
const playback=()=>reducedMotion.matches?0:Number($('speed').value);
const newSeed=()=>`${Date.now()}-${crypto.getRandomValues(new Uint32Array(1))[0]}`;
let game=createGame(newSeed()),run=null,active=false,busy=false,epoch=0,controller=null;
let ghost=null,moving=null,flash=[],checking=false,checkController=null;
let elapsedBase=0,activeSince=null,flashProgress=0,clearTimer=null;
const quantile=(xs,p)=>xs.length?[...xs].sort((a,b)=>a-b)[Math.max(0,Math.ceil(xs.length*p)-1)]:null;
const msText=n=>n===null?'—':`${n<10?n.toFixed(1):Math.round(n)} ms`;
const elapsed=()=>elapsedBase+(activeSince===null?0:performance.now()-activeSince);
function clockStart(){if(activeSince===null)activeSince=performance.now();}
function clockStop(){if(activeSince!==null){elapsedBase+=performance.now()-activeSince;activeSince=null;}}
function config(){return {baseURL:$('endpoint').value.trim(),apiKey:$('api-key').value.trim(),model:$('model').value.trim(),timeoutMs:Number($('timeout').value)};}
function label(){return $('model').value.trim()||'No model configured';}
function message(text){$('error-message').hidden=!text;$('error-message').textContent=text;}
function status(text,description){$('status').textContent=text;document.querySelector('.arena').dataset.phase=text.toLowerCase();if(description)$('phase-description').textContent=description;}
function updateProvider(){
  const mode=$('provider').value;
  $('provider-help').textContent=mode==='jev'?'One model request per piece, using the board and calculated placement outcomes.':'Jev-compatible decision API. Key optional for unauthenticated services.';
  $('api-key').placeholder=mode==='jev'?'Paste your Jev API key':'Optional for unauthenticated services';
  message('');
  if(mode==='jev'){$('endpoint').value='https://api.typesafe.ai';$('model').value='jev-latest';}
  if(mode==='custom'){$('endpoint').value='http://127.0.0.1:8000';$('model').value='';}
  $('check-message').textContent='Uses POST /v1/systemone. Testing makes one model request.';
  $('player-label').textContent=label();$('run-kind').textContent='Model API';
  $('timing-note').textContent='API latency includes network and server time. Active time includes animation, excludes pauses.';
}
function syncControls(){
  const locked=!!run||checking;
  configIds.forEach(id=>$(id).disabled=locked);
  $('check').disabled=locked;
  $('start').disabled=active||busy||!!run?.finished||checking;
  $('step').disabled=active||busy||!!run?.finished||checking;
  $('pause').disabled=!active&&!busy;
  $('finish').disabled=!run||run.finished;
  $('reset').disabled=checking;
  $('export').disabled=!run;
  $('start').textContent=run&&!run.finished?'▶ Resume':'▶ Start';
  $('board-overlay').hidden=!!run;
}
function rect(ctx,x,y,color,alpha=1,size=60){
  ctx.globalAlpha=alpha;ctx.fillStyle=color;ctx.fillRect(x*size+3,y*size+3,size-6,size-6);
  ctx.fillStyle='#ffffff30';ctx.fillRect(x*size+3,y*size+3,size-6,3);
  ctx.globalAlpha=1;
}
function drawShape(ctx,type,pose,alpha=1){rotations(type)[pose.rotation].forEach((row,y)=>row.forEach((v,x)=>{if(v)rect(ctx,pose.x+x,pose.y+y,colors[type],alpha);}));}
function draw(){
  const ctx=$('board').getContext('2d');ctx.clearRect(0,0,600,1200);ctx.fillStyle='#111c18';ctx.fillRect(0,0,600,1200);
  ctx.strokeStyle='#26362b';ctx.lineWidth=1;
  for(let x=0;x<=10;x++){ctx.beginPath();ctx.moveTo(x*60,0);ctx.lineTo(x*60,1200);ctx.stroke();}
  for(let y=0;y<=20;y++){ctx.beginPath();ctx.moveTo(0,y*60);ctx.lineTo(600,y*60);ctx.stroke();}
  game.board.forEach((row,y)=>row.forEach((v,x)=>{if(v)rect(ctx,x,y,colors[v]||'#a4ca9a');}));
  const type=game.sequence[game.placed];
  if(type&&!run?.finished){
    if(ghost){
      drawShape(ctx,type,ghost,.18);
      ctx.strokeStyle=colors[type];ctx.lineWidth=2;ctx.setLineDash([8,6]);
      for(const [x,y]of ghost.cells)ctx.strokeRect(x*60+4,y*60+4,52,52);
      ctx.setLineDash([]);
    }
    drawShape(ctx,type,moving||{x:Math.floor((10-rotations(type)[0][0].length)/2),y:0,rotation:0},.95);
  }
  for(const y of flash){ctx.fillStyle=`rgba(228,247,204,${.35+.5*flashProgress})`;ctx.fillRect(0,y*60,600,60);ctx.fillStyle='#ffffff';ctx.fillRect(300*(1-flashProgress),y*60+27,600*flashProgress,6);}
  const nc=$('next-piece').getContext('2d');nc.clearRect(0,0,160,120);
  const next=game.sequence[game.placed+1];
  if(next){const shape=rotations(next)[0];const ox=(160-shape[0].length*30)/2,oy=(120-shape.length*30)/2;
    shape.forEach((row,y)=>row.forEach((v,x)=>{if(v){nc.fillStyle=colors[next];nc.fillRect(ox+x*30+2,oy+y*30+2,26,26);}}));}
}
function tokenUsage(){
  const attempts=(run?.attempts||[]).filter(a=>a.status!=='pending');
  const values=key=>attempts.map(a=>a.usage?.[key]).filter(n=>Number.isSafeInteger(n)&&n>=0);
  const input=values('input_tokens'),output=values('output_tokens');
  const sum=values=>values.length?values.reduce((a,b)=>a+b,0):null;
  const inputTokens=sum(input),outputTokens=sum(output);
  const reportedRequests=attempts.filter(a=>Number.isSafeInteger(a.usage?.input_tokens)&&a.usage.input_tokens>=0&&Number.isSafeInteger(a.usage?.output_tokens)&&a.usage.output_tokens>=0).length;
  return {inputTokens,outputTokens,totalTokens:inputTokens===null&&outputTokens===null?null:(inputTokens??0)+(outputTokens??0),
    reportedRequests,requests:attempts.length,status:!input.length&&!output.length?'not_reported':reportedRequests===attempts.length?'complete':'partial'};
}
function metrics(){
  const attempts=run?.attempts||[];
  const latencies=attempts.filter(a=>a.latencyMs!==undefined&&a.status!=='error').map(a=>a.latencyMs);
  $('lines').textContent=game.lines;$('score').textContent=game.score;$('placed').textContent=game.placed;
  $('latency-p50').textContent=msText(quantile(latencies,.5));$('latency-p95').textContent=msText(quantile(latencies,.95));
  $('elapsed').textContent=`${(elapsed()/1000).toFixed(1)} s`;
  const usage=tokenUsage();
  for(const [id,key]of [['tokens-input','inputTokens'],['tokens-output','outputTokens'],['tokens-total','totalTokens']])
    $(id).textContent=usage[key]===null?'—':usage[key].toLocaleString('en-US');
  $('token-note').textContent=usage.status==='not_reported'?'Tokens: not reported yet.':`${usage.status==='partial'?'Partial usage':'Reported usage'} · ${usage.reportedRequests}/${usage.requests} requests include both counts.`;
  $('request-count').textContent=`${attempts.length} / ${attempts.filter(a=>a.status==='error').length} / ${attempts.filter(a=>a.status==='cancelled').length}`;
}
function showDecision(type,move,result){
  const root=$('decision-content');root.replaceChildren();
  const title=document.createElement('div');title.className='choice-title';
  const badge=document.createElement('span');badge.className='piece-badge';badge.textContent=type;
  const words=document.createElement('div');const b=document.createElement('b');b.textContent=`${type} → column ${move.x+1}`;
  const small=document.createElement('small');small.textContent=`${move.id} · ${msText(result.latencyMs)}`;words.append(b,small);title.append(badge,words);
  const description=document.createElement('div');description.className='choice-description';description.textContent=`Rotate ${move.rotation*90}°, land at row ${move.y+1}. Selected by the model from legal placements.`;
  const row=document.createElement('div');row.className='confidence-row';
  const left=document.createElement('span');left.textContent='Model confidence';const right=document.createElement('span');right.textContent=result.confidence==null?'Not reported':result.confidence.toFixed(3);row.append(left,right);
  const state=document.createElement('span');state.id='decision-status';state.className='decision-state';state.textContent='Selected · not placed yet';
  root.append(title,state,description);
  if(result.effects){
    const effects=result.effects,summary=document.createElement('div');summary.className='outcome-chips';
    for(const text of [`${effects.linesCleared} lines`,`${effects.holes} holes`,`Height ${effects.maxHeight}`]){const chip=document.createElement('span');chip.textContent=text;summary.append(chip);}
    root.append(summary);
  }
  root.append(row);
  $('decision-data').textContent=JSON.stringify({piece:type,choice:move.id,rotation:move.rotation,x:move.x,y:move.y,cells:move.cells,model:result.model,latencyMs:result.latencyMs,confidence:result.confidence,probabilities:result.probabilities,usage:result.usage,effects:result.effects,preparationMs:result.preparationMs},null,2);
}
function begin(){
  if(run)return true;
  const provider=$('provider').value,c=config();
  if(!c.baseURL||!c.model){message('Enter an API URL and model ID first.');return false;}
  if(provider==='jev'&&!c.apiKey){message('Enter your Jev API key to start.');return false;}
  game=createGame(game.seed);
  elapsedBase=0;
  run={version:VERSION,id:crypto.randomUUID(),createdAt:new Date().toISOString(),provider,
    model:c.model,seed:game.seed,
    rules:'10x20 / 7-bag / rotate-at-spawn, slide, straight descent / no kicks, hold or tucks',
    steps:[],attempts:[],finished:false,result:'In progress',elapsedMs:0,score:0,lines:0,placed:0};
  $('player-label').textContent=run.model;syncControls();metrics();return true;
}
function pause(quiet=false){
  active=false;epoch++;controller?.abort();controller=null;busy=false;clockStop();
  const attempt=run?.attempts.at(-1),selected=attempt?.status==='selected';
  if(attempt?.status==='pending'||selected)attempt.status='cancelled';
  ghost=null;moving=null;flash=[];clearTimeout(clearTimer);$('clear-event').hidden=true;
  if(selected&&$('decision-status'))$('decision-status').textContent='Cancelled · not placed';
  if(!quiet&&run&&!run.finished)status('Paused','Resume or step to choose the next piece.');
  syncControls();metrics();draw();
}
function snapshot(){
  if(!run)return null;
  return {...run,elapsedMs:elapsed(),score:game.score,lines:game.lines,placed:game.placed,
    tokenUsage:tokenUsage(),
    metrics:{decisionP50Ms:quantile(run.attempts.filter(a=>a.latencyMs!==undefined&&a.status!=='error').map(a=>a.latencyMs),.5),decisionP95Ms:quantile(run.attempts.filter(a=>a.latencyMs!==undefined&&a.status!=='error').map(a=>a.latencyMs),.95)},
    measurement:'API roundtrip includes network; active time includes animation, excludes user pauses. '};
}
function finish(reason){
  pause(true);if(!run)return;run.finished=true;run.result=reason;run.elapsedMs=elapsed();
  status(reason,'Export this run to keep its record.');syncControls();draw();
}
const errors={timeout:'Model request timed out. Resume to retry, or finish the run.',connection_failed:'Cannot connect. Check the URL, local server, model service, and network.',invalid_choice:'The model returned an illegal placement. Paused without a fallback.',invalid_probabilities:'Invalid probability distribution. Check protocol compatibility.',invalid_response:'The service returned an invalid System One response.',invalid_url:'Use HTTPS, or HTTP on localhost / 127.0.0.1. No credentials, query string, or fragment allowed.',invalid_model:'Enter a valid model ID.',invalid_key:'Invalid API key format.',upstream_401:'Authentication failed (401). Check your API key.',upstream_403:'Access denied by the model service (403).',upstream_429:'Rate limited by the model service (429). Wait before resuming.',cancelled:'Request cancelled.'};
function errorText(code){return errors[code]||(/^upstream_\d{3}$/.test(code)?`Model service returned HTTP ${code.slice(9)}. Paused.`:'Request failed. Check settings and protocol compatibility.');}
async function remoteDecision(){
  controller=new AbortController();
  const response=await fetch('/api/decide',{method:'POST',headers:{'content-type':'application/json'},signal:controller.signal,
    body:JSON.stringify({config:config(),game:{board:game.board,sequence:game.sequence.slice(game.placed,game.placed+2),placed:0}})});
  const body=await response.json();if(!response.ok)throw new Error(body.error||'connection_failed');return body;
}
function animate(duration,update,token){
  return new Promise(resolve=>{
    let last=performance.now(),elapsedMs=0;
    const frame=now=>{
      if(token!==epoch){resolve(false);return;}
      const speed=playback();
      elapsedMs=speed?Math.min(duration,elapsedMs+Math.min(now-last,100)*speed):duration;
      last=now;update(elapsedMs/duration);
      if(elapsedMs>=duration){resolve(true);return;}
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
}
async function animateMove(move,token){
  const timeline=[0];
  for(let i=1;i<move.path.length;i++){
    const from=move.path[i-1],to=move.path[i];
    timeline.push(timeline.at(-1)+(to.y!==from.y?65:to.rotation!==from.rotation?160:90));
  }
  let index=1;
  return animate(Math.max(1,timeline.at(-1)),progress=>{
    const elapsedMs=progress*timeline.at(-1);
    while(index<timeline.length&&elapsedMs>=timeline[index])index++;
    if(index>=timeline.length)moving=move.path.at(-1);
    else{
      const from=move.path[index-1],to=move.path[index];
      const fraction=(elapsedMs-timeline[index-1])/(timeline[index]-timeline[index-1]);
      moving={x:from.x+(to.x-from.x)*fraction,y:from.y+(to.y-from.y)*fraction,rotation:to.rotation};
    }
    draw();
  },token);
}
function showClear(lines,points){
  const event=$('clear-event');clearTimeout(clearTimer);
  event.textContent=`${['','SINGLE','DOUBLE','TRIPLE','FOUR LINES'][lines]} · +${points}`;
  event.hidden=false;
  clearTimer=setTimeout(()=>{event.hidden=true;},1600);
}
async function tick(){
  if(busy||run?.finished)return;
  const choices=candidates(game.board,game.sequence[game.placed]);
  if(!choices.length){finish('Game over');return;}
  const token=epoch;busy=true;clockStart();message('');status('Thinking','Choosing a placement for the current piece.');syncControls();
  const attempt={pieceIndex:game.placed,status:'pending'};run.attempts.push(attempt);metrics();
  try{
    const result=await remoteDecision();
    if(token!==epoch)return;
    Object.assign(attempt,{status:'selected',latencyMs:result.latencyMs,model:result.model,choice:result.choice,usage:result.usage});
    const move=choices.find(m=>m.id===result.choice);if(!move)throw new Error('invalid_choice');
    const type=game.sequence[game.placed];showDecision(type,move,result);ghost=move;
    status('Selected',`${type} → column ${move.x+1} · ${move.rotation*90}°`);metrics();draw();
    if(playback()&&!await animate(500,()=>{},token))return;
    if(token!==epoch)return;
    status('Placing','Rotate → move → drop');
    if(playback()&&!await animateMove(move,token))return;
    if(token!==epoch)return;
    moving=move.path.at(-1);draw();
    if(playback()&&!await animate(160,()=>{},token))return;
    if(token!==epoch)return;
    const before=game.board.map(row=>[...row]);for(const [x,y]of move.cells)before[y][x]=type;
    flash=before.flatMap((row,y)=>row.every(Boolean)?[y]:[]);flashProgress=0;
    if(flash.length){
      status('Clearing',`${flash.length} ${flash.length===1?'line':'lines'} complete`);
      if(playback()&&!await animate(420,progress=>{flashProgress=progress;draw();},token))return;
    }
    if(token!==epoch)return;
    const oldScore=game.score,oldLines=game.lines;
    game=applyMove(game,move.id);attempt.status='executed';
    $('decision-status').textContent='Placed';
    if(game.lines>oldLines)showClear(game.lines-oldLines,game.score-oldScore);
    run.steps.push({piece:type,choice:move.id,rotation:move.rotation,x:move.x,y:move.y,cells:move.cells,
      board:game.board.map(row=>[...row]),placed:game.placed,lines:game.lines,score:game.score,
      latencyMs:result.latencyMs,confidence:result.confidence,model:result.model,effects:result.effects,preparationMs:result.preparationMs});
    ghost=null;moving=null;flash=[];busy=false;controller=null;draw();metrics();
    if(!candidates(game.board,game.sequence[game.placed]).length){finish('Game over');return;}
    if(active){status('Placed','Preparing the next piece.');syncControls();setTimeout(()=>{if(token===epoch&&active)tick();},playback()?220/playback():0);}
    else{clockStop();status('Paused','Step complete. Resume or step again.');syncControls();metrics();}
  }catch(error){
    if(token!==epoch)return;
    attempt.status='error';attempt.error=/^[a-z_0-9]+$/.test(error.message)?error.message:'connection_failed';
    active=false;busy=false;controller=null;clockStop();ghost=null;moving=null;flash=[];
    status('API error','Paused. No automatic retry or fallback decision.');message(errorText(attempt.error));syncControls();metrics();draw();
  }
}
function reset(){
  pause(true);run=null;elapsedBase=0;game=createGame(newSeed());
  $('decision-data').textContent='Not started.';$('decision-content').replaceChildren();
  const note=document.createElement('p');note.className='field-note';note.textContent='Waiting for the first decision.';$('decision-content').append(note);
  message('');status('Ready','Click Start to play.');$('player-label').textContent=label();
  $('run-kind').textContent='Model API';syncControls();metrics();draw();
}
function download(data){const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=`dropwise-${data.id}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
$('provider').addEventListener('change',()=>{$('api-key').value='';updateProvider();});
$('speed').onchange=()=>{$('pace-note').textContent=playback()?'Preview → drop → clear':reducedMotion.matches?'Reduced motion · instant placement':'Fast play · no animation delay';};
reducedMotion.addEventListener('change',()=>{$('speed').onchange();});
$('speed').onchange();
$('model').addEventListener('input',()=>{$('player-label').textContent=label();});
$('start').onclick=()=>{if(!begin())return;active=true;tick();};
$('step').onclick=()=>{if(!begin())return;active=false;tick();};
$('pause').onclick=()=>pause();$('reset').onclick=reset;$('finish').onclick=()=>finish('Run finished');
$('export').onclick=()=>{const data=snapshot();if(data)download(data);};
$('check').onclick=async()=>{
  checking=true;checkController=new AbortController();syncControls();$('check-message').textContent='Checking connection…';
  try{const response=await fetch('/api/check',{method:'POST',headers:{'content-type':'application/json'},signal:checkController.signal,body:JSON.stringify({config:config()})});
    const data=await response.json();if(!response.ok)throw new Error(data.error);
    $('check-message').textContent=`Connected · ${data.model||'Model version not reported'} · ${msText(data.latencyMs)}. Start a run to evaluate gameplay.`;
  }catch(e){$('check-message').textContent=errorText(e.message);}
  finally{checking=false;checkController=null;syncControls();}
};
window.addEventListener('pagehide',()=>{checkController?.abort();pause(true);});
setInterval(()=>{if(activeSince!==null)metrics();},200);
updateProvider();syncControls();metrics();draw();
