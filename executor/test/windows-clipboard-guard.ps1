param([switch]$SelfTest)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
public sealed class ClipboardGuard {
 [DllImport("user32.dll")] static extern bool OpenClipboard(IntPtr owner);
 [DllImport("user32.dll")] static extern bool CloseClipboard();
 [DllImport("user32.dll")] static extern uint EnumClipboardFormats(uint format);
 [DllImport("user32.dll")] static extern IntPtr GetClipboardData(uint format);
 [DllImport("user32.dll")] static extern IntPtr SetClipboardData(uint format,IntPtr data);
 [DllImport("user32.dll")] static extern bool EmptyClipboard();
 [DllImport("user32.dll")] static extern uint GetClipboardSequenceNumber();
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern uint RegisterClipboardFormat(string name);
 [DllImport("kernel32.dll")] static extern UIntPtr GlobalSize(IntPtr handle);
 [DllImport("kernel32.dll")] static extern IntPtr GlobalLock(IntPtr handle);
 [DllImport("kernel32.dll")] static extern bool GlobalUnlock(IntPtr handle);
 [DllImport("kernel32.dll")] static extern IntPtr GlobalAlloc(uint flags,UIntPtr size);
 [DllImport("kernel32.dll")] static extern IntPtr GlobalFree(IntPtr handle);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern IntPtr CreateWindowEx(uint ex,string cls,string title,uint style,int x,int y,int w,int h,IntPtr parent,IntPtr menu,IntPtr instance,IntPtr param);
 [DllImport("user32.dll")] static extern bool DestroyWindow(IntPtr window);
 readonly Dictionary<uint,byte[]> saved = new Dictionary<uint,byte[]>();
 readonly IntPtr window;
 public uint Sequence {get;private set;}
 public int Formats {get{return saved.Count;}}
 public ClipboardGuard(){
  window=CreateWindowEx(0,"STATIC","ExternalLink clipboard guard",0,0,0,0,0,new IntPtr(-3),IntPtr.Zero,IntPtr.Zero,IntPtr.Zero);
  if(window==IntPtr.Zero)throw new Exception("Cannot create clipboard owner");
  Lock();try {
   // These standard formats contain non-HGLOBAL handles. Refuse before any write.
   uint f=0;while((f=EnumClipboardFormats(f))!=0){
    if(f==2||f==3||f==9||f==14||f==0x80||f==0x82||f==0x83||f==0x8e)throw new Exception("Unsupported clipboard handle format; clipboard untouched");
    saved[f]=Bytes(f);
   }
   // Materializing delayed formats can add synthesized formats; capture all too.
   f=0;while((f=EnumClipboardFormats(f))!=0){if(!saved.ContainsKey(f))saved[f]=Bytes(f);}
   Sequence=GetClipboardSequenceNumber();
  }finally{CloseClipboard();}
 }
 void Lock(){for(int i=0;i<20;i++){if(OpenClipboard(window))return;System.Threading.Thread.Sleep(25);}throw new Exception("Clipboard unavailable");}
 static byte[] Bytes(uint f){var handle=GetClipboardData(f);long size=(long)GlobalSize(handle).ToUInt64();if(handle==IntPtr.Zero||size<=0||size>67108864)throw new Exception("Cannot preserve full clipboard format; clipboard untouched");var p=GlobalLock(handle);if(p==IntPtr.Zero)throw new Exception("Cannot lock clipboard format");try{var b=new byte[(int)size];Marshal.Copy(p,b,0,b.Length);return b;}finally{GlobalUnlock(handle);}}
 public bool Unchanged(){return GetClipboardSequenceNumber()==Sequence;}
 ClipboardGuard(Dictionary<uint,byte[]> fixture){window=CreateWindowEx(0,"STATIC","ExternalLink fixture clipboard",0,0,0,0,0,new IntPtr(-3),IntPtr.Zero,IntPtr.Zero,IntPtr.Zero);foreach(var kv in fixture)saved.Add(kv.Key,kv.Value);}
 public bool VerifyMultipleFormats(){
  var formats=new Dictionary<uint,byte[]>();formats.Add(13,Encoding.Unicode.GetBytes("Controlled Unicode 中文🙂\0"));formats.Add(RegisterClipboardFormat("HTML Format"),Encoding.UTF8.GetBytes("Controlled HTML\0"));formats.Add(RegisterClipboardFormat("ExternalLink controlled binary"),new byte[]{0,255,1,0,128,42});
  var seed=new ClipboardGuard(formats);try{seed.Restore();var captured=new ClipboardGuard();try{var replacement=new ClipboardGuard(new Dictionary<uint,byte[]>{{13,Encoding.Unicode.GetBytes("Replacement\0")}});try{replacement.Restore();}finally{replacement.Dispose();}return captured.Restore();}finally{captured.Dispose();}}finally{seed.Dispose();}
 }
 public string TextHash(){Lock();try{if(GetClipboardData(13)==IntPtr.Zero)return "";byte[] b=Bytes(13);string s=Encoding.Unicode.GetString(b);int z=s.IndexOf('\0');if(z>=0)s=s.Substring(0,z);using(var sha=SHA256.Create())return BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(s))).Replace("-","").ToLowerInvariant();}finally{CloseClipboard();}}
 public bool Restore(){
  Lock();try{
   // Allocate every original format before emptying to avoid partial allocation failure.
   var allocated=new Dictionary<uint,IntPtr>();try{
    foreach(var kv in saved){var h=GlobalAlloc(2,(UIntPtr)kv.Value.Length);if(h==IntPtr.Zero)throw new Exception("Clipboard restore allocation failed");allocated[kv.Key]=h;var p=GlobalLock(h);if(p==IntPtr.Zero)throw new Exception("Clipboard restore lock failed");try{Marshal.Copy(kv.Value,0,p,kv.Value.Length);}finally{GlobalUnlock(h);}}
    if(!EmptyClipboard())throw new Exception("Clipboard restore empty failed");
    foreach(var formatId in new List<uint>(allocated.Keys)){if(SetClipboardData(formatId,allocated[formatId])==IntPtr.Zero)throw new Exception("Clipboard restore set failed");allocated.Remove(formatId);}
   }finally{foreach(var h in allocated.Values)GlobalFree(h);}
   var actual=new HashSet<uint>();uint f=0;while((f=EnumClipboardFormats(f))!=0)actual.Add(f);
   if(actual.Count!=saved.Count)throw new Exception("Restored clipboard format count differs");
   foreach(var kv in saved){if(!actual.Contains(kv.Key))throw new Exception("Restored clipboard format missing");byte[] b=Bytes(kv.Key);if(b.Length!=kv.Value.Length)throw new Exception("Restored clipboard bytes length differs");for(int i=0;i<b.Length;i++)if(b[i]!=kv.Value[i])throw new Exception("Restored clipboard bytes differ");}
   return true;
  }finally{CloseClipboard();}
 }
 public void Dispose(){DestroyWindow(window);}
}
'@
$clipboardGuard = $null
$clipboardMutated = $false
try {
 $clipboardGuard = [ClipboardGuard]::new()
 if ($SelfTest) { $clipboardMutated=$true; $multipleFormatsVerified=$clipboardGuard.VerifyMultipleFormats(); $originalRestored=$clipboardGuard.Restore(); $clipboardMutated=$false; @{ok=($multipleFormatsVerified -and $originalRestored);controlledMultipleFormatsRestored=$multipleFormatsVerified;originalAllFormatsRestored=$originalRestored;originalFormatCount=$clipboardGuard.Formats;contentLogged=$false} | ConvertTo-Json -Compress; return }
 @{ok=$true;ready=$true;formats=$clipboardGuard.Formats;memoryOnly=$true} | ConvertTo-Json -Compress
 while ($null -ne ($clipboardCommand = [Console]::ReadLine())) {
  switch ($clipboardCommand) {
   'arm' { if (!$clipboardGuard.Unchanged()) { throw 'Clipboard changed before test; clipboard untouched' }; $clipboardMutated=$true; '{"ok":true,"armed":true}' }
   'hash' { @{ok=$true;hash=$clipboardGuard.TextHash()} | ConvertTo-Json -Compress }
   'restore' { if ($clipboardMutated) { $clipboardRestored=$clipboardGuard.Restore(); $clipboardMutated=$false } else { $clipboardRestored=$clipboardGuard.Unchanged() }; @{ok=$clipboardRestored;restored=$clipboardRestored;formats=$clipboardGuard.Formats} | ConvertTo-Json -Compress; return }
   default { throw 'Unknown clipboard command' }
  }
 }
} catch { @{ok=$false;error=$_.Exception.Message} | ConvertTo-Json -Compress; exit 1 }
finally { if ($clipboardGuard) { if ($clipboardMutated) { $null=$clipboardGuard.Restore() }; $clipboardGuard.Dispose() } }
