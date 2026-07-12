; No Bloat PDF installer hooks.
; Tauri's NSIS template registers the .pdf association with the ProgId taken
; from fileAssociations[].name ("PDF Document") and points DefaultIcon at the
; app exe. Repoint it at the dedicated document icon so PDFs in Explorer get
; the branded file icon (once the user makes this app the default handler).

!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr SHCTX "Software\Classes\PDF Document\DefaultIcon" "" "$INSTDIR\pdf-document.ico"
  ; SHCNE_ASSOCCHANGED | SHCNF_FLUSH — tell Explorer to refresh icons now
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0x1000, p 0, p 0)'
!macroend
