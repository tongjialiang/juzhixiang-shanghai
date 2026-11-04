param([switch]$NoOpen)
$ErrorActionPreference = 'Stop'
$projectPath = Split-Path -Parent $PSScriptRoot
$mysqlBin = 'C:\Program Files\MySQL\MySQL Server 26.7\bin\mysqld.exe'
$dataPath = Join-Path $projectPath '.local\mysql'
$junctionPath = 'D:\caregpt\2026code\jzx-mysql-data'
# MySQL 的 Windows 参数处理不能稳定识别中文路径，使用指向项目数据目录的英文目录联接。
if (-not (Test-Path -LiteralPath $junctionPath)) {
    New-Item -ItemType Junction -Path $junctionPath -Target $dataPath | Out-Null
}
$junction = Get-Item -LiteralPath $junctionPath
if ($junction.LinkType -ne 'Junction' -or $junction.Target.TrimEnd('\') -ne $dataPath.TrimEnd('\')) {
    throw '数据库目录联接指向不正确，请检查后再启动。'
}
if (-not (Get-NetTCPConnection -LocalPort 3307 -State Listen -ErrorAction SilentlyContinue)) {
    Start-Process -FilePath $mysqlBin -ArgumentList '--no-defaults','--basedir="C:\Program Files\MySQL\MySQL Server 26.7"','--datadir=D:/caregpt/2026code/jzx-mysql-data','--port=3307','--bind-address=127.0.0.1','--mysqlx=OFF' -WindowStyle Hidden -RedirectStandardOutput "$projectPath\.local\mysql.stdout.log" -RedirectStandardError "$projectPath\.local\mysql.stderr.log" | Out-Null
}
for ($attempt = 0; $attempt -lt 30; $attempt++) {
    if (Get-NetTCPConnection -LocalPort 3307 -State Listen -ErrorAction SilentlyContinue) { break }
    Start-Sleep -Milliseconds 300
}
try { $health = Invoke-RestMethod 'http://127.0.0.1:3088/api/health' -TimeoutSec 2 } catch { $health = $null }
if (-not $health.ok) {
    Start-Process -FilePath (Get-Command node.exe).Source -ArgumentList 'server/index.js' -WorkingDirectory $projectPath -WindowStyle Hidden -RedirectStandardOutput "$projectPath\.local\server.stdout.log" -RedirectStandardError "$projectPath\.local\server.stderr.log" | Out-Null
}
for ($attempt = 0; $attempt -lt 30; $attempt++) {
    try { $health = Invoke-RestMethod 'http://127.0.0.1:3088/api/health' -TimeoutSec 2; if ($health.ok) { break } } catch {}
    Start-Sleep -Milliseconds 300
}
if (-not $health.ok) { throw '启动未完成，请查看 .local 目录中的日志。' }
Write-Host '局域网报名：http://192.168.1.142:3088/promo/'
Write-Host '运营后台：http://192.168.1.142:3088/admin'
Write-Host '独立现场核销：http://192.168.1.142:3088/checkin'
Write-Host '账号密码见 .local\登录信息_v3.txt'
if (-not $NoOpen) { Start-Process 'http://127.0.0.1:3088/admin' }
