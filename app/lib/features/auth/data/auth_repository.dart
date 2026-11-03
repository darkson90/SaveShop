import '../../../core/network/api_client.dart';
import '../../../core/storage/token_storage.dart';

class AuthRepository {
  AuthRepository(this._api, this._tokens);

  final ApiClient _api;
  final TokenStorage _tokens;

  Future<bool> hasSession() async => (await _tokens.refreshToken) != null;

  Future<void> login(String email, String password) async {
    final res = await _api.post('/auth/login', body: {'email': email, 'password': password});
    await _store(res);
  }

  Future<void> register(String email, String password, String? displayName) async {
    final res = await _api.post('/auth/register', body: {
      'email': email,
      'password': password,
      if (displayName != null && displayName.isNotEmpty) 'displayName': displayName,
    });
    await _store(res);
  }

  Future<void> logout() async {
    final refresh = await _tokens.refreshToken;
    if (refresh != null) {
      try {
        await _api.post('/auth/logout', body: {'refreshToken': refresh});
      } catch (_) {
        // La sessione locale si chiude comunque.
      }
    }
    await _tokens.clear();
  }

  Future<void> _store(Map<String, dynamic> res) async {
    await _tokens.save(accessToken: res['accessToken'] as String, refreshToken: res['refreshToken'] as String);
    await _tokens.saveUserId(res['userId'] as String);
  }
}
