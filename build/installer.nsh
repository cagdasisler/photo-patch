; Adds an "Uninstall Photo Patch" shortcut to the Start menu next to the app.
!macro customInstall
  CreateShortCut "$SMPROGRAMS\Uninstall ${PRODUCT_NAME}.lnk" "$INSTDIR\${UNINSTALL_FILENAME}"
!macroend

!macro customUnInstall
  Delete "$SMPROGRAMS\Uninstall ${PRODUCT_NAME}.lnk"
!macroend
