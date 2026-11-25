import { QueueServiceClient, StorageSharedKeyCredential } from '@azure/storage-queue';
const a='ststrugcaproduploads';
const svc=new QueueServiceClient(`https://${a}.queue.core.windows.net`,new StorageSharedKeyCredential(a,process.env.SAKEY));
const g=async n=>(await svc.getQueueClient(n).getProperties()).approximateMessagesCount;
let first=null, prev=null;
for(let i=0;i<16;i++){
  const b=await g('video-tasks-bulk'), iq=await g('video-tasks'), d=await g('video-tasks-deadletter');
  if(first===null) first=b;
  const delta = prev===null ? '' : (b-prev>0?`+${b-prev}`:`${b-prev}`);
  console.log(`t+${String(i*3).padStart(2)}m  bulk=${String(b).padStart(3)} ${delta.padStart(4)}  interactive=${iq}  dlq=${d}   (net vs start: ${b-first})`);
  prev=b;
  await new Promise(r=>setTimeout(r,180000));
}
console.log(`\nNET CHANGE over 45m: ${prev-first} (negative = draining, positive = still flooding)`);
