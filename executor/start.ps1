param([switch]$ServiceOnly)
$ErrorActionPreference = 'Stop'
$executorRoot = $PSScriptRoot
$runtimeHome = if ($env:EXTERNALLINK_HOME) { $env:EXTERNALLINK_HOME } else { Join-Path $env:USERPROFILE '.externallink-executor' }
New-Item -ItemType Directory -Force -Path $runtimeHome | Out-Null
$nodePath = (Get-Command node).Source
if (-not (Test-Path -LiteralPath (Join-Path $executorRoot 'node_modules/playwright'))) { throw '先在 executor 目录运行 npm ci' }
$hostAlive = $false
$savedHost = $null
$hostDecision = 'no_saved_host'
$hostState = Join-Path $runtimeHome 'host.json'
if (Test-Path -LiteralPath $hostState) {
  $savedHost = Get-Content -LiteralPath $hostState -Raw | ConvertFrom-Json -DateKind String
  for ($probeAttempt=0; $probeAttempt -lt 3 -and -not $hostAlive; $probeAttempt++) {
    try { $null = Invoke-RestMethod -Uri ($savedHost.endpoint + '/json/version') -TimeoutSec 2; $hostAlive = $true; $hostDecision='reuse_live_host' } catch {}
  }
  if (-not $hostAlive -and $savedHost.mode -eq 'native-chrome') {
    $expectedProfile=Join-Path $runtimeHome 'browser-profile-stable'
    if ([IO.Path]::GetFullPath($savedHost.profile) -ne [IO.Path]::GetFullPath($expectedProfile)) { throw '宿主目录身份不符，保留浏览器，不创建替代窗口' }
    $chromeProcess=Get-CimInstance Win32_Process -Filter "ProcessId=$($savedHost.chromePid)" -ErrorAction SilentlyContinue
    $dedicatedPattern='--user-data-dir=(?:"'+[regex]::Escape($expectedProfile)+'"|'+[regex]::Escape($expectedProfile)+')(?=\s|$)'
    if ($chromeProcess -and $chromeProcess.Name -eq 'chrome.exe' -and $chromeProcess.CommandLine -match $dedicatedPattern) {
      if ([Math]::Abs(($chromeProcess.CreationDate.ToUniversalTime()-[DateTime]::Parse($savedHost.startedAt).ToUniversalTime()).TotalSeconds) -gt 60) { throw '原Chrome进程创建时间不符，保留窗口，停止替代启动' }
      $portFile=Join-Path $expectedProfile 'DevToolsActivePort'
      if (Test-Path -LiteralPath $portFile) {
        $port=(Get-Content -LiteralPath $portFile -TotalCount 1).Trim()
        if ($port -match '^\d+$') {
          $candidateEndpoint='http://127.0.0.1:'+$port
          try {
            $null=Invoke-RestMethod -Uri ($candidateEndpoint+'/json/version') -TimeoutSec 3
            $savedHost.endpoint=$candidateEndpoint
            $savedHost | ConvertTo-Json -Compress | Set-Content -LiteralPath $hostState -Encoding utf8
            $hostAlive=$true; $hostDecision='reuse_verified_native_port'
          } catch {}
        }
      }
      if (-not $hostAlive) { throw '原专用Chrome进程仍存活但连接不可用；保留原窗口，不启动替代浏览器' }
    }
  }
}
@{at=[DateTime]::UtcNow.ToString('o');type='startup_host_probe';decision=$hostDecision;serviceOnly=[bool]$ServiceOnly;browserInstance=$savedHost.startedAt;chromePid=$savedHost.chromePid} | ConvertTo-Json -Compress | Add-Content -LiteralPath (Join-Path $runtimeHome 'host-events.jsonl') -Encoding utf8
if ($ServiceOnly -and -not $hostAlive) { throw '仅重启执行服务要求原浏览器宿主存活；浏览器和任务证据保持不变' }
if (-not $hostAlive) {
  $hostScript = 'src/browser-host.mjs'
  $hostConfigPath = Join-Path $runtimeHome 'host-config.json'
  if (Test-Path -LiteralPath $hostConfigPath) {
    $hostConfig = Get-Content -LiteralPath $hostConfigPath -Raw | ConvertFrom-Json
    if ($hostConfig.mode -eq 'native-chrome') { $hostScript = 'src/native-browser-host.mjs' }
  }
  Start-Process -FilePath $nodePath -ArgumentList @($hostScript) -WorkingDirectory $executorRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtimeHome 'host.log') -RedirectStandardError (Join-Path $runtimeHome 'host-error.log') | Out-Null
}
$serverAlive = $false
$serverState = Join-Path $runtimeHome 'server.json'
if (Test-Path -LiteralPath $serverState) {
  $savedServer = Get-Content -LiteralPath $serverState -Raw | ConvertFrom-Json
  $savedProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $($savedServer.pid)" -ErrorAction SilentlyContinue
  $serverAlive = $savedProcess -and $savedProcess.CommandLine -like '*src/server.mjs*'
  if ($serverAlive) {
    try { $response = Invoke-WebRequest -Uri ($savedServer.endpoint + '/status') -TimeoutSec 3 -SkipHttpErrorCheck; $serverAlive = $response.StatusCode -eq 401 }
    catch { $serverAlive = $false }
  }
}
if (-not $serverAlive) {
  Start-Process -FilePath $nodePath -ArgumentList @('src/server.mjs') -WorkingDirectory $executorRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $runtimeHome 'server.log') -RedirectStandardError (Join-Path $runtimeHome 'server-error.log') | Out-Null
}
$verified = $false
for ($attempt = 0; $attempt -lt 20; $attempt++) {
  if (Test-Path -LiteralPath $serverState) {
    try {
      $currentServer = Get-Content -LiteralPath $serverState -Raw | ConvertFrom-Json
      $healthResponse = Invoke-WebRequest -Uri ($currentServer.endpoint + '/status') -TimeoutSec 2 -SkipHttpErrorCheck
      if ($healthResponse.StatusCode -eq 401) { $verified = $true; break }
    } catch {}
  }
  Start-Sleep -Milliseconds 500
}
if (-not $verified) { throw "执行器没有通过 HTTP 启动检查，请查看 $runtimeHome\server-error.log" }
Write-Output "ExternalLink 执行器已通过启动检查；配对信息：$runtimeHome\pairing.txt。请在原插件中连接。"
