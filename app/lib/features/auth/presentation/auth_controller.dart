import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../app/providers.dart';
import '../../shopping_list/presentation/list_controller.dart';
import '../../stores/presentation/stores_providers.dart';
import '../data/auth_repository.dart';

final authRepositoryProvider = Provider(
  (ref) => AuthRepository(ref.watch(apiClientProvider), ref.watch(tokenStorageProvider)),
);

/// true = utente autenticato.
final authControllerProvider = AsyncNotifierProvider<AuthController, bool>(AuthController.new);

class AuthController extends AsyncNotifier<bool> {
  AuthRepository get _repo => ref.read(authRepositoryProvider);

  @override
  Future<bool> build() => _repo.hasSession();

  Future<void> login(String email, String password) async {
    state = const AsyncLoading<bool>();
    state = await AsyncValue.guard(() async {
      await _repo.login(email, password);
      _resetUserState();
      return true;
    });
  }

  Future<void> register(String email, String password, String? name) async {
    state = const AsyncLoading<bool>();
    state = await AsyncValue.guard(() async {
      await _repo.register(email, password, name);
      _resetUserState();
      return true;
    });
  }

  Future<void> logout() async {
    await ref.read(pushServiceProvider).unregister();
    await _repo.logout();
    await ref.read(localStoreProvider).clear();
    _resetUserState();
    state = const AsyncData(false);
  }

  /// Dati legati all'utente precedente da non riusare dopo login o logout.
  void _resetUserState() {
    ref.invalidate(listControllerProvider);
    ref.invalidate(profileProvider);
    ref.invalidate(searchContextProvider);
  }

  void sessionExpired() => state = const AsyncData(false);
}
