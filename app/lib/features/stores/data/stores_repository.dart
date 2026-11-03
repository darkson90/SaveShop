import '../../../core/network/api_client.dart';

class Chain {
  const Chain(this.id, this.name);
  final String id;
  final String name;
}

class Exclusion {
  const Exclusion({required this.id, required this.label, required this.kind});

  final String id;
  final String label;

  /// 'store' (singolo punto vendita) oppure 'chain' (intera insegna).
  final String kind;
}

class LoyaltyCard {
  const LoyaltyCard({required this.id, required this.chainId, required this.last4});
  final String id;
  final String chainId;
  final String last4;
}

class UserProfile {
  const UserProfile({required this.email, required this.defaultRadiusKm, this.displayName, this.homeLat, this.homeLng});

  final String email;
  final String? displayName;
  final int defaultRadiusKm;
  final double? homeLat;
  final double? homeLng;

  factory UserProfile.fromJson(Map<String, dynamic> j) {
    final home = j['home'] as Map<String, dynamic>?;
    return UserProfile(
      email: j['email'] as String,
      displayName: j['displayName'] as String?,
      defaultRadiusKm: (j['defaultRadiusKm'] as num).toInt(),
      homeLat: (home?['lat'] as num?)?.toDouble(),
      homeLng: (home?['lng'] as num?)?.toDouble(),
    );
  }
}

/// Negozi, blacklist, profilo e fidelity card (Store Service e User Service).
class StoresRepository {
  StoresRepository(this._api);

  final ApiClient _api;

  Future<UserProfile> profile() async => UserProfile.fromJson(await _api.get('/users/me'));

  Future<UserProfile> updateRadius(int km) async => UserProfile.fromJson(await _api.patch('/users/me', body: {'defaultRadiusKm': km}));

  /// La posizione di casa serve alle offerte (negozi vicini anche quando l'app è chiusa).
  Future<UserProfile> updateHome(double lat, double lng) async =>
      UserProfile.fromJson(await _api.patch('/users/me', body: {'home': {'lat': lat, 'lng': lng}}));

  Future<void> deleteAccount() => _api.delete('/users/me');

  Future<List<Chain>> chains() async {
    final res = await _api.get('/stores/chains');
    return (res['items'] as List).map((e) => Chain(e['id'] as String, e['name'] as String)).toList();
  }

  Future<List<Exclusion>> exclusions() async {
    final res = await _api.get('/users/me/excluded-stores');
    return (res['items'] as List)
        .map((e) => Exclusion(id: e['id'] as String, label: e['label'] as String, kind: e['kind'] as String))
        .toList();
  }

  Future<void> excludeStore(String storeId) => _api.post('/users/me/excluded-stores', body: {'storeId': storeId});

  Future<void> excludeChain(String chainId) => _api.post('/users/me/excluded-stores', body: {'chainId': chainId});

  Future<void> restore(String exclusionId) => _api.delete('/users/me/excluded-stores/$exclusionId');

  Future<List<LoyaltyCard>> cards() async {
    final res = await _api.get('/users/me/loyalty-cards');
    return (res['items'] as List)
        .map((e) => LoyaltyCard(id: e['id'] as String, chainId: e['chainId'] as String, last4: e['last4'] as String))
        .toList();
  }

  Future<void> addCard(String chainId, String number) =>
      _api.post('/users/me/loyalty-cards', body: {'chainId': chainId, 'cardNumber': number});

  Future<void> removeCard(String id) => _api.delete('/users/me/loyalty-cards/$id');
}
