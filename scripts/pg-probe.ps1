$env:PGPASSWORD = ''
# clear potentially problematic env vars that break postgres child processes
Remove-Item Env:LS_COLORS -ErrorAction SilentlyContinue
Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$env:PATH = "C:\Program Files\PostgreSQL\18\bin;C:\Windows\system32;C:\Windows"
& psql.exe -U postgres -h 127.0.0.1 -p 5544 -d postgres -tAc "SELECT 'connection-ok'"
