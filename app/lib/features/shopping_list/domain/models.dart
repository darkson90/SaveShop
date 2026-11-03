class ProductRef {
  const ProductRef({required this.id, required this.name, this.category, this.unit});

  final String id;
  final String name;
  final String? category;
  final String? unit;

  factory ProductRef.fromJson(Map<String, dynamic> j) => ProductRef(
        id: j['id'] as String,
        name: j['name'] as String,
        category: j['category'] as String?,
        unit: j['unit'] as String?,
      );

  Map<String, dynamic> toJson() => {'id': id, 'name': name, 'category': category, 'unit': unit};
}

class ListItem {
  const ListItem({
    required this.id,
    required this.raw,
    required this.quantity,
    required this.unit,
    required this.checked,
    this.product,
    this.pending = false,
  });

  final String id;
  final String raw;
  final double quantity;
  final String unit;
  final bool checked;
  final ProductRef? product;

  /// Inserito offline, in attesa di conferma dal server.
  final bool pending;

  String get label => product?.name ?? raw;
  bool get isUnmatched => product == null && !pending;

  factory ListItem.fromJson(Map<String, dynamic> j) => ListItem(
        id: j['id'] as String,
        raw: j['raw'] as String,
        quantity: (j['quantity'] as num).toDouble(),
        unit: (j['unit'] as String?) ?? 'pz',
        checked: j['checked'] as bool? ?? false,
        product: j['product'] == null ? null : ProductRef.fromJson(j['product'] as Map<String, dynamic>),
        pending: j['pending'] as bool? ?? false,
      );

  Map<String, dynamic> toJson() => {
        'id': id,
        'raw': raw,
        'quantity': quantity,
        'unit': unit,
        'checked': checked,
        'product': product?.toJson(),
        'pending': pending,
      };

  ListItem copyWith({double? quantity, bool? checked}) => ListItem(
        id: id,
        raw: raw,
        quantity: quantity ?? this.quantity,
        unit: unit,
        checked: checked ?? this.checked,
        product: product,
        pending: pending,
      );
}

class ShoppingList {
  const ShoppingList({required this.id, required this.name, required this.items});

  final String id;
  final String name;
  final List<ListItem> items;

  factory ShoppingList.fromJson(Map<String, dynamic> j) => ShoppingList(
        id: j['id'] as String,
        name: j['name'] as String,
        items: ((j['items'] as List?) ?? const [])
            .map((e) => ListItem.fromJson(e as Map<String, dynamic>))
            .toList(),
      );

  Map<String, dynamic> toJson() => {'id': id, 'name': name, 'items': items.map((i) => i.toJson()).toList()};

  ShoppingList copyWith({List<ListItem>? items}) => ShoppingList(id: id, name: name, items: items ?? this.items);
}

class FrequentProduct {
  const FrequentProduct({required this.productId, required this.name});

  final String productId;
  final String name;

  factory FrequentProduct.fromJson(Map<String, dynamic> j) =>
      FrequentProduct(productId: j['productId'] as String, name: j['name'] as String);
}
