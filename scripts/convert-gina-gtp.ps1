param(
  [Parameter(Mandatory = $true)]
  [string]$InputPath,

  [string]$OutputPath
)

set-strictmode -version latest
$ErrorActionPreference = 'Stop'

function Write-Info {
  param([string]$Message)
  Write-Host "[convert-gina] $Message"
}

function Normalize-Id {
  param([string]$Text)
  if (-not $Text) { return $null }
  $lower = $Text.ToLowerInvariant()
  $id = ($lower -replace "[^a-z0-9]+", "-")
  $id = $id.Trim('-')
  if (-not $id) { $id = "trigger" }
  return $id
}

function To-Bool {
  param($Value)
  if ($null -eq $Value) { return $false }
  $s = [string]$Value
  return $s.Trim().ToLowerInvariant() -in @('true','1','yes')
}

function To-Int {
  param($Value)
  if ($null -eq $Value) { return 0 }
  try { return [int]$Value } catch { return 0 }
}

function Get-NodeText {
  param($Node)
  if ($null -eq $Node) { return $null }
  # PowerShell [xml] exposes element text either as string or via #text
  if ($Node.'#text') { return [string]$Node.'#text' }
  return [string]$Node
}

function Build-TriggersFromXml {
  param([System.Xml.XmlDocument]$Xml, [hashtable]$SeenIds)

  $results = @()
  $nodes = $Xml.SelectNodes('//Trigger')
  foreach ($t in $nodes) {
    if (-not $t) { continue }

    $nameNode = $t.SelectSingleNode('Name')
    $textNode = $t.SelectSingleNode('TriggerText')
    $regexNode = $t.SelectSingleNode('EnableRegex')
    $typeNode = $t.SelectSingleNode('TimerType')
    $secNode = $t.SelectSingleNode('TimerDuration')
    $msNode = $t.SelectSingleNode('TimerMillisecondDuration')
    $catNode = $t.SelectSingleNode('Category')

    $name = Get-NodeText $nameNode
    $pattern = Get-NodeText $textNode
    $isRegex = To-Bool (Get-NodeText $regexNode)
    $timerType = Get-NodeText $typeNode
    $seconds = To-Int (Get-NodeText $secNode)
    if (-not $seconds) {
      $ms = To-Int (Get-NodeText $msNode)
      if ($ms -gt 0) { $seconds = [math]::Round($ms / 1000) }
    }
    $category = Get-NodeText $catNode

    if ([string]::IsNullOrWhiteSpace($pattern)) { continue }
    if ($seconds -le 0) { continue }
    if ($timerType -and $timerType -ne 'Timer') { continue }

    $baseId = Normalize-Id $name
    $id = $baseId
    $i = 2
    while ($SeenIds.ContainsKey($id)) {
      $id = "$baseId-$i"
      $i++
    }
    $SeenIds[$id] = $true

    $obj = [ordered]@{
      id       = $id
      label    = $name
      pattern  = $pattern
      duration = $seconds
    }
    if ($category) { $obj.category = $category }

    if ($isRegex) {
      $obj.isRegex = $true
      $obj.flags   = 'i'
    }

    $results += [pscustomobject]$obj
  }
  return $results
}

# Resolve paths
$inputFull = Resolve-Path -Path $InputPath
if (-not (Test-Path -Path $inputFull -PathType Leaf)) {
  throw "Input file not found: $InputPath"
}

if (-not $OutputPath -or [string]::IsNullOrWhiteSpace($OutputPath)) {
  $dir = Split-Path -Path $inputFull -Parent
  $base = [System.IO.Path]::GetFileNameWithoutExtension([string]$inputFull)
  $OutputPath = Join-Path -Path $dir -ChildPath ("$base.triggers.json")
}

$outFull = Resolve-Path -Path (Split-Path -Parent $OutputPath) -ErrorAction SilentlyContinue
if (-not $outFull) {
  $null = New-Item -ItemType Directory -Force -Path (Split-Path -Parent $OutputPath)
}

# Prepare temp working directory
$tempRoot = Join-Path -Path ([System.IO.Path]::GetTempPath()) -ChildPath ("gina-" + [System.Guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Force -Path $tempRoot
try {
  $zipPath = Join-Path -Path $tempRoot -ChildPath 'package.zip'
  Copy-Item -Path $inputFull -Destination $zipPath -Force

  $extractPath = Join-Path -Path $tempRoot -ChildPath 'unzipped'
  $null = New-Item -ItemType Directory -Force -Path $extractPath
  Expand-Archive -Path $zipPath -DestinationPath $extractPath -Force

  # Find ShareData.xml anywhere in the archive
  $shareXml = Get-ChildItem -Path $extractPath -Recurse -Filter 'ShareData.xml' -File | Select-Object -First 1
  if (-not $shareXml) {
    throw 'ShareData.xml not found in archive.'
  }

  [xml]$xml = Get-Content -Path $shareXml.FullName -Encoding UTF8
  $seen = @{}
  $all = Build-TriggersFromXml -Xml $xml -SeenIds $seen

  # Emit JSON in our app's trigger schema
  $json = $all | ConvertTo-Json -Depth 6
  # Write UTF-8 without BOM to avoid JSON.parse issues in Node
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($OutputPath, $json, $utf8NoBom)
  Write-Info "Converted $($all.Count) triggers to: $OutputPath"
} finally {
  # Cleanup temp
  try { Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $tempRoot } catch { }
}
