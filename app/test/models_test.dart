import 'package:flutter_test/flutter_test.dart';
import 'package:spesa_smart/core/widgets/format.dart';
import 'package:spesa_smart/features/comparison/domain/models.dart';
import 'package:spesa_smart/features/profile/domain/stats.dart';
import 'package:spesa_smart/features/shopping_list/domain/models.dart';
import 'package:intl/date_symbol_data_local.dart';

void main() {
  setUpAll(() => initializeDateFormatting('it_IT'));

  test('ListItem: voce libera senza prodotto', () {
    final item = ListItem.fromJson({'id': 'a', 'raw': 'candeline', 'quantity': 1, 'unit': 'pz', 'checked': false, 'product': null});
    expect(item.isUnmatched, isTrue);
    expect(item.label, 'candeline');
  });

  test('Comparison: modalità negozio unico', () {
    final c = Comparison.fromJson(CompareMode.singleStore, {
      'storesConsidered': 3,
      'unmatchedItems': 1,
      'pricesAsOf': '2026-11-03T04:00:00Z',
      'results': [
        {
          'storeId': 's1', 'name': 'Negozio', 'distanceKm': 2.4, 'total': 41.8, 'missingItems': 0, 'savingVsMax': 6.35,
          'items': [{'itemId': 'it1', 'unitPrice': 1.09, 'promo': true, 'loyaltyOnly': false}],
        }
      ],
    });
    expect(c.single.single.total, 41.8);
    expect(c.single.single.items.single.promo, isTrue);
    expect(c.unmatchedItems, 1);
  });

  test('UserStats dal JSON di /users/me/stats', () {
    final s = UserStats.fromJson({
      'totalSavedEur': 184.2, 'avgSavingPct': 12.4, 'totalSpentEur': 900, 'purchases': 37,
      'topProducts': [{'productId': 'p', 'name': 'Latte', 'times': 31}],
      'categories': [{'category': 'Latticini', 'spentEur': 96.1, 'sharePct': 18.2}],
    });
    expect(s.topProducts.first.name, 'Latte');
    expect(s.categories.first.sharePct, 18.2);
  });

  test('formattazione italiana', () {
    expect(euro(1234.5), contains('1.234,50'));
    expect(quantity(2, 'pz'), '2 pz');
    expect(quantity(1.5, 'kg'), '1,5 kg');
  });
}
