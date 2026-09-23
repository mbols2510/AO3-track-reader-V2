# Build (and optionally sign) an MSIX from the packaged app. Windows only: needs the Windows SDK
# (makeappx.exe / signtool.exe), which GitHub's windows-latest runners include.
#   pwsh apps/reader/make-msix.ps1 [-PfxPath cert.pfx -PfxPassword ***]
# The Publisher below must equal your signing certificate's subject.
param([string]$PfxPath = "", [string]$PfxPassword = "", [string]$Publisher = "CN=Ao3Track")
$ErrorActionPreference = "Stop"
$here = $PSScriptRoot
$version = (Get-Content "$here/package.json" | ConvertFrom-Json).version
$src = "$here/out/ArchiveTrackReader-win32-x64"
$stage = "$here/out/msix-stage"
Remove-Item -Recurse -Force $stage -ErrorAction SilentlyContinue
Copy-Item -Recurse $src $stage
New-Item -ItemType Directory "$stage/Assets" | Out-Null
Copy-Item "$here/../../assets/msix/*.png" "$stage/Assets/"

@"
<?xml version="1.0" encoding="utf-8"?>
<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
         xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"
         xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities"
         IgnorableNamespaces="uap rescap">
  <Identity Name="Ao3Track.ArchiveTrackReader" Publisher="$Publisher" Version="$version.0" ProcessorArchitecture="x64"/>
  <Properties>
    <DisplayName>Archive Track Reader</DisplayName>
    <PublisherDisplayName>Ao3Track</PublisherDisplayName>
    <Logo>Assets\StoreLogo.png</Logo>
    <Description>Unofficial reader for the Archive of Our Own with location tracking and self-hosted sync.</Description>
  </Properties>
  <Dependencies><TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.19041.0" MaxVersionTested="10.0.26100.0"/></Dependencies>
  <Resources><Resource Language="en-us"/></Resources>
  <Applications>
    <Application Id="ArchiveTrackReader" Executable="ArchiveTrackReader.exe" EntryPoint="Windows.FullTrustApplication">
      <uap:VisualElements DisplayName="Archive Track Reader" Description="Read AO3 and never lose your place"
          BackgroundColor="transparent" Square150x150Logo="Assets\Square150x150Logo.png" Square44x44Logo="Assets\Square44x44Logo.png">
        <uap:DefaultTile Wide310x150Logo="Assets\Wide310x150Logo.png"/>
      </uap:VisualElements>
    </Application>
  </Applications>
  <Capabilities><Capability Name="internetClient"/><rescap:Capability Name="runFullTrust"/></Capabilities>
</Package>
"@ | Set-Content -Encoding utf8 "$stage/AppxManifest.xml"

# Newest SDK that actually ships makeappx.exe. (Sort on the version folder: every leaf is named "x64".)
$makeappx = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin\*\x64\makeappx.exe" -ErrorAction SilentlyContinue |
  Sort-Object { try { [version]$_.Directory.Parent.Name } catch { [version]"0.0" } } -Descending | Select-Object -First 1
if (-not $makeappx) { throw "makeappx.exe not found; install the Windows 10/11 SDK" }
$bin = $makeappx.DirectoryName
Write-Host "Using Windows SDK tools from $bin"
$msix = "$here/out/ArchiveTrackReader-$version-x64.msix"
& "$bin\makeappx.exe" pack /o /d $stage /p $msix
if ($LASTEXITCODE -ne 0) { throw "makeappx failed ($LASTEXITCODE)" }
if ($PfxPath) {
  & "$bin\signtool.exe" sign /fd SHA256 /f $PfxPath /p $PfxPassword /tr http://timestamp.digicert.com /td SHA256 $msix
  if ($LASTEXITCODE -ne 0) { throw "signtool failed ($LASTEXITCODE)" }
}
Write-Host "Built $msix"
