param([Parameter(Mandatory=$true)][string]$Archive,[Parameter(Mandatory=$true)][string]$Destination,[Parameter(Mandatory=$true)][string]$Root)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$rootPath=[IO.Path]::GetFullPath((Resolve-Path -LiteralPath $Root).Path).TrimEnd('\')+'\'
$target=[IO.Path]::GetFullPath($Destination).TrimEnd('\')+'\'
if(-not $target.StartsWith($rootPath,[StringComparison]::OrdinalIgnoreCase) -or $target -eq $rootPath){throw 'Extraction destination must be inside the installation root'}
if(Test-Path -LiteralPath $Destination){throw 'Extraction destination already exists'}
$ancestor=[IO.Path]::GetDirectoryName($target.TrimEnd('\'))
while($ancestor -and ($ancestor.TrimEnd('\')+'\').StartsWith($rootPath,[StringComparison]::OrdinalIgnoreCase)){
  if(Test-Path -LiteralPath $ancestor){if((Get-Item -LiteralPath $ancestor).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Extraction path cannot traverse a filesystem link'}}
  if(($ancestor.TrimEnd('\')+'\') -eq $rootPath){break}
  $ancestor=[IO.Path]::GetDirectoryName($ancestor)
}
$zip=[IO.Compression.ZipFile]::OpenRead((Resolve-Path -LiteralPath $Archive).Path)
try{
  foreach($entry in $zip.Entries){
    $entryPath=[IO.Path]::GetFullPath([IO.Path]::Combine($Destination,$entry.FullName))
    if($entry.FullName.Contains(':')){throw 'Archive alternate data streams are not supported'}
    if(-not $entry.Name -and $entryPath.TrimEnd('\') -eq $target.TrimEnd('\')){continue}
    if(-not $entryPath.StartsWith($target,[StringComparison]::OrdinalIgnoreCase)){throw 'Archive contains a path outside the destination'}
    if((($entry.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000){throw 'Archive links are not supported'}
  }
}finally{$zip.Dispose()}
[IO.Compression.ZipFile]::ExtractToDirectory($Archive,$Destination)
