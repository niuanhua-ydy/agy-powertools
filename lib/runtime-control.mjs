import { createServer } from 'node:http';
import { mkdirSync,writeFileSync,readFileSync,readdirSync,unlinkSync,existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID,randomBytes } from 'node:crypto';

const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export async function serveRuntime({directory,version,stop,health,exit=()=>process.exit(0)}){
  const token=randomBytes(24).toString('hex'),file=join(directory,`${process.pid}-${randomUUID()}.json`);
  const server=createServer(async(request,response)=>{
    if(request.headers.authorization!==`Bearer ${token}`){response.writeHead(403).end();return;}
    if(request.method==='GET'&&request.url==='/health'){
      try{response.setHeader('content-type','application/json');response.end(JSON.stringify({id:'agy-powertools',version,...await health()}));}catch{response.writeHead(503).end();}return;
    }
    if(request.method==='POST'&&request.url==='/stop'){
      try{await stop({purge:request.headers['x-agy-purge']==='true'});response.end('{}');}
      catch{response.writeHead(500).end('{}');}
      finally{try{unlinkSync(file);}catch{}server.close();setTimeout(exit,100).unref();}return;
    }
    response.writeHead(404).end();
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  mkdirSync(directory,{recursive:true});writeFileSync(file,JSON.stringify({id:'agy-powertools',version,port:server.address().port,token}),{mode:0o600});
  return async()=>{try{unlinkSync(file);}catch{}await new Promise(resolve=>server.close(resolve));};
}

export function runtimeRecords(directory){
  if(!existsSync(directory))return[];
  return readdirSync(directory).filter(name=>/^\d+-[\da-f-]+\.json$/.test(name)).flatMap(name=>{
    try{const record=JSON.parse(readFileSync(join(directory,name),'utf8'));return record.id==='agy-powertools'&&Number.isInteger(record.port)&&record.port>0&&record.port<65536&&/^[a-f\d]{48}$/.test(record.token)?[{...record,file:join(directory,name)}]:[];}catch{return[];}
  });
}
export async function stopRuntimes(directory,{purge=false}={}){
  await Promise.all(runtimeRecords(directory).map(async record=>{
    try{const response=await fetch(`http://127.0.0.1:${record.port}/stop`,{method:'POST',headers:{authorization:`Bearer ${record.token}`,'x-agy-purge':String(purge)},signal:AbortSignal.timeout(8000)});if(response.status!==200&&response.status!==403)throw Error('插件暂时无法停止');}
    catch(error){if(error.cause?.code!=='ECONNREFUSED')throw Error('插件暂时无法停止，请重新打开客户端后重试');}
    try{unlinkSync(record.file);}catch{}
  }));
  await pause(200);
}
export function isRuntimeReady(status,version){
  return Boolean(status&&status.id==='agy-powertools'&&status.version===version&&(status.healthy===true||status.runtimeReady===true));
}
export async function waitForRuntime(directory,version,{timeout=25000}={}){
  const end=Date.now()+timeout;
  while(Date.now()<end){
    for(const record of runtimeRecords(directory).filter(record=>record.version===version)){
      try{const response=await fetch(`http://127.0.0.1:${record.port}/health`,{headers:{authorization:`Bearer ${record.token}`},signal:AbortSignal.timeout(1500)}),status=await response.json();if(isRuntimeReady(status,version))return status;}catch{}
    }
    await pause(250);
  }
  throw Error('新版本未能正常启动');
}
