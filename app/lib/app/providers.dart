import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../core/location/location_service.dart';
import '../core/network/api_client.dart';
import '../core/push/push_service.dart';
import '../core/storage/local_store.dart';
import '../core/storage/token_storage.dart';
import '../features/auth/presentation/auth_controller.dart';

final tokenStorageProvider = Provider((ref) => TokenStorage());
final localStoreProvider = Provider((ref) => LocalStore());
final locationServiceProvider = Provider((ref) => LocationService());

final apiClientProvider = Provider<ApiClient>((ref) {
  return ApiClient(
    ref.watch(tokenStorageProvider),
    onSessionExpired: () => ref.read(authControllerProvider.notifier).sessionExpired(),
  );
});

final pushServiceProvider = Provider<PushService>((ref) => PushService(ref.watch(apiClientProvider)));

/// ID dell'utente collegato: serve a riconoscere le proprie modifiche nelle liste condivise.
final currentUserIdProvider = FutureProvider<String?>((ref) => ref.watch(tokenStorageProvider).userId);
