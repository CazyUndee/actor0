' actor0 packaged launcher.
'
' Starts the agent with a direct node.exe spawn (never through the shell's
' os.spawnProcess — see scripts/package.mjs (stage-launcher) for why that permission
' cannot be made safe), writes the port file the page reads, then starts the
' app window. No console window: wscript runs scripts silently.
'
' Paths are resolved from the script's own location, so the app runs from any
' install directory and from a double-click without a working directory.
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
agentExe = here & "\runtime\node.exe"
agentBundle = here & "\agent\agent.mjs"
portFile = here & "\agent\port.json"
appExe = here & "\actor0-desktop-win_x64.exe"

' The agent's --port-file is the page's handshake (M3-era contract: the page
' polls agent-port.json, so the shim only has to place it next to the bundle).
cmd = """" & agentExe & """ """ & agentBundle & """ --port-file """ & portFile & """"
sh.Run cmd, 0, False

' Give the agent a beat to bind, then the window (the page re-polls, so the
' order is a convenience, not a race the user can lose).
WScript.Sleep 400
sh.Run """" & appExe & """", 1, False
