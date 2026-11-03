import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';

import '../../../core/widgets/async_view.dart';
import '../../../core/widgets/format.dart';
import '../../shopping_list/presentation/list_controller.dart';
import '../../stores/presentation/stores_providers.dart';
import '../domain/models.dart';
import 'comparison_providers.dart';

class ComparisonScreen extends ConsumerWidget {
  const ComparisonScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final mode = ref.watch(compareModeProvider);
    final comparison = ref.watch(comparisonProvider);
    final ctx = ref.watch(searchContextProvider).valueOrNull;

    return Scaffold(
      appBar: AppBar(
        title: const Text('Dove costa meno'),
        actions: [
          IconButton(
            tooltip: 'Negozi esclusi',
            icon: const Icon(Icons.block),
            onPressed: () => context.push('/impostazioni/esclusi'),
          ),
        ],
      ),
      body: Column(children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
          child: SegmentedButton<CompareMode>(
            segments: [for (final m in CompareMode.values) ButtonSegment(value: m, label: Text(m.label))],
            selected: {mode},
            onSelectionChanged: (s) => ref.read(compareModeProvider.notifier).state = s.first,
          ),
        ),
        if (ctx != null)
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
            child: Row(children: [
              Icon(ctx.point.fromGps ? Icons.my_location : Icons.home_outlined, size: 16),
              const SizedBox(width: 6),
              Expanded(
                child: Text(
                  '${ctx.point.fromGps ? 'Posizione attuale' : 'Posizione predefinita'} · raggio ${ctx.radiusKm} km',
                  style: Theme.of(context).textTheme.bodySmall,
                ),
              ),
            ]),
          ),
        Expanded(
          child: AsyncView(
            value: comparison,
            onRetry: () => ref.invalidate(comparisonProvider),
            data: (c) => RefreshIndicator(
              onRefresh: () => ref.refresh(comparisonProvider.future),
              child: switch (c.mode) {
                CompareMode.singleStore => _SingleStoreList(c),
                CompareMode.twoStores => _PairsList(c),
                CompareMode.perItem => _PerItemList(c),
              },
            ),
          ),
        ),
      ]),
    );
  }
}

class _Header extends StatelessWidget {
  const _Header(this.c);
  final Comparison c;

  @override
  Widget build(BuildContext context) {
    final parts = <String>[
      '${c.storesConsidered} negozi confrontati',
      if (c.pricesAsOf != null) 'prezzi del ${DateFormat('d MMM, HH:mm', 'it_IT').format(c.pricesAsOf!.toLocal())}',
    ];
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Text(parts.join(' · '), style: Theme.of(context).textTheme.bodySmall),
        // Licenza ODbL: i dati di Open Prices vanno citati dove vengono mostrati.
        Text('Prezzi reali in parte da Open Prices · Open Food Facts (ODbL)',
            style: Theme.of(context).textTheme.labelSmall?.copyWith(color: Theme.of(context).colorScheme.outline)),
        if (c.unmatchedItems > 0)
          Padding(
            padding: const EdgeInsets.only(top: 4),
            child: Text(
              '${c.unmatchedItems} voci non riconosciute escluse dal confronto',
              style: TextStyle(color: Theme.of(context).colorScheme.error, fontSize: 12),
            ),
          ),
      ]),
    );
  }
}

class _SingleStoreList extends ConsumerWidget {
  const _SingleStoreList(this.c);
  final Comparison c;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    if (c.single.isEmpty) return ListView(children: [_Header(c), const _NoResults()]);
    return ListView(padding: const EdgeInsets.only(bottom: 24), children: [
      _Header(c),
      for (final (i, r) in c.single.indexed)
        Dismissible(
          key: ValueKey(r.storeId),
          direction: DismissDirection.endToStart,
          background: Container(
            alignment: Alignment.centerRight,
            padding: const EdgeInsets.only(right: 24),
            color: Theme.of(context).colorScheme.errorContainer,
            child: const Row(mainAxisSize: MainAxisSize.min, children: [Icon(Icons.block), SizedBox(width: 8), Text('Escludi')]),
          ),
          confirmDismiss: (_) => _exclude(context, ref, r),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
            child: Card(
              child: ListTile(
                contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
                leading: CircleAvatar(child: Text('${i + 1}')),
                title: Text(r.name),
                subtitle: Text([
                  km(r.distanceKm),
                  if (r.missingItems > 0) '${r.missingItems} mancanti',
                  if (r.savingVsMax > 0) 'risparmi ${euro(r.savingVsMax)}',
                ].join(' · ')),
                trailing: Text(euro(r.total), style: Theme.of(context).textTheme.titleMedium),
                onTap: () => context.push('/confronto/negozio', extra: r),
              ),
            ),
          ),
        ),
    ]);
  }

  /// Swipe sul risultato: esclude il punto vendita e ricalcola.
  Future<bool> _exclude(BuildContext context, WidgetRef ref, StoreResult r) async {
    try {
      await ref.read(storesRepositoryProvider).excludeStore(r.storeId);
      ref.invalidate(comparisonProvider);
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('${r.name} escluso dai confronti')));
      }
      return true;
    } catch (e) {
      if (context.mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.toString())));
      return false;
    }
  }
}

class _PairsList extends ConsumerWidget {
  const _PairsList(this.c);
  final Comparison c;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    if (c.pairs.isEmpty) return ListView(children: [_Header(c), const _NoResults()]);
    final names = _itemNames(ref);
    return ListView(padding: const EdgeInsets.only(bottom: 24), children: [
      _Header(c),
      for (final p in c.pairs)
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
          child: Card(
            child: ExpansionTile(
              shape: const Border(),
              title: Text(p.stores.map((s) => s.name).join(' + ')),
              subtitle: Text([
                if (p.savingVsBestSingle != null && p.savingVsBestSingle! > 0) '${euro(p.savingVsBestSingle!)} in meno del negozio unico',
                if (p.missingItems > 0) '${p.missingItems} mancanti',
              ].join(' · ')),
              trailing: Text(euro(p.total), style: Theme.of(context).textTheme.titleMedium),
              children: [
                for (final s in p.stores) ...[
                  ListTile(dense: true, title: Text(s.name, style: const TextStyle(fontWeight: FontWeight.w600))),
                  for (final it in p.items.where((i) => i.storeId == s.storeId))
                    ListTile(dense: true, title: Text(names[it.itemId] ?? 'Articolo'), trailing: Text(euro(it.unitPrice))),
                ],
              ],
            ),
          ),
        ),
    ]);
  }
}

class _PerItemList extends ConsumerWidget {
  const _PerItemList(this.c);
  final Comparison c;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final names = _itemNames(ref);
    return ListView(padding: const EdgeInsets.only(bottom: 24), children: [
      _Header(c),
      Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
        child: Text('Totale comprando ogni articolo dove costa meno: ${euro(c.perItemTotal ?? 0)}',
            style: Theme.of(context).textTheme.titleMedium),
      ),
      for (final r in c.perItem)
        ListTile(
          title: Text(names[r.itemId] ?? 'Articolo'),
          subtitle: Text(r.storeName ?? 'Non disponibile nel raggio'),
          trailing: r.unitPrice == null
              ? null
              : Row(mainAxisSize: MainAxisSize.min, children: [
                  if (r.promo) const Padding(padding: EdgeInsets.only(right: 6), child: Icon(Icons.local_offer, size: 16)),
                  Text(euro(r.lineTotal)),
                ]),
        ),
    ]);
  }
}

Map<String, String> _itemNames(WidgetRef ref) {
  final items = ref.watch(listControllerProvider).valueOrNull?.items ?? const [];
  return {for (final i in items) i.id: i.label};
}

class _NoResults extends StatelessWidget {
  const _NoResults();

  @override
  Widget build(BuildContext context) => const Padding(
        padding: EdgeInsets.all(32),
        child: Text(
          'Nessun negozio nel raggio ha i prodotti della lista. Prova ad aumentare il raggio nelle impostazioni o a ripristinare un negozio escluso.',
          textAlign: TextAlign.center,
        ),
      );
}
