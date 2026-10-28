import {execFileSync} from 'node:child_process';
import {existsSync,readFileSync,writeFileSync,mkdirSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import {invariant} from '../../LIFEOS/TOOLS/Invariant';
import {lifeosPath} from './paths';
import {pulseSessionTitle} from '../../LIFEOS/TOOLS/PulseSessionTitle';

const valid=(id:string)=>/^pulse-[a-f0-9]{32}$/.test(id);
const binary=()=>['/opt/homebrew/bin/tmux','/usr/local/bin/tmux'].find(existsSync);
const mapping=(sessionId?:string)=>sessionId&&/^[a-f0-9-]{36}$/i.test(sessionId)?join(lifeosPath('MEMORY','STATE','pulse-sessions'),sessionId+'.json'):null;
function remembered(sessionId?:string):string|null{const path=mapping(sessionId);if(!path)return null;try{const id=JSON.parse(readFileSync(path,'utf8')).terminalId;return valid(id)?id:null;}catch{return null;}}
export function isPulseTerminal(sessionId?:string):boolean {
  return valid(process.env.PULSE_TERMINAL_ID||'') || /\/pulse-desktop,\d+,\d+$/.test(process.env.TMUX||'') || !!remembered(sessionId);
}
function target(sessionId?:string):string|null {
  if(!isPulseTerminal(sessionId))return null;
  const bin=binary();if(!bin)return null;
  const id=process.env.PULSE_TERMINAL_ID;
  if(id&&valid(id))return id;
  const pane=process.env.TMUX_PANE||'';
  if(!/^%\d+$/.test(pane))return remembered(sessionId);
  try {const name=execFileSync(bin,['-L','pulse-desktop','display-message','-p','-t',pane,'#{session_name}'],{ windowsHide: true,encoding:'utf8',timeout:1000}).trim();return valid(name)?name:null;}catch{return null;}
}
export function readPulseTab(sessionId?:string):any {
  const id=target(sessionId);if(!id)return null;
  try{return JSON.parse(execFileSync(binary()!,['-L','pulse-desktop','show-option','-v','-t',id,'@pulse-decoration'],{ windowsHide: true,encoding:'utf8',timeout:1000,stdio:['ignore','pipe','ignore']}));}catch{return null;}
}
export function writePulseTab(data:Record<string,unknown>,sessionId?:string):boolean {
  if(!isPulseTerminal(sessionId))return false;
  const id=target(sessionId);if(!id)return true;
  invariant(valid(id),'Pulse decorations target an owned session');
  try{
    const previous=readPulseTab(sessionId);
    const normalized={...data};
    // 'PAI' is the retired label; tabs decorated before the rename carry it forward as LifeOS.
    const env=process.env.LIFEOS_SESSION_PROVIDER==='PAI'?'LifeOS':process.env.LIFEOS_SESSION_PROVIDER;
    const provider=typeof env==='string'&&['Claude Code','Codex','LifeOS'].includes(env)
      ? env
      : previous?.provider==='PAI'?'LifeOS':previous?.provider;
    const model=typeof process.env.LIFEOS_SESSION_MODEL==='string'&&process.env.LIFEOS_SESSION_MODEL.trim()
      ? process.env.LIFEOS_SESSION_MODEL.trim()
      : previous?.model;
    if(provider)normalized.provider=provider;
    if(model)normalized.model=model;
    // Native thread names identify the session; decorated titles describe its activity.
    if(sessionId&&process.env.LIFEOS_HARNESS==='codex'){
      if(previous?.codexThreadId===sessionId){normalized.sessionName=previous.sessionName;normalized.codexThreadId=sessionId;normalized.nameCheckedAt=previous.nameCheckedAt;}
      if(previous?.codexThreadId!==sessionId||Date.now()-Number(previous?.nameCheckedAt||0)>60000)try{
        const result=JSON.parse(execFileSync('bun',[lifeosPath('CODEX','SessionTitle.ts'),sessionId,'--uppercase'],{ windowsHide: true,encoding:'utf8',timeout:3500,stdio:['ignore','pipe','ignore']}));
        if(typeof result.name==='string'&&result.name.trim()){normalized.sessionName=result.name;normalized.codexThreadId=sessionId;}
      }catch{/* Preserve last known name while Codex is unavailable. */}
      finally{normalized.nameCheckedAt=Date.now();normalized.codexThreadId=sessionId;}
    }
    for(const key of ['title','previousTitle'])if(typeof normalized[key]==='string')normalized[key]=pulseSessionTitle(normalized[key] as string);
    execFileSync(binary()!,['-L','pulse-desktop','set-option','-t',id,'@pulse-decoration',JSON.stringify(normalized)],{ windowsHide: true,timeout:1000,stdio:'ignore'});
    const path=mapping(sessionId);if(path){mkdirSync(lifeosPath('MEMORY','STATE','pulse-sessions'),{recursive:true});const temp=path+'.'+process.pid+'.tmp';writeFileSync(temp,JSON.stringify({terminalId:id}),{mode:0o600});renameSync(temp,path);}
  }catch{}
  return true;
}
