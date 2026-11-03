class PricedItem {
  const PricedItem({required this.itemId, required this.unitPrice, required this.promo, this.storeId, this.loyaltyOnly = false});

  final String itemId;
  final double unitPrice;
  final bool promo;
  final bool loyaltyOnly;

  /// Valorizzato nelle modalità a più negozi: dove comprare l'articolo.
  final String? storeId;

  factory PricedItem.fromJson(Map<String, dynamic> j) => PricedItem(
        itemId: j['itemId'] as String,
        unitPrice: (j['unitPrice'] as num).toDouble(),
        promo: j['promo'] as bool? ?? false,
        loyaltyOnly: j['loyaltyOnly'] as bool? ?? false,
        storeId: j['storeId'] as String?,
      );
}

class StoreResult {
  const StoreResult({
    required this.storeId,
    required this.name,
    required this.distanceKm,
    required this.total,
    required this.missingItems,
    required this.savingVsMax,
    required this.items,
  });

  final String storeId;
  final String name;
  final double distanceKm;
  final double total;
  final int missingItems;
  final double savingVsMax;
  final List<PricedItem> items;

  factory StoreResult.fromJson(Map<String, dynamic> j) => StoreResult(
        storeId: j['storeId'] as String,
        name: j['name'] as String,
        distanceKm: (j['distanceKm'] as num).toDouble(),
        total: (j['total'] as num).toDouble(),
        missingItems: (j['missingItems'] as num).toInt(),
        savingVsMax: (j['savingVsMax'] as num).toDouble(),
        items: (j['items'] as List).map((e) => PricedItem.fromJson(e as Map<String, dynamic>)).toList(),
      );
}

class StoreBrief {
  const StoreBrief(this.storeId, this.name, this.distanceKm);
  final String storeId;
  final String name;
  final double distanceKm;
}

class PairResult {
  const PairResult({required this.stores, required this.total, required this.missingItems, required this.items, this.savingVsBestSingle});

  final List<StoreBrief> stores;
  final double total;
  final int missingItems;
  final double? savingVsBestSingle;
  final List<PricedItem> items;

  factory PairResult.fromJson(Map<String, dynamic> j) => PairResult(
        stores: (j['stores'] as List)
            .map((s) => StoreBrief(s['storeId'] as String, s['name'] as String, (s['distanceKm'] as num).toDouble()))
            .toList(),
        total: (j['total'] as num).toDouble(),
        missingItems: (j['missingItems'] as num).toInt(),
        savingVsBestSingle: (j['savingVsBestSingle'] as num?)?.toDouble(),
        items: (j['items'] as List).map((e) => PricedItem.fromJson(e as Map<String, dynamic>)).toList(),
      );
}

class PerItemRow {
  const PerItemRow({required this.itemId, this.storeName, this.unitPrice, required this.lineTotal, required this.promo});

  final String itemId;
  final String? storeName;
  final double? unitPrice;
  final double lineTotal;
  final bool promo;

  factory PerItemRow.fromJson(Map<String, dynamic> j) => PerItemRow(
        itemId: j['itemId'] as String,
        storeName: j['storeName'] as String?,
        unitPrice: (j['unitPrice'] as num?)?.toDouble(),
        lineTotal: (j['lineTotal'] as num).toDouble(),
        promo: j['promo'] as bool? ?? false,
      );
}

enum CompareMode {
  singleStore('single_store', '1 negozio'),
  twoStores('two_stores', '2 negozi'),
  perItem('per_item', 'Per articolo');

  const CompareMode(this.api, this.label);
  final String api;
  final String label;
}

class Comparison {
  const Comparison({
    required this.mode,
    required this.storesConsidered,
    required this.unmatchedItems,
    this.pricesAsOf,
    this.single = const [],
    this.pairs = const [],
    this.perItem = const [],
    this.perItemTotal,
    this.perItemMissing = 0,
  });

  final CompareMode mode;
  final int storesConsidered;
  final int unmatchedItems;
  final DateTime? pricesAsOf;
  final List<StoreResult> single;
  final List<PairResult> pairs;
  final List<PerItemRow> perItem;
  final double? perItemTotal;
  final int perItemMissing;

  factory Comparison.fromJson(CompareMode mode, Map<String, dynamic> j) {
    final asOf = j['pricesAsOf'] as String?;
    final base = (
      stores: (j['storesConsidered'] as num?)?.toInt() ?? 0,
      unmatched: (j['unmatchedItems'] as num?)?.toInt() ?? 0,
      asOf: asOf == null ? null : DateTime.tryParse(asOf),
    );
    switch (mode) {
      case CompareMode.singleStore:
        return Comparison(
          mode: mode,
          storesConsidered: base.stores,
          unmatchedItems: base.unmatched,
          pricesAsOf: base.asOf,
          single: (j['results'] as List).map((e) => StoreResult.fromJson(e as Map<String, dynamic>)).toList(),
        );
      case CompareMode.twoStores:
        return Comparison(
          mode: mode,
          storesConsidered: base.stores,
          unmatchedItems: base.unmatched,
          pricesAsOf: base.asOf,
          pairs: (j['results'] as List).map((e) => PairResult.fromJson(e as Map<String, dynamic>)).toList(),
        );
      case CompareMode.perItem:
        final r = j['result'] as Map<String, dynamic>;
        return Comparison(
          mode: mode,
          storesConsidered: base.stores,
          unmatchedItems: base.unmatched,
          pricesAsOf: base.asOf,
          perItem: (r['items'] as List).map((e) => PerItemRow.fromJson(e as Map<String, dynamic>)).toList(),
          perItemTotal: (r['total'] as num).toDouble(),
          perItemMissing: (r['missingItems'] as num).toInt(),
        );
    }
  }
}
