$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$port = 3001
$appUrl = "http://localhost:$port"

function Test-PortOpen {
    param(
        [string]$HostName,
        [int]$Port,
        [int]$TimeoutMs = 500
    )

    try {
        $client = New-Object System.Net.Sockets.TcpClient
        $iar = $client.BeginConnect($HostName, $Port, $null, $null)
        $connected = $iar.AsyncWaitHandle.WaitOne($TimeoutMs, $false)
        if (-not $connected) {
            $client.Close()
            return $false
        }

        $client.EndConnect($iar)
        $client.Close()
        return $true
    }
    catch {
        return $false
    }
}

if (-not (Test-PortOpen -HostName "127.0.0.1" -Port $port)) {
    $startCommand = "Set-Location '$repoRoot'; `$env:PORT='$port'; npm --prefix app start"
    Start-Process -FilePath "powershell.exe" -WindowStyle Hidden -ArgumentList @(
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-Command", $startCommand
    )

    $maxAttempts = 30
    for ($i = 0; $i -lt $maxAttempts; $i++) {
        Start-Sleep -Milliseconds 500
        if (Test-PortOpen -HostName "127.0.0.1" -Port $port) {
            break
        }
    }
}

$edgeCandidates = @(
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles(x86)\Microsoft\Edge\Application\msedge.exe"
)

$edgeExe = $edgeCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1

if ($edgeExe) {
    Start-Process -FilePath $edgeExe -ArgumentList "--app=$appUrl"
}
else {
    Start-Process -FilePath $appUrl
}
