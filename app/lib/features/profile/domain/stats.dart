enum StatsPeriod {
  month('month', 'Mese'),
  threeMonths('3months', '3 mesi'),
  year('year', 'Anno'),
  all('all', 'Sempre');

  const StatsPeriod(this.api, this.label);
  final String api;
  final String label;
}

class TopProduct {
  const TopProduct(this.name, this.times);
  final String name;
  final int times;
}

class CategorySlice {
  const CategorySlice(this.category, this.spentEur, this.sharePct);
  final String category;
  final double spentEur;
  final double sharePct;
}

/// Metriche del profilo restituite da GET /users/me/stats.
class UserStats {
  const UserStats({
    required this.totalSavedEur,
    required this.avgSavingPct,
    required this.totalSpentEur,
    required this.purchases,
    required this.topProducts,
    required this.categories,
  });

  final double totalSavedEur;
  final double avgSavingPct;
  final double totalSpentEur;
  final int purchases;
  final List<TopProduct> topProducts;
  final List<CategorySlice> categories;

  factory UserStats.fromJson(Map<String, dynamic> j) => UserStats(
        totalSavedEur: (j['totalSavedEur'] as num).toDouble(),
        avgSavingPct: (j['avgSavingPct'] as num).toDouble(),
        totalSpentEur: (j['totalSpentEur'] as num?)?.toDouble() ?? 0,
        purchases: (j['purchases'] as num).toInt(),
        topProducts: (j['topProducts'] as List)
            .map((e) => TopProduct(e['name'] as String, (e['times'] as num).toInt()))
            .toList(),
        categories: (j['categories'] as List)
            .map((e) => CategorySlice(
                  e['category'] as String,
                  (e['spentEur'] as num).toDouble(),
                  (e['sharePct'] as num).toDouble(),
                ))
            .toList(),
      );
}
