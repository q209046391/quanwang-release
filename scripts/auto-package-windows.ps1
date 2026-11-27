param(
    [Parameter(Mandatory)][string]$Overlay,
    [Parameter(Mandatory)][string]$Work,
    [string]$Npm = 'npm.cmd',
    [string]$Python = 'python'
)

$ErrorActionPreference = 'Stop'
$pin = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'windows-build-inputs.json') | ConvertFrom-Json
$Overlay = (Resolve-Path -LiteralPath $Overlay).Path
$Work = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Work)
$null = New-Item -ItemType Directory -Path $Work -Force

function Test-Hash([string]$File, [string]$Sha, [long]$Size = 0) {
    return (Test-Path -LiteralPath $File -PathType Leaf) -and
        ($Size -eq 0 -or (Get-Item -LiteralPath $File).Length -eq $Size) -and
        ((Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash -eq $Sha)
}

function Get-VerifiedFile([string]$Url, [string]$Name, [string]$Sha, [long]$Size, [long]$Maximum) {
    $target = Join-Path $Work $Name
    if (!(Test-Hash $target $Sha $Size)) {
        $temporary = "$target.$([guid]::NewGuid().ToString('N')).download"
        try {
            $curlArgs = @('--fail', '--silent', '--show-error', '--location', '--retry', '2', '--max-time', '480',
                '--max-filesize', $Maximum, '--header', 'Accept: application/octet-stream', '--output', $temporary, $Url)
            & curl.exe @curlArgs
            if ($LASTEXITCODE -ne 0 -or !(Test-Hash $temporary $Sha $Size)) {
                throw "Download size or SHA-256 mismatch: $Name"
            }
            Move-Item -LiteralPath $temporary -Destination $target -Force
        } finally {
            if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary }
        }
    }
    return $target
}

if (!(Test-Hash $Overlay $pin.overlaySha256)) { throw 'Quanwang source overlay SHA-256 mismatch' }
$upstream = 'https://api.github.com/repos/jackotom/hongguo-drama'
$release = Invoke-RestMethod "$upstream/releases/latest" -Headers @{'User-Agent' = 'Quanwang-Windows-Build'} -TimeoutSec 30
if ($release.tag_name -ne $pin.tag -or $release.target_commitish -ne $pin.commit -or $release.draft -or $release.prerelease) {
    throw "Latest upstream tag $($release.tag_name) needs source compatibility review before packaging"
}
$upstreamVersion = $pin.tag.Substring(1)
$sourceName = "hongguo-downloader-$upstreamVersion-windows-source.zip"
$portableName = "hongguo-downloader-$upstreamVersion-win-x64.exe"
foreach ($item in @(@{name = $sourceName; data = $pin.source}, @{name = $portableName; data = $pin.portable})) {
    $asset = @($release.assets | Where-Object name -eq $item.name)
    if ($asset.Count -ne 1 -or $asset[0].id -ne $item.data.id -or $asset[0].size -ne $item.data.size -or
        $asset[0].digest -ne "sha256:$($item.data.sha256)" -or $asset[0].state -ne 'uploaded') {
        throw "The upstream release asset changed: $($item.name)"
    }
}

$base = Get-VerifiedFile "https://codeload.github.com/jackotom/hongguo-drama/zip/$($pin.baseCommit)" 'upstream-tag.zip' $pin.baseSha256 0 50MB
$source = Get-VerifiedFile "$upstream/releases/assets/$($pin.source.id)?download=1" $sourceName $pin.source.sha256 $pin.source.size 50MB
$portable = Get-VerifiedFile "$upstream/releases/assets/$($pin.portable.id)?download=1" $portableName $pin.portable.sha256 $pin.portable.size 300MB
$electronUrl = "https://api.github.com/repos/electron/electron/releases/assets/$($pin.electron.id)?download=1"
$electron = Get-VerifiedFile $electronUrl "electron-v$($pin.electron.version)-win32-x64.zip" $pin.electron.sha256 $pin.electron.size 300MB

$run = Join-Path $Work ("build-" + [guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $run
$stage = Join-Path $run 'source'
& $Python (Join-Path $PSScriptRoot 'package_windows.py') stage $base $Overlay $source $pin.tag $stage
if ($LASTEXITCODE -ne 0) { throw 'Upstream merge failed' }
$staged = Get-Content -Raw -LiteralPath (Join-Path $stage 'package.json') | ConvertFrom-Json
if ($staged.version -ne $pin.candidate -or $staged.devDependencies.electron -ne $pin.electron.version) {
    throw 'Generated version or Electron selection differs from the approved build inputs'
}
$buildArgs = @{Source=$stage; UpstreamPortable=$portable; ElectronArchive=$electron;
    Output=(Join-Path $run 'windows'); Npm=$Npm; Python=$Python}
& (Join-Path $PSScriptRoot 'build-windows.ps1') @buildArgs
$output = Join-Path $run 'windows'
if ($env:GITHUB_OUTPUT) { Add-Content -LiteralPath $env:GITHUB_OUTPUT -Value "windows=$output" -Encoding utf8 }
Write-Output "Windows candidate: $output"
