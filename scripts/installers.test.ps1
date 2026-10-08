[CmdletBinding()]
param([Parameter(Mandatory)][string] $Executable)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$temporary = Join-Path ([IO.Path]::GetTempPath()) ("folio-installer-test-" + [Guid]::NewGuid().ToString("N"))
$originalPath = [Environment]::GetEnvironmentVariable("Path", "User")
$originalProcessPath = $env:Path
$originalVersion = $env:FOLIO_VERSION
$originalDirectory = $env:FOLIO_INSTALL_DIR
$originalAssets = $env:FOLIO_TEST_ASSETS
$shortcutPath = Join-Path ([Environment]::GetFolderPath("Programs")) "Folio.lnk"
$originalShortcut = if (Test-Path -LiteralPath $shortcutPath) { [IO.File]::ReadAllBytes($shortcutPath) } else { $null }
New-Item -ItemType Directory -Path $temporary | Out-Null
try {
    $payload = Join-Path $temporary "payload"
    New-Item -ItemType Directory -Path $payload | Out-Null
    Copy-Item -LiteralPath $Executable -Destination (Join-Path $payload "Folio.exe")
    $architecture = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
    $arch = if ($architecture -eq "ARM64") { "arm64" } else { "x64" }
    $asset = "folio-windows-$arch.zip"
    $archive = Join-Path $temporary $asset
    Compress-Archive -Path (Join-Path $payload "Folio.exe") -DestinationPath $archive
    $hash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
    $sums = Join-Path $temporary "SHA256SUMS"
    Set-Content -LiteralPath $sums -Value "$hash  $asset" -Encoding Ascii
    function Invoke-WebRequest {
        param([switch] $UseBasicParsing, [string] $Uri, [string] $OutFile)
        $base = "https://github.com/HSPK/folio/releases/download/v0.1.0/"
        if (-not $Uri.StartsWith($base)) { throw "Unexpected download URL: $Uri" }
        $name = $Uri.Substring($base.Length)
        if ($name -ne $asset -and $name -ne "SHA256SUMS") { throw "Unexpected asset: $name" }
        Copy-Item -LiteralPath (Join-Path $env:FOLIO_TEST_ASSETS $name) -Destination $OutFile
    }
    $env:FOLIO_TEST_ASSETS = $temporary
    $env:FOLIO_VERSION = "0.1.0"
    $env:FOLIO_INSTALL_DIR = Join-Path $temporary "custom install directory"
    & (Join-Path $root "install.ps1")
    $installed = Join-Path $env:FOLIO_INSTALL_DIR "Folio.exe"
    $before = (Get-FileHash -LiteralPath $installed -Algorithm SHA256).Hash
    if ($before -ne (Get-FileHash -LiteralPath $Executable -Algorithm SHA256).Hash) { throw "Installed binary differs from the release payload." }
    if ((Get-Item -LiteralPath $installed).VersionInfo.ProductVersion -ne "0.1.0") { throw "Incorrect installed version." }
    if (-not (Test-Path -LiteralPath $shortcutPath)) { throw "Start Menu shortcut was not created." }
    if (([Environment]::GetEnvironmentVariable("Path", "User") -split ";") -notcontains $env:FOLIO_INSTALL_DIR) {
        throw "The installation directory was not added to user PATH."
    }
    Set-Content -LiteralPath $sums -Value "$('0' * 64)  $asset" -Encoding Ascii
    $rejected = $false
    try { & (Join-Path $root "install.ps1") }
    catch {
        if ($_.Exception.Message -notmatch "Checksum mismatch") { throw }
        $rejected = $true
    }
    if (-not $rejected) { throw "Invalid checksum was accepted." }
    if ((Get-FileHash -LiteralPath $installed -Algorithm SHA256).Hash -ne $before) { throw "Failed update changed the existing installation." }
    Write-Host "Windows installer: verified install, PATH, shortcut and failed-update preservation passed."
} finally {
    [Environment]::SetEnvironmentVariable("Path", $originalPath, "User")
    $env:Path = $originalProcessPath
    $env:FOLIO_VERSION = $originalVersion
    $env:FOLIO_INSTALL_DIR = $originalDirectory
    $env:FOLIO_TEST_ASSETS = $originalAssets
    if ($null -ne $originalShortcut) { [IO.File]::WriteAllBytes($shortcutPath, $originalShortcut) }
    elseif (Test-Path -LiteralPath $shortcutPath) { Remove-Item -LiteralPath $shortcutPath -Force }
    Remove-Item -LiteralPath $temporary -Recurse -Force
}
