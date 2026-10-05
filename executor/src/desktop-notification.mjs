import {spawn} from 'node:child_process';
const ps=value=>"'"+String(value).replace(/'/g,"''")+"'";
export function notificationCommand(title,body,platform=process.platform){
 if(platform==='win32'){const script=`Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $notification=New-Object System.Windows.Forms.NotifyIcon; $notification.Icon=[System.Drawing.SystemIcons]::Information; $notification.Text='ExternalLink'; $notification.add_BalloonTipShown({[Console]::Out.WriteLine('EXTERNALLINK_BALLOON_SHOWN'); [Console]::Out.Flush()}); $context=New-Object System.Windows.Forms.ApplicationContext; $timer=New-Object System.Windows.Forms.Timer; $timer.Interval=12000; $timer.add_Tick({$notification.Visible=$false; $notification.Dispose(); $timer.Stop(); $context.ExitThread()}); $timer.Start(); $notification.Visible=$true; $notification.ShowBalloonTip(10000,${ps(title)},${ps(body)},[System.Windows.Forms.ToolTipIcon]::Info); [System.Windows.Forms.Application]::Run($context);`;
  return{command:'powershell.exe',args:['-NoLogo','-NoProfile','-NonInteractive','-WindowStyle','Hidden','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')]};
 }
 if(platform==='darwin'){const quoted=value=>JSON.stringify(String(value));return{command:'osascript',args:['-e','display notification '+quoted(body)+' with title '+quoted(title)]};}
 return{command:'notify-send',args:[String(title),String(body)]};
}
export async function notifyDesktop(title,body,{launch=spawn,platform=process.platform}={}){
 const target=notificationCommand(title,body,platform);
 return new Promise(resolve=>{
  let settled=false,timeout,output='',displayedAt;
  const finish=result=>{if(settled)return;settled=true;clearTimeout(timeout);resolve(result);};
  let child;try{child=launch(target.command,target.args,{windowsHide:true,stdio:['ignore','pipe','ignore'],shell:false});}catch(error){finish({status:'failed',error:error.message});return;}
  child.stdout?.on('data',chunk=>{output=(output+String(chunk)).slice(-4096);if(platform==='win32'&&/(?:^|\r?\n)EXTERNALLINK_BALLOON_SHOWN\r?\n/.test(output))displayedAt||=new Date().toISOString();});
  timeout=setTimeout(()=>{finish({status:'failed',error:'桌面提醒进程超时'});child.kill();},20000);
  child.once('error',error=>finish({status:'failed',error:error.message}));
  child.once('exit',code=>finish(code!==0?{status:'failed',error:'桌面提醒退出码 '+code}:platform!=='win32'?{status:'requested'}:displayedAt?{status:'displayed',evidence:'BalloonTipShown',displayedAt}:{status:'not_confirmed',error:'系统未确认桌面提醒已显示'}));
 });
}
