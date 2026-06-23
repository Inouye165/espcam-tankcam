Write-Host "=============================================" -ForegroundColor Cyan
Write-Host "USB Board Detection & Comparison Script" -ForegroundColor Cyan
Write-Host "=============================================" -ForegroundColor Cyan
Write-Host ""

# Step 1: Prompt unplug
Write-Host "Step 1: Please UNPLUG the Waveshare board from USB." -ForegroundColor Yellow
Read-Host "Press ENTER when the board is UNPLUGGED to take the baseline snapshot"

Write-Host "Taking baseline snapshot..." -ForegroundColor Green
$before = Get-PnpDevice | Sort-Object Class,FriendlyName
$beforePath = "$env:USERPROFILE\Desktop\before.txt"
$before | Out-File $beforePath

# Step 2: Prompt plug
Write-Host ""
Write-Host "Step 2: Please PLUG the Waveshare board back in." -ForegroundColor Yellow
Write-Host "Wait 3-5 seconds for Windows to play the connection sound." -ForegroundColor Gray
Read-Host "Press ENTER when the board is PLUGGED IN to take the final snapshot"

Write-Host "Taking plug-in snapshot..." -ForegroundColor Green
$after = Get-PnpDevice | Sort-Object Class,FriendlyName
$afterPath = "$env:USERPROFILE\Desktop\after.txt"
$after | Out-File $afterPath

# Step 3: Compare
Write-Host ""
Write-Host "---------------------------------------------" -ForegroundColor Cyan
Write-Host "Comparing snapshots..." -ForegroundColor Cyan
Write-Host "---------------------------------------------" -ForegroundColor Cyan

$diff = Compare-Object (Get-Content $beforePath) (Get-Content $afterPath)

if ($diff) {
    Write-Host "Found changes in detected devices:" -ForegroundColor Green
    foreach ($line in $diff) {
        if ($line.SideIndicator -eq "=>") {
            Write-Host "[ADDED]   $($line.InputObject)" -ForegroundColor Green
        } else {
            Write-Host "[REMOVED] $($line.InputObject)" -ForegroundColor Red
        }
    }
} else {
    Write-Host "No differences detected. Windows did not register any new USB or hardware changes." -ForegroundColor Red
}

Write-Host ""
Write-Host "Snapshots saved to Desktop as 'before.txt' and 'after.txt'." -ForegroundColor Gray
