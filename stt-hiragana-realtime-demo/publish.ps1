param(
  [Parameter(Mandatory = $true)]
  [string]$RemoteUrl,
  [string]$Branch = "main"
)

$ErrorActionPreference = "Stop"

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  throw "git が見つかりません。Git for Windows をインストールしてください。"
}

git init
git add .
if (-not (git rev-parse --verify HEAD 2>$null)) {
  git commit -m "Initial public release"
}

git branch -M $Branch

$existing = git remote 2>$null
if ($existing -match "origin") {
  git remote set-url origin $RemoteUrl
} else {
  git remote add origin $RemoteUrl
}

git push -u origin $Branch
Write-Host "Published to $RemoteUrl"
