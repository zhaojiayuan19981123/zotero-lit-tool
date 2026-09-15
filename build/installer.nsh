; ============================================================
; One-Stop Research Terminal - custom NSIS installer script
; 1) customCheckAppRunning: auto kill a running app instance
;    before install/uninstall (no more "cannot close" dialog)
; 2) customInstall: always create a desktop shortcut
; ============================================================

!macro customCheckAppRunning
  DetailPrint "Closing running app..."
  ; Try a graceful close first (sends WM_CLOSE), wait, then force kill.
  nsExec::Exec 'taskkill /T /IM "${APP_EXECUTABLE_FILENAME}"'
  Pop $R0
  Sleep 800
  nsExec::Exec 'taskkill /F /T /IM "${APP_EXECUTABLE_FILENAME}"'
  Pop $R0
  Sleep 400
!macroend

!macro customInstall
  ; Desktop shortcut (auto-created, embedded exe icon)
  CreateShortCut "$DESKTOP\${SHORTCUT_NAME}.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0
!macroend
