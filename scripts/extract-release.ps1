param(
    [Parameter(Mandatory = $true)][string]$ArchivePath,
    [Parameter(Mandatory = $true)][string]$DestinationPath
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::OpenRead($ArchivePath)
try {
    if ($archive.Entries.Count -eq 0) { throw 'Release ZIP is empty.' }
    foreach ($entry in $archive.Entries) {
        # Explorer rejects dot-directory entries even though tar and .NET can
        # extract them. ZIP paths must be relative, with forward slashes only.
        if ($entry.FullName -match '(^/|\\|^[A-Za-z]:|(^|/)\.\.?(/|$))') {
            throw "Nonportable ZIP entry: $($entry.FullName)"
        }
    }
} finally {
    $archive.Dispose()
}

Expand-Archive -LiteralPath $ArchivePath -DestinationPath $DestinationPath -ErrorAction Stop
