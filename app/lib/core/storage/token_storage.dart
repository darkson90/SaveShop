import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// Token di accesso e refresh nel Keychain (iOS) / Keystore (Android).
class TokenStorage {
  TokenStorage([FlutterSecureStorage? storage]) : _storage = storage ?? const FlutterSecureStorage();

  final FlutterSecureStorage _storage;
  static const _access = 'access_token';
  static const _refresh = 'refresh_token';
  static const _userId = 'user_id';

  Future<String?> get accessToken => _storage.read(key: _access);
  Future<String?> get refreshToken => _storage.read(key: _refresh);
  Future<String?> get userId => _storage.read(key: _userId);

  Future<void> saveUserId(String id) => _storage.write(key: _userId, value: id);

  Future<void> save({required String accessToken, required String refreshToken}) async {
    await _storage.write(key: _access, value: accessToken);
    await _storage.write(key: _refresh, value: refreshToken);
  }

  Future<void> clear() async {
    await _storage.delete(key: _access);
    await _storage.delete(key: _refresh);
    await _storage.delete(key: _userId);
  }
}
