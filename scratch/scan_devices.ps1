# Scan all PnpDevices for serial/USB/Silicon Labs keywords and print full list
$keywords = @("*CP21*", "*Silicon*", "*UART*", "*Serial*", "*Unknown*", "*CH34*")
$devices = Get-PnpDevice

$matched = New-Object System.Collections.Generic.List[PSCustomObject]
foreach ($dev in $devices) {
    $found = $false
    foreach ($kw in $keywords) {
        if ($dev.FriendlyName -like $kw) {
            $found = $true
            break
        }
    }
    if ($found) {
        $matched.Add([PSCustomObject]@{
            FriendlyName = $dev.FriendlyName
            InstanceId   = $dev.InstanceId
            Present      = $dev.Present
            Status       = $dev.Status
            Class        = $dev.Class
        })
    }
}

$matched | Format-List
