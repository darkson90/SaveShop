import '../../../core/network/api_client.dart';
import '../domain/models.dart';

class ListRepository {
  ListRepository(this._api);

  final ApiClient _api;

  /// La lista aperta più recente; se non esiste ne crea una nuova.
  Future<ShoppingList> currentList() async {
    final res = await _api.get('/lists', query: {'limit': 10});
    final open = (res['items'] as List).cast<Map<String, dynamic>>().where((l) => l['status'] == 'open');
    if (open.isEmpty) return ShoppingList.fromJson(await _api.post('/lists', body: {'name': 'Spesa'}));
    return ShoppingList.fromJson(await _api.get('/lists/${open.first['id']}'));
  }

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

  Future<Map<String, dynamic>> purchase(String listId, {required String storeId, required double lat, required double lng, required int radiusKm}) =>
      _api.post('/lists/$listId/purchase', body: {'storeId': storeId, 'lat': lat, 'lng': lng, 'radiusKm': radiusKm});
}
