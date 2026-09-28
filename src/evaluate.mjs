import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {createGame,candidates,applyMove,VERSION} from './public/engine.js';
import {buildRequest,decide} from './provider.mjs';

if(process.argv[2]==='--review'){
  const record=JSON.parse(await readFile(process.argv[3],'utf8'));
  if((record.gameVersion||record.version)!==VERSION)throw new Error('Unsupported game version');
  const reviews=[];
  for(const run of record.runs||[record]){
    let game=createGame(run.seed);
    for(const step of run.steps){
      game=applyMove(game,step.choice);
      if(step.lines!==game.lines||step.score!==game.score||step.board&&JSON.stringify(step.board)!==JSON.stringify(game.board))throw new Error('Trace result does not match reconstructed board');
    }
    reviews.push({seed:run.seed,placed:game.placed,lines:game.lines,score:game.score,verified:true});
  }
  console.log(JSON.stringify({reviews,note:'Verifies recorded moves and results only; does not rate decisions.'},null,2));
  process.exit(0);
}

try{process.loadEnvFile(new URL('../.env',import.meta.url));}catch(e){if(e.code!=='ENOENT')throw new Error('Could not load local .env');}
const options={pieces:30,seeds:['2026']};
for(let i=2;i<process.argv.length;i+=2){
  const name=process.argv[i],value=process.argv[i+1];
  if(!value)throw new Error('Expected --pieces N or --seeds a,b');
  if(name==='--pieces')options.pieces=Number(value);
  else if(name==='--seeds')options.seeds=value.split(',');
  else throw new Error('Unknown evaluation option');
}
if(!Number.isInteger(options.pieces)||options.pieces<1||options.pieces>500||options.seeds.length>10||options.seeds.some(s=>!/^[\w-]{1,64}$/.test(s)))throw new Error('Invalid evaluation options');
const config={baseURL:process.env.JEV_BASE_URL||'https://api.typesafe.ai',apiKey:process.env.JEV_API_KEY||'',model:process.env.JEV_MODEL||'jev-latest',timeoutMs:30000};
if(!config.apiKey&&!process.env.JEV_BASE_URL){console.error('Set JEV_API_KEY in .env or the environment.');process.exit(1);}
const abort=new AbortController();process.on('SIGINT',()=>abort.abort());
const report={createdAt:new Date().toISOString(),gameVersion:VERSION,model:config.model,options,runs:[]};
const percentile=(xs,p)=>xs.length?[...xs].sort((a,b)=>a-b)[Math.max(0,Math.ceil(xs.length*p)-1)]:null;
for(const seed of options.seeds){
  let game=createGame(seed);
  const run={seed,steps:[],result:'piece_limit',calls:0};
  const started=performance.now();let error=null;
  for(let i=0;i<options.pieces;i++){
    if(abort.signal.aborted){error='cancelled';break;}
    if(!candidates(game.board,game.sequence[game.placed]).length){run.result='top_out';break;}
    try{
      const preparationStart=performance.now();
      const request=buildRequest(game,config.model),preparationMs=performance.now()-preparationStart;
      run.instructions=request.questions.move.instructions;
      run.calls++;
      const result=await decide(config,request,abort.signal);
      game=applyMove(game,result.choice);
      run.steps.push({choice:result.choice,model:result.model,latencyMs:result.latencyMs,preparationMs,requestBytes:Buffer.byteLength(JSON.stringify(request)),usage:result.usage,confidence:result.confidence,effects:request.questions.move.criteria[result.choice].effects,lines:game.lines,score:game.score,board:game.board});
      if((i+1)%10===0)console.log(`seed=${seed}: ${i+1} pieces, ${game.lines} lines`);
    }catch(e){error=/^(invalid_[a-z_]+|upstream_\d+|timeout|cancelled|connection_failed)$/.test(e.message)?e.message:'evaluation_failed';break;}
  }
  Object.assign(run,{result:error||run.result,placed:game.placed,lines:game.lines,score:game.score,elapsedMs:performance.now()-started,
    latencyP50Ms:percentile(run.steps.map(s=>s.latencyMs),.5),latencyP95Ms:percentile(run.steps.map(s=>s.latencyMs),.95),
    preparationP50Ms:percentile(run.steps.map(s=>s.preparationMs),.5)});
  report.runs.push(run);
  console.log(JSON.stringify({seed,result:run.result,placed:run.placed,lines:run.lines,score:run.score,latencyP50Ms:run.latencyP50Ms,preparationP50Ms:run.preparationP50Ms}));
  if(error){process.exitCode=1;break;}
}
const directory=new URL('../output/',import.meta.url);await mkdir(directory,{recursive:true});
const name=`evaluation-${Date.now()}.json`;await writeFile(new URL(name,directory),JSON.stringify(report,null,2));
console.log(`Saved output/${name}`);
