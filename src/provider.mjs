import {candidates,SHAPES,rotations,settle} from './public/engine.js';

export function endpointURL(value) {
  let url;try {url=new URL(value);} catch {throw new Error('invalid_url');}
  if(url.username||url.password||url.search||url.hash) throw new Error('invalid_url');
  if(url.protocol!=='https:' && !(url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname))) throw new Error('invalid_url');
  const path=url.pathname.replace(/\/+$/,'');
  url.pathname=path.endsWith('/systemone')?path:path.endsWith('/v1')?path+'/systemone':path+'/v1/systemone';
  return url.href;
}
function boardStats(board){
  let holes=0;
  const columnHeights=Array.from({length:10},(_,x)=>{
    let top=20;
    for(let y=0;y<20;y++){
      if(board[y][x])top=Math.min(top,y);
      else if(top<y)holes++;
    }
    return 20-top;
  });
  return {holes,maxHeight:Math.max(...columnHeights),aggregateHeight:columnHeights.reduce((a,b)=>a+b,0),
    bumpiness:columnHeights.slice(1).reduce((sum,h,i)=>sum+Math.abs(h-columnHeights[i]),0),columnHeights};
}
function holeDepth(board){
  let depth=0;
  for(let x=0;x<10;x++){
    let cover=0;
    for(let y=0;y<20;y++){if(board[y][x])cover++;else depth+=cover;}
  }
  return depth;
}
function wellStats(heights){
  const depths=heights.map((h,x)=>Math.max(0,Math.min(x?heights[x-1]:20,x<9?heights[x+1]:20)-h));
  return {maxWellDepth:Math.max(...depths),deepWells:depths.filter(d=>d>=3).length,wellCells:depths.reduce((a,b)=>a+b,0)};
}

export function buildRequest(game,model) {
  const type=game?.sequence?.[game?.placed];
  if(!SHAPES[type]||!SHAPES[game?.sequence?.[game?.placed+1]]||!Array.isArray(game.board)||game.board.length!==20||
    game.board.some(row=>!Array.isArray(row)||row.length!==10||row.some(v=>v!==0&&!Object.hasOwn(SHAPES,v)))) throw new Error('invalid_board');
  const choices=candidates(game.board,type);
  if(!choices.length) throw new Error('no_moves');
  const request={model,state:{
    rules:'10 columns, 20 rows; x=0 left, y=0 top. # occupied, . empty. Rotate clockwise at spawn, slide horizontally, then descend vertically until grounded. No hold, wall kicks or tucks. Complete rows disappear. Survive and keep clearing rows.',
    board:game.board.map(row=>row.map(v=>v?'#':'.').join('')),
    current:type,next:game.sequence[game.placed+1],
    orientations:rotations(type).map((shape,rotation)=>({rotation,clockwiseDegrees:rotation*90,shape:shape.map(row=>row.map(v=>v?'#':'.').join(''))})),
  },questions:{move:{type:'choice',instructions:'Choose one placement for long-term survival and repeated scoring. First avoid blocking the known next piece whenever a survivable option exists. Prefer clearing rows without creating covered holes. A move with no immediate clear can be better if it leaves fewer holes, a lower stack and a flatter surface. Avoid sacrificing survival to chase a four-line clear. Consider the known next piece. Use exact placement effects when supplied; otherwise derive consequences from the board and occupied cells. Compare all options; do not assume the first option is best. Return one offered ID.',
    criteria:Object.fromEntries(choices.map(m=>[m.id,{rotation:m.rotation,x:m.x,y:m.y,cells:m.cells}]))}}};
  const before=boardStats(game.board),next=game.sequence[game.placed+1];
  request.state.boardStats={...before,...wellStats(before.columnHeights)};
  request.state.effectDefinitions='Effects are exact after placement AND row removal, not recommendations. holes counts empty cells with a filled cell above in the same column; holesDelta is after minus before. maxHeight and aggregateHeight measure stack height from the floor. bumpiness is the sum of adjacent column height differences. nextLegalMoves=0 means immediate game over for the known next piece. nextMaxLines is the maximum immediate clear available to that next piece, not a guarantee. holeDepth sums the filled cells above each covered empty cell (buried holes are harder to clear). nextMinHoles is the fewest holes achievable after the known next piece. nextCleanTotalLines is the most total lines cleared by current+next while ending with ZERO holes, or null if impossible. These are achievable possibilities, not automatic next decisions; no unknown future pieces are inspected. A well is an open one-column trench below both neighboring columns (walls count as height 20). maxWellDepth is its maximum depth, deepWells counts trenches at least 3 cells deep, wellCells sums their depths. Wells are NOT counted as covered holes; a hole-free board can still be dangerously tall or dependent on multiple I pieces.';
  for(const move of choices){
    const after=settle(game.board,type,move),stats=boardStats(after.board);
    const nextMoves=candidates(after.board,next);
    let nextMaxLines=0,nextMinHoles=null,nextCleanTotalLines=null;
    for(const nextMove of nextMoves){
      const future=settle(after.board,next,nextMove),holes=boardStats(future.board).holes;
      nextMaxLines=Math.max(nextMaxLines,future.lines);
      nextMinHoles=nextMinHoles===null?holes:Math.min(nextMinHoles,holes);
      if(holes===0)nextCleanTotalLines=Math.max(nextCleanTotalLines??0,after.lines+future.lines);
    }
    const {columnHeights,...summary}=stats;
    request.questions.move.criteria[move.id].effects={linesCleared:after.lines,holesDelta:stats.holes-before.holes,...summary,
      nextLegalMoves:nextMoves.length,nextMaxLines,holeDepth:holeDepth(after.board),nextMinHoles,nextCleanTotalLines,...wellStats(columnHeights)};
  }
  return request;
}
export async function decide(config,request,signal) {
  if(!config||typeof config.model!=='string'||!config.model.trim()||config.model.length>120) throw new Error('invalid_model');
  if(typeof config.apiKey!=='string'||config.apiKey.length>4096||/[\r\n]/.test(config.apiKey)) throw new Error('invalid_key');
  const url=endpointURL(config.baseURL);
  const ms=Number(config.timeoutMs??15000);
  if(!Number.isFinite(ms)||ms<100||ms>60000) throw new Error('invalid_timeout');
  const timeout=AbortSignal.timeout(ms), combined=signal?AbortSignal.any([timeout,signal]):timeout;
  const started=performance.now();
  try {
    const response=await fetch(url,{method:'POST',redirect:'error',signal:combined,
      headers:{'content-type':'application/json',...(config.apiKey?{authorization:`Bearer ${config.apiKey}`}:{})},body:JSON.stringify(request)});
    if(!response.ok) {await response.body?.cancel();throw new Error(`upstream_${response.status}`);}
    const reader=response.body.getReader();let size=0;const chunks=[];
    for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>262144){await reader.cancel();throw new Error('invalid_response');}chunks.push(value);}
    let body;try {body=JSON.parse(Buffer.concat(chunks).toString());} catch {throw new Error('invalid_response');}
    const answer=body?.answers?.move, ids=Object.keys(request.questions.move.criteria);
    if(!answer||typeof answer.choice!=='string'||!ids.includes(answer.choice)) throw new Error('invalid_choice');
    let probabilities=null;
    if(answer.probabilities!==undefined) {
      const p=answer.probabilities;
      if(!p||typeof p!=='object'||Array.isArray(p)||Object.keys(p).length!==ids.length||
        ids.some(id=>!Object.hasOwn(p,id)||typeof p[id]!=='number'||!Number.isFinite(p[id])||p[id]<0||p[id]>1)||
        Math.abs(Object.values(p).reduce((a,b)=>a+b,0)-1)>0.02) throw new Error('invalid_probabilities');
      probabilities=Object.fromEntries(ids.map(id=>[id,p[id]]));
    }
    const confidence=typeof answer.confidence==='number'&&answer.confidence>=0&&answer.confidence<=1?answer.confidence:null;
    const usage={};for(const k of ['input_tokens','output_tokens']) if(Number.isSafeInteger(body.usage?.[k])&&body.usage[k]>=0) usage[k]=body.usage[k];
    const actualModel=typeof body.model==='string'&&body.model.length<=120&&!body.model.includes(config.apiKey||'\0')?body.model:null;
    return {choice:answer.choice,confidence,probabilities,model:actualModel,usage,latencyMs:performance.now()-started};
  } catch(error) {
    if(timeout.aborted) throw new Error('timeout');
    if(signal?.aborted) throw new Error('cancelled');
    if(/^(upstream_\d{3}|invalid_response|invalid_choice|invalid_probabilities)$/.test(error.message)) throw error;
    throw new Error('connection_failed');
  }
}
