[CmdletBinding()]
param(
    [string] $Version = $env:FOLIO_VERSION,
    [string] $InstallDir = $env:FOLIO_INSTALL_DIR
)

$ErrorActionPreference = "Stop"
if ($env:OS -ne "Windows_NT") { throw "Use install.sh on Linux or macOS." }
if (-not $env:LOCALAPPDATA) { throw "LOCALAPPDATA is not set." }
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$architecture = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
$arch = switch ($architecture) {
    "AMD64" { "x64" }
    "ARM64" { "arm64" }
    default { throw "Only x64 and ARM64 Windows are supported." }
}
if (-not $Version -or $Version -eq "latest") {
    $release = Invoke-RestMethod -Uri "https://api.github.com/repos/HSPK/folio/releases/latest"
    $Version = $release.tag_name
}
if ($Version -notmatch "^v") { $Version = "v$Version" }
if ($Version -notmatch "^v\d+\.\d+\.\d+$") { throw "Invalid release version: $Version" }
if (-not $InstallDir) { $InstallDir = Join-Path $env:LOCALAPPDATA "Programs\Folio" }
$InstallDir = [IO.Path]::GetFullPath($InstallDir)
$asset = "folio-windows-$arch.zip"
$base = "https://github.com/HSPK/folio/releases/download/$Version"
$temporary = Join-Path ([IO.Path]::GetTempPath()) ("folio-install-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $temporary | Out-Null
try {
    $archive = Join-Path $temporary $asset
    $sums = Join-Path $temporary "SHA256SUMS"
    Invoke-WebRequest -UseBasicParsing -Uri "$base/$asset" -OutFile $archive
    Invoke-WebRequest -UseBasicParsing -Uri "$base/SHA256SUMS" -OutFile $sums
    $entry = @(Get-Content -LiteralPath $sums | Where-Object { $_ -match "^[a-fA-F0-9]{64}\s+$([regex]::Escape($asset))$" })
    if ($entry.Count -ne 1) { throw "Missing or invalid checksum for $asset." }
    $expected = ($entry[0] -split "\s+")[0]
    if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $expected) {
        throw "Checksum mismatch; nothing was installed."
    }
    $expanded = Join-Path $temporary "expanded"
    Expand-Archive -LiteralPath $archive -DestinationPath $expanded
    $executable = Join-Path $expanded "Folio.exe"
    if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) { throw "The archive contains no Folio.exe." }
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
    $destination = Join-Path $InstallDir "Folio.exe"
    if (Test-Path -LiteralPath $destination -PathType Container) { throw "$destination is a directory." }
    $staged = Join-Path $InstallDir (".folio-install-" + [Guid]::NewGuid().ToString("N") + ".exe")
    try {
        Copy-Item -LiteralPath $executable -Destination $staged
        Move-Item -LiteralPath $staged -Destination $destination -Force
    } catch {
        throw "Could not install Folio. Close any running Folio instance and retry. $($_.Exception.Message)"
    } finally {
        if (Test-Path -LiteralPath $staged) { Remove-Item -LiteralPath $staged -Force }
    }
    $programs = [Environment]::GetFolderPath("Programs")
    if (-not $programs) { throw "The Start Menu directory could not be located." }
    New-Item -ItemType Directory -Path $programs -Force | Out-Null
    $shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $programs "Folio.lnk"))
    $shortcut.TargetPath = $destination
    $shortcut.WorkingDirectory = $InstallDir
    $shortcut.IconLocation = "$destination,0"
    $shortcut.Save()
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $entries = @($userPath -split ";" | Where-Object { $_ })
    if ($entries -notcontains $InstallDir) {
        [Environment]::SetEnvironmentVariable("Path", (($entries + $InstallDir) -join ";"), "User")
    }
    if (($env:Path -split ";") -notcontains $InstallDir) { $env:Path += ";$InstallDir" }
    Write-Host "Installed Folio $($Version.TrimStart('v')) to $destination"
    Write-Host "Open Folio from the Start Menu. New terminals can also run: folio"
} finally {
    Remove-Item -LiteralPath $temporary -Recurse -Force
}
