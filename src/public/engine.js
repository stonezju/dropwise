export const WIDTH = 10, HEIGHT = 20;
export const VERSION = 'blocks-v1';
export const SHAPES = {
  I:[[1,1,1,1]], O:[[1,1],[1,1]], T:[[0,1,0],[1,1,1]],
  S:[[0,1,1],[1,1,0]], Z:[[1,1,0],[0,1,1]],
  J:[[1,0,0],[1,1,1]], L:[[0,0,1],[1,1,1]],
};
const rotationCache = new Map();
export function rotations(type) {
  if(!SHAPES[type]) throw new Error('Unknown piece');
  if(!rotationCache.has(type)) {
    const result=[]; let m=SHAPES[type];
    for(let i=0;i<4;i++) {
      if(!result.some(r=>JSON.stringify(r)===JSON.stringify(m))) result.push(m);
      m=m[0].map((_,x)=>m.map(row=>row[x]).reverse());
    }
    rotationCache.set(type,result);
  }
  return rotationCache.get(type);
}
export function createGame(seed='2026',minPieces=7) {
  let n=2166136261;
  for(const c of String(seed)) n=Math.imul(n^c.charCodeAt(0),16777619);
  return extendSequence({seed:String(seed),randomState:n,board:Array.from({length:HEIGHT},()=>Array(WIDTH).fill(0)),sequence:[],placed:0,lines:0,score:0},minPieces);
}
function extendSequence(game,minPieces) {
  if(game.sequence.length>=minPieces)return game;
  let n=game.randomState;
  const random=()=>{
    n=(n+0x6D2B79F5)|0; let t=Math.imul(n^(n>>>15),1|n);
    t^=t+Math.imul(t^(t>>>7),61|t); return ((t^(t>>>14))>>>0)/4294967296;
  };
  const sequence=[...game.sequence];
  while(sequence.length<minPieces) {
    const bag=Object.keys(SHAPES);
    for(let i=bag.length-1;i>0;i--) {const j=Math.floor(random()*(i+1)); [bag[i],bag[j]]=[bag[j],bag[i]];}
    sequence.push(...bag);
  }
  return {...game,sequence,randomState:n};
}
export function fits(board,shape,x,y) {
  return shape.every((row,dy)=>row.every((cell,dx)=>!cell||
    (x+dx>=0&&x+dx<WIDTH&&y+dy>=0&&y+dy<HEIGHT&&!board[y+dy][x+dx])));
}
export function candidates(board,type) {
  const shapes=rotations(type), spawn=Math.floor((WIDTH-shapes[0][0].length)/2);
  if(!fits(board,shapes[0],spawn,0)) return [];
  const result=[]; const rotatePath=[{x:spawn,y:0,rotation:0}];
  for(let r=0;r<shapes.length;r++) {
    const shape=shapes[r];
    if(!fits(board,shape,spawn,0)) break;
    if(r) rotatePath.push({x:spawn,y:0,rotation:r});
    for(let x=0;x<=WIDTH-shape[0].length;x++) {
      const path=rotatePath.map(p=>({...p})); let cur=spawn, valid=true;
      while(cur!==x) {
        cur+=Math.sign(x-cur);
        if(!fits(board,shape,cur,0)) {valid=false;break;}
        path.push({x:cur,y:0,rotation:r});
      }
      if(!valid) continue;
      let y=0;
      while(fits(board,shape,x,y+1)) {y++;path.push({x,y,rotation:r});}
      const cells=[];
      shape.forEach((row,dy)=>row.forEach((v,dx)=>{if(v) cells.push([x+dx,y+dy]);}));
      result.push({id:`r${r}x${x}y${y}`,rotation:r,x,y,cells,path});
    }
  }
  return result;
}
export function settle(board,type,move) {
  if(!move||!fits(board,rotations(type)[move.rotation],move.x,move.y)) throw new Error('Invalid placement');
  const out=board.map(row=>[...row]);
  for(const [x,y] of move.cells) out[y][x]=type;
  const cleared=[];
  out.forEach((row,y)=>{if(row.every(Boolean)) cleared.push(y);});
  const remaining=out.filter(row=>!row.every(Boolean));
  while(remaining.length<HEIGHT) remaining.unshift(Array(WIDTH).fill(0));
  return {board:remaining,lines:cleared.length,score:[0,100,300,500,800][cleared.length],cleared};
}
export function applyMove(game,id) {
  const type=game.sequence[game.placed];
  const move=candidates(game.board,type).find(m=>m.id===id);
  if(!move) throw new Error('Invalid choice');
  const next=settle(game.board,type,move);
  return extendSequence({...game,board:next.board,placed:game.placed+1,lines:game.lines+next.lines,score:game.score+next.score},game.placed+3);
}
