#!/usr/bin/env bash
# Genera le cartelle android/ e ios/ (non versionate) e aggiunge permessi di posizione e rete.
# Uso: cd app && ./tool/setup_platforms.sh
set -euo pipefail
cd "$(dirname "$0")/.."

flutter create --platforms=android,ios --org it.spesasmart --project-name spesa_smart .
rm -f test/widget_test.dart   # test d'esempio generato da flutter create

# perl -0 sostituisce solo la prima occorrenza ed è disponibile sia su macOS sia su Linux.
MANIFEST=android/app/src/main/AndroidManifest.xml
if ! grep -q ACCESS_COARSE_LOCATION "$MANIFEST"; then
  perl -0pi -e 's#<application#<uses-permission android:name="android.permission.INTERNET"/>\n    <uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION"/>\n    <uses-permission android:name="android.permission.ACCESS_FINE_LOCATION"/>\n    <application android:usesCleartextTraffic="true"#' "$MANIFEST"   # cleartext solo per il backend locale
fi

PLIST=ios/Runner/Info.plist
if ! grep -q NSLocationWhenInUseUsageDescription "$PLIST"; then
  perl -0pi -e 's#<dict>#<dict>\n\t<key>NSLocationWhenInUseUsageDescription</key>\n\t<string>Usiamo la posizione solo per trovare i negozi vicini e confrontare i prezzi.</string>#' "$PLIST"
fi

flutter pub get
echo "Piattaforme pronte. Avvio: flutter run --dart-define=API_BASE_URL=http://10.0.2.2:8080/api/v1"
