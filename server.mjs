import http from 'node:http';
import {readFile,stat} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {spawn} from 'node:child_process';
const root=path.dirname(fileURLToPath(import.meta.url));
const port=Number(process.env.PORT||4174);
function openBrowser(){if(process.platform==='win32')spawn('cmd.exe',['/c','start','',`http://127.0.0.1:${port}`],{windowsHide:true,stdio:'ignore'}).unref();}
const mime={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.json':'application/json','.png':'image/png','.svg':'image/svg+xml','.ico':'image/x-icon'};
const server=http.createServer(async(req,res)=>{try{const url=new URL(req.url,'http://localhost');let rel=decodeURIComponent(url.pathname);if(rel==='/')rel='/index.html';const filename=path.resolve(root,'.'+rel);if(!filename.startsWith(root+path.sep)){res.writeHead(403);return res.end('Forbidden');}if(!(await stat(filename)).isFile())throw new Error('Not found');const data=await readFile(filename);res.writeHead(200,{'Content-Type':mime[path.extname(filename)]||'application/octet-stream','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(data);}catch{res.writeHead(404,{'Content-Type':'text/plain'});res.end('Not found');}});
server.listen(port,'127.0.0.1',()=>{console.log(`LittleWorld: http://127.0.0.1:${port}`);if(process.argv.includes('--open'))openBrowser();});
server.on('error',err=>{if(err.code==='EADDRINUSE'&&process.argv.includes('--open')){http.get(`http://127.0.0.1:${port}/index.html`,res=>{let body='';res.on('data',b=>body+=b);res.on('end',()=>{if(body.includes('<title>LittleWorld')){console.log('LittleWorld is already running; opening it.');openBrowser();}else{console.error(`Port ${port} belongs to another application.`);process.exitCode=1;}});}).on('error',e=>{console.error(e.message);process.exitCode=1;});}else{console.error(err.message);process.exitCode=1;}});
