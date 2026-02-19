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
  if ($Node -is [string]) { return [string]$Node }
  if ($Node.PSObject -and $Node.PSObject.Properties.Name -contains '#text') {
    $v = $Node.'#text'
    if ($null -ne $v) { return [string]$v }
  }
  return [string]$Node
}

function Build-AudioSettings {
  param($Node)
  if ($null -eq $Node) { return $null }
  $useTts = To-Bool (Get-NodeText ($Node.SelectSingleNode('UseTextToVoice')))
  $interrupt = To-Bool (Get-NodeText ($Node.SelectSingleNode('InterruptSpeech')))
  $ttsText = Get-NodeText ($Node.SelectSingleNode('TextToVoiceText'))
  $playFile = To-Bool (Get-NodeText ($Node.SelectSingleNode('PlayMediaFile')))
  $soundFile = Get-NodeText ($Node.SelectSingleNode('MediaFile'))

  if ($useTts) {
    $obj = [ordered]@{
      mode = 'tts'
      text = $ttsText
    }
    if ($interrupt) { $obj.interrupt = $true }
    return [pscustomobject]$obj
  }
  if ($playFile -and -not [string]::IsNullOrWhiteSpace($soundFile)) {
    $obj = [ordered]@{
      mode = 'file'
      soundFile = $soundFile
    }
    if ($interrupt) { $obj.interrupt = $true }
    return [pscustomobject]$obj
  }
  return $null
}

function Build-TextSettings {
  param($Node)
  if ($null -eq $Node) { return $null }
  $useText = To-Bool (Get-NodeText ($Node.SelectSingleNode('UseText')))
  $displayText = Get-NodeText ($Node.SelectSingleNode('DisplayText'))
  $copyClipboard = To-Bool (Get-NodeText ($Node.SelectSingleNode('CopyToClipboard')))
  $clipboardText = Get-NodeText ($Node.SelectSingleNode('ClipboardText'))

  if (-not $useText -and -not $copyClipboard) {
    return $null
  }

  $obj = [ordered]@{}
  if ($useText) {
    $obj.display = $true
    $obj.displayText = $displayText
  }
  if ($copyClipboard) {
    $obj.clipboard = $true
    $obj.clipboardText = $clipboardText
  }
  return [pscustomobject]$obj
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
    $timerNameNode = $t.SelectSingleNode('TimerName')
    $useEndingNode = $t.SelectSingleNode('UseTimerEnding')
    $endingTriggerNode = $t.SelectSingleNode('TimerEndingTrigger')
    $useEndedNode = $t.SelectSingleNode('UseTimerEnded')
    $endedTriggerNode = $t.SelectSingleNode('TimerEndedTrigger')
    $endingNode = $t.SelectSingleNode('TimerEndingTime')
    $catNode = $t.SelectSingleNode('Category')
    $groupNameNode = $t.SelectSingleNode('ancestor::TriggerGroup[1]/Name')

    $name = Get-NodeText $nameNode
    $pattern = Get-NodeText $textNode
    $isRegex = To-Bool (Get-NodeText $regexNode)
    $timerType = Get-NodeText $typeNode
    $timerName = Get-NodeText $timerNameNode
    $seconds = To-Int (Get-NodeText $secNode)
    $useTimerEnding = To-Bool (Get-NodeText $useEndingNode)
    $useTimerEnded = To-Bool (Get-NodeText $useEndedNode)
    $timerEnding = To-Int (Get-NodeText $endingNode)
    if (-not $seconds) {
      $ms = To-Int (Get-NodeText $msNode)
      if ($ms -gt 0) { $seconds = [math]::Round($ms / 1000) }
    }
    $category = Get-NodeText $catNode
    $groupName = Get-NodeText $groupNameNode
    $hasTsToken = [regex]::IsMatch([string]$pattern, '\{TS\}', [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)

    if ([string]::IsNullOrWhiteSpace($pattern)) { continue }
    if ($timerType -and $timerType -ne 'Timer') { continue }
    if ($seconds -le 0 -and $useTimerEnding -and $timerEnding -gt 0) {
      $seconds = $timerEnding
    }
    if ($seconds -le 0 -and $hasTsToken) {
      # Keep TS-driven timers; runtime will replace with parsed duration from the log line.
      $seconds = 1
    }
    if ($seconds -le 0) { continue }

    if ([string]::IsNullOrWhiteSpace($category) -or $category -eq 'Default') {
      if (-not [string]::IsNullOrWhiteSpace($groupName) -and $groupName -ne 'Default') {
        $category = $groupName
      }
    }

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
    if ($hasTsToken) { $obj.dynamicDuration = 'ts' }
    if (-not [string]::IsNullOrWhiteSpace($timerName)) {
      $obj.timer = [ordered]@{
        name = $timerName
      }
    }
    $basicText = Build-TextSettings $t
    if ($basicText) { $obj.textSettings = $basicText }
    $basicAudio = Build-AudioSettings $t
    if ($basicAudio) { $obj.audio = $basicAudio }
    if ($useTimerEnding -and $timerEnding -ge 0) {
      $endingAudio = Build-AudioSettings $endingTriggerNode
      $endingText = Build-TextSettings $endingTriggerNode
      $endingObj = [ordered]@{
        enabled = $true
        thresholdSeconds = $timerEnding
      }
      if ($endingText) { $endingObj.textSettings = $endingText }
      if ($endingAudio) { $endingObj.audio = $endingAudio }
      $obj.timerEnding = [pscustomobject]$endingObj
    }
    if ($useTimerEnded) {
      $endedAudio = Build-AudioSettings $endedTriggerNode
      $endedText = Build-TextSettings $endedTriggerNode
      if ($endedAudio -or $endedText) {
        $endedObj = [ordered]@{
          enabled = $true
        }
        if ($endedText) { $endedObj.textSettings = $endedText }
        if ($endedAudio) { $endedObj.audio = $endedAudio }
        $obj.timerEnded = [pscustomobject]$endedObj
      }
    }

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
  # Force array semantics even when only one trigger is returned.
  $all = @(Build-TriggersFromXml -Xml $xml -SeenIds $seen)

  # Emit JSON in our app's trigger schema as an array in all cases.
  if ($all.Count -eq 0) {
    $json = '[]'
  } elseif ($all.Count -eq 1) {
    $single = $all[0] | ConvertTo-Json -Depth 6
    $json = "[`n$single`n]"
  } else {
    $json = $all | ConvertTo-Json -Depth 6
  }
  # Write UTF-8 without BOM to avoid JSON.parse issues in Node
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($OutputPath, $json, $utf8NoBom)
  Write-Info "Converted $($all.Count) triggers to: $OutputPath"
} finally {
  # Cleanup temp
  try { Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $tempRoot } catch { }
}
