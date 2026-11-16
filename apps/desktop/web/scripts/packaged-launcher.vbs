' actor0 packaged launcher.
'
' Starts the agent with a direct node.exe spawn (never through the shell's
' os.spawnProcess — see scripts/package.mjs (stage-launcher) for why that
' permission cannot be made safe), writes the port file the page reads, then
' starts the app window. No console window: wscript runs scripts silently.
'
' Paths resolve from the script's own location, so the app runs from any
' install directory. The app exe is found by pattern rather than name because
' package.mjs stamps the version into it (actor0-<version>-win-x64.exe) and a
' hard-coded name rots on every release — the previous launcher shipped
' pointing at an exe that no longer existed.
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
agentExe = here & "\runtime\node.exe"
agentBundle = here & "\agent\agent.mjs"
portFile = here & "\agent\port.json"

' Find the app exe: first unversioned (dev staging), else the newest matching
' actor0-*-win-x64.exe — two builds extracted side by side launch the newest.
Dim appExe
appExe = ""
If fso.FileExists(here & "\actor0-desktop-win_x64.exe") Then
  appExe = here & "\actor0-desktop-win_x64.exe"
Else
  Dim folder, best, bestDate
  Set folder = fso.GetFolder(here)
  For Each f In folder.Files
    If Left(f.Name, 7) = "actor0-" And InStr(f.Name, "-win-x64.exe") > 0 Then
      If bestDate = "" Or f.DateLastModified > bestDate Then
        bestDate = f.DateLastModified
        best = f.Path
      End If
    End If
  Next
  appExe = best
End If
If appExe = "" Then
  MsgBox "actor0: could not find the app executable next to this launcher.", 16, "actor0"
  WScript.Quit 1
End If

' Single instance: if a live agent already holds the port file, this is a
' second launch — just focus the (new) window and do not spawn a second agent,
' which would race the first for the handshake and linger as a stray process.
Dim launched
launched = False
If fso.FileExists(portFile) Then
  On Error Resume Next
  Dim port, probe
  port = 0
  Dim ts
  Set ts = fso.OpenTextFile(portFile, 1)
  If Not ts.AtEndOfStream Then
    Dim line
    line = ts.ReadAll()
    Dim re
    Set re = New RegExp
    re.Pattern = """port"":\s*(\d+)"
    Dim m
    Set m = re.Execute(line)
    If m.Count > 0 Then port = CLng(m(0).SubMatches(0))
  End If
  ts.Close
  On Error GoTo 0
  If port > 0 Then
    ' A stale port file from a dead agent would also resolve here; the page
    ' treats an unreachable agent as connect-fail and shows its banner, and a
    ' dead agent dying with the window means the file dies with it — accepted
    ' rather than probing sockets from vbs (no such primitive).
    launched = True
  End If
End If

If Not launched Then
  ' The shim is the agent's supervisor AND its cleanup: the window runs
  ' synchronously, and when it closes the agent is killed — a user closing the
  ' app must not leave a background agent holding a port. sh.Exec exposes the
  ' PID through ProcessId, and the kill uses taskkill on the PID directly
  ' (Exec.Terminate proved unreliable against a detached node child).
  Dim agentProc
  Set agentProc = sh.Exec("""" & agentExe & """ """ & agentBundle & """ --port-file """ & portFile & """")
  WScript.Sleep 400
  sh.Run """" & appExe & """", 1, True
  ' The window is gone: kill the agent by its process id, tree-fell so any
  ' background shell children of the agent die with it.
  On Error Resume Next
  sh.Run "taskkill /pid " & agentProc.ProcessId & " /T /F", 0, True
  On Error GoTo 0
Else
  ' Second instance: just focus a new window on the existing agent.
  sh.Run """" & appExe & """", 1, False
End If
