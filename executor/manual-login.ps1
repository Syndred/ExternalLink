param(
  [string]$Url = 'https://www.basedtools.ai/signin'
)
$ErrorActionPreference = 'Stop'
$loginUri = [Uri]$Url
if ($loginUri.Scheme -notin @('http', 'https')) { throw '登录入口必须为 http/https 网站' }
$runtimeRoot = if ($env:EXTERNALLINK_HOME) { $env:EXTERNALLINK_HOME } else { Join-Path $env:USERPROFILE '.externallink-executor' }
$chromeCandidates = @(
  (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
  (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'),
  (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
)
$chromePath = $chromeCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $chromePath) { throw '未找到正式安装的 Google Chrome' }
# Separate from Chrome for Testing: do not downgrade its profile or copy credentials.
$profilePath = Join-Path $runtimeRoot 'browser-profile-stable'
if (Get-CimInstance Win32_Process -Filter 'Name="chrome.exe"' | Where-Object {
  $_.CommandLine -like ('*' + $profilePath + '*') -and $_.CommandLine -like '*--remote-debugging-port=*' -and $_.CommandLine -notlike '*--type=*'
}) { throw '执行器仍连接这个专用 Chrome。请先暂停执行器并正常关闭该窗口，再进入人工登录模式；不会另开浏览器假称已断开自动化。' }
New-Item -ItemType Directory -Force -Path $profilePath | Out-Null
$loginProcess = Start-Process -FilePath $chromePath -ArgumentList @(
  ('--user-data-dir="' + $profilePath + '"'), '--new-window', $loginUri.AbsoluteUri
) -WindowStyle Normal -PassThru
$handoff = [ordered]@{
  mode = 'manual_login'
  executablePath = $chromePath
  profile = $profilePath
  pid = $loginProcess.Id
  site = $loginUri.AbsoluteUri
  automationConnected = $false
  startedAt = [DateTime]::UtcNow.ToString('o')
}
$handoff | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $runtimeRoot 'manual-login.json') -Encoding utf8
$handoff | ConvertTo-Json
