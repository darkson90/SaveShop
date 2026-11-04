/// Configurazione da --dart-define, es.:
///   flutter run --dart-define=API_BASE_URL=http://10.0.2.2:8080/api/v1
class AppConfig {
  /// Versione dell'app, confrontata con app.minSupportedVersion del pannello (tenere allineata a pubspec.yaml).
  static const appVersion = '0.1.0';

  /// 10.0.2.2 è l'host visto dall'emulatore Android; su simulatore iOS usare localhost.
  static const apiBaseUrl = String.fromEnvironment('API_BASE_URL', defaultValue: 'http://10.0.2.2:8080/api/v1');

  /// Posizione usata se il GPS non è disponibile e l'utente non ha un indirizzo salvato
  /// (coerente con i dati dimostrativi del backend).
  static const fallbackLat = 46.419;
  static const fallbackLng = 12.245;
}
