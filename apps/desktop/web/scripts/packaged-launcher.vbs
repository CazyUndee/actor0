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

' --- take the OS frame off the window -------------------------------------
' Windows paints two things over a borderless window that the page cannot
' reach — a WS_THICKFRAME band and the 1px translucent DWMWA_BORDER_COLOR
' line — and both read as a second border outside the app's own ring. The
' script polls for the window (it does not exist yet) and is started hidden
' and unwaited, so it costs no start-up time. Dev starts the same file
' (scripts/run.mjs), so the two builds cannot disagree about how many borders
' the app has.
frameScript = here & "\win-frameless.ps1"
If fso.FileExists(frameScript) Then
  q = Chr(34)
  sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File " & q & frameScript & q, 0, False
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
  Dim defaultCwd
  defaultCwd = sh.ExpandEnvironmentStrings("%USERPROFILE%")
  If sh.Environment("Process")("ACTOR0_AGENT_CWD") = "" Then
    sh.Environment("Process")("ACTOR0_AGENT_CWD") = defaultCwd
  End If
  ' --nl-path hands the agent the shell's app directory: it reads the shell's
  ' .tmp/auth_info.json from there (port + token) once the shell has written
  ' it, which is what engages the scoped Neutralino bridge and the OAuth
  ' browser opener. Only the stable path can be passed now (the launcher
  ' starts the agent before the shell exists, so the auth details do not
  ' exist yet — openBridge's retry loop covers the shell's boot delay).
  '
  ' The build number is actor0.cmd's own argument, bare: package.mjs derives
  ' it from
  ' the commits since the last version tag and hands it to the agent, which puts
  ' it in agent.hello so the title bar can read "v0.5.7 (build: 125)". It is a
  ' build counter, never a version — see the repo's AGENTS.md.
  buildArg = ""
  If WScript.Arguments.Count > 0 Then buildArg = WScript.Arguments(0)
  ' The agent is started detached through cmd, with its output appended to
  ' agent\agent.log — not through sh.Exec. An Exec pipe is a stdout the host
  ' has to drain, and a packaged app whose agent dies otherwise has nowhere to
  ' say why; the log is the only surface a user can be pointed at.
  q = Chr(34)
  agentLog = here & "\agent\agent.log"
  On Error Resume Next
  fso.DeleteFile portFile, True
  On Error GoTo 0
  buildFlag = ""
  If IsNumeric(buildArg) Then buildFlag = " --build " & CLng(buildArg)
  startCmd = "cmd /c " & q & q & agentExe & q & " " & q & agentBundle & q & _
    " --port-file " & q & portFile & q & " --token " & token & _
    " --nl-path " & q & here & q & buildFlag & " >> " & q & agentLog & q & " 2>&1" & q
  sh.Run startCmd, 0, False

  ' Wait for the agent to say where it is listening, by polling the file it
  ' writes, rather than sleeping for a guess. 400ms was that guess, and it
  ' produced a window whose only possible message was "disconnected".
  Dim agentPid, waited
  agentPid = 0
  For waited = 1 To 150
    WScript.Sleep 100
    agentPid = ReadPortPid(portFile)
    If agentPid > 0 Then Exit For
  Next
  If agentPid = 0 Then
    MsgBox "actor0: the agent did not start. See " & agentLog, 16, "actor0"
  End If

  sh.Run q & appExe & q, 1, True
  On Error Resume Next
  ' Kill the pid the agent *recorded*, not one held by a scripting object: the
  ' window is gone, so its agent and the shell children it started are what is
  ' left to clean up.
  If agentPid > 0 Then sh.Run "taskkill /pid " & agentPid & " /T /F", 0, True
  On Error GoTo 0
Else
  ' Second instance: just focus a new window on the existing agent.
  sh.Run """" & appExe & """", 1, False
End If

' The pid the agent wrote into the port file, or 0 when there is none yet.
Function ReadPortPid(path)
  ReadPortPid = 0
  If Not fso.FileExists(path) Then Exit Function
  On Error Resume Next
  Dim txt, stream, re3, m3
  Set stream = fso.OpenTextFile(path, 1)
  If Not stream.AtEndOfStream Then txt = stream.ReadAll()
  stream.Close
  Set re3 = New RegExp
  re3.Pattern = """pid"":\s*(\d+)"
  Set m3 = re3.Execute(txt)
  If m3.Count > 0 Then ReadPortPid = CLng(m3(0).SubMatches(0))
  On Error GoTo 0
End Function
