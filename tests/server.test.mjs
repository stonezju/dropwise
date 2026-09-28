import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createServer} from '../src/server.mjs';
import {endpointURL,buildRequest,decide} from '../src/provider.mjs';
import {createGame,candidates} from '../src/public/engine.js';
async function listen(server) {
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return `http://127.0.0.1:${server.address().port}`;
}
const close=server=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});
const config=url=>({baseURL:url,apiKey:'fixture-secret',model:'test-model',timeoutMs:1000});
const game=createGame('api');
test('endpoint normalization accepts root/version/full path and rejects unsafe URLs',()=>{
  assert.equal(endpointURL('https://api.typesafe.ai'),'https://api.typesafe.ai/v1/systemone');
  assert.equal(endpointURL('http://localhost:8000/v1'),'http://localhost:8000/v1/systemone');
  assert.equal(endpointURL('https://host/api/v1/systemone'),'https://host/api/v1/systemone');
  for(const url of ['file:///a','http://remote.test','https://user:secret@host','https://host/?key=secret']) assert.throws(()=>endpointURL(url));
});
test('observation contains current board, next piece and legal actions only',()=>{
  const req=buildRequest(game,'my-model');
  assert.equal(req.model,'my-model'); assert.equal(req.state.current,game.sequence[0]);
  assert.equal(req.state.next,game.sequence[1]); assert.equal(req.state.sequence,undefined);
  assert.equal(req.questions.move.type,'choice');
  assert.deepEqual(Object.keys(req.state).sort(),['board','boardStats','current','effectDefinitions','next','orientations','rules']);
  assert.ok(Object.keys(req.questions.move.criteria).length>0);
  assert.equal(JSON.stringify(req).includes('heuristic'),false);
});

test('placements include exact outcomes, preserve every legal option, and ignore unknown future pieces',()=>{
  const g=createGame('geometry');g.sequence[0]='I';g.sequence[1]='O';
  for(let y=16;y<20;y++)g.board[y].fill('T',1);
  const before=structuredClone(g),request=buildRequest(g,'test');
  const choices=candidates(g.board,'I');
  assert.deepEqual(Object.keys(request.questions.move.criteria),choices.map(m=>m.id));
  for(const move of choices){
    const {effects,...geometry}=request.questions.move.criteria[move.id];
    assert.deepEqual(geometry,{rotation:move.rotation,x:move.x,y:move.y,cells:move.cells});
    assert.ok(effects.holes>=0);
  }
  assert.deepEqual(request.questions.move.criteria.r1x0y16.effects,{linesCleared:4,holesDelta:0,holes:0,maxHeight:0,aggregateHeight:0,bumpiness:0,nextLegalMoves:9,nextMaxLines:0,holeDepth:0,nextMinHoles:0,nextCleanTotalLines:4,maxWellDepth:0,deepWells:0,wellCells:0});
  assert.deepEqual(g,before);
  assert.equal(request.state.orientations[1].shape.join('/'),'#/#/#/#');
  g.sequence[2]=g.sequence[2]==='O'?'T':'O';
  assert.deepEqual(buildRequest(g,'test'),request);
});

test('real HTTP proxy sends bearer and validates response without returning key',async()=>{
  let received;
  const upstream=http.createServer(async(req,res)=>{
    let text='';for await(const part of req) text+=part;
    const body=JSON.parse(text); received={body,auth:req.headers.authorization,path:req.url};
    const ids=Object.keys(body.questions.move.criteria);
    res.setHeader('content-type','application/json');res.end(JSON.stringify({model:'pinned-v1',answers:{move:{type:'choice',choice:ids[0],probabilities:Object.fromEntries(ids.map((id,i)=>[id,i===0?1:0])),confidence:0.9}},usage:{input_tokens:50,output_tokens:1}}));
  });
  const baseURL=await listen(upstream); const server=createServer();const origin=await listen(server);
  try {
    const r=await fetch(origin+'/api/decide',{method:'POST',headers:{'content-type':'application/json',origin},body:JSON.stringify({config:config(baseURL),game})});
    assert.equal(r.status,200);const result=await r.json();
    assert.equal(result.model,'pinned-v1'); assert.ok(result.latencyMs>=0);
    assert.equal(result.observationVersion,undefined);
    assert.deepEqual(result.effects,received.body.questions.move.criteria[result.choice].effects);
    assert.deepEqual(result.usage,{input_tokens:50,output_tokens:1});
    assert.equal(received.auth,'Bearer fixture-secret');assert.equal(received.path,'/v1/systemone');
    assert.equal(JSON.stringify(result).includes('fixture-secret'),false);
    const blocked=await fetch(origin+'/api/decide',{method:'POST',headers:{'content-type':'application/json',origin:'https://evil.test'},body:'{}'});
    assert.equal(blocked.status,403);
  } finally {await close(server);await close(upstream);}
});
test('unknown choice and bad probabilities are rejected, no fallback',async()=>{
  let invalidChoice=true;
  const upstream=http.createServer(async(req,res)=>{
    let t='';for await(const b of req)t+=b;const ids=Object.keys(JSON.parse(t).questions.move.criteria);
    res.end(JSON.stringify({answers:{move:{choice:invalidChoice?'not-a-choice':ids[0],probabilities:{[ids[0]]:7}}}}));
  });const url=await listen(upstream);
  try {
    await assert.rejects(decide(config(url),buildRequest(game,'x')),/invalid_choice/);
    invalidChoice=false;await assert.rejects(decide(config(url),buildRequest(game,'x')),/invalid_probabilities/);
  } finally {await close(upstream);}
});
test('upstream errors never echo bodies and requests time out',async()=>{
  let hang=false;const upstream=http.createServer((req,res)=>{if(!hang){res.writeHead(401);res.end('fixture-secret');}});
  const url=await listen(upstream);
  try {
    await assert.rejects(decide(config(url),buildRequest(game,'x')),e=>e.message==='upstream_401');
    hang=true;await assert.rejects(decide({...config(url),timeoutMs:100},buildRequest(game,'x')),/timeout/);
  } finally {await close(upstream);}
});
