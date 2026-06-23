Write-Host "=============================================" -ForegroundColor Cyan
Write-Host "USB Board Detection (Present Only) Script" -ForegroundColor Cyan
Write-Host "=============================================" -ForegroundColor Cyan
Write-Host ""

# Step 1: Prompt unplug
Write-Host "Step 1: Please UNPLUG the Waveshare board from USB." -ForegroundColor Yellow
Read-Host "Press ENTER when the board is UNPLUGGED to take the baseline snapshot"

Write-Host "Taking baseline snapshot (Present Only)..." -ForegroundColor Green
$before = Get-PnpDevice -PresentOnly | Select-Object FriendlyName, InstanceId, Class, Status | Sort-Object Class,FriendlyName
$beforePath = "$env:USERPROFILE\Desktop\before_present.txt"
$before | Format-Table -AutoSize | Out-File $beforePath

# Step 2: Prompt plug
Write-Host ""
Write-Host "Step 2: Please PLUG the Waveshare board back in." -ForegroundColor Yellow
Write-Host "Wait 3-5 seconds for Windows to play the connection sound." -ForegroundColor Gray
Read-Host "Press ENTER when the board is PLUGGED IN to take the final snapshot"

Write-Host "Taking plug-in snapshot (Present Only)..." -ForegroundColor Green
$after = Get-PnpDevice -PresentOnly | Select-Object FriendlyName, InstanceId, Class, Status | Sort-Object Class,FriendlyName
$afterPath = "$env:USERPROFILE\Desktop\after_present.txt"
$after | Format-Table -AutoSize | Out-File $afterPath

# Step 3: Compare
Write-Host ""
Write-Host "---------------------------------------------" -ForegroundColor Cyan
Write-Host "Comparing snapshots..." -ForegroundColor Cyan
Write-Host "---------------------------------------------" -ForegroundColor Cyan

$diff = Compare-Object (Get-Content $beforePath) (Get-Content $afterPath)

if ($diff) {
    Write-Host "Found changes in present devices:" -ForegroundColor Green
    foreach ($line in $diff) {
        if ($line.SideIndicator -eq "=>") {
            Write-Host "[ADDED]   $($line.InputObject)" -ForegroundColor Green
        } else {
            Write-Host "[REMOVED] $($line.InputObject)" -ForegroundColor Red
        }
    }
} else {
    Write-Host "No differences detected in present devices. Windows did not register any new active hardware." -ForegroundColor Red
}

Write-Host ""
Write-Host "Snapshots saved to Desktop as 'before_present.txt' and 'after_present.txt'." -ForegroundColor Gray
