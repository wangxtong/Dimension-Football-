import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadReportBundle } from './report-store.mjs';

export function createReportServer({ directory, token, load = loadReportBundle }) {
  if(!/^[A-Za-z0-9_-]{32,200}$/.test(token||''))throw new Error('REPORTS_READ_TOKEN_REQUIRED');
  return createServer(async (request,response)=>{
    response.setHeader('Content-Type','application/json; charset=utf-8');
    response.setHeader('Cache-Control','no-store');
    response.setHeader('X-Content-Type-Options','nosniff');
    const finish=(status,data)=>{response.statusCode=status;response.end(request.method==='HEAD'?'':JSON.stringify(data));};
    const supplied=Buffer.from(request.headers.authorization||''), expected=Buffer.from('Bearer '+token);
    if(supplied.length!==expected.length||!timingSafeEqual(supplied,expected))return finish(401,{error:'UNAUTHORIZED'});
    if(!['GET','HEAD'].includes(request.method)){response.setHeader('Allow','GET, HEAD');return finish(405,{error:'METHOD_NOT_ALLOWED'});}
    const path=new URL(request.url,'http://localhost').pathname;
    if(!['/api/report','/health'].includes(path))return finish(404,{error:'NOT_FOUND'});
    try{
      const bundle=await load(directory);
      if(path==='/health')return finish(200,{status:'available',reportId:bundle.reportId,reportHash:bundle.reportHash,generatedAt:bundle.report.generatedAt});
      finish(200,bundle);
    }catch{finish(503,{error:'REPORT_UNAVAILABLE'});}
  });
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(process.argv.includes('--help'))console.log('REPORTS_DIRECTORY, REPORTS_READ_TOKEN, REPORTS_PORT (default 8787). Listens on 127.0.0.1; publish only through an authenticated HTTPS reverse proxy.');
  else{
    try{
      const port=Number(process.env.REPORTS_PORT||8787);
      if(!Number.isInteger(port)||port<1024||port>65535)throw Error('INVALID_PORT');
      const server=createReportServer({directory:process.env.REPORTS_DIRECTORY||'/var/lib/vantis/reports',token:process.env.REPORTS_READ_TOKEN});
      server.requestTimeout=15000;server.headersTimeout=10000;
      server.listen(port,'127.0.0.1',()=>console.log('Report service listening on loopback'));
      for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>server.close());
    }catch{console.error('REPORT_SERVER_CONFIGURATION_INVALID');process.exitCode=1;}
  }
}
