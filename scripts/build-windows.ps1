param(
    [Parameter(Mandatory)][string]$Source,
    [Parameter(Mandatory)][string]$UpstreamPortable,
    [Parameter(Mandatory)][string]$ElectronArchive,
    [Parameter(Mandatory)][string]$Output,
    [string]$Npm = 'npm.cmd',
    [string]$Python = 'python'
)

$ErrorActionPreference = 'Stop'
$Source = (Resolve-Path -LiteralPath $Source).Path
$UpstreamPortable = (Resolve-Path -LiteralPath $UpstreamPortable).Path
$ElectronArchive = (Resolve-Path -LiteralPath $ElectronArchive).Path
$Output = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Output)
if (Test-Path -LiteralPath $Output) { throw "Output already exists: $Output" }
$null = New-Item -Path $Output -ItemType Directory
$inputs = New-Item -Path (Join-Path $Output '_build') -ItemType Directory

function Invoke-Checked([string]$Command, [string[]]$Arguments) {
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Command failed with exit code $LASTEXITCODE" }
}

Push-Location -LiteralPath $Source
try {
    $package = Get-Content -Raw -LiteralPath package.json | ConvertFrom-Json
    $version = $package.version
    $brand = $package.build.productName
    if ($version -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid candidate version' }
    Invoke-Checked $Python @((Join-Path $PSScriptRoot 'package_windows.py'), 'archive', $Source, (Join-Path $Output "$brand-$version-源码.zip"))
    Invoke-Checked $Npm @('ci', '--cache', (Join-Path $inputs 'npm-cache'), '--ignore-scripts', '--no-audit', '--no-fund')

    $sevenZip = Join-Path $Source 'node_modules/electron-winstaller/vendor/7z-x64.exe'
    $archiveMember = '$PLUGINSDIR\app-64.7z'
    Invoke-Checked $sevenZip @('x', $UpstreamPortable, $archiveMember, "-o$inputs", '-y')
    $upstreamPayload = Join-Path $inputs $archiveMember
    $runtime = Join-Path $inputs 'upstream'
    $helper = 'build/sdk-playback/win32-x64/hongguo-sdk-playback.exe'
    $unpackedHelper = "resources/app.asar.unpacked/$helper"
    Invoke-Checked $sevenZip @('x', $upstreamPayload, 'resources/bin/*', $unpackedHelper, "-o$runtime", '-y')
    foreach ($name in @('ffmpeg.exe', 'ffprobe.exe', 'librempeg.exe')) {
        if (!(Test-Path -LiteralPath (Join-Path $runtime "resources/bin/$name") -PathType Leaf)) {
            throw "Verified upstream package is missing $name"
        }
    }
    Copy-Item -Path (Join-Path $runtime 'resources/bin/*') -Destination 'build/ffmpeg' -Force
    $null = New-Item -Path (Split-Path -Parent $helper) -ItemType Directory -Force
    Copy-Item -LiteralPath (Join-Path $runtime $unpackedHelper) -Destination $helper

    $electron = Join-Path $inputs 'electron'
    Invoke-Checked $sevenZip @('x', $ElectronArchive, "-o$electron", '-y')
    $expectedElectron = "^$([regex]::Escape($package.devDependencies.electron))(?:\.0)?$"
    if ((Get-Item -LiteralPath (Join-Path $electron 'electron.exe')).VersionInfo.ProductVersion -notmatch $expectedElectron) {
        throw 'Electron runtime version does not match package.json'
    }
    Invoke-Checked 'node' @('--check', 'main.js')
    Invoke-Checked 'node' @('--check', 'preload.js')
    $env:Path = (Split-Path (Get-Command $Npm).Source) + ';' + $env:Path
    Invoke-Checked $Npm @('run', 'build:react')
    $env:CSC_IDENTITY_AUTO_DISCOVERY = 'false'
    Invoke-Checked 'node' @('node_modules/electron-builder/out/cli/cli.js',
        '--win', 'portable', 'nsis', '--x64', '--publish', 'never',
        "--config.electronDist=$electron", "--config.directories.output=$Output",
        '-c.publish.provider=generic',
        '-c.publish.url=https://quanwang-update-test-1542797533.cos.ap-guangzhou.myqcloud.com/automation-test/candidate/')
    foreach ($name in @("$brand-$version.exe", "quanwang-$version-setup.exe", 'latest.yml')) {
        if (!(Test-Path -LiteralPath (Join-Path $Output $name) -PathType Leaf)) { throw "Missing generated file: $name" }
    }
    $appInfo = (Get-Item -LiteralPath (Join-Path $Output "win-unpacked/$brand.exe")).VersionInfo
    if ($appInfo.ProductName -ne $brand -or $appInfo.FileVersion -ne $version) {
        throw 'Windows product name or version does not match the candidate'
    }
    Invoke-Checked 'node' @((Join-Path $PSScriptRoot 'verify-candidate.cjs'), $Source, $Output)
} finally {
    Pop-Location
}
