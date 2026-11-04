@echo off
chcp 65001 >nul
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$isAdmin=([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator); if(-not $isAdmin){Write-Host '请关闭此窗口，右键本文件，选择 以管理员身份运行。';exit 1}; $rule=Get-NetFirewallRule -Name 'JZXShanghaiLocal3088' -ErrorAction SilentlyContinue; if($rule){Enable-NetFirewallRule -Name 'JZXShanghaiLocal3088'}else{New-NetFirewallRule -Name 'JZXShanghaiLocal3088' -DisplayName '榉之乡上海研修-局域网3088' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 3088 -LocalAddress 192.168.1.142 -RemoteAddress 192.168.0.0/23 -Profile Any | Out-Null}; Write-Host '已允许当前局域网访问 http://192.168.1.142:3088 ，没有开放数据库端口。'"
pause
