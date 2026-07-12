# No Bloat PDF release signing via Microsoft Artifact Signing.
# Invoked by the Tauri bundler (bundle.windows.signCommand) for the app exe
# and the NSIS installer. Requires: signed-in Azure CLI (az login) for the
# account that holds the Artifact Signing Certificate Profile Signer role.
param([Parameter(Mandatory = $true)][string]$File)

# The signing dlib authenticates via Azure CLI; make sure az is on PATH even
# when the parent process env predates the CLI install.
$env:Path = "C:\Program Files\Microsoft SDKs\Azure\CLI2\wbin;" + $env:Path

$signtool = "C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64\signtool.exe"
$dlib = "$env:LOCALAPPDATA\Microsoft\MicrosoftArtifactSigningClientTools\Azure.CodeSigning.Dlib.dll"
$metadata = Join-Path $PSScriptRoot "metadata.json"

& $signtool sign /fd SHA256 /tr "http://timestamp.acs.microsoft.com" /td SHA256 /dlib $dlib /dmdf $metadata $File
exit $LASTEXITCODE
