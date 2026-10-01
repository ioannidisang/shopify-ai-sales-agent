import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
process.loadEnvFile?.(existsSync('.env') ? '.env' : '.env.example');
const major = Number(process.versions.node.split('.')[0]);
const run = (file,args) => spawnSync(file,args,{encoding:'utf8',windowsHide:true});
const git = run('git',['--version']);
const cliPath = join(process.cwd(),'node_modules','@shopify','cli','bin','run.js');
const cli = run(process.execPath,[cliPath,'version']);
const required = ['SHOPIFY_API_KEY','SHOPIFY_API_SECRET','OPENAI_API_KEY','OPENAI_MODEL','SESSION_SECRET','ENCRYPTION_KEY'];
console.log(JSON.stringify({
  node:process.version,nodeSupported:major===24,
  git:git.status===0?git.stdout.trim():'unavailable',
  shopifyCli:cli.status===0?cli.stdout.trim():'unavailable',
  appConfig:existsSync('shopify.app.toml')?'present':'not linked (example only)',
  database:process.env.DATABASE_URL?'PostgreSQL configured':'local PGlite',
  credentials:Object.fromEntries(required.map(key=>[key,Boolean(process.env[key])])),
  liveReady:required.every(key=>Boolean(process.env[key]))&&existsSync('shopify.app.toml')&&Boolean(process.env.DATABASE_URL),
},null,2));
if(major!==24||git.status!==0||cli.status!==0)process.exitCode=1;
