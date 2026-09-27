// Build an MSI from the packaged app folder using wixl (msitools) — works on Linux.
// On Windows you can feed the same .wxs to WiX (`wix build`) instead.
import { readdirSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const here = import.meta.dirname;
const { version } = JSON.parse(readFileSync(resolve(here, 'package.json'), 'utf8'));
const src = resolve(here, 'out/ArchiveTrackReader-win32-x64');
const outMsi = resolve(here, `out/ArchiveTrackReader-${version}-x64.msi`);
// Never change: Windows uses this to recognise upgrades of the same product.
const UPGRADE_CODE = '7C5B1F7E-3A41-4F0B-9E7D-2B8A6C1D4E90';

// Deterministic GUIDs so component identity is stable between builds (clean upgrades).
const guid = (s) => {
  const h = createHash('sha1').update(`ao3track-reader:${s}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`.toUpperCase();
};
const id = (prefix, s) => `${prefix}_${createHash('md5').update(s).digest('hex').slice(0, 20)}`;
const esc = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

const componentRefs = [];
function dir(abs, depth = 1) {
  let xml = '';
  for (const name of readdirSync(abs).sort()) {
    const p = join(abs, name);
    const rel = relative(src, p).split(sep).join('/');
    if (statSync(p).isDirectory()) {
      xml += `${'  '.repeat(depth)}<Directory Id="${id('d', rel)}" Name="${esc(name)}">\n${dir(p, depth + 1)}${'  '.repeat(depth)}</Directory>\n`;
    } else {
      const cid = id('c', rel);
      componentRefs.push(cid);
      const isExe = rel === 'ArchiveTrackReader.exe';
      // wixl doesn't read version resources, so the exe would count as unversioned; give it its real version.
      const ver = isExe ? ` DefaultVersion="${version}.0"` : '';
      xml += `${'  '.repeat(depth)}<Component Id="${cid}" Guid="${guid(rel)}" Win64="yes"><File Id="${isExe ? 'MainExe' : id('f', rel)}" Source="${esc(p)}" Name="${esc(name)}" KeyPath="yes"${ver}/></Component>\n`;
    }
  }
  return xml;
}
const tree = dir(src, 5);

const wxs = `<?xml version="1.0" encoding="utf-8"?>
<Wix xmlns="http://schemas.microsoft.com/wix/2006/wi">
  <Product Id="*" Name="Archive Track Reader" Language="1033" Version="${version}.0" Manufacturer="Ao3Track" UpgradeCode="${UPGRADE_CODE}">
    <Package InstallerVersion="500" Compressed="yes" InstallScope="perMachine"
             Description="Archive Track Reader ${version}" Comments="Unofficial reader for the Archive of Our Own" Manufacturer="Ao3Track"/>
    <Media Id="1" Cabinet="app.cab" EmbedCab="yes"/>

    <!-- Remove any older version first (MajorUpgrade, spelled out for wixl). -->
    <Upgrade Id="${UPGRADE_CODE}">
      <UpgradeVersion Minimum="0.0.0" Maximum="${version}.0" IncludeMinimum="yes" IncludeMaximum="no" Property="OLDERVERSIONBEINGUPGRADED"/>
      <UpgradeVersion Minimum="${version}.0" IncludeMinimum="no" OnlyDetect="yes" Property="NEWERVERSIONDETECTED"/>
    </Upgrade>
    <InstallExecuteSequence>
      <RemoveExistingProducts After="InstallValidate"/>
    </InstallExecuteSequence>

    <!-- Always write every file on install/upgrade. Windows otherwise decides per file, before the
         old version is removed, whether a copy is "already there"; the removal then deleted files
         (e.g. the exe) that were never put back (#10). Everything here is private to the app. -->
    <Property Id="REINSTALLMODE" Value="amus"/>

    <Icon Id="AppIcon" SourceFile="${esc(resolve(here, '../../assets/icon.ico'))}"/>
    <Property Id="ARPPRODUCTICON" Value="AppIcon"/>
    <Property Id="ARPHELPLINK" Value="https://github.com/wench/Ao3-Tracker"/>
    <Property Id="ARPCOMMENTS" Value="Unofficial reader for the Archive of Our Own with location tracking and self-hosted sync"/>

    <Directory Id="TARGETDIR" Name="SourceDir">
      <Directory Id="ProgramFiles64Folder">
        <Directory Id="INSTALLDIR" Name="Archive Track Reader">
${tree}        </Directory>
      </Directory>
      <Directory Id="ProgramMenuFolder"/>
      <Directory Id="DesktopFolder"/>
    </Directory>

    <DirectoryRef Id="ProgramMenuFolder">
      <Component Id="StartMenuShortcut" Guid="${guid('shortcut:startmenu')}">
        <Shortcut Id="StartMenuLnk" Name="Archive Track Reader" Description="Read AO3 and never lose your place" Target="[INSTALLDIR]ArchiveTrackReader.exe" WorkingDirectory="INSTALLDIR" Icon="AppIcon"/>
        <RegistryValue Root="HKCU" Key="Software\\Ao3Track\\ArchiveTrackReader" Name="StartMenuShortcut" Type="integer" Value="1" KeyPath="yes"/>
      </Component>
    </DirectoryRef>
    <DirectoryRef Id="DesktopFolder">
      <Component Id="DesktopShortcut" Guid="${guid('shortcut:desktop')}">
        <Shortcut Id="DesktopLnk" Name="Archive Track Reader" Target="[INSTALLDIR]ArchiveTrackReader.exe" WorkingDirectory="INSTALLDIR" Icon="AppIcon"/>
        <RegistryValue Root="HKCU" Key="Software\\Ao3Track\\ArchiveTrackReader" Name="DesktopShortcut" Type="integer" Value="1" KeyPath="yes"/>
      </Component>
    </DirectoryRef>

    <Feature Id="Main" Title="Archive Track Reader" Level="1">
${componentRefs.map((c) => `      <ComponentRef Id="${c}"/>`).join('\n')}
      <ComponentRef Id="StartMenuShortcut"/>
      <ComponentRef Id="DesktopShortcut"/>
    </Feature>
  </Product>
</Wix>
`;
const wxsPath = resolve(here, 'out/ArchiveTrackReader.wxs');
writeFileSync(wxsPath, wxs);
execFileSync('wixl', ['-a', 'x64', '-o', outMsi, wxsPath], { stdio: 'inherit' });
console.log(`${componentRefs.length} files -> ${outMsi}`);
