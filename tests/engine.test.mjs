import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, candidates, applyMove, rotations, fits, settle } from '../src/public/engine.js';
const empty = () => Array.from({length:20}, () => Array(10).fill(0));

test('seed produces reproducible seven-bags and different seeds differ', () => {
  const a=createGame('demo',70), b=createGame('demo',70), c=createGame('other',70);
  assert.deepEqual(a.sequence,b.sequence);
  assert.notDeepEqual(a.sequence,c.sequence);
  for(let i=0;i<70;i+=7) assert.equal(new Set(a.sequence.slice(i,i+7)).size,7);
});

test('piece generation continues beyond the old 504-piece limit and remains reproducible', () => {
  let game=createGame('long-run');
  const seen=[];
  for(let i=0;i<1200;i++){
    seen.push(game.sequence[game.placed]);
    game=applyMove({...game,board:empty()},candidates(empty(),game.sequence[game.placed])[0].id);
    assert.ok(game.sequence[game.placed+1]);
  }
  assert.deepEqual(seen,createGame('long-run',1200).sequence.slice(0,1200));
});
test('unique rotations and empty board landing counts are exact', () => {
  assert.equal(rotations('O').length,1); assert.equal(rotations('I').length,2);
  assert.equal(rotations('T').length,4);
  assert.equal(candidates(empty(),'O').length,9);
  assert.equal(candidates(empty(),'I').length,17);
});
test('all offered moves have collision-free paths and grounded destinations', () => {
  const board=empty(); board[19][3]='T'; board[18][3]='T';
  for(const m of candidates(board,'L')) {
    for(const p of m.path) assert.ok(fits(board, rotations('L')[p.rotation],p.x,p.y));
    assert.equal(fits(board,rotations('L')[m.rotation],m.x,m.y+1),false);
  }
});
test('clears four lines, shifts the board and never mutates the input', () => {
  const board=empty(); for(let y=16;y<20;y++) board[y].fill('T',1);
  board[15][9]='J'; const before=structuredClone(board);
  const m=candidates(board,'I').find(m=>m.rotation===1&&m.x===0);
  const result=settle(board,'I',m);
  assert.equal(result.lines,4); assert.equal(result.score,800);
  assert.equal(result.board[19][9],'J'); assert.deepEqual(board,before);
  assert.equal(result.board.flat().filter(Boolean).length,1);
});
test('blocked spawn offers no moves, including tempting distant columns', () => {
  const board=empty(); board[0][4]='J';
  assert.equal(candidates(board,'O').length,0);
});
test('invalid choices do not alter game and valid moves advance only once', () => {
  const g=createGame('run'); const before=structuredClone(g);
  assert.throws(()=>applyMove(g,'invalid')); assert.deepEqual(g,before);
  const m=candidates(g.board,g.sequence[0])[0]; const next=applyMove(g,m.id);
  assert.equal(next.placed,1); assert.equal(g.placed,0);
  assert.equal(next.board.flat().filter(Boolean).length,4);
});
test('recorded legal choices reproduce the same game', () => {
  let a=createGame('2026'), b=createGame('2026');
  for(let i=0;i<20;i++) {
    const list=candidates(a.board,a.sequence[a.placed]); assert.ok(list.length);
    const id=list.sort((x,y)=>y.y-x.y)[0].id;
    a=applyMove(a,id); b=applyMove(b,id);
  }
  assert.equal(a.placed,20); assert.deepEqual(a,b);
});
