import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
process.loadEnvFile?.(existsSync('.env') ? '.env' : '.env.example');
const major = Number(process.versions.node.split('.')[0]);
const run = (file,args) => spawnSync(file,args,{encoding:'utf8',windowsHide:true});
const git = run('git',['--version']);
const cliPath = join(process.cwd(),'node_modules','@shopify','cli','bin','run.js');
const cli = run(process.execPath,[cliPath,'version']);
const required = ['SHOPIFY_API_KEY','SHOPIFY_API_SECRET','SESSION_SECRET','ENCRYPTION_KEY'];
const modelKeys = ['OPENAI_API_KEY','OPENAI_MODEL','MISTRAL_API_KEY','MISTRAL_MODEL'];
const providers = { openai: Boolean(process.env.OPENAI_API_KEY && process.env.OPENAI_MODEL), mistral: Boolean(process.env.MISTRAL_API_KEY && process.env.MISTRAL_MODEL) };
console.log(JSON.stringify({
  node:process.version,nodeSupported:major===24,
  git:git.status===0?git.stdout.trim():'unavailable',
  shopifyCli:cli.status===0?cli.stdout.trim():'unavailable',
  appConfig:existsSync('shopify.app.toml')?'present':'not linked (example only)',
  database:process.env.DATABASE_URL?'PostgreSQL configured':'local PGlite',
  credentials:Object.fromEntries([...required,...modelKeys].map(key=>[key,Boolean(process.env[key])])),
  providers,
  environmentConfigured:required.every(key=>Boolean(process.env[key]))&&Object.values(providers).some(Boolean)&&existsSync('shopify.app.toml')&&Boolean(process.env.DATABASE_URL),
  abcProvidersConfigured:providers.openai&&providers.mistral,
  note:'Configuration presence only; live readiness requires store installation, scoped database grants, approved knowledge and real end-to-end checks.',
},null,2));
if(major!==24||git.status!==0||cli.status!==0)process.exitCode=1;
