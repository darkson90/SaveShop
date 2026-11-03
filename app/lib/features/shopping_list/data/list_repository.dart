import '../../../core/network/api_client.dart';
import '../domain/models.dart';

class ListRepository {
  ListRepository(this._api);

  final ApiClient _api;

  /// La lista scelta (se ancora aperta e accessibile), altrimenti la più recente aperta; se non ce n'è una, la crea.
  Future<ShoppingList> currentList({String? preferredId}) async {
    final res = await _api.get('/lists', query: {'limit': 20});
    final open = (res['items'] as List).cast<Map<String, dynamic>>().where((l) => l['status'] == 'open').toList();
    if (open.isEmpty) return ShoppingList.fromJson(await _api.post('/lists', body: {'name': 'Spesa'}));
    final chosen = open.firstWhere((l) => l['id'] == preferredId, orElse: () => open.first);
    return getList(chosen['id'] as String);
  }

  Future<ShoppingList> getList(String id) async => ShoppingList.fromJson(await _api.get('/lists/$id'));

  /// Codice d'invito (solo il proprietario): valido 48 ore, fino a 5 membri.
  Future<({String code, DateTime expiresAt})> createInvite(String listId) async {
    final res = await _api.post('/lists/$listId/invites');
    return (code: res['code'] as String, expiresAt: DateTime.parse(res['expiresAt'] as String));
  }

  Future<String> join(String code) async => (await _api.post('/lists/join', body: {'code': code}))['listId'] as String;

  Future<void> removeMember(String listId, String userId) => _api.delete('/lists/$listId/members/$userId');

  /// Testo letto dall'OCR del telefono: il server riconosce le righe e le abbina agli articoli.
  Future<Map<String, dynamic>> readReceipt(String listId, String text) =>
      _api.post('/lists/$listId/receipt', body: {'text': text});

  Future<ShoppingList> newList() async => ShoppingList.fromJson(await _api.post('/lists', body: {'name': 'Spesa'}));

  Future<ListItem> addItem(String listId, Map<String, dynamic> body, String idempotencyKey) async {
    final res = await _api.post('/lists/$listId/items', body: body, headers: {'Idempotency-Key': idempotencyKey});
    return ListItem.fromJson(res);
  }

  Future<ListItem> updateItem(String listId, String itemId, Map<String, dynamic> body) async =>
      ListItem.fromJson(await _api.patch('/lists/$listId/items/$itemId', body: body));

  Future<void> removeItem(String listId, String itemId) => _api.delete('/lists/$listId/items/$itemId');

  Future<List<ProductRef>> suggest(String q) async {
    final res = await _api.get('/products/suggest', query: {'q': q, 'limit': 6});
    return (res['items'] as List).map((e) => ProductRef.fromJson(e as Map<String, dynamic>)).toList();
  }

  Future<List<FrequentProduct>> frequent() async {
    final res = await _api.get('/lists/frequent-products', query: {'limit': 10});
    return (res['items'] as List).map((e) => FrequentProduct.fromJson(e as Map<String, dynamic>)).toList();
  }

  Future<Map<String, dynamic>> purchase(
    String listId, {
    required String storeId,
    required double lat,
    required double lng,
    required int radiusKm,
    List<({String itemId, double unitPaid})> paidPrices = const [],
  }) =>
      _api.post('/lists/$listId/purchase', body: {
        'storeId': storeId,
        'lat': lat,
        'lng': lng,
        'radiusKm': radiusKm,
        if (paidPrices.isNotEmpty) 'paidPrices': [for (final p in paidPrices) {'itemId': p.itemId, 'unitPaid': p.unitPaid}],
      });
}
