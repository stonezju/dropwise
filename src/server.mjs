import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {buildRequest,decide} from './provider.mjs';

const assets=new Map([
  ['/', ['index.html','text/html']], ['/app.js',['app.js','text/javascript']],
  ['/engine.js',['engine.js','text/javascript']], ['/style.css',['style.css','text/css']],
]);
function json(res,status,data) {res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(data));}
export function createServer() {
  return http.createServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    const allowedHosts=[`127.0.0.1:${req.socket.localPort}`,`localhost:${req.socket.localPort}`];
    if(!allowedHosts.includes(req.headers.host)) return json(res,403,{error:'forbidden_host'});
    const path=new URL(req.url,'http://localhost').pathname;
    if(req.method==='POST'&&['/api/decide','/api/check'].includes(path)) {
      if(req.headers.origin!==`http://${req.headers.host}`||!req.headers['content-type']?.startsWith('application/json')) return json(res,403,{error:'forbidden_origin'});
      const controller=new AbortController();res.on('close',()=>{if(!res.writableEnded)controller.abort();});
      try {
        let size=0;const chunks=[];
        for await(const chunk of req){size+=chunk.length;if(size>65536){json(res,413,{error:'request_too_large'});return;}chunks.push(chunk);}
        let body;try{body=JSON.parse(Buffer.concat(chunks).toString());}catch{throw new Error('invalid_json');}
        if(!body||typeof body!=='object'||!body.config) throw new Error('invalid_config');
        const prepareStarted=performance.now();
        const request=path==='/api/check'?{model:body.config.model,state:'Connection check. Choose ready.',questions:{move:{type:'choice',instructions:'Select ready.',criteria:{ready:'The service is ready.',other:'Any other result.'}}}}:buildRequest(body.game,body.config.model);
        const preparationMs=performance.now()-prepareStarted;
        const result=await decide(body.config,request,controller.signal);
        if(!res.destroyed)json(res,200,{...result,...(path==='/api/decide'?{preparationMs,effects:request.questions.move.criteria[result.choice].effects}:{})});
      } catch(error) {
        if(!res.destroyed)json(res,400,{error:/^(invalid_[a-z_]+|no_moves|upstream_\d{3}|timeout|cancelled|connection_failed)$/.test(error.message)?error.message:'request_failed'});
      }
      return;
    }
    if(req.method==='GET'&&assets.has(path)) {
      const [name,type]=assets.get(path);
      try {const bytes=await readFile(new URL(`./public/${name}`,import.meta.url));res.writeHead(200,{'content-type':`${type}; charset=utf-8`,'cache-control':'no-cache'});res.end(bytes);}
      catch{json(res,500,{error:'asset_unavailable'});}return;
    }
    json(res,404,{error:'not_found'});
  });
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const port=Number(process.env.PORT||8787);
  const server=createServer();
  server.on('error',error=>{console.error(error.code==='EADDRINUSE'?`Port ${port} is busy. Choose another PORT.`:'Server could not start.');process.exitCode=1;});
  server.listen(port,'127.0.0.1',()=>console.log(`Dropwise → http://127.0.0.1:${port}`));
}
