using System;
using System.IO;
using System.Text;
using System.Diagnostics;
using System.Runtime.InteropServices;
// Debug ONLY a newly created, isolated E2E child. No attach, memory dumps, registry changes or process-wide hooks.
public static class RoastDuckNativeProbe {
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup {
        public int cb;public string reserved;public string desktop;public string title;public uint x,y,xSize,ySize,xChars,yChars,fill,flags;public ushort show,reserved2;public IntPtr bytes,input,output,error;
    }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo {public IntPtr process,thread;public uint pid,tid;}
    [StructLayout(LayoutKind.Sequential)] struct Security {public int length;public IntPtr descriptor;[MarshalAs(UnmanagedType.Bool)]public bool inherit;}
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern bool CreateProcess(string app,StringBuilder command,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string directory,ref Startup startup,out ProcessInfo info);
    [DllImport("kernel32.dll",SetLastError=true)]static extern bool WaitForDebugEvent(IntPtr data,uint milliseconds);
    [DllImport("kernel32.dll",SetLastError=true)]static extern bool ContinueDebugEvent(uint process,uint thread,uint status);
    [DllImport("kernel32.dll")]static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]static extern IntPtr CreateFile(string name,uint access,uint share,ref Security security,uint creation,uint attributes,IntPtr template);
    static string Quote(string value){return "\""+value.Replace("\\\"","\\\\\"").Replace("\"","\\\"")+"\"";}
    static void Close(IntPtr handle){if(handle!=IntPtr.Zero&&handle!=new IntPtr(-1))CloseHandle(handle);}
    public static int Run(string node,string[] arguments,string directory,string evidence){
        if(IntPtr.Size!=8)throw new Exception("A 64-bit probe is required");
        if(Environment.GetEnvironmentVariable("ROASTDUCK_E2E")!="1"||Environment.GetEnvironmentVariable("AI_PROVIDER")!="mock"||Environment.GetEnvironmentVariable("ROASTDUCK_DB")!="file:./test-results/e2e.db")throw new Exception("Only isolated Mock E2E processes may be probed");
        string testRoot=Path.GetFullPath(Path.Combine(directory,"test-results"))+Path.DirectorySeparatorChar;
        if(!Path.GetFullPath(evidence).StartsWith(testRoot,StringComparison.OrdinalIgnoreCase))throw new Exception("Evidence path must be under test-results");
        if(Array.IndexOf(arguments,"node_modules/next/dist/bin/next")<0||Array.IndexOf(arguments,"127.0.0.1")<0)throw new Exception("Only the local Next E2E child is allowed");
        Security security=new Security();security.length=Marshal.SizeOf(typeof(Security));security.inherit=true;
        IntPtr stdout=CreateFile(Path.Combine(evidence,"native-child-stdout.log"),0x40000000,1,ref security,1,0x80,IntPtr.Zero);
        IntPtr stderr=CreateFile(Path.Combine(evidence,"native-child-stderr.log"),0x40000000,1,ref security,1,0x80,IntPtr.Zero);
        if(stdout==new IntPtr(-1)||stderr==new IntPtr(-1))throw new Exception("Cannot create child output evidence");
        Startup startup=new Startup();startup.cb=Marshal.SizeOf(typeof(Startup));startup.flags=0x100;startup.output=stdout;startup.error=stderr;
        StringBuilder command=new StringBuilder(Quote(node));foreach(string arg in arguments)command.Append(" ").Append(Quote(arg));
        ProcessInfo info;bool created=CreateProcess(node,command,IntPtr.Zero,IntPtr.Zero,true,0x08000002,IntPtr.Zero,directory,ref startup,out info);Close(stdout);Close(stderr);
        if(!created)throw new Exception("Create E2E child failed: "+Marshal.GetLastWin32Error());
        IntPtr data=Marshal.AllocHGlobal(176);int exitCode=1;
        Console.WriteLine("NATIVE_PROBE_CHILD "+info.pid);
        try{
            bool done=false;
            while(!done){
                if(!WaitForDebugEvent(data,1000)){int error=Marshal.GetLastWin32Error();if(error==121)continue;throw new Exception("WaitForDebugEvent: "+error);}
                uint kind=(uint)Marshal.ReadInt32(data,0),pid=(uint)Marshal.ReadInt32(data,4),tid=(uint)Marshal.ReadInt32(data,8),status=0x00010002;
                if(kind==1){
                    uint code=(uint)Marshal.ReadInt32(data,16);bool first=Marshal.ReadInt32(data,168)!=0;
                    if(code!=0x80000003)status=0x80010001;
                    if(!first){
                        ulong address=(ulong)Marshal.ReadIntPtr(data,32).ToInt64();string found="unmapped";ulong offset=0;
                        try{foreach(ProcessModule module in Process.GetProcessById((int)pid).Modules){ulong start=(ulong)module.BaseAddress.ToInt64();if(address>=start&&address<start+(ulong)module.ModuleMemorySize){found=module.FileName;offset=address-start;break;}}}catch(Exception error){found="module_lookup_failed:"+error.GetType().Name;}
                        string line=DateTime.UtcNow.ToString("o")+" code=0x"+code.ToString("X8")+" address=0x"+address.ToString("X")+" module="+found+" offset=0x"+offset.ToString("X");
                        File.AppendAllText(Path.Combine(evidence,"native-exception.txt"),line+Environment.NewLine);Console.WriteLine(line);
                    }
                }else if(kind==3){Close(Marshal.ReadIntPtr(data,16));}
                else if(kind==6){Close(Marshal.ReadIntPtr(data,16));}
                else if(kind==5){exitCode=Marshal.ReadInt32(data,16);done=true;}
                ContinueDebugEvent(pid,tid,status);
            }
        }finally{Marshal.FreeHGlobal(data);Close(info.thread);Close(info.process);}
        return exitCode;
    }
}
