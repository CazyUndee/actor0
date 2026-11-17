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
' hard-coded name rots on every release.
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
agentExe = here & "\runtime\node.exe"
agentBundle = here & "\agent\agent.mjs"
portFile = here & "\agent\port.json"

' --- find the app executable ----------------------------------------------

Dim appExe
appExe = ""
If fso.FileExists(here & "\actor0-desktop-win_x64.exe") Then
  appExe = here & "\actor0-desktop-win_x64.exe"
Else
  Dim folder, best, bestDate
  Set folder = fso.GetFolder(here)
  bestDate = ""
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

' --- single instance ------------------------------------------------------
' If a live agent already holds the port file, this is a second launch: open
' the window on the existing agent instead of racing it with a second agent.
' (Emitted ports are above 32767 — CInt overflows; CLng is required.)

Dim launched
launched = False
If fso.FileExists(portFile) Then
  On Error Resume Next
  Dim port
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
  ' Also capture the pid the agent wrote, so a stale port file left by a dead
  ' agent can be detected instead of trusted blindly.
  Dim pidRe, pm
  Set pidRe = New RegExp
  pidRe.Pattern = """pid"":\s*(\d+)"
  Set pm = pidRe.Execute(line)
  Dim pid
  pid = 0
  If pm.Count > 0 Then pid = CLng(pm(0).SubMatches(0))
  ts.Close
  On Error GoTo 0
  If port > 0 Then
    Dim alive
    alive = False
    If pid > 0 Then
      On Error Resume Next
      Dim execCheck
      Set execCheck = sh.Exec("tasklist /FI ""PID eq " & pid & """ /NH")
      Dim out
      out = execCheck.StdOut.ReadAll()
      On Error GoTo 0
      If InStr(out, CStr(pid)) > 0 Then alive = True
    End If
    If alive Or pid = 0 Then
      launched = True
    Else
      ' Stale port file: remove it so this launch spawns a fresh agent.
      On Error Resume Next
      fso.DeleteFile portFile, True
      On Error GoTo 0
      launched = False
    End If
  End If
End If

' --- generate a per-launch token for the agent's WebSocket -------------------
' The agent's socket exposes config.get (provider credentials) and turn.send (the
' whole tool set), so it must never listen unauthenticated (D-1). The token is
' minted here, passed as --token, and the agent writes it into port.json for the
' page to present. It lives only for this launch.

Randomize
Dim tokenChars, i, token
tokenChars = "0123456789abcdef"
token = ""
For i = 1 To 64
  token = token & Mid(tokenChars, Int(Rnd() * 16) + 1, 1)
Next

' --- first instance: supervise + cleanup ----------------------------------
' The window runs synchronously; when it closes the agent is killed by its
' Exec PID via taskkill /T /F (Exec.Terminate proved unreliable against the
' detached node child), tree-felled so background shell children die too.

If Not launched Then
  Dim agentProc
  ' --nl-path hands the agent the shell's app directory: it reads the shell's
  ' .tmp/auth_info.json from there (port + token) once the shell has written
  ' it, which is what engages the scoped Neutralino bridge and the OAuth
  ' browser opener. Only the stable path can be passed now (the launcher
  ' starts the agent before the shell exists, so the auth details do not
  ' exist yet — openBridge's retry loop covers the shell's boot delay).
  Set agentProc = sh.Exec("""" & agentExe & """ """ & agentBundle & """ --port-file """ & portFile & """ --token """ & token & """ --nl-path """ & here & """")
  WScript.Sleep 400
  sh.Run """" & appExe & """", 1, True
  On Error Resume Next
  sh.Run "taskkill /pid " & agentProc.ProcessId & " /T /F", 0, True
  On Error GoTo 0
Else
  ' Second instance: just focus a new window on the existing agent.
  sh.Run """" & appExe & """", 1, False
End If
