$ErrorActionPreference = 'Stop'
$taskInstallerRoot = if ($PSScriptRoot) { $PSScriptRoot } else { Join-Path (Get-Location) 'executor\scripts' }
$taskLauncherPath = Join-Path $taskInstallerRoot 'open-workbench.mjs'
$taskNodePath = (& node -p 'process.execPath').Trim()
$taskPowerShellPath = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
$taskLogPath = Join-Path $env:USERPROFILE '.externallink-executor\watchdog.log'
$taskCommand = "& '" + $taskNodePath.Replace("'", "''") + "' '" + $taskLauncherPath.Replace("'", "''") + "' --watch --services-only *> '" + $taskLogPath.Replace("'", "''") + "'"
$taskArguments = '-NoProfile -WindowStyle Hidden -Command "' + $taskCommand + '"'
$taskShell = New-Object -ComObject WScript.Shell
$taskShortcutPath = Join-Path ($taskShell.SpecialFolders.Item('Startup')) 'ExternalLink-Workbench.lnk'
$taskShortcut = $taskShell.CreateShortcut($taskShortcutPath)
$taskShortcut.TargetPath = $taskPowerShellPath
$taskShortcut.Arguments = $taskArguments
$taskShortcut.WorkingDirectory = Split-Path $taskInstallerRoot
$taskShortcut.WindowStyle = 7
$taskShortcut.Save()
Start-Process -FilePath $taskPowerShellPath -ArgumentList $taskArguments -WorkingDirectory $taskShortcut.WorkingDirectory -WindowStyle Hidden
Write-Output '已启用外链助手后台启动与本机服务守护；不会自动投稿或打开新的浏览器。'
