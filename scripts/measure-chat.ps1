# Baseline / pasca-optimasi: ukur waktu respons /api/ai/chat per pertanyaan.
# Pemakaian: powershell -File scripts\measure-chat.mts.ps1 [tag]
param([string]$tag = "run")

$ErrorActionPreference = "Stop"
$base = "http://localhost:3000"
$s = New-Object Microsoft.PowerShell.Commands.WebRequestSession

# Login sebagai pembeli (scope data personal)
$login = Invoke-WebRequest -Uri "$base/api/auth/login" -Method POST -ContentType "application/json" `
  -Body '{"email":"pembeli@mendungtirta.com","password":"password123"}' -WebSession $s -UseBasicParsing
if ($login.StatusCode -ne 200) { throw "login gagal: $($login.StatusCode)" }

$questions = @(
  "Berapa harga ikan kerapu?",
  "Produk di bawah Rp50000",
  "Berapa jumlah penjual?",
  "Bagaimana status pesanan saya?",
  "Siapa saya?",
  "Halo, apa yang bisa kamu bantu?"
)

$lines = @("=== MEASURE $tag $(Get-Date -Format 'HH:mm:ss') ===")
foreach ($q in $questions) {
  $body = @{ message = $q } | ConvertTo-Json
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  try {
    $r = Invoke-WebRequest -Uri "$base/api/ai/chat" -Method POST -ContentType "application/json" `
      -Body $body -WebSession $s -UseBasicParsing -TimeoutSec 100
    $sw.Stop()
    $j = $r.Content | ConvertFrom-Json
    $replyLen = if ($j.reply) { $j.reply.Length } else { 0 }
    $lines += ("{0,6} ms | {1,-8} | {2,-16} | len={3} | {4}" -f $sw.ElapsedMilliseconds, $r.StatusCode, "$($j.source)/$($j.fallbackReason)", $replyLen, $q)
  } catch {
    $sw.Stop()
    $code = "?"
    if ($_.Exception.Response) { try { $code = [int]$_.Exception.Response.StatusCode } catch { $code = "?" } }
    $lines += ("{0,6} ms | ERR {1} | {2}" -f $sw.ElapsedMilliseconds, $code, $q)
  }
}
$out = $lines -join "`n"
$out | Tee-Object -FilePath "C:\Users\ASUS\AppData\Local\Temp\opencode\measure-$tag.txt" -Append
